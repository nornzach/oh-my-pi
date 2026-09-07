import { describe, expect, test } from "bun:test";
import {
	buildRpcActiveTools,
	buildRpcContextReport,
	buildRpcJobs,
	shareRpcSession,
	previewRpcShareSession,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-reports";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionEntry } from "../src/session/session-entries";

/**
 * Contract tests for the report-dialog RPC builders (get_context_report,
 * get_active_tools, share_session, get_jobs): each must mirror its TUI
 * slash-command twin's data source and the pinned wire shape.
 */

function messageEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-06-12T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	} as unknown as SessionEntry;
}

/** Incompressible filler so gzip cannot absorb the payload. */
function randomHex(words: number): string {
	return Array.from(crypto.getRandomValues(new Uint32Array(words)), v => v.toString(16)).join("");
}

describe("buildRpcContextReport", () => {
	test("passes the session breakdown through as-is with window and model header", () => {
		const breakdown = {
			contextWindow: 200_000,
			anchored: true,
			usedTokens: 50_000,
			systemPromptTokens: 10_000,
			systemToolsTokens: 5_000,
			systemContextTokens: 1_000,
			skillsTokens: 2_000,
			messagesTokens: 32_000,
		};
		const session = {
			getContextBreakdown: () => breakdown,
			model: { id: "test-model", contextWindow: 200_000 },
		} as unknown as AgentSession;

		const report = buildRpcContextReport(session);

		expect(report.breakdown).toBe(breakdown);
		expect(report.contextWindow).toBe(200_000);
		expect(report.model).toBe("test-model");
	});

	test("falls back to the model window and reports the unavailable state without a model", () => {
		const fromModel = buildRpcContextReport({
			getContextBreakdown: () => undefined,
			model: { id: "m", contextWindow: 128_000 },
		} as unknown as AgentSession);
		expect(fromModel).toEqual({ breakdown: undefined, contextWindow: 128_000, model: "m" });

		const noModel = buildRpcContextReport({
			getContextBreakdown: () => undefined,
			model: undefined,
		} as unknown as AgentSession);
		expect(noModel).toEqual({ breakdown: undefined, contextWindow: 0, model: "" });
	});
});

describe("buildRpcActiveTools", () => {
	test("maps active tools with descriptions and classifies source from the registry", () => {
		const session = {
			agent: {
				state: {
					tools: [
						{ name: "read", description: "Read files" },
						{ name: "mcp__docs_search", description: "Search docs" },
						{ name: "my_custom", description: "Custom tool" },
					],
				},
			},
			hasBuiltInTool: (name: string) => name === "read",
			getXdevToolEntries: () => [{ name: "mcp__db_query", summary: "DB device" }],
		} as unknown as AgentSession;

		const { tools } = buildRpcActiveTools(session);

		expect(tools).toEqual([
			{ name: "read", description: "Read files", source: "builtin" },
			{ name: "mcp__docs_search", description: "Search docs", source: "mcp" },
			{ name: "my_custom", description: "Custom tool", source: "extension" },
			// xd:// mounts follow the active set, same source classification.
			{ name: "mcp__db_query", description: "DB device", source: "mcp" },
		]);
	});
});

describe("buildRpcJobs", () => {
	test("concatenates running then recent, items as-is", () => {
		const running: AsyncJobSnapshotItem[] = [
			{ id: "j1", type: "bash", status: "running", label: "npm test", startTime: 100 },
		];
		const recent: AsyncJobSnapshotItem[] = [
			{ id: "j2", type: "task", status: "completed", label: "scout", startTime: 50 },
		];
		const session = {
			getAsyncJobSnapshot: () => ({ running, recent, delivery: {} }),
		} as unknown as AgentSession;

		const { jobs } = buildRpcJobs(session);

		expect(jobs).toEqual([...running, ...recent]);
		expect(jobs[0]).toBe(running[0]);
		expect(jobs[1]).toBe(recent[0]);
	});

	test("empty list when the session has no job registry", () => {
		const session = { getAsyncJobSnapshot: () => null } as unknown as AgentSession;
		expect(buildRpcJobs(session)).toEqual({ jobs: [] });
	});
});

describe("shareRpcSession", () => {
	function stubSession(entries: SessionEntry[], serverUrl: string): AgentSession {
		return {
			sessionManager: {
				getHeader: () => ({
					type: "session",
					version: 3,
					id: "t",
					timestamp: "2026-06-12T00:00:00.000Z",
					cwd: "/tmp",
				}),
				getEntries: () => entries,
				getLeafId: () => entries[entries.length - 1]?.id ?? "leaf",
			} as unknown as SessionManager,
			settings: {
				get: (path: string) => (path === "share.serverUrl" ? serverUrl : undefined),
			},
			state: undefined,
			obfuscator: undefined,
		} as unknown as AgentSession;
	}

	function shareServer(): { base: string; stop(): void } {
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return new Response("nope", { status: 405 });
				await req.arrayBuffer();
				return Response.json({ id: "blobshareid01" });
			},
		});
		return { base: `http://localhost:${server.port}`, stop: () => server.stop(true) };
	}

	test("local preview does not upload and stale snapshots cannot upload", async () => {
		let uploads = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				await req.arrayBuffer();
				uploads++;
				return Response.json({ id: "confirmed01" });
			},
		});
		try {
			const entries = [messageEntry("e1", null, "original conversation")];
			const session = stubSession(entries, `http://localhost:${server.port}`);
			const preview = previewRpcShareSession(session);
			expect(uploads).toBe(0);
			entries.push(messageEntry("e2", "e1", "new private message"));
			await expect(shareRpcSession(session, preview.snapshotId)).rejects.toThrow("Refresh the local preview");
			expect(uploads).toBe(0);
			const updated = previewRpcShareSession(session);
			await shareRpcSession(session, updated.snapshotId);
			expect(uploads).toBe(1);
		} finally {
			server.stop(true);
		}
	});

	test("the confirmed size-limited preview equals the decrypted uploaded payload", async () => {
		let payload = new Uint8Array(new ArrayBuffer(0));
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				payload = new Uint8Array(await request.arrayBuffer());
				return Response.json({ id: "previewbytes01" });
			},
		});
		try {
			const sourceText = randomHex(1_000_000);
			const session = stubSession([messageEntry("e1", null, sourceText)], `http://localhost:${server.port}`);
			const preview = previewRpcShareSession(session);
			expect(preview.truncated).toBe(true);
			expect(payload.byteLength).toBe(0);
			const result = await shareRpcSession(session, preview.snapshotId);
			const key = await crypto.subtle.importKey(
				"raw",
				Buffer.from(result.url.split("#")[1]!, "base64url"),
				"AES-GCM",
				false,
				["decrypt"],
			);
			const plain = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: payload.subarray(0, 12) },
				key,
				payload.subarray(12),
			);
			expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(plain))))).toEqual(
				JSON.parse(preview.preview),
			);
			expect(preview.preview).not.toContain(sourceText);
		} finally {
			server.stop(true);
		}
	});

	test("returns the viewer url without a truncated flag when content fits", async () => {
		const server = shareServer();
		try {
			const session = stubSession(
				[messageEntry("e1", null, "share me"), messageEntry("e2", "e1", "second")],
				server.base,
			);
			const result = await shareRpcSession(session);
			expect(result.url.split("#")[0]).toBe(`${server.base}/blobshareid01`);
			expect(result.truncated).toBeUndefined();
		} finally {
			server.stop();
		}
	});

	test("flags truncated when large content is trimmed to fit the share budget", async () => {
		const server = shareServer();
		try {
			const session = stubSession(
				[messageEntry("e1", null, "keep me"), messageEntry("e2", "e1", randomHex(1_000_000))],
				server.base,
			);
			const result = await shareRpcSession(session);
			expect(result.url.split("#")[0]).toBe(`${server.base}/blobshareid01`);
			expect(result.truncated).toBe(true);
		} finally {
			server.stop();
		}
	});
});
