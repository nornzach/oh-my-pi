/**
 * Issue #8860 — the exit banner advertises `--resume <id>` for sessions that
 * were never written to disk. Persistence is lazy: `getSessionFile()` returns
 * an allocated path from the start, but the JSONL is only materialized once the
 * history crosses the persistence gate (first assistant message / explicit
 * `ensureOnDisk()`). Consumers advertising a resume command must gate on
 * `isSessionOnDisk()` instead of just the allocated path.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

function freshSession(): SessionManager {
	const cwd = join("/tmp", `omp-on-disk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	return SessionManager.create(cwd, join(cwd, "sessions"), new MemorySessionStorage());
}

describe("SessionManager.isSessionOnDisk (issue #8860)", () => {
	it.each(["bashExecution", "pythonExecution"] as const)(
		"retains %s output across a session switch without a model reply",
		async role => {
			using tempDir = TempDir.createSync("gui-execution-persistence-");
			const session = SessionManager.create(tempDir.path(), tempDir.path());
			const result = {
				output: "retained local result",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			};
			session.appendMessage(
				role === "bashExecution"
					? { ...result, role, command: "printf result" }
					: { ...result, role, code: "print('result')", excludeFromContext: true },
			);
			const original = session.getSessionFile();
			if (!original) throw new Error("Missing persistent session path");
			await session.newSession();
			await session.setSessionFile(original);
			expect(session.getEntries()).toContainEqual(
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({ role, output: "retained local result" }),
				}),
			);
			await session.close();
		},
	);

	it("returns false for a fresh lazy session whose JSONL was never materialized", () => {
		const session = freshSession();
		expect(session.getSessionId()).not.toBe("");
		expect(session.getSessionFile()).toBeTruthy();
		// The path is allocated up front, but no file exists yet.
		expect(session.isSessionOnDisk()).toBe(false);
	});

	it("returns true once ensureOnDisk() materializes the session file", async () => {
		const session = freshSession();
		expect(session.isSessionOnDisk()).toBe(false);
		await session.ensureOnDisk();
		expect(session.isSessionOnDisk()).toBe(true);
		expect(session.getSessionFile()).toBeTruthy();
	});

	it("stays false for an in-memory (non-persisting) session", () => {
		const session = SessionManager.inMemory();
		expect(session.isSessionOnDisk()).toBe(false);
	});
});
