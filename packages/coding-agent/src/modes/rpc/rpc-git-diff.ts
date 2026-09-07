import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { BINARY_SNIFF_BYTES, isEnoent, isProbablyBinaryHeader } from "@oh-my-pi/pi-utils";
import { parseGitStatus } from "../../utils/git-status";
import type { RpcGitChanges, RpcGitDiff } from "./rpc-types";

const MAX_FILES = 1000;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_CHARS = 200_000;

export async function getRpcGitChanges(cwd: string): Promise<RpcGitChanges> {
	const repo = vcs.git(cwd);
	if (!repo) return { isRepo: false, root: null, base: null, files: [], truncated: false };
	const base = (await repo.headSha()) ?? null;
	const [status, changed] = await Promise.all([
		repo.statusPorcelain({ untracked: "all", nulTerminated: true }),
		base ? repo.changedFiles({ base }) : Promise.resolve(null),
	]);
	const net = changed ? new Set(changed) : null;
	const files = parseGitStatus(status)
		.filter(
			entry =>
				entry.index === "?" ||
				entry.oldPath !== undefined ||
				(net ? net.has(entry.path) || (entry.oldPath && net.has(entry.oldPath)) : entry.worktree !== "D"),
		)
		.map(entry => ({
			path: entry.path,
			oldPath: entry.oldPath,
			status: `${entry.index}${entry.worktree}`,
		}));
	return {
		isRepo: true,
		root: repo.info().repoRoot,
		base,
		files: files.slice(0, MAX_FILES),
		truncated: files.length > MAX_FILES,
	};
}

/** Read one authorized changed path; never follow a symlink out of the checkout. */
export async function getRpcGitDiff(cwd: string, filePath: string): Promise<RpcGitDiff> {
	if (!filePath || filePath.includes("\0") || path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes("..")) {
		throw new Error("Invalid repository-relative path");
	}
	const changes = await getRpcGitChanges(cwd);
	const entry = changes.files.find(file => file.path === filePath);
	if (!changes.root || !entry)
		throw new Error("This file is no longer in the changed file list. Refresh to continue.");
	const repo = vcs.requireGit(changes.root);
	const result: RpcGitDiff = { path: filePath, diff: "", kind: "text", truncated: false };
	const absolute = path.join(changes.root, filePath);
	let exists = true;
	try {
		const stat = await fs.lstat(absolute);
		if (stat.isSymbolicLink()) return { ...result, kind: "symlink" };
		if (stat.isDirectory()) return { ...result, kind: "directory" };
		const resolved = await fs.realpath(absolute);
		if (!resolved.startsWith(`${changes.root}${path.sep}`)) throw new Error("File resolves outside this checkout");
		if (stat.size > MAX_DIFF_BYTES) return { ...result, kind: "large", truncated: true };
	} catch (error) {
		if (!isEnoent(error)) throw error;
		exists = false;
	}
	const current = exists ? Bun.file(absolute) : null;
	if (current && isProbablyBinaryHeader(await current.slice(0, BINARY_SNIFF_BYTES).bytes()))
		return { ...result, kind: "binary" };
	const isNew = !changes.base || entry.status === "??" || entry.status[0] === "A";
	if (!isNew && changes.base) {
		const old = await repo.showBlob(`${changes.base}:${entry.oldPath ?? filePath}`, MAX_DIFF_BYTES);
		if (old.truncated) return { ...result, kind: "large", truncated: true };
		if (isProbablyBinaryHeader(old.data.subarray(0, BINARY_SNIFF_BYTES))) return { ...result, kind: "binary" };
	}
	let diff: string;
	if (isNew) {
		const content = current ? await current.text() : "";
		const lines = content.split("\n");
		if (content.endsWith("\n")) lines.pop();
		diff = content ? `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join("\n")}` : "";
	} else {
		diff = await repo.diffText({
			base: changes.base!,
			files: [filePath, ...(entry.oldPath ? [entry.oldPath] : [])].map(file => `:(literal)${file}`),
			context: 3,
			binary: false,
		});
	}
	// Current native base/worktree diffs omit content-identical renames. Preserve the status metadata.
	if (!diff && entry.oldPath) diff = `rename from ${entry.oldPath}\nrename to ${filePath}`;
	return { ...result, diff: diff.slice(0, MAX_DIFF_CHARS), truncated: diff.length > MAX_DIFF_CHARS };
}
