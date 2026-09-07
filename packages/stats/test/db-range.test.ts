import { describe, expect, it } from "bun:test";
import { getDashboardStats, getFolderStats, getRequestPage } from "@oh-my-pi/omp-stats/aggregator";
import { initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { FolderStats, MessageStats } from "@oh-my-pi/omp-stats/types";
import { handleApi } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-db-range-");

function makeMessage(timestamp: number, entryId: string, folder = "/tmp/project"): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder,
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		agentType: "main",
	};
}

async function readFolderStats(response: Response): Promise<FolderStats[]> {
	expect(response.status).toBe(200);
	return response.json() as Promise<FolderStats[]>;
}

describe("getDashboardStats time range", () => {
	it("filters dashboard stats by selected range", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([makeMessage(now, "within-24h"), makeMessage(now - 48 * 60 * 60 * 1000, "outside-24h")]);

		const dayStats = await getDashboardStats("24h");
		expect(dayStats.overall.totalRequests).toBe(1);
		expect(dayStats.byModel[0]).toMatchObject({
			totalRequests: 1,
			model: "gpt-5.4",
			provider: "openai-codex",
		});

		const weekStats = await getDashboardStats("7d");
		expect(weekStats.overall.totalRequests).toBe(2);
		expect(weekStats.byModel[0]).toMatchObject({ totalRequests: 2, model: "gpt-5.4", provider: "openai-codex" });

		const allStats = await getDashboardStats("all");
		expect(allStats.overall.totalRequests).toBe(2);
	});

	it("counts cache writes in the cache hit denominator", async () => {
		await initDb();

		const message = makeMessage(Date.now(), "cache-write");
		message.usage.input = 100;
		message.usage.output = 0;
		message.usage.cacheRead = 300;
		message.usage.cacheWrite = 100;
		message.usage.totalTokens = 500;
		insertMessageStats([message]);

		const stats = await getDashboardStats("all");
		expect(stats.overall.cacheRate).toBeCloseTo(0.6);
		expect(stats.byModel[0]?.cacheRate).toBeCloseTo(0.6);
	});

	it("falls back to 24h for unknown range", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([makeMessage(now, "within-24h"), makeMessage(now - 48 * 60 * 60 * 1000, "outside-24h")]);

		const stats = await getDashboardStats("last century");
		expect(stats.overall.totalRequests).toBe(1);
	});

	it("filters dedicated folder stats by selected range", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([
			makeMessage(now, "folder-within-24h", "/tmp/current-project"),
			makeMessage(now - 48 * 60 * 60 * 1000, "folder-outside-24h", "/tmp/older-project"),
		]);

		const dayStats = await getFolderStats("24h");
		expect(dayStats).toEqual([expect.objectContaining({ folder: "/tmp/current-project", totalRequests: 1 })]);

		const allStats = await getFolderStats("all");
		expect(allStats).toHaveLength(2);
		expect(allStats).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ folder: "/tmp/current-project", totalRequests: 1 }),
				expect.objectContaining({ folder: "/tmp/older-project", totalRequests: 1 }),
			]),
		);
	});

	it("returns range-filtered folder stats through the HTTP API", async () => {
		const db = await initDb();

		const now = Date.now();
		insertMessageStats([
			makeMessage(now, "api-folder-within-24h", "/tmp/current-project"),
			makeMessage(now - 48 * 60 * 60 * 1000, "api-folder-outside-24h", "/tmp/older-project"),
		]);

		// The legacy dashboard path reads this in getStatsByAgentType; the folder query does not.
		db.run("DROP INDEX idx_messages_timestamp_agent_type");
		db.run("ALTER TABLE messages DROP COLUMN agent_type");

		const folders = await readFolderStats(
			await handleApi(new Request("http://stats.test/api/stats/folders?range=24h")),
		);
		expect(folders).toEqual([expect.objectContaining({ folder: "/tmp/current-project", totalRequests: 1 })]);
	});
});

it("pages past 200 equal-timestamp requests without repeats and excludes rows indexed after the first page", async () => {
	await initDb();
	const timestamp = Date.now() - 1000;
	insertMessageStats(Array.from({ length: 237 }, (_, index) => makeMessage(timestamp, `page-${index}`)));
	insertMessageStats([makeMessage(timestamp - 48 * 60 * 60 * 1000, "out-of-range")]);
	let page = await getRequestPage("24h", 25);
	const ids = page.rows.map(row => row.entryId);
	insertMessageStats([makeMessage(timestamp - 1, "late-indexed")]);
	while (page.nextCursor) {
		page = await getRequestPage("24h", 25, page.nextCursor);
		expect(page.total).toBe(237);
		ids.push(...page.rows.map(row => row.entryId));
	}
	expect(ids).toEqual(Array.from({ length: 237 }, (_, index) => `page-${236 - index}`));
	const refreshed = await getRequestPage("all", 200);
	expect(refreshed.total).toBe(239);
});

it("rejects malformed paging parameters with HTTP 400 and keeps the legacy endpoint array", async () => {
	for (const query of ["limit=-1", "limit=201", "limit=NaN", "cursor=broken", "range=unknown"]) {
		const response = await handleApi(new Request(`http://localhost/api/stats/requests?${query}`));
		expect(response.status).toBe(400);
	}
	await initDb();
	insertMessageStats([makeMessage(Date.now(), "legacy")]);
	const response = await handleApi(new Request("http://localhost/api/stats/recent?limit=1"));
	const rows = (await response.json()) as MessageStats[];
	expect(rows.map(row => row.entryId)).toEqual(["legacy"]);
});
