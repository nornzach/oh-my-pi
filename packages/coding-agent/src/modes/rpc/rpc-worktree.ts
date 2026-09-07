/**
 * Git worktree RPC commands backing the GUI's tab × worktree binding
 * (plan/20-git-worktrees.md in the GUI repo).
 *
 * Design points:
 * - `get_git_status` is the live data source for the footer's git segment —
 *   branch + porcelain counts for the session cwd, `isRepo: false` outside a
 *   repository (the GUI hides the segment).
 * - `worktree_create` materializes a NEW branch `omp/gui/<name>` checked out
 *   at `~/.omp/wt/gui-<name>-<hash7(primaryRoot)>` — the naming mirrors
 *   `omp/task/<taskId>` (task/worktree.ts) and PR checkouts `<pr>-<hash7>`
 *   (gh.ts), so `omp worktree list/clear` sweeps these like the other two
 *   producers. Collisions suffix `-2..-100` on both path and branch.
 * - `worktree_remove` refuses a dirty worktree unless `force` (the GUI's
 *   close dialog is the confirm channel). The bound branch is never deleted —
 *   merged-state detection is out of scope; `git branch -d` is one command.
 *
 * Mutations run under the shared repository lock and are registered
 * as background RPC commands (worktree add can be slow on large repos).
 */
import * as fs from "node:fs/promises";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getWorktreeDir, hashPath, logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { parseIsolationBackend } from "../../task/worktree";
import { withRepoLock } from "../../utils/repo-lock";
import type { RpcGitStatus, RpcWorktreeCreateResult } from "./rpc-types";

/** Typed RPC errors: `code` lands in the response envelope's `code` field. */
export class RpcWorktreeError extends Error {
	constructor(
		readonly code:
			| "not_a_repo"
			| "invalid_name"
			| "worktree_create_failed"
			| "worktree_dirty"
			| "not_a_worktree"
			| "worktree_remove_failed",
		message: string,
	) {
		super(message);
	}
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_SUFFIX = 100;

/** Live git state for the footer segment (TUI gitSegment parity: branch + staged/unstaged/untracked). */
export async function buildRpcGitStatus(session: AgentSession): Promise<RpcGitStatus> {
	const cwd = session.sessionManager.getCwd();
	const repository = vcs.git(cwd);
	if (!repository) return { isRepo: false, branch: null, staged: 0, unstaged: 0, untracked: 0 };
	const [branch, status] = await Promise.all([repository.currentBranch(), repository.statusSummary()]);
	return {
		isRepo: true,
		branch: branch ?? null,
		staged: status.staged,
		unstaged: status.unstaged,
		untracked: status.untracked,
	};
}

/**
 * Create a worktree + branch for a GUI tab. `baseCwd` defaults to the session
 * cwd; `baseRef` is "HEAD" (current checkout) or "default" (repository default
 * branch, resolved from the native VCS adapter, falling back to HEAD when unknown).
 */
export async function createRpcWorktree(
	session: AgentSession,
	input: { name: string; baseCwd?: string; baseRef?: "HEAD" | "default" },
): Promise<RpcWorktreeCreateResult> {
	const name = slugifyName(input.name);
	if (/[^a-z0-9 -]/i.test(input.name) || !NAME_PATTERN.test(name)) {
		throw new RpcWorktreeError(
			"invalid_name",
			`Invalid worktree name "${input.name}" — use 1-41 chars of [a-z0-9-], starting with a letter or digit.`,
		);
	}
	const baseCwd = input.baseCwd ?? session.sessionManager.getCwd();
	const repository = vcs.git(baseCwd);
	if (!repository) throw new RpcWorktreeError("not_a_repo", `Not a git repository: ${baseCwd}`);
	const primaryRoot = repository.primaryRoot();

	const startPoint = input.baseRef === "default" ? ((await repository.defaultBranch()) ?? "HEAD") : "HEAD";

	return withRepoLock(primaryRoot, async () => {
		for (let suffix = 1; suffix <= MAX_SUFFIX; suffix++) {
			const candidateName = suffix === 1 ? name : `${name}-${suffix}`;
			const branch = `omp/gui/${candidateName}`;
			const path = getWorktreeDir(`gui-${candidateName}-${hashPath(primaryRoot)}`);
			// stat the dir itself, not just .git — a half-created worktree dir
			// (no .git yet) still makes `git worktree add` fail with "exists".
			const taken =
				(await fs.stat(path).then(
					() => true,
					() => false,
				)) || (await repository.listBranches(false)).includes(branch);
			if (taken) continue;
			try {
				await repository.createBranch(branch, startPoint, false);
				const worktree = await repository.worktreeAdd(path, branch, {
					detach: false,
					clone: session.settings.get("worktree.clone"),
					backend: parseIsolationBackend(session.settings.get("isolation.backend")),
				});
				if (worktree.cloneError) {
					logger.warn("GUI worktree clone fell back to plain checkout", { path, error: worktree.cloneError });
				}
			} catch (error) {
				// Roll back a branch whose worktree add failed so the next suffix
				// (or a retry) does not trip over the half-created ref.
				await repository.deleteBranch(branch, true).catch(() => false);
				throw new RpcWorktreeError(
					"worktree_create_failed",
					`Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return { path, branch, baseCwd: primaryRoot };
		}
		throw new RpcWorktreeError("worktree_create_failed", `No available worktree name after ${MAX_SUFFIX} attempts`);
	});
}

/**
 * Remove a worktree. Dirty (staged/unstaged/untracked > 0) refuses unless
 * `force`; the refusal carries the counts so the GUI's close dialog can show
 * exactly what would be discarded.
 */
export async function removeRpcWorktree(
	_session: AgentSession,
	input: { path: string; force?: boolean },
): Promise<{ removed: true }> {
	const worktreePath = input.path;
	const worktreeRepository = vcs.git(worktreePath);
	if (!worktreeRepository) throw new RpcWorktreeError("not_a_worktree", `Not inside a git worktree: ${worktreePath}`);
	const primaryRoot = worktreeRepository.primaryRoot();

	if (!input.force) {
		const status = await worktreeRepository.statusSummary();
		if (status.staged > 0 || status.unstaged > 0 || status.untracked > 0) {
			throw new RpcWorktreeError(
				"worktree_dirty",
				`Worktree has uncommitted changes: ${status.staged} staged, ${status.unstaged} unstaged, ${status.untracked} untracked.`,
			);
		}
	}

	return withRepoLock(primaryRoot, async () => {
		const repository = vcs.requireGit(primaryRoot);
		const removed = await repository.worktreeRemove(worktreePath, true);
		if (!removed) throw new RpcWorktreeError("worktree_remove_failed", `git worktree remove failed: ${worktreePath}`);
		await repository.worktreePrune();
		return { removed: true };
	});
}

/** Lowercase, spaces→`-`, strip everything outside [a-z0-9-], collapse runs, trim dashes. */
function slugifyName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}
