import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	applyRpcGetQueue,
	applyRpcQueueClear,
	applyRpcQueueMove,
	applyRpcQueueRemove,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-queue";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Contract tests for the queue-management RPC commands (get_queue /
 * queue_remove / queue_move / queue_clear). Pins the wire shapes and the
 * displayability contract: only user-restorable entries are listed and
 * cleared — advisor cards, hidden companions, and internal steers are
 * excluded from get_queue and survive queue_clear (mirroring the default
 * AgentSession.clearQueue filtering). Ids are stable per entry, never array
 * indices.
 */

let tempDir: TempDir;
let authStorage: AuthStorage | undefined;
let session: AgentSession;

beforeEach(async () => {
	tempDir = TempDir.createSync("@pi-rpc-queue-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({ "compaction.enabled": false });

	const mock = createMockModel({ handler: () => ({ content: ["done"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry: new Map(),
	});
});

afterEach(async () => {
	await session.dispose();
	authStorage?.close();
	authStorage = undefined;
	tempDir.removeSync();
});

/** The shape AgentSession#queueUserMessage enqueues for a user steer/follow-up. */
function userQueued(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, attribution: "user", timestamp };
}

function advisorCard(timestamp: number): AgentMessage {
	return {
		role: "custom",
		customType: "advisor",
		content: "advisor note",
		display: true,
		attribution: "agent",
		timestamp,
	} as AgentMessage;
}

/** Hidden companion of a user prompt (magic-keyword notice family). */
function hiddenUserCompanion(timestamp: number): AgentMessage {
	return {
		role: "custom",
		customType: "ultrathink-notice",
		content: "notice",
		display: false,
		attribution: "user",
		timestamp,
	} as AgentMessage;
}

/** Hidden agent-authored internal steer (goal/plan context family). */
function hiddenInternalSteer(timestamp: number): AgentMessage {
	return {
		role: "custom",
		customType: "goal-mode-context",
		content: "internal",
		display: false,
		attribution: "agent",
		timestamp,
	} as AgentMessage;
}

describe("applyRpcGetQueue", () => {
	it("lists both lanes in insertion order with stable ids, text, and timestamps", () => {
		session.agent.steer(userQueued("steer me", 100));
		session.agent.followUp(userQueued("later", 200));
		session.agent.steer(userQueued("steer again", 300));

		expect(applyRpcGetQueue(session)).toEqual({
			steering: [
				{ id: "s1", text: "steer me", timestamp: 100 },
				{ id: "s3", text: "steer again", timestamp: 300 },
			],
			followUp: [{ id: "f2", text: "later", timestamp: 200 }],
		});
	});

	it("excludes advisor cards, hidden companions, and internal steers", () => {
		session.agent.steer(advisorCard(10));
		session.agent.steer(hiddenInternalSteer(20));
		session.agent.steer(userQueued("visible steer", 30));
		session.agent.followUp(hiddenUserCompanion(40));
		session.agent.followUp(userQueued("visible follow-up", 50));

		const queue = applyRpcGetQueue(session);
		expect(queue.steering.map(entry => entry.text)).toEqual(["visible steer"]);
		expect(queue.followUp.map(entry => entry.text)).toEqual(["visible follow-up"]);
		// The hidden/agent-authored entries stay queued server-side.
		expect(session.agent.peekSteeringQueue()).toHaveLength(3);
		expect(session.agent.peekFollowUpQueue()).toHaveLength(2);
	});

	it("keeps ids stable across session-style queue filtering", () => {
		session.agent.steer(userQueued("keep one", 1));
		const card = advisorCard(2);
		session.agent.steer(card);
		session.agent.steer(userQueued("keep two", 3));
		const before = applyRpcGetQueue(session).steering.map(entry => entry.id);

		// #extractQueuedAdvisorCards-style reinsertion of survivors by reference.
		session.agent.replaceQueues(
			session.agent.peekSteeringQueue().filter(message => message !== card),
			[...session.agent.peekFollowUpQueue()],
		);

		expect(applyRpcGetQueue(session).steering.map(entry => entry.id)).toEqual(before);
	});
});

describe("applyRpcQueueRemove", () => {
	it("removes exactly the addressed entry from its lane", () => {
		session.agent.steer(userQueued("drop me", 1));
		session.agent.steer(userQueued("keep me", 2));
		session.agent.followUp(userQueued("untouched", 3));
		const target = applyRpcGetQueue(session).steering[0];

		expect(applyRpcQueueRemove(session, target.id)).toEqual({ removed: true });

		const queue = applyRpcGetQueue(session);
		expect(queue.steering.map(entry => entry.text)).toEqual(["keep me"]);
		expect(queue.followUp.map(entry => entry.text)).toEqual(["untouched"]);
	});

	it("throws on an unknown id (wire: error response)", () => {
		session.agent.steer(userQueued("real", 1));
		expect(() => applyRpcQueueRemove(session, "s999")).toThrow("Unknown queued message id: s999");
		// A consumed id is equally unknown on the second attempt.
		const [{ id }] = applyRpcGetQueue(session).steering;
		applyRpcQueueRemove(session, id);
		expect(() => applyRpcQueueRemove(session, id)).toThrow(`Unknown queued message id: ${id}`);
	});
});

describe("applyRpcQueueMove", () => {
	it("reorders within the entry's own lane and returns the final index", () => {
		session.agent.followUp(userQueued("a", 1));
		session.agent.followUp(userQueued("b", 2));
		session.agent.followUp(userQueued("c", 3));
		session.agent.steer(userQueued("other lane", 4));
		const [a, , c] = applyRpcGetQueue(session).followUp;

		expect(applyRpcQueueMove(session, c.id, 0)).toEqual({ lane: "followUp", index: 0 });
		expect(applyRpcGetQueue(session).followUp.map(entry => entry.text)).toEqual(["c", "a", "b"]);

		// toIndex clamps into the post-removal range instead of erroring.
		expect(applyRpcQueueMove(session, a.id, 99)).toEqual({ lane: "followUp", index: 2 });
		expect(applyRpcGetQueue(session).followUp.map(entry => entry.text)).toEqual(["c", "b", "a"]);

		// The untouched lane keeps its order.
		expect(applyRpcGetQueue(session).steering.map(entry => entry.text)).toEqual(["other lane"]);
	});

	it("throws on an unknown id", () => {
		expect(() => applyRpcQueueMove(session, "f999", 0)).toThrow("Unknown queued message id: f999");
	});
});

describe("applyRpcQueueClear", () => {
	it("clears both lanes when no lane is given and reports user-restorable removals", () => {
		session.agent.steer(userQueued("steer", 1));
		session.agent.steer(advisorCard(2));
		session.agent.followUp(hiddenUserCompanion(3));
		session.agent.followUp(userQueued("follow-up", 4));
		session.agent.followUp(hiddenInternalSteer(5));

		expect(applyRpcQueueClear(session)).toEqual({ removed: 2 });

		expect(applyRpcGetQueue(session)).toEqual({ steering: [], followUp: [] });
		// Advisor cards and internal steers survive; the hidden companion rode
		// out with its user message (mirroring clearQueue's keep-filter).
		expect(session.agent.peekSteeringQueue()).toHaveLength(1);
		expect(session.agent.peekFollowUpQueue()).toHaveLength(1);
	});

	it("clears only the addressed lane when lane is given", () => {
		session.agent.steer(userQueued("steer", 1));
		session.agent.followUp(userQueued("follow-up", 2));
		session.agent.followUp(advisorCard(3));

		expect(applyRpcQueueClear(session, "steering")).toEqual({ removed: 1 });

		const queue = applyRpcGetQueue(session);
		expect(queue.steering).toEqual([]);
		expect(queue.followUp.map(entry => entry.text)).toEqual(["follow-up"]);
		// The follow-up lane was not filtered at all: its advisor card survives.
		expect(session.agent.peekFollowUpQueue()).toHaveLength(2);
	});
});

describe("queue_update session event", () => {
	interface QueueSnapshot {
		steering: Array<{ id: string; text: string; timestamp: number }>;
		followUp: Array<{ id: string; text: string; timestamp: number }>;
	}

	/** Subscribe and collect every queue_update payload, in emission order. */
	function collectQueueUpdates(): QueueSnapshot[] {
		const updates: QueueSnapshot[] = [];
		session.subscribe(event => {
			if (event.type === "queue_update") {
				updates.push({ steering: [...event.steering], followUp: [...event.followUp] });
			}
		});
		return updates;
	}

	it("emits an authoritative snapshot on every enqueue", () => {
		const updates = collectQueueUpdates();
		session.agent.steer(userQueued("first", 1));
		session.agent.followUp(userQueued("second", 2));

		expect(updates).toEqual([
			{ steering: [{ id: "s1", text: "first", timestamp: 1 }], followUp: [] },
			{
				steering: [{ id: "s1", text: "first", timestamp: 1 }],
				followUp: [{ id: "f2", text: "second", timestamp: 2 }],
			},
		]);
	});

	it("emits on remove, move, and clear with the post-mutation snapshot", () => {
		session.agent.followUp(userQueued("a", 1));
		session.agent.followUp(userQueued("b", 2));
		const updates = collectQueueUpdates();

		session.removeQueuedMessageById(session.agent.queueEntryId(session.agent.peekFollowUpQueue()[0]) ?? "");
		session.moveQueuedMessageById(session.agent.queueEntryId(session.agent.peekFollowUpQueue()[0]) ?? "", 0);
		session.agent.steer(advisorCard(3));
		session.clearQueuedMessages();

		// remove drops "a"; the move is a no-op reorder of the single survivor;
		// the advisor-card enqueue fires but never appears; clear empties the lane.
		expect(updates).toEqual([
			{ steering: [], followUp: [{ id: "f2", text: "b", timestamp: 2 }] },
			{ steering: [], followUp: [{ id: "f2", text: "b", timestamp: 2 }] },
			{ steering: [], followUp: [{ id: "f2", text: "b", timestamp: 2 }] },
			{ steering: [], followUp: [] },
		]);
		// The advisor card still sits in the agent queue — excluded from snapshots.
		expect(session.agent.peekSteeringQueue()).toHaveLength(1);
	});

	it("emits when the drain consumes queued entries", async () => {
		const updates = collectQueueUpdates();
		session.agent.steer(userQueued("drain me", 1));

		await session.agent.continue();

		expect(updates[0]).toEqual({ steering: [{ id: "s1", text: "drain me", timestamp: 1 }], followUp: [] });
		expect(updates.at(-1)).toEqual({ steering: [], followUp: [] });
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});
});
