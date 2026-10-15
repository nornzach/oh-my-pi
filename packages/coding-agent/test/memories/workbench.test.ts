import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildMemoryToolDeveloperInstructions,
	editMemoryList,
	getMemoryActivity,
	getMemoryRoot,
	type MemoryActivity,
	readMemoryList,
	runMemoryUpdate,
} from "@oh-my-pi/pi-coding-agent/memories";
import {
	claimStage1Jobs,
	closeMemoryDb,
	eraseProjectMemory,
	forgetMemorySource,
	listStage1OutputsForGlobal,
	markStage1SucceededNoOutput,
	markStage1SucceededWithOutput,
	openMemoryDb,
	restoreMemorySource,
	type Stage1Claim,
	upsertThreads,
} from "@oh-my-pi/pi-coding-agent/memories/storage";
import { readMemoryOverview } from "@oh-my-pi/pi-coding-agent/memories/workbench";
import { getAgentDbPath, TempDir } from "@oh-my-pi/pi-utils";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const stage1Reply = (threadId: string) =>
	reply(
		JSON.stringify({ raw_memory: `raw ${threadId}`, rollout_summary: `summary ${threadId}`, rollout_slug: threadId }),
	);
const consolidationReply = () =>
	reply(JSON.stringify({ memory_md: "# Memory\n\nbody", memory_summary: "Consolidated summary", skills: [] }));

/** Claims everything eligible right now, as a startup pass would. */
function claimAll(db: Database, cwd?: string) {
	return claimStage1Jobs(db, {
		nowSec: NOW,
		threadScanLimit: 100,
		maxRolloutsPerStartup: 100,
		maxRolloutAgeDays: 30,
		minRolloutIdleHours: 0,
		leaseSeconds: 60,
		runningConcurrencyCap: 100,
		workerId: "test",
		cwd,
	});
}

function thread(id: string, cwd: string, updatedAt = NOW - 3_600) {
	return { id, updatedAt, rolloutPath: `/sessions/${id}.jsonl`, cwd, sourceKind: "cli" };
}

/** Read every eligible session of `cwd`, recording whether each produced something to keep. */
function readThreads(db: Database, cwd: string, outputs: Record<string, boolean>) {
	const claims = claimAll(db, cwd);
	expect(claims.map(claim => claim.threadId).sort()).toEqual(Object.keys(outputs).sort());
	for (const claim of claims) recordRead(db, claim, cwd, outputs[claim.threadId]);
}

function recordRead(db: Database, claim: Stage1Claim, cwd: string, output: boolean) {
	const { threadId } = claim;
	const done = { threadId, ownershipToken: claim.ownershipToken, sourceUpdatedAt: claim.sourceUpdatedAt, cwd };
	if (output) {
		markStage1SucceededWithOutput(db, {
			...done,
			rawMemory: `raw ${threadId}`,
			rolloutSummary: `summary ${threadId}`,
			rolloutSlug: threadId,
			nowSec: NOW,
		});
	} else {
		markStage1SucceededNoOutput(db, { ...done, nowSec: NOW });
	}
}

describe("memory workbench", () => {
	let tempDir: TempDir;
	let agentDir: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@test-memory-workbench-");
		agentDir = tempDir.path();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await Bun.sleep(0);
		await tempDir.remove().catch(() => {});
	});

	test("the user's notes lead the injected memory, and lists are cut at whole bullets", async () => {
		const settings = Settings.isolated({ "memory.backend": "local", "memories.summaryInjectionTokenLimit": 60 });
		const root = getMemoryRoot(agentDir, settings.getCwd());
		await Bun.write(path.join(root, "notes.md"), "- Always run bun check before pushing\n");
		await Bun.write(path.join(root, "memory_summary.md"), "Summary of the project.");
		// Newest first; only the first fits after notes and summary take their share.
		await Bun.write(
			path.join(root, "learned.md"),
			`- newest lesson ${"n".repeat(100)}\n- older lesson ${"o".repeat(100)}\n- oldest lesson ${"x".repeat(100)}\n`,
		);

		const prompt = await buildMemoryToolDeveloperInstructions(agentDir, settings);
		expect(prompt).toBeDefined();
		const text = prompt as string;
		expect(text.indexOf("Always run bun check")).toBeLessThan(text.indexOf("Summary of the project."));
		expect(text).toContain("newest lesson");
		expect(text).not.toContain("older lesson");
		expect(text).not.toContain("oldest lesson");
		expect(text).not.toContain("...[truncated]...");
	});

	test("note and lesson edits name an entry by its stored line and refuse stale ones", async () => {
		const cwd = "/work/project";
		const root = getMemoryRoot(agentDir, cwd);

		const added = await editMemoryList(agentDir, cwd, "notes", { action: "add", text: "Use  pnpm\tnot npm" });
		expect(added).toEqual({ ok: true, line: "- Use pnpm not npm" });
		expect(await editMemoryList(agentDir, cwd, "notes", { action: "add", text: "   " })).toEqual({
			ok: false,
			reason: "empty",
		});

		const updated = await editMemoryList(agentDir, cwd, "notes", {
			action: "update",
			line: "- Use pnpm not npm",
			text: "Use bun, not npm",
		});
		expect(updated).toEqual({ ok: true, line: "- Use bun, not npm" });
		// A second window still holding the old line must not overwrite the newer text.
		expect(
			await editMemoryList(agentDir, cwd, "notes", { action: "update", line: "- Use pnpm not npm", text: "x" }),
		).toEqual({ ok: false, reason: "not_found" });

		await Bun.write(path.join(root, "learned.md"), "- keep A _(context: from review)_\n- keep B\n");
		// Rewriting A into B's text leaves one B, where A stood.
		await editMemoryList(agentDir, cwd, "lessons", {
			action: "update",
			line: "- keep A _(context: from review)_",
			text: "keep B",
		});
		expect((await readMemoryList(root, "lessons")).map(entry => entry.line)).toEqual(["- keep B"]);

		await editMemoryList(agentDir, cwd, "notes", { action: "delete", line: "- Use bun, not npm" });
		expect(await Bun.file(path.join(root, "notes.md")).exists()).toBe(false);
	});

	test("a forgotten session stays out of memory, even after it changes, until restored", () => {
		const db = openMemoryDb(getAgentDbPath(agentDir));
		try {
			upsertThreads(db, [thread("a", "/p"), thread("b", "/p")]);
			readThreads(db, "/p", { a: true, b: true });

			forgetMemorySource(db, { threadId: "a", cwd: "/p", nowSec: NOW });
			expect(listStage1OutputsForGlobal(db, 10, "/p").map(row => row.threadId)).toEqual(["b"]);
			upsertThreads(db, [thread("a", "/p", NOW - 60)]);
			expect(claimAll(db).map(claim => claim.threadId)).toEqual([]);

			// Restoring reads it again even though it has not changed since it was last read.
			readThreads(db, "/p", {});
			upsertThreads(db, [thread("b", "/p")]);
			forgetMemorySource(db, { threadId: "b", cwd: "/p", nowSec: NOW });
			restoreMemorySource(db, "b");
			expect(claimAll(db).map(claim => claim.threadId)).toEqual(["b"]);
		} finally {
			closeMemoryDb(db);
		}
	});

	test("erasing a project clears only it, and its existing sessions are not read again", () => {
		const db = openMemoryDb(getAgentDbPath(agentDir));
		try {
			upsertThreads(db, [thread("x1", "/x"), thread("y1", "/y")]);
			readThreads(db, "/x", { x1: true });
			readThreads(db, "/y", { y1: true });

			eraseProjectMemory(db, { cwd: "/x", threadIds: ["x1"], nowSec: NOW });
			expect(listStage1OutputsForGlobal(db, 10, "/x")).toEqual([]);
			expect(listStage1OutputsForGlobal(db, 10, "/y").map(row => row.threadId)).toEqual(["y1"]);

			upsertThreads(db, [thread("x1", "/x"), thread("x2", "/x")]);
			expect(claimAll(db, "/x").map(claim => claim.threadId)).toEqual(["x2"]);
		} finally {
			closeMemoryDb(db);
		}
	});

	test("the overview reports where each session stands", async () => {
		const cwd = "/work/app";
		const sessionDir = path.join(agentDir, "sessions", "app");
		const settings = Settings.isolated({ "memory.backend": "local", "memories.minRolloutIdleHours": 12 });
		const write = async (id: string, ageSec: number, title?: string) => {
			const file = path.join(sessionDir, `${id}.jsonl`);
			const lines = [
				...(title ? [JSON.stringify({ type: "title", v: 1, title })] : []),
				JSON.stringify({ type: "session", id, cwd }),
			];
			await Bun.write(file, `${lines.join("\n")}\n`);
			const at = new Date((NOW - ageSec) * 1000);
			await fs.utimes(file, at, at);
			return { id, updatedAt: NOW - ageSec, rolloutPath: file, cwd, sourceKind: "cli" };
		};
		const kept = await write("kept", 2 * DAY, "Fix the login bug");
		const empty = await write("empty", 2 * DAY);
		const gone = await write("gone", 2 * DAY);
		await write("fresh", 60);
		await write("queued", 2 * DAY);
		await write("ancient", 40 * DAY);

		const db = openMemoryDb(getAgentDbPath(agentDir));
		try {
			upsertThreads(db, [kept, empty, gone]);
			readThreads(db, cwd, { kept: true, empty: false, gone: true });
			forgetMemorySource(db, { threadId: "gone", cwd, nowSec: NOW });
		} finally {
			closeMemoryDb(db);
		}

		const overview = await readMemoryOverview({ agentDir, settings, scope: { cwd, sessionDir } });
		const states = Object.fromEntries(overview.sources.map(source => [source.threadId, source.state]));
		expect(states).toEqual({
			kept: "remembered",
			empty: "nothing",
			gone: "forgotten",
			fresh: "waiting",
			queued: "queued",
			ancient: "old",
		});
		const remembered = overview.sources.find(source => source.threadId === "kept");
		expect(remembered?.title).toBe("Fix the login bug");
		expect(remembered?.summary).toBe("summary kept");
		expect(overview.consolidation.pending).toBe(true);
	});

	test("a host update reads every waiting session of its project, batch after batch", async () => {
		const project = "/work/target";
		const sessionDir = path.join(agentDir, "sessions", "target");
		const ids = ["t1", "t2", "t3", "t4", "t5"];
		for (const id of ids) {
			await Bun.write(
				path.join(sessionDir, `${id}.jsonl`),
				`${JSON.stringify({ type: "session", id, cwd: project })}\n${JSON.stringify({ type: "message", message: { role: "user", content: `work ${id}` } })}\n`,
			);
		}
		// Another project's waiting session must not be read by this project's update.
		const db = openMemoryDb(getAgentDbPath(agentDir));
		upsertThreads(db, [thread("other", "/work/other")]);
		closeMemoryDb(db);

		const settings = Settings.isolated({
			"memory.backend": "local",
			"memories.stage1Concurrency": 2,
			"memories.minRolloutIdleHours": 12,
		});
		const model = { provider: "openai", id: "test-model", name: "test-model", contextWindow: 32_000 } as Model;
		const session = {
			sessionManager: {
				getSessionFile: () => path.join(agentDir, "current.jsonl"),
				getSessionDir: () => path.join(agentDir, "sessions", "home"),
				getSessionId: () => "current",
				getCwd: () => "/work/home",
			},
			settings,
			model,
			refreshBaseSystemPrompt: vi.fn(async () => {}),
		};
		const modelRegistry = {
			find: () => model,
			getAll: () => [model],
			getApiKey: async () => "key",
			resolver: () => async () => "key",
		};

		const read: string[] = [];
		let firstSeen: MemoryActivity | undefined;
		vi.spyOn(ai, "completeSimple").mockImplementation((async (_model: Model, context: ai.Context) => {
			const input = context.messages[0]?.content;
			const text = Array.isArray(input) && input[0]?.type === "text" ? input[0].text : "";
			const id = ids.find(candidate => text.includes(`work ${candidate}`));
			if (!id) return consolidationReply();
			firstSeen ??= { ...(getMemoryActivity(project) as MemoryActivity) };
			read.push(id);
			return stage1Reply(id);
		}) as typeof ai.completeSimple);

		await runMemoryUpdate({
			session: session as never,
			settings,
			modelRegistry: modelRegistry as never,
			agentDir,
			scope: { cwd: project, sessionDir },
			minIdleMinutes: 0,
			signal: new AbortController().signal,
		});

		expect(read.sort()).toEqual(ids);
		expect(firstSeen).toEqual({ phase: "reading", done: 0, total: 5 });
		expect(getMemoryActivity(project)).toBeUndefined();
		expect(await Bun.file(path.join(getMemoryRoot(agentDir, project), "memory_summary.md")).text()).toBe(
			"Consolidated summary\n",
		);
	});
});
