/**
 * Canonical live-apply for runtime settings, shared by the TUI settings
 * selector and every client that only has `set_setting` (RPC GUI, ACP, SDK).
 *
 * Background: the apply logic used to live only in the TUI selector switch,
 * so an RPC `set_setting` wrote config.yml but left the running session
 * stale until restart — the GUI settings window appeared to do nothing for
 * these keys. This module is the single apply path both callers use.
 *
 * Only keys whose values are CACHED in session/agent/module state belong
 * here. Keys read live via settings.get() at use-time (retry.*, the loop
 * guards, compaction.enabled, advisor.subagents, …) need no apply, and
 * TUI-chrome keys (statusLine.*, tui.*, display.*, theme, …) have no
 * agent-side effect at all.
 */
import { MCPManager } from "../mcp/manager";
import { type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "../thinking";
import { setImageProviderOrder } from "../tools/image-gen";
import { setExcludedSearchProviders, setSearchProviderOrder } from "../web/search/provider";
import { isSearchProviderId } from "../web/search/types";

/**
 * Narrow structural apply target: `AgentSession` satisfies it; tests
 * substitute a fake. Module-global state (provider orders, MCP manager) is
 * applied directly, outside the target.
 */
export interface RuntimeSettingTarget {
	agent: {
		temperature?: number;
		topP?: number;
		topK?: number;
		minP?: number;
		presencePenalty?: number;
		repetitionPenalty?: number;
		hideThinkingSummary?: boolean;
	};
	setThinkingLevel(level: ConfiguredThinkingLevel | undefined, persist?: boolean): void;
	setAdvisorEnabled(enabled: boolean): unknown;
	setSteeringMode(mode: "all" | "one-at-a-time"): void;
	setFollowUpMode(mode: "all" | "one-at-a-time"): void;
	setInterruptMode(mode: "immediate" | "wait"): void;
	refreshBaseSystemPrompt(): Promise<void>;
	applyMemoryBackend(): Promise<void>;
	applyInspectImageModeChange(): Promise<unknown>;
}

/** Sampling params cached as Agent fields; -1/negative means provider default (undefined). */
const SAMPLING_SETTING_KEYS: Record<string, true> = {
	temperature: true,
	topP: true,
	topK: true,
	minP: true,
	presencePenalty: true,
	repetitionPenalty: true,
};

function numOrUndefined(value: unknown): number | undefined {
	const num = typeof value === "number" ? value : Number(value);
	return Number.isFinite(num) && num >= 0 ? num : undefined;
}

/**
 * Apply a just-written setting to the running session. Returns true when
 * `path` is a runtime key this module handles (caller treats false as
 * "persistence only", which is correct for live-read and chrome keys).
 * Throws when an async apply fails — the value is already persisted; the
 * caller decides how to surface the apply failure (TUI: showError, RPC:
 * error reply).
 */
export async function applyRuntimeSetting(
	session: RuntimeSettingTarget,
	path: string,
	value: unknown,
): Promise<boolean> {
	if (SAMPLING_SETTING_KEYS[path] === true) {
		// SAMPLING_SETTING_KEYS gates membership, so `path` is one of the six.
		const key = path as "temperature" | "topP" | "topK" | "minP" | "presencePenalty" | "repetitionPenalty";
		session.agent[key] = numOrUndefined(value);
		return true;
	}

	switch (path) {
		case "defaultThinkingLevel": {
			const parsed = typeof value === "string" ? parseConfiguredThinkingLevel(value) : undefined;
			if (parsed !== undefined) session.setThinkingLevel(parsed, true);
			return true;
		}
		case "advisor.enabled":
			session.setAdvisorEnabled(value === true);
			return true;
		case "steeringMode":
			if (value === "all" || value === "one-at-a-time") session.setSteeringMode(value);
			return true;
		case "followUpMode":
			if (value === "all" || value === "one-at-a-time") session.setFollowUpMode(value);
			return true;
		case "interruptMode":
			if (value === "immediate" || value === "wait") session.setInterruptMode(value);
			return true;
		case "omitThinking":
			session.agent.hideThinkingSummary = value === true;
			return true;
		case "personality":
		case "tools.xdevDocs":
		case "tui.renderMermaid":
			// renderMermaid's TUI chrome half stays in the TUI; the agent-side
			// effect (the setting is baked into the cached system prompt) is here.
			await session.refreshBaseSystemPrompt();
			return true;
		case "memory.backend":
			await session.applyMemoryBackend();
			return true;
		case "inspect_image.mode":
			await session.applyInspectImageModeChange();
			return true;
		case "providers.webSearchOrder":
			if (Array.isArray(value)) setSearchProviderOrder(value.filter(isSearchProviderId));
			return true;
		case "providers.webSearchExclude":
			if (Array.isArray(value)) setExcludedSearchProviders(value.filter(isSearchProviderId));
			return true;
		case "providers.imageOrder":
			if (Array.isArray(value)) {
				setImageProviderOrder(value.filter((entry): entry is string => typeof entry === "string"));
			}
			return true;
		case "mcp.notifications":
			MCPManager.instance()?.setNotificationsEnabled(value === true);
			return true;
		default:
			return false;
	}
}
