import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildRpcGitStatus,
	createRpcWorktree,
	removeRpcWorktree,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-worktree";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { branch } from "@oh-my-pi/pi-coding-agent/utils/git";
import { $ } from "bun";

// The RPC functions only touch session.sessionManager.getCwd() — a stub is
// the right-sized seam (a full AgentSession pulls provider/auth machinery).
function stubSession(cwd: string): AgentSession {
	return { sessionManager: { getCwd: () => cwd } } as unknown as AgentSession;
}

async function gitInit(repo: string): Promise<void> {
	fs.mkdirSync(repo, { recursive: true });
	await $`git init -b main`.cwd(repo).quiet();
	await $`git -c user.email=t@t -c user.name=t commit --allow-empty -m init`.cwd(repo).quiet();
}

describe("rpc-worktree", () => {
	let tempRoot: string;
	let repo: string;
	let worktreesDir: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-worktree-")));
		repo = path.join(tempRoot, "repo");
		worktreesDir = path.join(tempRoot, "wt");
		await gitInit(repo);
		savedEnv = process.env.OMP_WORKTREE_DIR;
		process.env.OMP_WORKTREE_DIR = worktreesDir;
	});

	afterEach(() => {
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	it("reports branch and porcelain counts for the session cwd", async () => {
		const clean = await buildRpcGitStatus(stubSession(repo));
		expect(clean).toEqual({ isRepo: true, branch: "main", staged: 0, unstaged: 0, untracked: 0 });

		fs.writeFileSync(path.join(repo, "new.txt"), "untracked");
		fs.writeFileSync(path.join(repo, "README.md"), "modified");
		await $`git add README.md && git -c user.email=t@t -c user.name=t commit -m readme`.cwd(repo).quiet();
		// Stage AFTER the commit so the commit doesn't sweep it up.
		fs.writeFileSync(path.join(repo, "staged.txt"), "staged");
		await $`git add staged.txt`.cwd(repo).quiet();
		fs.appendFileSync(path.join(repo, "README.md"), "dirty");

		const dirty = await buildRpcGitStatus(stubSession(repo));
		expect(dirty.branch).toBe("main");
		expect(dirty.staged).toBe(1);
		expect(dirty.unstaged).toBe(1);
		expect(dirty.untracked).toBe(1);
	});

	it("reports isRepo false outside a repository", async () => {
		const loose = path.join(tempRoot, "loose");
		fs.mkdirSync(loose);
		expect(await buildRpcGitStatus(stubSession(loose))).toEqual({
			isRepo: false,
			branch: null,
			staged: 0,
			unstaged: 0,
			untracked: 0,
		});
	});

	it("creates a worktree on a new omp/gui branch under the managed dir", async () => {
		const result = await createRpcWorktree(stubSession(repo), { name: "My Feature" });
		expect(result.branch).toBe("omp/gui/my-feature");
		expect(result.baseCwd).toBe(repo);
		expect(path.dirname(result.path)).toBe(worktreesDir);
		expect(path.basename(result.path)).toMatch(/^gui-my-feature-[0-9a-f]{7}$/);
		expect(fs.existsSync(path.join(result.path, ".git"))).toBe(true);

		// The worktree is a real checkout of the new branch at HEAD.
		const branch = (await $`git branch --show-current`.cwd(result.path).text()).trim();
		expect(branch).toBe("omp/gui/my-feature");

		// Name collision suffixes BOTH path and branch.
		const second = await createRpcWorktree(stubSession(repo), { name: "my-feature" });
		expect(second.branch).toBe("omp/gui/my-feature-2");
		expect(second.path).not.toBe(result.path);
	});

	it("creates from the repository default branch when baseRef is default", async () => {
		await createRpcWorktree(stubSession(repo), { name: "from-default", baseRef: "default" });
		expect(await branch.list(repo)).toContain("omp/gui/from-default");
	});

	it("rejects invalid names and non-repo cwds with typed codes", async () => {
		await expect(createRpcWorktree(stubSession(repo), { name: "!!!" })).rejects.toMatchObject({
			code: "invalid_name",
		});
		const loose = path.join(tempRoot, "loose");
		fs.mkdirSync(loose);
		await expect(createRpcWorktree(stubSession(loose), { name: "x" })).rejects.toMatchObject({ code: "not_a_repo" });
	});

	it("removes a clean worktree, refuses a dirty one, force overrides", async () => {
		const { path: wtPath } = await createRpcWorktree(stubSession(repo), { name: "cleanup" });
		await expect(removeRpcWorktree(stubSession(repo), { path: wtPath })).resolves.toEqual({ removed: true });
		expect(fs.existsSync(wtPath)).toBe(false);

		const dirty = await createRpcWorktree(stubSession(repo), { name: "dirty" });
		fs.writeFileSync(path.join(dirty.path, "dirty.txt"), "unsaved");
		await expect(removeRpcWorktree(stubSession(repo), { path: dirty.path })).rejects.toMatchObject({
			code: "worktree_dirty",
		});
		expect(fs.existsSync(dirty.path)).toBe(true);

		await expect(removeRpcWorktree(stubSession(repo), { path: dirty.path, force: true })).resolves.toEqual({
			removed: true,
		});
		expect(fs.existsSync(dirty.path)).toBe(false);
	});
});
