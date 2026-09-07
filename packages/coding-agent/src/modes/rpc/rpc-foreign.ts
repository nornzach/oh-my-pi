import * as fs from "node:fs/promises";
import * as path from "node:path";
import { directoryExists, withFileLock } from "@oh-my-pi/pi-utils";
import { SessionManager } from "../../session/session-manager";
import { loadSessionFile } from "../../session/session-loader";
/**
 * Foreign-session import RPC actions: list Claude/Codex sessions and import
 * one as a fresh OMP session copy (the source data is never modified).
 * Thin shells over the existing importer (session/foreign-session-import.ts)
 * — same machinery as `--from-claude/--from-codex` and `/resume @claude`.
 */

import type { AgentSession } from "../../session/agent-session";
import { createForeignSessionStore, persistForeignSession } from "../../session/foreign-session-import";
import type { ForeignSessionInfo, ForeignSessionSource } from "../../session/foreign-session-store";
import type { RpcForeignSessionInfo } from "./rpc-types";

function toWire(info: ForeignSessionInfo): RpcForeignSessionInfo {
	return {
		id: info.id,
		path: info.path,
		cwd: info.cwd,
		title: info.title,
		created: info.created.toISOString(),
		modified: info.modified.toISOString(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
	};
}

/**
 * Wire frames are cast, not shape-validated: reject a source outside the
 * declared union before it reaches createForeignSessionStore, which would
 * silently treat anything but "claude" as codex.
 */
function assertRpcForeignSource(source: ForeignSessionSource): void {
	if (source !== "claude" && source !== "codex") {
		throw new Error(`Unsupported foreign session source: ${source}. Expected "claude" or "codex".`);
	}
}

export async function buildRpcForeignSessionList(source: ForeignSessionSource): Promise<RpcForeignSessionInfo[]> {
	assertRpcForeignSource(source);
	const sessions = await createForeignSessionStore(source).list();
	return sessions.map(toWire);
}

/**
 * Import one foreign session. `foreignId` matches either the source id or the
 * source path from list_foreign_sessions (the picker passes whatever it has).
 * When the source cwd no longer exists, the imported session lands in the
 * current session's cwd (same fallback as the CLI import flags).
 */
export async function applyRpcImportForeignSession(
	session: AgentSession,
	source: ForeignSessionSource,
	foreignId: string,
): Promise<{ sessionPath: string; sessionId: string; cwd: string; reused?: boolean }> {
	assertRpcForeignSource(source);
	const store = createForeignSessionStore(source);
	const sessions = await store.list();
	const info = sessions.find(candidate => candidate.id === foreignId || candidate.path === foreignId);
	if (!info) {
		throw new Error(`Foreign session not found: ${foreignId}`);
	}
	const cwd = (await directoryExists(info.cwd)) ? info.cwd : session.sessionManager.getCwd();
	const sessionDir = SessionManager.getDefaultSessionDir(cwd);
	const digest = new Bun.CryptoHasher("sha256")
		.update(JSON.stringify([source, info.path, info.id, info.modified.toISOString()]))
		.digest("hex");
	const destination = path.join(sessionDir, `import_${digest}.jsonl`);
	await fs.mkdir(sessionDir, { recursive: true });
	// Stable destination + atomic session persistence closes timeout/retry and concurrent-import races.
	return withFileLock(destination, async () => {
		if (await Bun.file(destination).exists()) {
			const loaded = await loadSessionFile(destination);
			const header = loaded.entries.find(entry => entry.type === "session");
			if (!header || header.type !== "session")
				throw new Error("The existing imported session cannot be read. Inspect it before retrying.");
			return { sessionPath: destination, sessionId: header.id, cwd: header.cwd, reused: true };
		}
		const imported = await persistForeignSession(store, info, {
			fallbackCwd: cwd,
			sessionDir,
			sessionFile: destination,
		});
		const sessionPath = imported.getSessionFile();
		if (!sessionPath) throw new Error("Import did not produce a session file");
		return { sessionPath, sessionId: imported.getSessionId(), cwd: imported.getCwd() };
	});
}
