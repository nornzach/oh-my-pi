import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { assistantMsg, userMsg } from "../utilities";

/**
 * Contract tests for SessionManager.copyBranchToNewSession — the fork_from
 * RPC backing. The copy contains ONLY the root→entryId path (labels carried),
 * and the source session is left completely untouched (unlike
 * createBranchedSession, which converts it in place).
 */

let tempDir: string;
let sessionDir: string;

beforeEach(() => {
	tempDir = path.join(os.tmpdir(), `fork-from-test-${Snowflake.next()}`);
	sessionDir = path.join(tempDir, "sessions");
	fs.mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
	removeSyncWithRetries(tempDir);
});

describe("copyBranchToNewSession", () => {
	it("writes only the root-to-leaf path into a new file", async () => {
		const manager = SessionManager.create(tempDir, sessionDir);
		const id1 = manager.appendMessage(userMsg("first"));
		const id2 = manager.appendMessage(assistantMsg("second"));
		const id3 = manager.appendMessage(userMsg("third"));
		await manager.flush();

		const result = await manager.copyBranchToNewSession(id2);
		expect(result).toBeDefined();
		expect(result!.sessionId).not.toBe(manager.getSessionId());
		expect(fs.existsSync(result!.sessionPath)).toBe(true);

		const entries = await loadEntriesFromFile(result!.sessionPath);
		const messages = entries.filter(e => e.type === "message");
		expect(messages).toHaveLength(2);
		expect(messages[0]?.id).toBe(id1);
		expect(messages[1]?.id).toBe(id2);
		expect(entries.some(e => e.id === id3)).toBe(false);
	});

	it("leaves the source session untouched", async () => {
		const manager = SessionManager.create(tempDir, sessionDir);
		manager.appendMessage(userMsg("first"));
		const id2 = manager.appendMessage(assistantMsg("second"));
		await manager.flush();
		const fileBefore = manager.getSessionFile();
		const idBefore = manager.getSessionId();

		await manager.copyBranchToNewSession(id2);

		expect(manager.getSessionFile()).toBe(fileBefore);
		expect(manager.getSessionId()).toBe(idBefore);
		expect(manager.getEntries()).toHaveLength(2);
	});

	it("throws for an unknown entry id", async () => {
		const manager = SessionManager.create(tempDir, sessionDir);
		manager.appendMessage(userMsg("first"));
		await manager.flush();
		await expect(manager.copyBranchToNewSession("does-not-exist")).rejects.toThrow("not found");
	});

	it("returns undefined when the session is not persisting", async () => {
		const manager = SessionManager.inMemory();
		const id = manager.appendMessage(userMsg("first"));
		expect(await manager.copyBranchToNewSession(id)).toBeUndefined();
	});
});
