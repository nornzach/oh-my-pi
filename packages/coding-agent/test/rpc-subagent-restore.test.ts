import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readPersistedSubagents } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagent-restore";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const tempPaths: string[] = [];

afterEach(() => {
	for (const tempPath of tempPaths.splice(0)) removeSyncWithRetries(tempPath);
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-restore-"));
	tempPaths.push(dir);
	return dir;
}

const at = (second: number) => `2026-10-26T03:39:${String(second).padStart(2, "0")}.000Z`;

function spawned(id: string, index: number, status = "pending") {
	return { index, id, agent: "task", agentSource: "bundled", status, task: `Do ${id}`, assignment: `# Target\n${id}` };
}

/** A task call's result, as the session file stores it. */
function taskResult(callId: string, second: number, details: Record<string, unknown>) {
	return {
		type: "message",
		timestamp: at(second),
		message: { role: "toolResult", toolCallId: callId, toolName: "task", content: [], details },
	};
}

/** The assistant message that made a task call, as the session file stores it. */
function taskCall(callId: string, second: number) {
	return {
		type: "message",
		timestamp: at(second),
		message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "task", arguments: {} }] },
	};
}

/** A session file: header lines, then `entries`, one per line. */
function writeSession(file: string, entries: unknown[]): string {
	const header = [
		{ type: "title", v: 1, title: "" },
		{ type: "session", version: 3, id: path.basename(file) },
	];
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${[...header, ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

describe("readPersistedSubagents", () => {
	test("rebuilds background agents from their spawn and the job reports after it", async () => {
		const dir = tempDir();
		const session = path.join(dir, "main.jsonl");
		writeSession(session, [
			taskResult("call-1", 1, {
				results: [],
				progress: [spawned("Rain", 0), spawned("Field", 1), spawned("Park", 2)],
				async: { state: "running", jobId: "Rain", type: "task" },
			}),
			// `wait` lists the jobs it saw; a later `async-result` delivery settles the rest.
			{
				type: "message",
				timestamp: at(5),
				message: {
					role: "toolResult",
					toolName: "wait",
					details: { jobs: [{ id: "Rain", status: "completed", agentUrlId: "Rain", durationMs: 6498 }] },
				},
			},
			{
				type: "custom_message",
				customType: "async-result",
				timestamp: at(9),
				details: { jobs: [{ jobId: "Field", agentId: "Field", status: "failed", durationMs: 9000 }] },
			},
		]);
		// Its transcript records the model that served it and what it used.
		writeSession(path.join(dir, "main", "Rain.jsonl"), [
			{ type: "model_change", id: "m1", parentId: null, timestamp: at(2), model: "mock/mock-1" },
			{
				type: "message",
				id: "a1",
				parentId: "m1",
				timestamp: at(4),
				message: {
					role: "assistant",
					provider: "mock",
					model: "mock-1",
					stopReason: "stop",
					content: [{ type: "text", text: "Done." }],
					usage: { input: 3000, output: 800, cacheWrite: 0, totalTokens: 3800, cost: { total: 0.25 } },
				},
			},
		]);

		const rows = await readPersistedSubagents(session, 256);

		expect(rows.map(row => [row.id, row.status, row.parentToolCallId])).toEqual([
			["Rain", "completed", "call-1"],
			["Field", "failed", "call-1"],
			// Never reported back: the process that ran it is gone.
			["Park", "aborted", "call-1"],
		]);
		expect(rows[0]).toMatchObject({
			sessionFile: path.join(dir, "main", "Rain.jsonl"),
			assignment: "# Target\nRain",
		});
		expect(rows[0]?.progress).toMatchObject({
			status: "completed",
			durationMs: 6498,
			resolvedModel: "mock/mock-1",
			tokens: 3800,
			cost: 0.25,
		});
		// Its transcript is gone, so there is nothing to open.
		expect(rows[1]?.sessionFile).toBeUndefined();
	});

	test("labels a background agent with the title its transcript was given", async () => {
		const dir = tempDir();
		const session = path.join(dir, "main.jsonl");
		writeSession(session, [
			taskResult("call-1", 1, { results: [], progress: [spawned("Rain", 0)], async: { state: "running" } }),
		]);
		// The executor titles the agent's session once its label lands.
		const child = await SessionManager.open(path.join(dir, "main", "Rain.jsonl"), path.join(dir, "main"));
		child.appendMessage({ role: "user", content: "Map it", timestamp: Date.now() });
		await child.setSessionName("Map the auth surface", "auto", "task-label");
		await child.flush();
		await child.close();

		const [row] = await readPersistedSubagents(session, 256);

		expect(row?.description).toBe("Map the auth surface");
		expect(row?.progress?.description).toBe("Map the auth surface");
	});

	test("takes a blocking call's outcomes and labels from its results", async () => {
		const dir = tempDir();
		const session = path.join(dir, "main.jsonl");
		writeSession(session, [
			taskResult("call-1", 1, {
				results: [
					{ ...spawned("Ok", 0), description: "Write the essay", exitCode: 0, durationMs: 10 },
					{ ...spawned("Stopped", 1), exitCode: 1, aborted: true, durationMs: 10 },
					{ ...spawned("Broke", 2), exitCode: 1, error: "Rate limited", durationMs: 10 },
				],
			}),
		]);

		const rows = await readPersistedSubagents(session, 256);

		expect(rows.map(row => [row.id, row.status, row.description])).toEqual([
			["Ok", "completed", "Write the essay"],
			["Stopped", "aborted", undefined],
			["Broke", "failed", undefined],
		]);
	});

	test("lists the agents an agent spawned under it, after it", async () => {
		const dir = tempDir();
		const session = path.join(dir, "main.jsonl");
		writeSession(session, [taskResult("call-1", 1, { results: [{ ...spawned("Lead", 0), exitCode: 0 }] })]);
		writeSession(path.join(dir, "main", "Lead.jsonl"), [
			taskResult("call-child", 2, { results: [{ ...spawned("Helper", 0), exitCode: 0 }] }),
		]);

		const rows = await readPersistedSubagents(session, 256);

		expect(rows.map(row => [row.id, row.parentSubagentId, row.parentToolCallId])).toEqual([
			["Lead", undefined, "call-1"],
			["Helper", "Lead", "call-child"],
		]);
	});
});

describe("RpcSubagentRegistry saved agents", () => {
	function lifecycle(bus: EventBus, id: string, status: "started" | "completed", callId: string) {
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status,
			parentToolCallId: callId,
		});
	}

	test("a session opened in a new process lists its earlier agents and reads their transcripts", async () => {
		const dir = tempDir();
		const session = path.join(dir, "main.jsonl");
		writeSession(session, [taskResult("call-1", 1, { results: [{ ...spawned("Rain", 0), exitCode: 0 }] })]);
		const transcript = writeSession(path.join(dir, "main", "Rain.jsonl"), []);
		const registry = new RpcSubagentRegistry(
			new EventBus(),
			() => {},
			() => session,
		);

		expect(() => registry.resolveSessionFile({ subagentId: "Rain" })).toThrow();
		await registry.restorePersisted();

		expect(registry.getSubagents().map(row => [row.id, row.status])).toEqual([["Rain", "completed"]]);
		expect(registry.resolveSessionFile({ subagentId: "Rain" })).toBe(transcript);
	});

	test("lists saved agents in spawn order, timed by the call that spawned them", async () => {
		const dir = tempDir();
		const session = path.join(dir, "main.jsonl");
		// Two blocking calls, two agents each; a call's result is saved only once its agents finish.
		writeSession(session, [
			taskCall("call-1", 1),
			taskResult("call-1", 9, {
				results: [
					{ ...spawned("Lead", 0), exitCode: 0 },
					{ ...spawned("Kit", 1), exitCode: 0 },
				],
			}),
			taskCall("call-2", 10),
			taskResult("call-2", 12, {
				results: [
					{ ...spawned("Bay", 0), exitCode: 0 },
					{ ...spawned("Ash", 1), exitCode: 0 },
				],
			}),
		]);
		const registry = new RpcSubagentRegistry(
			new EventBus(),
			() => {},
			() => session,
		);

		await registry.restorePersisted();

		expect(registry.getSubagents().map(row => [row.id, row.spawnedAt])).toEqual([
			["Lead", Date.parse(at(1))],
			["Kit", Date.parse(at(1))],
			["Bay", Date.parse(at(10))],
			["Ash", Date.parse(at(10))],
		]);
	});

	test("keeps what this process saw over the saved row, and drops the old session's rows on a switch", async () => {
		const dir = tempDir();
		const first = path.join(dir, "first.jsonl");
		const second = path.join(dir, "second.jsonl");
		writeSession(first, [taskResult("call-1", 1, { results: [{ ...spawned("Rain", 0), exitCode: 0 }] })]);
		writeSession(second, [taskResult("call-2", 1, { results: [{ ...spawned("Snow", 0), exitCode: 0 }] })]);
		let current = first;
		const bus = new EventBus();
		const registry = new RpcSubagentRegistry(
			bus,
			() => {},
			() => current,
		);
		// Revived in this process: running, not the saved "completed".
		lifecycle(bus, "Rain", "started", "call-1");

		await registry.restorePersisted();
		expect(registry.getSubagents().map(row => [row.id, row.status])).toEqual([["Rain", "running"]]);

		current = second;
		registry.clear();
		await registry.restorePersisted();
		expect(registry.getSubagents().map(row => row.id)).toEqual(["Snow"]);
	});
});
