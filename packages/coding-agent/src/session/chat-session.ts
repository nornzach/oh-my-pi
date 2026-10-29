import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ScopeLike } from "../config/registry";
import { cfgChatHistory, cfgChatHistoryTurns, cfgChatSystemPrompt } from "./chat-settings";
import { isUserQueuedMessage } from "./queued-messages";
import type { SessionManager } from "./session-manager";

type SessionKindSource = Pick<SessionManager, "getHeader">;

function isChatSession(sessionManager: SessionKindSource): boolean {
	return sessionManager.getHeader()?.kind === "chat";
}

/** The `chat.systemPrompt` preset a chat session sends verbatim, or `undefined` to build the default prompt. */
export function chatSystemPrompt(sessionManager: SessionKindSource, scope: ScopeLike): string | undefined {
	if (!isChatSession(sessionManager)) return undefined;
	const preset = cfgChatSystemPrompt.get(scope);
	return preset.trim() ? preset : undefined;
}

/**
 * Earlier turns a session's requests carry (`chat.history`, `chat.historyTurns`), or
 * `undefined` for the whole conversation. Only chat sessions limit them.
 */
export function chatHistoryLimit(sessionManager: SessionKindSource, scope: ScopeLike): number | undefined {
	if (!isChatSession(sessionManager)) return undefined;
	if (cfgChatHistory.get(scope) === "single") return 0;
	const turns = cfgChatHistoryTurns.get(scope);
	return turns > 0 ? turns : undefined;
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
