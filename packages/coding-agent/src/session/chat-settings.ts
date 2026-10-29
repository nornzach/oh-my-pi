import { combine, register } from "../config/registry";

// ────────────────────────────────────────────────────────────────────────
// Chat sessions (`omp --chat`, GUI chat tabs)
// ────────────────────────────────────────────────────────────────────────

/** System prompt a chat session sends in place of the generated one; blank keeps the default. */
export const cfgChatSystemPrompt = register({
	id: "chat.systemPrompt",
	type: "string",
	default: "",
	ui: {
		tab: "context",
		group: "Chat",
		label: "Chat System Prompt",
		description:
			"Sent as the whole system prompt in chat sessions (omp --chat, GUI chat tabs), replacing the default one. Leave empty to keep the default chat prompt",
	},
});

/** Whether a chat message carries the conversation so far or is sent on its own. */
export const cfgChatHistory = register({
	id: "chat.history",
	type: "enum",
	values: ["continuous", "single"] as const,
	default: "continuous",
	ui: {
		tab: "context",
		group: "Chat",
		label: "Chat History",
		description: "What the model sees with each chat message. The transcript still shows every turn",
		options: [
			{ value: "continuous", label: "Continuous", description: "Earlier turns go with each message" },
			{ value: "single", label: "Single turn", description: "Each message is sent on its own" },
		],
	},
});

/** Earlier turns a continuous chat sends with each message; 0 sends all of them. */
export const cfgChatHistoryTurns = register({
	id: "chat.historyTurns",
	type: "number",
	default: 0,
	validate: raw => {
		if (raw === undefined || raw === null || (typeof raw === "number" && Number.isInteger(raw) && raw >= 0)) return;
		throw new Error(
			`Invalid chat.historyTurns: expected a whole number of turns (0 = all), got ${Bun.inspect(raw)}.`,
		);
	},
	ui: {
		tab: "context",
		group: "Chat",
		label: "Chat History Depth",
		description: "How many earlier turns a continuous chat sends with each message",
		options: [
			{ value: "0", label: "All turns", description: "The whole conversation" },
			{ value: "1", label: "1 turn" },
			{ value: "3", label: "3 turns" },
			{ value: "5", label: "5 turns" },
			{ value: "10", label: "10 turns" },
			{ value: "20", label: "20 turns" },
		],
	},
});

/** Every chat setting, for listeners that re-read them as one. */
export const cfgChatSettings = combine({
	systemPrompt: cfgChatSystemPrompt,
	history: cfgChatHistory,
	historyTurns: cfgChatHistoryTurns,
});
