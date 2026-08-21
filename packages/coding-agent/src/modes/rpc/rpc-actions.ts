/**
 * Mutating domain actions for RPC mode (skill/hook/plugin enable, MCP server
 * actions). The read-only counterparts live in rpc-domains.ts; these mirror the
 * TUI/slash-command mutation paths against the same settings, config files, and
 * runtime managers:
 *
 * - skills/hooks: the extension-dashboard's `disabledExtensions` toggle
 *   (`skill:<name>`, `hook:<type>:<tool>:<name>` ids),
 * - plugins: `MarketplaceManager.setPluginEnabled` (`/plugins enable`) and
 *   `PluginManager.setEnabled` (npm channel, Settings → Plugins),
 * - MCP: `setMcpServerEnabled` (dashboard-canonical wrapper around the same
 *   `updateMCPServer`/`setServerDisabled` writes `/mcp enable|disable` perform)
 *   plus the `/mcp` controller's live-runtime steps (connect/disconnect/
 *   reconnect and `session.refreshMCPTools`).
 */
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { PluginManager } from "../../extensibility/plugins";
import { parsePluginId } from "../../extensibility/plugins/marketplace";
import { MCPManager } from "../../mcp";
import { loadAllMCPConfigs } from "../../mcp/config";
import { readMCPConfigFile, removeMCPServer, setMcpServerEnabled } from "../../mcp/config-writer";
import type { AgentSession } from "../../session/agent-session";
import { createDomainMarketplaceManager } from "./rpc-domains";
import { installedPluginActivation, pluginRequiresRestart } from "./rpc-marketplace";
import { serializeMcpReload } from "./rpc-mcp-extra";
import type { RpcMcpActionResult, RpcPluginSetEnabledResult } from "./rpc-types";

/**
 * Toggle an extension id in the `disabledExtensions` setting, mirroring
 * `ExtensionDashboard.#handleExtensionToggle`. Returns false when the setting
 * already reflected the requested state (no write performed).
 */
async function persistDisabledExtensionsToggle(
	session: AgentSession,
	extensionId: string,
	enabled: boolean,
): Promise<boolean> {
	const settings = session.settings;
	const disabled = [...settings.get("disabledExtensions")];
	const index = disabled.indexOf(extensionId);
	if (enabled === (index === -1)) return false;
	if (enabled) disabled.splice(index, 1);
	else disabled.push(extensionId);
	settings.set("disabledExtensions", disabled);
	await settings.flush();
	return true;
}

/**
 * Enable/disable a skill by name (`skill:<name>` in `disabledExtensions`).
 * The caller runs the session reload pipeline afterwards: `refreshSkills`
 * re-reads `disabledExtensions` live (session-tools.ts), so the toggle takes
 * effect without a restart — unlike the TUI dashboard, which only repaints.
 */
export async function applyRpcSkillEnabled(
	session: AgentSession,
	name: string,
	enabled: boolean,
): Promise<{ name: string; enabled: boolean }> {
	if (!name.trim()) throw new Error("Skill name cannot be empty");
	await persistDisabledExtensionsToggle(session, `skill:${name}`, enabled);
	return { name, enabled };
}

/**
 * Enable/disable a hook by its stable id (`hook:<type>:<tool>:<name>`, as
 * reported by `get_hooks`). Persists through the same `disabledExtensions`
 * channel as the dashboard. Hooks bind at extension-load time and no live
 * rebind exists anywhere (the TUI dashboard has the same limitation), so the
 * toggle takes effect on the next session start.
 */
export async function applyRpcHookEnabled(
	session: AgentSession,
	id: string,
	enabled: boolean,
): Promise<{ id: string; enabled: boolean }> {
	if (!id.startsWith("hook:")) {
		throw new Error(`Invalid hook id: ${id} (expected "hook:<type>:<tool>:<name>")`);
	}
	await persistDisabledExtensionsToggle(session, id, enabled);
	return { id, enabled };
}

/**
 * Enable/disable an installed plugin. Marketplace installs address by their
 * full `name@marketplace` id (mirrors `/plugins enable|disable`); anything
 * else routes to the npm channel by bare package name (mirrors
 * Settings → Plugins). The caller reloads plugin state afterwards so the
 * change takes effect in the live session.
 */
export async function applyRpcPluginEnabled(
	session: AgentSession,
	id: string,
	enabled: boolean,
	scope?: "user" | "project",
): Promise<RpcPluginSetEnabledResult> {
	if (!id.trim()) throw new Error("Plugin id cannot be empty");
	if (parsePluginId(id)) {
		const manager = await createDomainMarketplaceManager(session.sessionManager.getCwd());
		await manager.setPluginEnabled(id, enabled, scope);
		const entry = (await manager.listInstalledPlugins()).find(candidate => candidate.id === id)?.entries[0];
		const activation = entry ? await installedPluginActivation(entry.installPath, id) : "live";
		return { id, enabled, channel: "marketplace", activation };
	}
	const npmManager = new PluginManager();
	await npmManager.setEnabled(id, enabled);
	const installed = (await npmManager.list()).find(plugin => plugin.name === id);
	return {
		id,
		enabled,
		channel: "npm",
		activation:
			installed && pluginRequiresRestart(installed.manifest, installed.enabledFeatures)
				? "restart-required"
				: "live",
	};
}

// ============================================================================
// MCP server actions
// ============================================================================

export type RpcMcpAction = "enable" | "disable" | "reconnect" | "remove";

/**
 * Drive an MCP server action the way the `/mcp` subcommands do.
 *
 * enable/disable: persists through `setMcpServerEnabled` (the canonical toggle
 * the extension dashboard routes through; it performs the same
 * `updateMCPServer`/`setServerDisabled` writes as `/mcp enable|disable`,
 * including the force-enable allowlist for non-writable sources), then applies
 * the controller's live-runtime steps (`#connectEnabledMCPServer` /
 * disconnect + `refreshMCPTools`).
 *
 * reconnect: `/mcp reconnect` verbatim (`reconnectServer` + `refreshMCPTools`).
 *
 * remove: `/mcp remove` config delete, then the controller's serialized full
 * `reloadServers` rediscovery so every remaining server's tools rebind.
 */
export async function applyRpcMcpAction(
	session: AgentSession,
	name: string,
	action: RpcMcpAction,
	scope?: "user" | "project",
): Promise<RpcMcpActionResult> {
	if (!name.trim()) throw new Error("Server name cannot be empty");
	const cwd = session.sessionManager.getCwd();
	const manager = MCPManager.instance();

	switch (action) {
		case "enable":
		case "disable": {
			const enabled = action === "enable";
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);
			const [userConfig, projectConfig] = await Promise.all([
				readMCPConfigFile(userPath),
				readMCPConfigFile(projectPath),
			]);
			const configured = projectConfig.mcpServers?.[name] ?? userConfig.mcpServers?.[name];
			const discovered = manager?.getSource(name) !== undefined;
			const disabledNames = new Set(userConfig.disabledServers ?? []);
			if (!configured && !discovered && !disabledNames.has(name)) {
				throw new Error(`Server "${name}" not found.`);
			}
			await setMcpServerEnabled({ userPath, projectPath, name, enabled });
			// Serialized with every other shared-manager mutation (mcp_add /
			// mcp_reauth reloads): a targeted connect resolving after a concurrent
			// disconnectAll would be dropped unclosed.
			await serializeMcpReload(async () => {
				if (enabled) {
					// Mirror MCPCommandController.#connectEnabledMCPServer.
					if (manager) {
						const { configs, sources } = await loadAllMCPConfigs(cwd);
						const config = configs[name];
						if (config) {
							const source = sources[name];
							await manager.connectServers({ [name]: config }, source ? { [name]: source } : {});
						}
					}
				} else {
					await manager?.disconnectServer(name);
				}
				await session.refreshMCPTools(manager?.getTools() ?? []);
			});
			return { name, action, status: manager?.getConnectionStatus(name) ?? "disconnected" };
		}

		case "reconnect": {
			if (!manager) throw new Error("MCP manager not available.");
			const connection = await serializeMcpReload(async () => {
				const reconnected = await manager.reconnectServer(name, { manual: true });
				if (reconnected) await session.refreshMCPTools(manager.getTools());
				return reconnected;
			});
			if (!connection) {
				throw new Error(`Failed to reconnect to "${name}". Check server status and logs.`);
			}
			return { name, action, status: manager.getConnectionStatus(name) };
		}

		case "remove": {
			const filePath = getMCPConfigPath(scope ?? "project", cwd);
			const config = await readMCPConfigFile(filePath);
			if (!config.mcpServers?.[name]) {
				throw new Error(`Server "${name}" not found in ${scope ?? "project"} config.`);
			}
			await removeMCPServer(filePath, name);
			// Serialized with every other shared-manager mutation (mcp_add /
			// mcp_reauth reloads): an interleaved disconnectAll would drop
			// in-flight connections unclosed and double-connect discoveries.
			await serializeMcpReload(async () => {
				if (manager) {
					// Mirror MCPCommandController.reloadServers: full rediscovery with the
					// same settings-derived filters as startup.
					await manager.disconnectAll();
					session.setMCPPromptCommands([]);
					await manager.discoverAndConnect({
						enableProjectConfig: session.settings.get("mcp.enableProjectConfig") ?? true,
						filterExa: true,
						filterBrowser: session.settings.get("browser.enabled") ?? false,
					});
				}
				await session.refreshMCPTools(manager?.getTools() ?? []);
			});
			return { name, action };
		}
	}
}
