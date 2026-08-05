/**
 * Data builders for domain-inspection RPC commands (skills, hooks, MCP servers,
 * plugins, marketplaces, prompt templates, memory). Keeps rpc-mode.ts switch
 * cases thin; all projection logic lives here. Every builder is read-only: no
 * mutation of settings, registries, or runtime state.
 */
import { getMCPConfigPath, logger } from "@oh-my-pi/pi-utils";
import { type Hook, hookCapability } from "../../capability/hook";
import { templateUsesInlineArgPlaceholders } from "../../config/prompt-templates";
import { loadCapability } from "../../discovery";
import { clearPluginRootsAndCaches, resolveOrDefaultProjectRegistryPath } from "../../discovery/helpers";
import { PluginManager } from "../../extensibility/plugins";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
	parsePluginId,
} from "../../extensibility/plugins/marketplace";
import { loadSkills } from "../../extensibility/skills";
import { MCPManager } from "../../mcp";
import { readMCPConfigFile } from "../../mcp/config-writer";
import { hasMcpAuthorizationHeader, lookupMcpOAuthCredential } from "../../mcp/oauth-credentials";
import type { MCPServerConfig } from "../../mcp/types";
import { resolveMemoryBackend } from "../../memory-backend";
import type { AgentSession } from "../../session/agent-session";
import type {
	RpcHooksResult,
	RpcMarketplacesResult,
	RpcMcpServerInfo,
	RpcMcpServersResult,
	RpcMemoryReport,
	RpcPluginsResult,
	RpcPromptTemplatesResult,
	RpcSkillsResult,
} from "./rpc-types";

// ============================================================================
// Skills
// ============================================================================

/**
 * List every discoverable skill with its session enable state.
 *
 * The enabled set is the session's live runtime store (`session.skills`), which
 * startup loading already filtered through every disable channel (master toggle,
 * per-source toggles, ignore/include globs, capability disabled ids). The
 * universe re-runs `loadSkills` with every filter channel opened so disabled
 * skills stay visible; a skill is enabled iff the session actually loaded it.
 *
 * Dedupe caveat: both loads collapse same-name duplicates by provider priority.
 * When the priority winner is disabled but a same-named shadowed skill is
 * enabled, the row shows the winner's source marked enabled — a rare shadow
 * aliasing accepted for a single deduped listing.
 */
export async function buildRpcSkillsResult(session: AgentSession): Promise<RpcSkillsResult> {
	const enabledNames = new Set(session.skills.map(skill => skill.name));
	const discovered = await loadSkills({
		...(session.skillsSettings ?? {}),
		cwd: session.sessionManager.getCwd(),
		enabled: true,
		enableCodexUser: true,
		enableClaudeUser: true,
		enableClaudeProject: true,
		enablePiUser: true,
		enablePiProject: true,
		enableAgentsUser: true,
		enableAgentsProject: true,
		ignoredSkills: [],
		includeSkills: [],
		disabledExtensions: [],
	});
	const skills = discovered.skills.map(skill => ({
		name: skill.name,
		description: skill.description,
		source: skill.source,
		enabled: enabledNames.has(skill.name),
		location: skill.filePath,
	}));
	return { skills };
}

// ============================================================================
// Hooks
// ============================================================================

function hookKey(hook: Hook): string {
	return `${hook.type}:${hook.tool}:${hook.name}`;
}

/**
 * List discovered pre/post tool hooks with their enable state.
 *
 * Hooks have no live runtime registry on the session (startup binds discovery
 * results straight into the extension runner), so this re-runs the same
 * capability discovery the startup path uses. `loadCapability` applies the
 * `disabledExtensions` setting unless `includeDisabled` is set, so enable state
 * is the diff between a filtered and an unfiltered load.
 */
export async function buildRpcHooksResult(session: AgentSession): Promise<RpcHooksResult> {
	const cwd = session.sessionManager.getCwd();
	const disabledExtensions = session.settings.get("disabledExtensions");
	const [enabledResult, allResult] = await Promise.all([
		loadCapability<Hook>(hookCapability.id, { cwd, disabledExtensions: [...disabledExtensions] }),
		loadCapability<Hook>(hookCapability.id, { cwd, includeDisabled: true }),
	]);
	const enabledKeys = new Set(enabledResult.items.map(hookKey));
	const hooks = allResult.items
		.map(hook => ({
			id: hookCapability.toExtensionId?.(hook) ?? `hook:${hookKey(hook)}`,
			name: hook.name,
			event: `${hook.type}:${hook.tool}`,
			enabled: enabledKeys.has(hookKey(hook)),
			source: hook._source.provider,
			path: hook.path,
		}))
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
	return { hooks };
}

// ============================================================================
// MCP servers
// ============================================================================

/**
 * List every known MCP server: union of user config, project config, disabled
 * markers, and runtime-discovered connections. Connection state and tool counts
 * come from the process-global MCPManager singleton created at session startup
 * (`runRpcMode` receives no manager handle); config-only servers degrade to
 * disconnected/zero when MCP is disabled or discovery never ran. Mirrors
 * `/mcp list` semantics.
 */
export async function buildRpcMcpServersResult(session: AgentSession): Promise<RpcMcpServersResult> {
	const cwd = session.sessionManager.getCwd();
	const manager = MCPManager.instance();
	const [userConfig, projectConfig] = await Promise.all([
		readMCPConfigFile(getMCPConfigPath("user", cwd)),
		readMCPConfigFile(getMCPConfigPath("project", cwd)),
	]);

	// Project config overrides user config for same-named servers.
	const configured = new Map<string, MCPServerConfig>();
	for (const configFile of [userConfig, projectConfig]) {
		for (const [name, serverConfig] of Object.entries(configFile.mcpServers ?? {})) {
			if (serverConfig) configured.set(name, serverConfig);
		}
	}
	const disabledNames = new Set(userConfig.disabledServers ?? []);

	const names = new Set<string>([...configured.keys(), ...disabledNames]);
	if (manager) {
		for (const name of manager.getAllServerNames()) {
			names.add(name);
		}
	}

	const authStorage = session.modelRegistry.authStorage;
	const tools = manager?.getTools() ?? [];
	const servers: RpcMcpServerInfo[] = [];
	for (const name of names) {
		const config = configured.get(name) ?? manager?.getServerConfig(name);
		servers.push({
			name,
			transport: config?.type ?? (config ? "stdio" : "unknown"),
			status: manager?.getConnectionStatus(name) ?? "disconnected",
			toolCount: tools.filter(tool => tool.mcpServerName === name).length,
			enabled: config?.enabled !== false && !disabledNames.has(name),
			authed: config
				? lookupMcpOAuthCredential(authStorage, config) !== undefined || hasMcpAuthorizationHeader(config)
				: false,
		});
	}
	servers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
	return { servers };
}

// ============================================================================
// Plugins & marketplaces
// ============================================================================

/**
 * Mirror of the slash-command `createMarketplaceManager` helper, kept local so
 * the RPC surface does not depend on TUI command plumbing. Shared by the
 * read-only plugin/marketplace builders here and the mutating plugin action in
 * rpc-actions.ts.
 */
export async function createDomainMarketplaceManager(cwd: string): Promise<MarketplaceManager> {
	return new MarketplaceManager({
		marketplacesRegistryPath: getMarketplacesRegistryPath(),
		installedRegistryPath: getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(cwd),
		marketplacesCacheDir: getMarketplacesCacheDir(),
		pluginsCacheDir: getPluginsCacheDir(),
		clearPluginRootsCache: clearPluginRootsAndCaches,
	});
}

/**
 * List installed plugins from both install channels: npm packages
 * (`PluginManager`) and marketplace installs (`MarketplaceManager` registries).
 * Mirrors `/plugins list`.
 */
export async function buildRpcPluginsResult(session: AgentSession): Promise<RpcPluginsResult> {
	const plugins: RpcPluginsResult["plugins"] = [];

	const npmManager = new PluginManager();
	for (const plugin of await npmManager.list()) {
		plugins.push({
			name: plugin.name,
			marketplace: "npm",
			enabled: plugin.enabled,
			version: plugin.version,
		});
	}

	const marketplaceManager = await createDomainMarketplaceManager(session.sessionManager.getCwd());
	for (const summary of await marketplaceManager.listInstalledPlugins()) {
		const entry = summary.entries[0];
		const parsed = parsePluginId(summary.id);
		plugins.push({
			id: summary.id,
			name: parsed?.name ?? summary.id,
			marketplace: parsed?.marketplace ?? "marketplace",
			enabled: entry?.enabled !== false,
			version: entry?.version ?? "",
			scope: summary.scope,
			shadowedBy: summary.shadowedBy,
		});
	}

	return { plugins };
}

/**
 * List configured marketplaces with cached-catalog plugin counts. `pluginCount`
 * is omitted when the catalog has not been fetched yet — `#readCatalog` throws
 * in that case and `/marketplace update` is what populates it.
 */
export async function buildRpcMarketplacesResult(session: AgentSession): Promise<RpcMarketplacesResult> {
	const manager = await createDomainMarketplaceManager(session.sessionManager.getCwd());
	const entries = await manager.listMarketplaces();
	const marketplaces = await Promise.all(
		entries.map(async entry => {
			let pluginCount: number | undefined;
			try {
				pluginCount = (await manager.listAvailablePlugins(entry.name)).length;
			} catch {
				// Catalog not cached yet — leave pluginCount undefined.
			}
			return { name: entry.name, source: entry.sourceUri, pluginCount };
		}),
	);
	return { marketplaces };
}

// ============================================================================
// Prompt templates
// ============================================================================

/**
 * List file-based prompt templates loaded for this session. Templates carry no
 * declared argument schema — every template accepts trailing args (substituted
 * inline when the body references them, appended otherwise) — so `argumentHint`
 * only surfaces whether the body consumes args inline.
 */
export function buildRpcPromptTemplatesResult(session: AgentSession): RpcPromptTemplatesResult {
	const templates = session.promptTemplates.map(template => ({
		name: template.name,
		description: template.description,
		source: template.source,
		argumentHint: templateUsesInlineArgPlaceholders(template.content) ? "[arguments]" : undefined,
	}));
	return { templates };
}

// ============================================================================
// Memory
// ============================================================================

/**
 * Read-only memory backend report: active backend id, structured status (when
 * the backend implements it), and the `/memory stats` / `/memory diagnose`
 * markdown payloads. Each optional hook is best-effort — a backend that lacks
 * or fails a hook simply omits that field, matching the slash command's
 * availability wording.
 */
export async function buildRpcMemoryReport(session: AgentSession): Promise<RpcMemoryReport> {
	const backend = await resolveMemoryBackend(session.settings);
	const agentDir = session.settings.getAgentDir();
	const cwd = session.sessionManager.getCwd();
	const report: RpcMemoryReport = { backend: backend.id };

	if (backend.status) {
		try {
			const status = await backend.status({ agentDir, cwd, session });
			report.status = {
				active: status.active,
				writable: status.writable,
				searchable: status.searchable,
				scope: status.scope,
				retainBank: status.retainBank,
				recallBanks: status.recallBanks ? [...status.recallBanks] : undefined,
				workingCount: status.workingCount,
				episodicCount: status.episodicCount,
				tripleCount: status.tripleCount,
				lastMemory: status.lastMemory,
				lastRecall: status.lastRecall,
				database: status.database,
				message: status.message,
				error: status.error,
			};
			if (status.workingCount !== undefined || status.episodicCount !== undefined) {
				report.entryCount = (status.workingCount ?? 0) + (status.episodicCount ?? 0);
			}
		} catch (error: unknown) {
			logger.warn("rpc get_memory_report: backend status failed", { error: String(error) });
		}
	}

	if (backend.stats) {
		try {
			report.stats = await backend.stats(agentDir, cwd, session);
		} catch (error: unknown) {
			logger.warn("rpc get_memory_report: backend stats failed", { error: String(error) });
		}
	}

	if (backend.diagnose) {
		try {
			report.diagnosis = await backend.diagnose(agentDir, cwd, session);
		} catch (error: unknown) {
			logger.warn("rpc get_memory_report: backend diagnose failed", { error: String(error) });
		}
	}

	return report;
}
