/**
 * Workspace-directory RPC commands (TUI /dirs, /add-dir, /remove-dir, /move
 * parity; see builtin-registry.ts).
 *
 * Semantics mirrored from the TUI handlers:
 * - All three mutations refuse while the session is streaming (typed busy error).
 * - Paths are normalized against the session cwd (`~` expansion included).
 * - add_directory stats the target first (missing → "Directory does not exist",
 *   non-directory → "Not a directory"), dedupes (already-present is a no-op
 *   success), and rejects the cwd itself via SessionManager.
 * - remove_directory refuses the primary (cwd) directory — "use /move" — and
 *   treats an unknown directory as a no-op success, both like the TUI.
 * - move_session relocates the session file's cwd association on disk
 *   (SessionManager.moveTo via AgentSession.moveSession); the destination must
 *   already exist (no interactive create-offer — the RPC peer has no confirm
 *   channel here, and the GUI picker only returns existing directories).
 *
 * Both mutations refresh the base system prompt afterwards so the next turn's
 * prompt sees the updated roots, exactly like the TUI handlers.
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSession } from "../../session/agent-session";
import { normalizeWorkspaceDirectory } from "../../session/session-workspace";
import type { RpcWorkspaceDirectoriesResult } from "./rpc-types";

/** Refused while streaming: maps to the RPC envelope `code` field (TUI "Cannot … while streaming."). */
export class RpcWorkspaceBusyError extends Error {
	readonly code = "busy";
	constructor(action: string) {
		super(`Cannot ${action} while streaming.`);
	}
}

/** Project the session's workspace roots for the wire: primary (cwd) first, additional roots in order. */
export function buildRpcWorkspaceDirectories(session: AgentSession): RpcWorkspaceDirectoriesResult {
	const manager = session.sessionManager;
	return {
		directories: [
			{ path: path.resolve(manager.getCwd()), primary: true },
			...manager.getAdditionalDirectories().map(directory => ({ path: directory, primary: false })),
		],
	};
}

/** Stat `resolved`, mirroring the TUI add-dir/move validation. Returns the resolved absolute path. */
async function requireExistingDirectory(resolved: string): Promise<void> {
	let stat: Stats;
	try {
		stat = await fs.stat(resolved);
	} catch {
		throw new Error(`Directory does not exist: ${resolved}`);
	}
	if (!stat.isDirectory()) {
		throw new Error(`Not a directory: ${resolved}`);
	}
}

/**
 * /add-dir: add a workspace root. Already-present paths are a no-op success
 * (TUI prints "Already in the workspace" and consumes the command); the
 * SessionManager rejects adding the cwd itself. Returns the post-add list.
 */
export async function applyRpcAddDirectory(
	session: AgentSession,
	directory: string,
): Promise<RpcWorkspaceDirectoriesResult> {
	if (session.isStreaming) throw new RpcWorkspaceBusyError("add a directory");
	const resolved = normalizeWorkspaceDirectory(directory, session.sessionManager.getCwd());
	await requireExistingDirectory(resolved);
	const added = await session.sessionManager.addWorkspaceDirectory(resolved);
	if (added !== null) await session.refreshBaseSystemPrompt();
	return buildRpcWorkspaceDirectories(session);
}

/**
 * /remove-dir: remove a workspace root. The primary (cwd) directory is
 * refused with the TUI's "/move" pointer; unknown paths are a no-op success
 * (TUI prints "Not a workspace directory" and consumes the command). Returns
 * the post-removal list.
 */
export async function applyRpcRemoveDirectory(
	session: AgentSession,
	directory: string,
): Promise<RpcWorkspaceDirectoriesResult> {
	if (session.isStreaming) throw new RpcWorkspaceBusyError("remove a directory");
	const manager = session.sessionManager;
	const resolved = normalizeWorkspaceDirectory(directory, manager.getCwd());
	if (resolved === path.resolve(manager.getCwd())) {
		throw new Error("Cannot remove the working directory; use /move to change it.");
	}
	const removed = await manager.removeWorkspaceDirectory(resolved);
	if (removed !== null) await session.refreshBaseSystemPrompt();
	return buildRpcWorkspaceDirectories(session);
}

export interface RpcMoveSessionDeps {
	/**
	 * Re-point process-global cwd-derived state at the destination after the
	 * session file moved (TUI applyCwdChange parity): setProjectDir, settings
	 * reload, provider globals, plugin/capability caches. Wired by rpc-mode,
	 * injected here so the move stays unit-testable without process chdir.
	 */
	applyCwdChange: (newCwd: string) => Promise<void>;
}

/**
 * /move: relocate the session to a different working directory. Flushes
 * pending settings first (TUI ordering: a failed save aborts before any disk
 * relocation), then moves the session file + artifacts, then re-scopes
 * process state via {@link RpcMoveSessionDeps.applyCwdChange}. Returns the
 * session cwd after the move.
 */
export async function applyRpcMoveSession(
	session: AgentSession,
	directory: string,
	deps: RpcMoveSessionDeps,
): Promise<{ cwd: string }> {
	if (session.isStreaming) throw new RpcWorkspaceBusyError("move");
	const resolved = normalizeWorkspaceDirectory(directory, session.sessionManager.getCwd());
	await requireExistingDirectory(resolved);
	try {
		await session.settings.flush();
	} catch (err) {
		throw new Error(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		await session.moveSession(resolved);
	} catch (err) {
		throw new Error(`Move failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	const cwd = session.sessionManager.getCwd();
	await deps.applyCwdChange(cwd);
	return { cwd };
}
