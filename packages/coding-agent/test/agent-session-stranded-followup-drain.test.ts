import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Live-repro contract (GUI preview): slow blocker running → two follow-ups
 * queued → user aborts the turn (follow-ups intentionally preserved) → a NEW
 * user prompt runs and completes → the stranded follow-ups MUST drain in
 * server order after that turn. A user interrupt suppresses auto-resume only
 * for the run it stopped; a completed subsequent user turn is the explicit
 * resume point. Both blocker shapes are pinned: a parked model stream and a
 * parked tool execution aborted mid-call.
 */

let tempDir: TempDir;
let authStorage: AuthStorage;
let session: AgentSession;

beforeEach(async () => {
	tempDir = TempDir.createSync("@pi-stranded-drain-");
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
});

afterEach(async () => {
	await session.dispose();
	authStorage.close();
	tempDir.removeSync();
	vi.restoreAllMocks();
});

function userTurnTexts(): string[] {
	return session.state.messages
		.filter((message): message is Extract<AgentMessage, { role: "user" }> => message.role === "user")
		.map(message =>
			typeof message.content === "string"
				? message.content
				: ((message.content.find(part => part.type === "text") as { text: string } | undefined)?.text ?? ""),
		);
}

describe("stranded follow-up drain after user interrupt", () => {
	it("drains preserved follow-ups after the next completed user turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				// The parked blocker turn (Main's `sleep 240`): cancelled by abort.
				() => {
					started.resolve();
					return { content: ["blocking"], delayMs: 60_000 };
				},
				{ content: ["go2 answer"] },
				{ content: ["alpha answer"] },
				{ content: ["beta answer"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		// (1) Slow blocker starts streaming.
		const blocker = session.prompt("blocker");
		await started.promise;
		expect(session.isStreaming).toBe(true);

		// (2) Two follow-ups queue behind it.
		await session.followUp("alpha");
		await session.followUp("beta");
		expect(session.queuedMessageCount).toBe(2);

		// (3) User aborts: the turn unwinds, follow-ups are preserved (user
		// interrupt suppresses auto-resume of the stopped run).
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await blocker.catch(() => {});
		await session.waitForIdle();
		expect(session.agent.hasQueuedMessages()).toBe(true);
		expect(session.queuedMessageCount).toBe(2);

		// (4) A new user prompt runs and completes — the explicit resume point.
		await session.prompt("go2");
		await session.waitForIdle();

		// (5) The stranded follow-ups drain in server order: alpha's turn, then
		// beta's (one-at-a-time follow-up mode).
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(userTurnTexts()).toEqual(["blocker", "go2", "alpha", "beta"]);
	});

	it("drains preserved follow-ups when the aborted turn parked inside a tool call", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const toolStarted = Promise.withResolvers<void>();
		const sleepTool = {
			name: "sleep",
			label: "Sleep",
			description: "Parks until aborted (Main's `sleep 240`)",
			parameters: { type: "object" as const },
			execute: async (_args: unknown, signal?: AbortSignal) => {
				toolStarted.resolve();
				const park = Promise.withResolvers<never>();
				signal?.addEventListener("abort", () => park.reject(new Error("tool aborted")), { once: true });
				return park.promise;
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall" as const, name: "sleep", arguments: {} }] },
				{ content: ["go2 answer"] },
				{ content: ["alpha answer"] },
				{ content: ["beta answer"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			getToolChoice: () => session.nextToolChoiceDirective(),
			initialState: { model, systemPrompt: ["Test"], tools: [sleepTool as never], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([[sleepTool.name, sleepTool as never]]),
		});

		// (1) Blocker turn dispatches the tool and parks inside its execute.
		const blocker = session.prompt("blocker");
		await toolStarted.promise;

		// (2) Two follow-ups queue behind it.
		await session.followUp("alpha");
		await session.followUp("beta");
		expect(session.queuedMessageCount).toBe(2);

		// (3) User aborts mid-tool: turn unwinds, follow-ups preserved.
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await blocker.catch(() => {});
		await session.waitForIdle();
		expect(session.agent.hasQueuedMessages()).toBe(true);

		// (4) A new user prompt runs and completes.
		await session.prompt("go2");
		await session.waitForIdle();

		// (5) The stranded follow-ups must drain in server order.
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(userTurnTexts()).toEqual(["blocker", "go2", "alpha", "beta"]);
	});
});
