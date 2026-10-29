/**
 * Contract: a chat session (`omp --chat`, GUI chat tabs) sends `chat.systemPrompt`
 * as its whole system prompt and carries only the turns `chat.history` /
 * `chat.historyTurns` allow, while its transcript keeps every turn. Agent
 * sessions ignore all three settings.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { limitChatHistory } from "@oh-my-pi/pi-coding-agent/session/chat-session";
import {
	cfgChatHistory,
	cfgChatHistoryTurns,
	cfgChatSystemPrompt,
} from "@oh-my-pi/pi-coding-agent/session/chat-settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const roots: TempDir[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(sessions.splice(0).map(session => session.dispose()));
	await Promise.all(roots.splice(0).map(root => root.remove()));
});

function text(message: AgentMessage): string {
	if (message.role === "fileMention") return `@${message.files.map(file => file.path).join(",")}`;
	if (!("content" in message)) return `[${message.role}]`;
	if (typeof message.content === "string") return message.content;
	return message.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

/** A request message's text, without the date/cwd reminder each request's first user turn carries. */
function sent(message: AgentMessage): string {
	return text(message).replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, "");
}

type Request = Pick<Context, "messages" | "systemPrompt">;

/** A session on a mock model that records every main-loop request. */
async function harness(kind: "chat" | "agent", overrides: Record<string, unknown> = {}) {
	const root = TempDir.createSync("@omp-chat-settings-");
	roots.push(root);
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const mock = createMockModel({ handler: { content: ["reply"] } });
	const settings = Settings.isolated({ "retry.enabled": false, "todo.enabled": false, ...overrides });
	const { session } = await createAgentSession({
		cwd: root.path(),
		agentDir: root.path(),
		modelRegistry: new ModelRegistry(auth),
		model: mock,
		sessionManager: SessionManager.create(
			root.path(),
			root.path(),
			new MemorySessionStorage(),
			kind === "chat" ? { kind } : undefined,
		),
		settings,
		// What `--chat` builds: no tools at all.
		toolNames: [],
		restrictToolNames: true,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	sessions.push(session);
	const requests: Request[] = [];
	session.agent.streamFn = (model, context, options) => {
		requests.push({ messages: structuredClone(context.messages), systemPrompt: context.systemPrompt?.slice() });
		return mock.stream(model, context, options);
	};
	return { session, settings, requests };
}

/** Let a settings change rebuild the system prompt before the next message. */
async function settle(session: AgentSession): Promise<void> {
	await Promise.resolve();
	await session.runToolRegistryMutation(async () => undefined);
}

describe("limitChatHistory", () => {
	const user = (content: string, timestamp: number): AgentMessage => ({ role: "user", content, timestamp });
	const reply = (content: string, timestamp: number): AgentMessage => ({
		...createAssistantMessage(content),
		timestamp,
	});
	const notice = (content: string, timestamp: number): AgentMessage => ({
		role: "custom",
		customType: "notice",
		content,
		display: false,
		timestamp,
	});
	const conversation: AgentMessage[] = [
		notice("branch summary", 0),
		user("first", 1),
		reply("one", 2),
		user("second", 3),
		reply("two", 4),
		// Leading companion of the current prompt, then a file it mentioned.
		notice("plan mode on", 5),
		user("third", 6),
		{ role: "fileMention", files: [{ path: "notes.md", content: "milk" }], timestamp: 7 },
	];

	it.each([
		// Only the current turn, with the companions on both sides of its prompt.
		[0, ["plan mode on", "third", "@notes.md"]],
		// Cut at the previous prompt: the reply before it closes the kept range.
		[1, ["second", "two", "plan mode on", "third", "@notes.md"]],
		// The oldest kept turn reaches the start through its leading notice.
		[2, ["branch summary", "first", "one", "second", "two", "plan mode on", "third", "@notes.md"]],
		// Fewer turns than the limit.
		[9, ["branch summary", "first", "one", "second", "two", "plan mode on", "third", "@notes.md"]],
	])("keeps the current turn and %i earlier", (earlierTurns, expected) => {
		expect(limitChatHistory(conversation, earlierTurns).map(text)).toEqual(expected);
	});
});

describe("chat.systemPrompt", () => {
	it("replaces a chat's system prompt from the next message, and blank restores the generated one", async () => {
		const { session, settings, requests } = await harness("chat");
		await session.prompt("hello");
		const generated = requests[0].systemPrompt;

		cfgChatSystemPrompt.override(settings, "Answer like a ship's cook.");
		await settle(session);
		await session.prompt("what's for dinner?");
		expect(requests[1].systemPrompt).toEqual(["Answer like a ship's cook."]);

		cfgChatSystemPrompt.override(settings, "  ");
		await settle(session);
		await session.prompt("and tomorrow?");
		expect(requests[2].systemPrompt).toEqual(generated);
	});

	it("never reaches an agent session's prompt", async () => {
		const { session, requests } = await harness("agent", { "chat.systemPrompt": "Answer like a ship's cook." });
		await session.prompt("hello");
		expect(requests[0].systemPrompt?.join("\n")).not.toContain("ship's cook");
	});
});

describe("chat.history", () => {
	it("sends only the turns the settings allow while the transcript keeps every turn", async () => {
		// Single turn wins over a depth.
		const { session, settings, requests } = await harness("chat", {
			"chat.history": "single",
			"chat.historyTurns": 3,
		});
		await session.prompt("first");
		await session.prompt("second");
		expect(requests[1].messages.map(sent)).toEqual(["second"]);
		expect(session.messages.map(text)).toEqual(["first", "reply", "second", "reply"]);

		cfgChatHistory.override(settings, "continuous");
		cfgChatHistoryTurns.override(settings, 1);
		await session.prompt("third");
		expect(requests[2].messages.map(sent)).toEqual(["second", "reply", "third"]);

		cfgChatHistoryTurns.override(settings, 0);
		await session.prompt("fourth");
		expect(requests[3].messages.map(sent)).toEqual(["first", "reply", "second", "reply", "third", "reply", "fourth"]);
	});

	it("leaves an agent session's history whole", async () => {
		const { session, requests } = await harness("agent", { "chat.history": "single" });
		await session.prompt("first");
		await session.prompt("second");
		expect(requests[1].messages.map(sent)).toEqual(["first", "reply", "second"]);
	});

	it("keeps a chat that sends only its latest turns from auto-compacting", async () => {
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const compactions = async (history: "continuous" | "single") => {
			const { session } = await harness("chat", {
				"chat.history": history,
				"compaction.thresholdTokens": 100,
				"compaction.keepRecentTokens": 1,
				"compaction.methodOrder": ["soft"],
				"compaction.asyncEnabled": false,
			});
			const started: AgentSessionEvent[] = [];
			session.subscribe(event => {
				if (event.type === "auto_compaction_start") started.push(event);
			});
			await session.prompt("x".repeat(2_000));
			await session.prompt("y".repeat(2_000));
			await session.waitForIdle();
			return started.length;
		};
		// Control: the same chat with its whole history compacts past the threshold.
		expect(await compactions("continuous")).toBeGreaterThan(0);
		expect(await compactions("single")).toBe(0);
	});
});
