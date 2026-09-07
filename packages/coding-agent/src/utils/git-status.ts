/** Parse Git porcelain v1 -z without splitting paths on whitespace. */
export interface GitStatusEntry {
	path: string;
	oldPath?: string;
	index: string;
	worktree: string;
}

export function parseGitStatus(text: string): GitStatusEntry[] {
	const records = text.split("\0");
	const entries: GitStatusEntry[] = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (record.length < 4) continue;
		const index = record[0];
		const worktree = record[1];
		const oldPath = index === "R" || index === "C" || worktree === "R" || worktree === "C" ? records[++i] : undefined;
		entries.push({ path: record.slice(3), oldPath, index, worktree });
	}
	return entries;
}
