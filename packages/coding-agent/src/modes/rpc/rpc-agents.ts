/**
 * Per-subagent lifecycle RPC actions (TUI Agent Hub `x`/`r` parity,
 * agent-hub.ts #killSelected/#reviveSelected).
 *
 * - abort: USER_INTERRUPT abort of the running session + tombstone release.
 *   Read-only advisor transcripts and the main agent are refused.
 * - revive: AgentLifecycleManager.ensureLive — idempotent for live agents,
 *   revives parked ones; unknown/aborted ids surface as `not_parked`.
 */

import {
	formatModelString,
	resolveAgentModelPatterns,
	resolveAgentPrewalkPattern,
	resolveModelOverride,
} from "../../config/model-resolver";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { discoverAgents } from "../../task/discovery";
import { resolveAgentPrewalkDefault } from "../../task/prewalk";
import type { RpcAgentDefinitionsResult } from "./rpc-types";

export type RpcSubagentActionReason = "advisor_readonly" | "main_agent" | "not_found" | "not_parked" | "abort_failed";

export interface RpcSubagentActionResult {
	ok: boolean;
	reason?: RpcSubagentActionReason;
}

/** Workspace-visible definitions and the same model/prewalk projection as the TUI control center. */
export async function buildRpcAgentDefinitions(session: AgentSession): Promise<RpcAgentDefinitionsResult> {
	const { agents } = await discoverAgents(session.sessionManager.getCwd());
	const activeModelPattern = session.model ? formatModelString(session.model) : undefined;
	const defaultModelPattern = session.settings.getModelRole("default");
	const modelOverrides =
		(session.settings.get("task.agentModelOverrides") as Record<string, string> | undefined) ?? {};
	const prewalkOverrides = (session.settings.get("task.agentPrewalk") as Record<string, string> | undefined) ?? {};
	const taskPrewalk = session.settings.get("task.prewalk") ?? false;
	const resolve = (patterns: string[]): { model?: string; thinkingLevel?: string } => {
		const result = resolveModelOverride(patterns, session.modelRegistry, session.settings);
		return {
			model: result.model ? formatModelString(result.model) : undefined,
			thinkingLevel: result.thinkingLevel,
		};
	};

	return {
		agents: agents.map(agent => {
			const base = {
				agentModel: agent.model,
				settings: session.settings,
				activeModelPattern,
				fallbackModelPattern: defaultModelPattern,
			};
			const defaultPatterns = resolveAgentModelPatterns(base);
			const effectivePatterns = resolveAgentModelPatterns({
				...base,
				settingsOverride: modelOverrides[agent.name],
			});
			const defaultResolution = resolve(defaultPatterns);
			const effectiveResolution = resolve(effectivePatterns);
			const prewalkPattern = resolveAgentPrewalkPattern({
				settingsOverride: prewalkOverrides[agent.name],
				agentPrewalk: resolveAgentPrewalkDefault(agent, taskPrewalk),
			});
			const prewalkResolution = prewalkPattern ? resolve([prewalkPattern]) : {};
			return {
				name: agent.name,
				description: agent.description,
				source: agent.source,
				filePath: agent.filePath,
				model: agent.model,
				thinkingLevel: agent.thinkingLevel,
				tools: agent.tools,
				spawns: agent.spawns,
				autoloadSkills: agent.autoloadSkills,
				output: agent.output,
				blocking: agent.blocking,
				readSummarize: agent.readSummarize,
				prewalk: agent.prewalk,
				defaultPatterns,
				defaultResolved: defaultResolution.model,
				effectivePatterns,
				effectiveResolved: effectiveResolution.model,
				effectiveThinkingLevel: effectiveResolution.thinkingLevel,
				prewalkPattern,
				prewalkResolved: prewalkResolution.model,
			};
		}),
	};
}

export async function applyRpcAbortSubagent(agentId: string): Promise<RpcSubagentActionResult> {
	if (agentId === MAIN_AGENT_ID) return { ok: false, reason: "main_agent" };
	const ref = AgentRegistry.global().get(agentId);
	if (!ref) return { ok: false, reason: "not_found" };
	if (ref.kind === "advisor") return { ok: false, reason: "advisor_readonly" };
	try {
		if (ref.status === "running" && ref.session) {
			await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
		}
		await AgentLifecycleManager.global().release(ref.id, ref, { tombstone: true });
		return { ok: true };
	} catch {
		return { ok: false, reason: "abort_failed" };
	}
}

export async function applyRpcReviveSubagent(agentId: string): Promise<RpcSubagentActionResult> {
	if (agentId === MAIN_AGENT_ID) return { ok: false, reason: "main_agent" };
	const ref = AgentRegistry.global().get(agentId);
	if (!ref) return { ok: false, reason: "not_found" };
	if (ref.kind === "advisor") return { ok: false, reason: "advisor_readonly" };
	try {
		// Idempotent for live agents (returns the live session); revives parked
		// ones. Throws for unknown ids (pre-checked above) and for refs with no
		// reviver (aborted/tombstoned or never adopted).
		await AgentLifecycleManager.global().ensureLive(agentId);
		return { ok: true };
	} catch {
		return { ok: false, reason: "not_parked" };
	}
}
