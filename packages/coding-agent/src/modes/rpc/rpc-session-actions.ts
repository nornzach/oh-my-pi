/**
 * One-shot session actions for RPC mode (TUI /prewalk /fresh /shake
 * /reload-plugins /force parity). Each helper mirrors the slash command's
 * semantics against the same session/controller surface the TUI drives —
 * nothing is reimplemented here:
 *
 * - set_prewalk: /prewalk's model resolution (expandRoleAlias @smol →
 *   resolveCliModel → auth check) then AgentSession.armPrewalk; the
 *   toggle-off half disarms (PrewalkCoordinator.disarm — no TUI equivalent).
 * - fresh: AgentSession.freshSession verbatim, including its busy refusal.
 * - shake_context: AgentSession.shake + formatShakeSummary.
 * - reload_plugins: the RPC boot path's reload pipeline extended to TUI
 *   reloadTuiPluginState parity (#7189) with MCP reconnect; returns the
 *   post-reload inventory counts.
 * - set/get_force_tool: /force's AgentSession.setForcedToolChoice plus the
 *   session-side pending-force tracking (get/clear — no TUI equivalent).
 */
import { reset as resetCapabilities } from "../../capability";
import {
	DEFAULT_PREWALK_TARGET,
	expandRoleAlias,
	getModelMatchPreferences,
	resolveCliModel,
} from "../../config/model-resolver";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { MCPManager } from "../../mcp";
import type { AgentSession } from "../../session/agent-session";
import { formatShakeSummary, type ShakeMode } from "../../session/shake-types";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { buildRpcPluginsResult } from "./rpc-domains";
import { serializeMcpReload } from "./rpc-mcp-extra";
import type {
	RpcAvailableSlashCommand,
	RpcForceToolState,
	RpcFreshResult,
	RpcPrewalkState,
	RpcReloadPluginsResult,
	RpcShakeContextResult,
} from "./rpc-types";

/**
 * Arm/disarm the next-action model prewalk (/prewalk). Arming resolves the
 * fast/cheap target exactly like the slash command; disarming cancels a
 * pending switch (idempotent — reports the post-state either way).
 */
export function applyRpcSetPrewalk(session: AgentSession, enabled: boolean): RpcPrewalkState {
	if (!enabled) {
		session.disarmPrewalk();
		return { enabled: false };
	}
	const rolePattern = expandRoleAlias(DEFAULT_PREWALK_TARGET, session.settings);
	const resolved = resolveCliModel({
		cliModel: rolePattern,
		modelRegistry: session.modelRegistry,
		preferences: getModelMatchPreferences(session.settings),
	});
	if (resolved.error || !resolved.model) {
		throw new Error(resolved.error ?? `Model "${rolePattern}" not found`);
	}
	if (!session.modelRegistry.hasConfiguredAuth(resolved.model)) {
		throw new Error(`No API key for ${resolved.model.provider}/${resolved.model.id}`);
	}
	session.armPrewalk(resolved.model, resolved.thinkingLevel);
	return { enabled: true };
}

/**
 * Reset provider stream state (/fresh). Returns undefined while streaming —
 * the caller maps that to a "busy" refusal, same boundary as the slash
 * command's "wait for the current response" message.
 */
export function applyRpcFresh(session: AgentSession): RpcFreshResult | undefined {
	if (!session.freshSession()) return undefined;
	return {};
}

/** Drop heavy content from context (/shake elide|images). */
export async function applyRpcShakeContext(session: AgentSession, mode: ShakeMode): Promise<RpcShakeContextResult> {
	const result = await session.shake(mode);
	return { removed: formatShakeSummary(result) };
}

/**
 * Reload plugin state (/reload-plugins). This is the RPC boot path's
 * reloadPluginState pipeline — plugin-root/fs caches, capability cache,
 * skills, file slash commands — extended with the TUI handler's MCP
 * reconnect (#7189: the command's documented scope includes MCP, and the
 * reconnect rebinds the session's MCP tools). `onCommandsRefreshed` receives
 * the rebuilt palette list so the host can push a single
 * available_commands_update frame without recomputing it.
 */
export async function applyRpcReloadPlugins(
	session: AgentSession,
	onCommandsRefreshed?: (commands: RpcAvailableSlashCommand[]) => void,
): Promise<RpcReloadPluginsResult> {
	const cwd = session.sessionManager.getCwd();
	const projectPath = await resolveActiveProjectRegistryPath(cwd);
	clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
	resetCapabilities();
	await session.refreshSkills();
	session.setSlashCommands(await loadSlashCommands({ cwd }));

	// TUI MCPCommandController.reloadServers parity: full rediscovery with the
	// same settings-derived filters as startup, serialized with every other
	// shared-manager mutation. Skipped entirely when MCP never initialized
	// (mirrors the TUI controller's `if (!ctx.mcpManager) return`).
	const manager = MCPManager.instance();
	if (manager) {
		await serializeMcpReload(async () => {
			await manager.disconnectAll();
			// Clear prompt commands before rediscovery so removed servers cannot
			// leave stale entries; new prompts repopulate via the manager callback.
			session.setMCPPromptCommands([]);
			await manager.discoverAndConnect({
				enableProjectConfig: session.settings.get("mcp.enableProjectConfig") ?? true,
				filterExa: true,
				filterBrowser: session.settings.get("browser.enabled") ?? false,
			});
			await session.refreshMCPTools(manager.getTools());
		});
	}

	const commands = await buildAvailableSlashCommands(session, undefined, { includeTuiOnlyBuiltins: true });
	onCommandsRefreshed?.(commands);
	const { plugins } = await buildRpcPluginsResult(session);
	return { plugins: plugins.length, skills: session.skills.length, commands: commands.length };
}

/**
 * Force the next turn onto a tool, or clear a pending force (/force +
 * GUI-only clear). Takes exactly one of `tool` / `clear`; the response
 * reports the post-state so the dialog can render server truth.
 */
export function applyRpcSetForceTool(
	session: AgentSession,
	payload: { tool?: string; clear?: boolean },
): RpcForceToolState {
	if (payload.clear === true) {
		if (payload.tool !== undefined) throw new Error("set_force_tool takes exactly one of tool or clear.");
		session.clearForcedToolChoice();
		return { tool: null };
	}
	const tool = payload.tool?.trim();
	if (!tool) throw new Error("set_force_tool takes exactly one of tool or clear.");
	session.setForcedToolChoice(tool);
	return { tool: session.getForcedToolChoice() };
}

/** The pending forced tool, or null (GUI dialog's current-value row). */
export function applyRpcGetForceTool(session: AgentSession): RpcForceToolState {
	return { tool: session.getForcedToolChoice() };
}
