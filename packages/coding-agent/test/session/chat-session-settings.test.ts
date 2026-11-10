/**
 * Contract: a chat session (`omp --chat`, GUI chat tabs) sends only a chat
 * prompt — its preset, else the built-in one, never the agent prompt — with a
 * date but no working directory, and carries only the turns its history setting
 * allows, while its transcript keeps every turn. A chat's own settings, saved in
 * its session, win over the `chat.*` defaults and never reach another chat.
 * Agent sessions ignore all of it.
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
async function harness(kind: "chat" | "agent", overrides: Record<string, unknown> = {}, shared?: Settings) {
	const root = TempDir.createSync("@omp-chat-settings-");
	roots.push(root);
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const mock = createMockModel({ handler: { content: ["reply"] } });
	const settings = shared ?? Settings.isolated({ "retry.enabled": false, "todo.enabled": false, ...overrides });
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
	it("sends only the chat prompt, a preset replaces it from the next message, and blank restores it", async () => {
		const { session, settings, requests } = await harness("chat");
		const agent = await harness("agent");
		await session.prompt("hello");
		await agent.session.prompt("hello");
		const builtIn = requests[0].systemPrompt;
		// One short block, sharing nothing with the agent's prompt.
		expect(builtIn).toHaveLength(1);
		expect(builtIn?.[0]).toContain("chat mode");
		const agentLines = (agent.requests[0].systemPrompt?.join("\n") ?? "")
			.split("\n")
			.filter(line => line.length > 40);
		expect(agentLines.length).toBeGreaterThan(0);
		for (const line of agentLines) expect(builtIn?.[0]).not.toContain(line);

		cfgChatSystemPrompt.override(settings, "Answer like a ship's cook.");
		await settle(session);
		await session.prompt("what's for dinner?");
		expect(requests[1].systemPrompt).toEqual(["Answer like a ship's cook."]);

		cfgChatSystemPrompt.override(settings, "  ");
		await settle(session);
		await session.prompt("and tomorrow?");
		expect(requests[2].systemPrompt).toEqual(builtIn);
	});

	it("tells a chat the date but not the working directory", async () => {
		const chat = await harness("chat");
		const agent = await harness("agent");
		await chat.session.prompt("hello");
		await agent.session.prompt("hello");
		const reminder = (request: Request) =>
			text(request.messages[0]).match(/^<system-reminder>[\s\S]*?<\/system-reminder>/)?.[0];
		expect(reminder(chat.requests[0])).toMatch(/Today: \d{4}-\d{2}-\d{2}\./);
		expect(reminder(chat.requests[0])).not.toContain("working directory");
		expect(reminder(agent.requests[0])).toContain("working directory");
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

	it("follows a chat's own saved settings, which never reach another chat", async () => {
		const settings = Settings.isolated({ "retry.enabled": false, "todo.enabled": false, "chat.history": "single" });
		const mine = await harness("chat", {}, settings);
		const other = await harness("chat", {}, settings);
		await mine.session.saveChatConfig({ history: "continuous", systemPrompt: "Mine." });
		for (const { session } of [mine, other]) {
			await session.prompt("first");
			await session.prompt("second");
		}
		expect(mine.requests[1]).toEqual({
			systemPrompt: ["Mine."],
			messages: expect.anything(),
		});
		expect(mine.requests[1].messages.map(sent)).toEqual(["first", "reply", "second"]);
		// The other chat still follows the defaults: single turn, built-in prompt.
		expect(other.requests[1].messages.map(sent)).toEqual(["second"]);
		expect(other.requests[1].systemPrompt?.[0]).toContain("chat mode");
		// A later default change no longer reaches the chat that saved its own.
		cfgChatHistory.override(settings, "single");
		await mine.session.prompt("third");
		expect(mine.requests[2].messages.map(sent)).toEqual(["first", "reply", "second", "reply", "third"]);
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
				// Above the chat system prompt: threshold compaction is blocked outright
				// when fixed context alone exceeds the recovery band.
				"compaction.thresholdTokens": 2_000,
				"compaction.keepRecentTokens": 1,
				"compaction.methodOrder": ["soft"],
				"compaction.asyncEnabled": false,
			});
			const started: AgentSessionEvent[] = [];
			session.subscribe(event => {
				if (event.type === "auto_compaction_start") started.push(event);
			});
			// Each turn fits under the threshold; only the whole history exceeds it.
			await session.prompt("x".repeat(6_000));
			await session.prompt("y".repeat(6_000));
			await session.waitForIdle();
			return started.length;
		};
		// Control: the same chat with its whole history compacts past the threshold.
		expect(await compactions("continuous")).toBeGreaterThan(0);
		expect(await compactions("single")).toBe(0);
	});
});
