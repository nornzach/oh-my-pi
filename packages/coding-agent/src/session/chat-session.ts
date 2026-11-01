import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ScopeLike } from "../config/registry";
import chatPromptContent from "../prompts/chat-mode.md" with { type: "text" };
import { cfgChatHistory, cfgChatHistoryTurns, cfgChatSystemPrompt } from "./chat-settings";
import { isUserQueuedMessage } from "./queued-messages";
import type { SessionManager } from "./session-manager";

type SessionKindSource = Pick<SessionManager, "getHeader">;
type ChatSessionSource = Pick<SessionManager, "getHeader" | "getBranch">;

/** Custom session entry holding one chat's own settings; the latest on the branch wins. */
export const CHAT_CONFIG_ENTRY = "chat-config";

/** What a chat sends: its system prompt and how much of the conversation goes with each message. */
export interface ChatConfig {
	/** Sent as the whole system prompt; blank sends the built-in chat prompt. */
	systemPrompt: string;
	/** `single` sends every message on its own. */
	history: "continuous" | "single";
	/** Earlier turns a continuous chat sends with each message; 0 sends all of them. */
	historyTurns: number;
}

export function isChatSession(sessionManager: SessionKindSource): boolean {
	return sessionManager.getHeader()?.kind === "chat";
}

/**
 * A chat's settings: the ones it saved for itself, else the `chat.*` defaults.
 * Each chat keeps its own, so editing one never changes another.
 */
export function chatConfig(sessionManager: ChatSessionSource, scope: ScopeLike): ChatConfig {
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== CHAT_CONFIG_ENTRY) continue;
		const saved = parseChatConfig(entry.data);
		if (saved) return saved;
	}
	return {
		systemPrompt: cfgChatSystemPrompt.get(scope),
		history: cfgChatHistory.get(scope),
		historyTurns: cfgChatHistoryTurns.get(scope),
	};
}

/**
 * Save `patch` into this chat's own settings, in its session; other chats keep theirs.
 * Throws on a value the settings would reject.
 */
export function saveChatConfig(
	sessionManager: ChatSessionSource & Pick<SessionManager, "appendCustomEntry">,
	scope: ScopeLike,
	patch: Partial<ChatConfig>,
): ChatConfig {
	const next = parseChatConfig({ ...chatConfig(sessionManager, scope), ...patch });
	if (!next) throw new Error(`Invalid chat settings: ${Bun.inspect(patch)}`);
	sessionManager.appendCustomEntry(CHAT_CONFIG_ENTRY, next);
	return next;
}

function parseChatConfig(data: unknown): ChatConfig | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const { systemPrompt, history, historyTurns } = data as Record<string, unknown>;
	if (typeof systemPrompt !== "string") return undefined;
	if (history !== "continuous" && history !== "single") return undefined;
	if (typeof historyTurns !== "number" || !Number.isInteger(historyTurns) || historyTurns < 0) return undefined;
	return { systemPrompt, history, historyTurns };
}

/**
 * The whole system prompt a chat session sends — its own preset, else the built-in
 * chat prompt — or `undefined` outside chat sessions, which build the agent prompt.
 */
export function chatSystemPrompt(sessionManager: ChatSessionSource, scope: ScopeLike): string | undefined {
	if (!isChatSession(sessionManager)) return undefined;
	const preset = chatConfig(sessionManager, scope).systemPrompt;
	return preset.trim() ? preset : chatPromptContent.trim();
}

/**
 * Earlier turns a session's requests carry, or `undefined` for the whole
 * conversation. Only chat sessions limit them.
 */
export function chatHistoryLimit(sessionManager: ChatSessionSource, scope: ScopeLike): number | undefined {
	if (!isChatSession(sessionManager)) return undefined;
	const config = chatConfig(sessionManager, scope);
	if (config.history === "single") return 0;
	return config.historyTurns > 0 ? config.historyTurns : undefined;
}

/**
 * The model's view of a chat: the current turn and at most `earlierTurns` turns before it.
 *
 * A turn opens with a user prompt and also owns the companions queued just ahead of it
 * (notices, summaries), back to the previous reply; everything after the prompt up to the
 * next one (file mentions, the reply, tool calls and their results) belongs to it too, so
 * the cut never splits a turn. Only the request is trimmed: the session keeps every message.
 */
export function limitChatHistory(messages: AgentMessage[], earlierTurns: number): AgentMessage[] {
	let prompts = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (!isUserQueuedMessage(messages[index])) continue;
		prompts++;
		if (prompts <= earlierTurns) continue;
		// `index` opens the oldest turn kept; take its leading companions along.
		let start = index;
		while (start > 0 && !endsTurnBefore(messages[start - 1])) start--;
		return start === 0 ? messages : messages.slice(start);
	}
	return messages;
}

/** A reply, or the previous prompt, closes everything before a turn's leading companions. */
function endsTurnBefore(message: AgentMessage): boolean {
	return message.role === "assistant" || message.role === "toolResult" || isUserQueuedMessage(message);
}
