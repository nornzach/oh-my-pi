import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { getRpcGitChanges, getRpcGitDiff } from "../src/modes/rpc/rpc-git-diff";

test("repository diff reports final contents, renames, binary, deletion and untracked files in the active checkout", async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-diff-"));
	const root = await fs.realpath(temporary);
	try {
		expect((await getRpcGitChanges(root)).isRepo).toBe(false);
		await $`git init -b main`.cwd(root).quiet();
		await Bun.write(path.join(root, "new.txt"), "new\n");
		expect((await getRpcGitDiff(root, "new.txt")).diff).toContain("+new");
		for (const name of ["a.txt", "delete.txt", "rename.txt"]) await Bun.write(path.join(root, name), "original\n");
		await $`git add .`.cwd(root).quiet();
		await $`git -c user.name=Test -c user.email=test@example.test commit -m initial`.cwd(root).quiet();
		await Bun.write(path.join(root, "a.txt"), "staged\n");
		await $`git add a.txt`.cwd(root).quiet();
		await Bun.write(path.join(root, "a.txt"), "original\n");
		expect((await getRpcGitChanges(root)).files.map(file => file.path)).not.toContain("a.txt");
		await Bun.write(path.join(root, "a.txt"), "final\n");
		await fs.rm(path.join(root, "delete.txt"));
		await $`git mv rename.txt renamed.txt`.cwd(root).quiet();
		await Bun.write(path.join(root, "image.bin"), new Uint8Array([0, 255, 1]));
		await Bun.write(path.join(root, "space name.txt"), "untracked\n");
		const changes = await getRpcGitChanges(root);
		expect(changes.files.map(file => file.path).sort()).toEqual([
			"a.txt",
			"delete.txt",
			"image.bin",
			"renamed.txt",
			"space name.txt",
		]);
		expect(changes.files.find(file => file.path === "renamed.txt")?.oldPath).toBe("rename.txt");
		const diff = await getRpcGitDiff(root, "a.txt");
		expect(diff.diff).toContain("-original");
		expect(diff.diff).toContain("+final");
		expect(diff.diff).not.toContain("staged");
		expect((await getRpcGitDiff(root, "delete.txt")).diff).toContain("-original");
		expect((await getRpcGitDiff(root, "image.bin")).kind).toBe("binary");
		expect((await getRpcGitDiff(root, "space name.txt")).diff).toContain("+untracked");
		expect((await getRpcGitDiff(root, "renamed.txt")).diff).toContain("rename");
		await fs.symlink(os.tmpdir(), path.join(root, "outside"));
		expect((await getRpcGitDiff(root, "outside")).kind).toBe("symlink");
		await expect(getRpcGitDiff(root, "../outside")).rejects.toThrow("Invalid");
		await expect(getRpcGitDiff(root, "new.txt")).rejects.toThrow("no longer");
		const worktree = path.join(root, "linked");
		await $`git worktree add -b linked ${worktree}`.cwd(root).quiet();
		await Bun.write(path.join(worktree, "a.txt"), "linked-only\n");
		expect((await getRpcGitDiff(worktree, "a.txt")).diff).toContain("+linked-only");
		expect((await getRpcGitChanges(worktree)).root).toBe(worktree);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
