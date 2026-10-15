/**
 * Session-owned todo auto-clear, as RPC hosts see it: a settled list leaves the visible
 * state (and stays gone after a reload) while the plan itself is kept, a list the user
 * revealed again is left alone, and a host-set list with nothing durable behind it is dropped.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgTasksTodoClearDelay } from "@oh-my-pi/pi-coding-agent/tools/settings";
import {
	createTodoHudStateData,
	TODO_HUD_STATE_CUSTOM_TYPE,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("session todo auto-clear", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-session-todo-clear-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	afterAll(() => {
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function createSession(sessionManager?: SessionManager): { session: AgentSession; cleared: () => number } {
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: sessionManager ?? SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		sessions.push(session);
		cfgTasksTodoClearDelay.override(session.settings, 0);
		let count = 0;
		session.subscribe(event => {
			if (event.type === "todo_auto_clear") count++;
		});
		return { session, cleared: () => count };
	}

	/** Let a pending dismissal (which waits on message persistence) finish. */
	async function settle(session: AgentSession): Promise<void> {
		await session.settleInFlightMessagePersistence();
		await Bun.sleep(0);
		await session.sessionManager.flush();
	}

	const done = (): TodoPhase[] => [{ name: "Done", tasks: [{ content: "ship", status: "completed" }] }];

	it("hides a settled plan from clients, across reloads, without losing it", async () => {
		const { session, cleared } = createSession();
		// A session file is written once it holds an assistant reply.
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Finished the plan." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		session.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: done() });
		session.setTodoPhases(done());
		await settle(session);

		expect(cleared()).toBe(1);
		expect(session.getVisibleTodoPhases()).toEqual([]);
		expect(session.getTodoPhases()).toEqual(done());

		const file = session.sessionManager.getSessionFile()!;
		const reopened = createSession(await SessionManager.open(file));
		reopened.session.setTodoPhases(done());
		await settle(reopened.session);
		expect(reopened.session.getVisibleTodoPhases()).toEqual([]);
		expect(reopened.session.getTodoPhases()).toEqual(done());
		// Already dismissed: no second record.
		expect(
			reopened.session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === TODO_HUD_STATE_CUSTOM_TYPE),
		).toHaveLength(1);
	});

	it("leaves a plan the user revealed again on screen", async () => {
		const { session, cleared } = createSession();
		session.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: done() });
		const revealed = createTodoHudStateData(session.sessionManager.getBranch(), done(), "revealed");
		session.sessionManager.appendCustomEntry(TODO_HUD_STATE_CUSTOM_TYPE, revealed);
		session.setTodoPhases(done());
		await settle(session);

		expect(cleared()).toBe(0);
		expect(session.getVisibleTodoPhases()).toEqual(done());
	});

	it("drops a host-set settled list that has no durable snapshot to reveal later", async () => {
		const { session, cleared } = createSession();
		session.setTodoPhases(done());
		await settle(session);

		expect(cleared()).toBe(1);
		expect(session.getTodoPhases()).toEqual([]);
	});

	it("keeps an unfinished plan visible", async () => {
		const { session, cleared } = createSession();
		const unfinished: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "ship", status: "completed" },
					{ content: "test", status: "in_progress" },
				],
			},
		];
		session.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: unfinished });
		session.setTodoPhases(unfinished);
		await settle(session);

		expect(cleared()).toBe(0);
		expect(session.getVisibleTodoPhases()).toEqual(unfinished);
	});
});
