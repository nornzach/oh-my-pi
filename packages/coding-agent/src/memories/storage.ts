import { Database } from "bun:sqlite";

export interface MemoryThread {
	id: string;
	updatedAt: number;
	rolloutPath: string;
	cwd: string;
	sourceKind: string;
	/** Session title from the file's title slot; not persisted. */
	title?: string;
}

export interface Stage1OutputRow {
	threadId: string;
	sourceUpdatedAt: number;
	rawMemory: string;
	rolloutSummary: string;
	rolloutSlug: string | null;
	generatedAt: number;
	cwd: string;
}

export interface Stage1Claim {
	threadId: string;
	ownershipToken: string;
	inputWatermark: number;
	sourceUpdatedAt: number;
	rolloutPath: string;
	cwd: string;
}

export interface GlobalClaim {
	ownershipToken: string;
	inputWatermark: number;
}

const STAGE1_KIND = "memory_stage1";
const GLOBAL_KIND = "memory_consolidate_global";
const DEFAULT_RETRY_REMAINING = 3;

/**
 * Case-fold a project cwd into a stable memory scope key on case-insensitive
 * filesystems.
 *
 * Windows reports the same directory with drifting casing across launches
 * (`C:\Users\me\Documents\proj` vs `...\documents\proj`). The on-disk memory
 * root (`getMemoryRoot`) collapses both into one directory because NTFS is
 * case-insensitive, but the scope keys derived from cwd — `global:${cwd}` job
 * keys, `threads.cwd`, and the `t.cwd = ?` output filter — compare with
 * SQLite's default BINARY collation. Without folding, one project's memories
 * split across two scopes that share a single directory: Phase 2 for one casing
 * sees zero outputs, wipes the shared `MEMORY.md`/`memory_summary.md`/`skills/`,
 * and advances its watermark, permanently stranding the other casing's outputs
 * (#12596). Fold to lower case on win32 so one physical directory maps to one
 * scope key, matching the filesystem's own case-insensitivity.
 */
export function normalizeScopeCwd(cwd: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? cwd.toLowerCase() : cwd;
}

/**
 * Per-project job key so Phase 2 consolidation is isolated to a single cwd.
 * Previously a single "global" key caused cross-project memory contamination.
 */
function globalJobKey(cwd: string): string {
	return `global:${normalizeScopeCwd(cwd)}`;
}

export function openMemoryDb(dbPath: string): Database {
	const db = new Database(dbPath);
	// Install the busy handler BEFORE any lock-taking statement. See #2421.
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS threads (
	id TEXT PRIMARY KEY,
	updated_at INTEGER NOT NULL,
	rollout_path TEXT NOT NULL,
	cwd TEXT NOT NULL,
	source_kind TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stage1_outputs (
	thread_id TEXT PRIMARY KEY,
	source_updated_at INTEGER NOT NULL,
	raw_memory TEXT NOT NULL,
	rollout_summary TEXT NOT NULL,
	rollout_slug TEXT,
	generated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
	kind TEXT NOT NULL,
	job_key TEXT NOT NULL,
	status TEXT NOT NULL,
	worker_id TEXT,
	ownership_token TEXT,
	started_at INTEGER,
	finished_at INTEGER,
	lease_until INTEGER,
	retry_at INTEGER,
	retry_remaining INTEGER NOT NULL,
	last_error TEXT,
	input_watermark INTEGER,
	last_success_watermark INTEGER,
	PRIMARY KEY (kind, job_key)
);

CREATE TABLE IF NOT EXISTS forgotten_threads (
	thread_id TEXT PRIMARY KEY,
	cwd TEXT NOT NULL,
	forgotten_at INTEGER NOT NULL
);
`);
	return db;
}

export function closeMemoryDb(db: Database): void {
	db.close();
}

export function clearMemoryData(db: Database): void {
	db.exec(`
DELETE FROM stage1_outputs;
DELETE FROM threads;
DELETE FROM jobs WHERE kind IN ('memory_stage1', 'memory_consolidate_global');
DELETE FROM forgotten_threads;
`);
}

export function upsertThreads(db: Database, threads: MemoryThread[]): void {
	if (threads.length === 0) return;
	const stmt = db.prepare(`
INSERT INTO threads (id, updated_at, rollout_path, cwd, source_kind)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	updated_at = excluded.updated_at,
	rollout_path = excluded.rollout_path,
	cwd = excluded.cwd,
	source_kind = excluded.source_kind
`);
	const tx = db.transaction((rows: MemoryThread[]) => {
		for (const row of rows) {
			stmt.run(row.id, row.updatedAt, row.rolloutPath, normalizeScopeCwd(row.cwd), row.sourceKind);
		}
	});
	tx(threads);
}

function ensureStage1Job(db: Database, threadId: string): void {
	db.prepare(`
INSERT OR IGNORE INTO jobs (kind, job_key, status, retry_remaining, input_watermark, last_success_watermark)
VALUES (?, ?, 'pending', ?, 0, 0)
`).run(STAGE1_KIND, threadId, DEFAULT_RETRY_REMAINING);
}

function ensureGlobalJob(db: Database, cwd: string): void {
	db.prepare(`
INSERT OR IGNORE INTO jobs (kind, job_key, status, retry_remaining, input_watermark, last_success_watermark)
VALUES (?, ?, 'pending', ?, 0, 0)
`).run(GLOBAL_KIND, globalJobKey(cwd), DEFAULT_RETRY_REMAINING);
}

interface Stage1CandidateParams {
	nowSec: number;
	threadScanLimit: number;
	maxRolloutAgeDays: number;
	minRolloutIdleHours: number;
	excludeThreadIds?: string[];
	/** Only consider this project's sessions. */
	cwd?: string;
}

interface Stage1CandidateRow {
	id: string;
	updated_at: number;
	rollout_path: string;
	cwd: string;
	source_kind: string;
}

/** Recent, idle, not-forgotten sessions whose current content has not been read yet. */
function stage1Candidates(db: Database, params: Stage1CandidateParams): Stage1CandidateRow[] {
	const { nowSec, threadScanLimit, maxRolloutAgeDays, minRolloutIdleHours, excludeThreadIds = [], cwd } = params;
	const maxAgeSec = maxRolloutAgeDays * 24 * 60 * 60;
	const minIdleSec = minRolloutIdleHours * 60 * 60;
	const candidateSql = `
SELECT id, updated_at, rollout_path, cwd, source_kind FROM threads
WHERE id NOT IN (SELECT thread_id FROM forgotten_threads)${cwd === undefined ? "" : " AND cwd = ?"}
ORDER BY updated_at DESC LIMIT ?`;
	const candidateArgs = cwd === undefined ? [threadScanLimit] : [normalizeScopeCwd(cwd), threadScanLimit];
	const rows = db.prepare(candidateSql).all(...candidateArgs) as Stage1CandidateRow[];
	const excluded = new Set(excludeThreadIds);
	const outputAt = db.prepare("SELECT source_updated_at FROM stage1_outputs WHERE thread_id = ?");
	return rows.filter(row => {
		if (excluded.has(row.id)) return false;
		if (row.source_kind !== "cli" && row.source_kind !== "app") return false;
		if (nowSec - row.updated_at > maxAgeSec) return false;
		if (nowSec - row.updated_at < minIdleSec) return false;
		const stage1 = outputAt.get(row.id) as { source_updated_at?: number } | undefined;
		return (stage1?.source_updated_at ?? 0) < row.updated_at;
	});
}

/** How many sessions a claim with these parameters could still take, ignoring the concurrency cap. */
export function countClaimableStage1Threads(db: Database, params: Stage1CandidateParams): number {
	const job = db.prepare(
		"SELECT status, lease_until, retry_at, retry_remaining, input_watermark, last_success_watermark FROM jobs WHERE kind = ? AND job_key = ?",
	);
	let count = 0;
	for (const row of stage1Candidates(db, params)) {
		const state = job.get(STAGE1_KIND, row.id) as
			| {
					status: string;
					lease_until: number | null;
					retry_at: number | null;
					retry_remaining: number;
					input_watermark: number | null;
					last_success_watermark: number | null;
			  }
			| undefined;
		if (state) {
			if ((state.last_success_watermark ?? 0) >= row.updated_at) continue;
			if (state.status === "running" && state.lease_until !== null && state.lease_until > params.nowSec) continue;
			const changed = state.input_watermark === null || state.input_watermark < row.updated_at;
			const retryable = state.retry_remaining > 0 && (state.retry_at === null || state.retry_at <= params.nowSec);
			if (!changed && !retryable) continue;
		}
		count++;
	}
	return count;
}

export function claimStage1Jobs(
	db: Database,
	params: Stage1CandidateParams & {
		maxRolloutsPerStartup: number;
		leaseSeconds: number;
		runningConcurrencyCap: number;
		workerId: string;
	},
): Stage1Claim[] {
	const { nowSec, maxRolloutsPerStartup, leaseSeconds, runningConcurrencyCap, workerId } = params;
	const runningCountRow = db
		.prepare(
			"SELECT COUNT(*) AS count FROM jobs WHERE kind = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until > ?",
		)
		.get(STAGE1_KIND, nowSec) as { count?: number } | undefined;
	let runningCount = runningCountRow?.count ?? 0;
	if (runningCount >= runningConcurrencyCap) return [];
	const candidateRows = stage1Candidates(db, params);
	const claims: Stage1Claim[] = [];
	for (const row of candidateRows) {
		if (claims.length >= maxRolloutsPerStartup) break;
		if (runningCount >= runningConcurrencyCap) break;
		ensureStage1Job(db, row.id);
		const ownershipToken = crypto.randomUUID();
		const leaseUntil = nowSec + leaseSeconds;
		const claimed = db
			.prepare(`
UPDATE jobs
SET status = 'running', worker_id = ?, ownership_token = ?, started_at = ?, finished_at = NULL,
	lease_until = ?, retry_at = NULL, last_error = NULL, input_watermark = ?,
	retry_remaining = CASE
		WHEN input_watermark IS NULL THEN ?
		WHEN input_watermark < ? THEN ?
		ELSE retry_remaining
	END
WHERE kind = ? AND job_key = ?
	AND (last_success_watermark IS NULL OR last_success_watermark < ?)
	AND NOT (status = 'running' AND lease_until IS NOT NULL AND lease_until > ?)
	AND (
		input_watermark IS NULL
		OR input_watermark < ?
		OR (
			retry_remaining > 0
			AND (retry_at IS NULL OR retry_at <= ?)
		)
	)
`)
			.run(
				workerId,
				ownershipToken,
				nowSec,
				leaseUntil,
				row.updated_at,
				DEFAULT_RETRY_REMAINING,
				row.updated_at,
				DEFAULT_RETRY_REMAINING,
				STAGE1_KIND,
				row.id,
				row.updated_at,
				nowSec,
				row.updated_at,
				nowSec,
			);
		if (Number(claimed.changes ?? 0) <= 0) continue;
		claims.push({
			threadId: row.id,
			ownershipToken,
			inputWatermark: row.updated_at,
			sourceUpdatedAt: row.updated_at,
			rolloutPath: row.rollout_path,
			cwd: row.cwd,
		});
		runningCount += 1;
	}
	return claims;
}

export function enqueueGlobalWatermark(
	db: Database,
	sourceUpdatedAt: number,
	cwd: string,
	params?: { forceDirtyWhenNotAdvanced?: boolean },
): void {
	const forceDirtyWhenNotAdvanced = params?.forceDirtyWhenNotAdvanced ?? false;
	ensureGlobalJob(db, cwd);
	db.prepare(`
UPDATE jobs
SET
	input_watermark = CASE
		WHEN input_watermark IS NULL THEN ?
		WHEN input_watermark < ? THEN ?
		WHEN ? = 1 AND (last_success_watermark IS NULL OR input_watermark <= last_success_watermark) THEN
			CASE
				WHEN last_success_watermark IS NULL THEN input_watermark + 1
				ELSE last_success_watermark + 1
			END
		ELSE input_watermark
	END,
	retry_remaining = CASE
		WHEN input_watermark IS NULL THEN ?
		WHEN input_watermark < ? THEN ?
		WHEN ? = 1 AND (last_success_watermark IS NULL OR input_watermark <= last_success_watermark) THEN ?
		ELSE retry_remaining
	END,
	retry_at = CASE
		WHEN input_watermark IS NULL THEN NULL
		WHEN input_watermark < ? THEN NULL
		WHEN ? = 1 AND (last_success_watermark IS NULL OR input_watermark <= last_success_watermark) THEN NULL
		ELSE retry_at
	END
WHERE kind = ? AND job_key = ?
`).run(
		sourceUpdatedAt,
		sourceUpdatedAt,
		sourceUpdatedAt,
		forceDirtyWhenNotAdvanced ? 1 : 0,
		DEFAULT_RETRY_REMAINING,
		sourceUpdatedAt,
		DEFAULT_RETRY_REMAINING,
		forceDirtyWhenNotAdvanced ? 1 : 0,
		DEFAULT_RETRY_REMAINING,
		sourceUpdatedAt,
		forceDirtyWhenNotAdvanced ? 1 : 0,
		GLOBAL_KIND,
		globalJobKey(cwd),
	);
}

export function markStage1SucceededWithOutput(
	db: Database,
	params: {
		threadId: string;
		ownershipToken: string;
		sourceUpdatedAt: number;
		rawMemory: string;
		rolloutSummary: string;
		rolloutSlug: string | null;
		nowSec: number;
		cwd: string;
	},
): boolean {
	const { threadId, ownershipToken, sourceUpdatedAt, rawMemory, rolloutSummary, rolloutSlug, nowSec, cwd } = params;
	const tx = db.transaction(() => {
		const matched = db
			.prepare(
				"SELECT 1 AS ok FROM jobs WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?",
			)
			.get(STAGE1_KIND, threadId, ownershipToken) as { ok?: number } | undefined;
		if (!matched?.ok) return false;

		db.prepare(`
UPDATE jobs
SET status = 'done', finished_at = ?, lease_until = NULL, retry_at = NULL,
	last_error = NULL, last_success_watermark = input_watermark
WHERE kind = ? AND job_key = ? AND ownership_token = ?
`).run(nowSec, STAGE1_KIND, threadId, ownershipToken);

		db.prepare(`
INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(thread_id) DO UPDATE SET
	source_updated_at = excluded.source_updated_at,
	raw_memory = excluded.raw_memory,
	rollout_summary = excluded.rollout_summary,
	rollout_slug = excluded.rollout_slug,
	generated_at = excluded.generated_at
WHERE excluded.source_updated_at >= stage1_outputs.source_updated_at
`).run(threadId, sourceUpdatedAt, rawMemory, rolloutSummary, rolloutSlug, nowSec);

		enqueueGlobalWatermark(db, sourceUpdatedAt, cwd, { forceDirtyWhenNotAdvanced: true });
		return true;
	});
	return tx() as boolean;
}

export function markStage1SucceededNoOutput(
	db: Database,
	params: { threadId: string; ownershipToken: string; sourceUpdatedAt: number; nowSec: number; cwd: string },
): boolean {
	const { threadId, ownershipToken, sourceUpdatedAt, nowSec, cwd } = params;
	const tx = db.transaction(() => {
		const matched = db
			.prepare(
				"SELECT 1 AS ok FROM jobs WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?",
			)
			.get(STAGE1_KIND, threadId, ownershipToken) as { ok?: number } | undefined;
		if (!matched?.ok) return false;

		db.prepare(`
UPDATE jobs
SET status = 'done', finished_at = ?, lease_until = NULL, retry_at = NULL,
	last_error = NULL, last_success_watermark = input_watermark
WHERE kind = ? AND job_key = ? AND ownership_token = ?
`).run(nowSec, STAGE1_KIND, threadId, ownershipToken);

		db.prepare("DELETE FROM stage1_outputs WHERE thread_id = ?").run(threadId);
		enqueueGlobalWatermark(db, sourceUpdatedAt, cwd, { forceDirtyWhenNotAdvanced: true });
		return true;
	});
	return tx() as boolean;
}

export function markStage1Failed(
	db: Database,
	params: { threadId: string; ownershipToken: string; retryDelaySeconds: number; reason: string; nowSec: number },
): boolean {
	const { threadId, ownershipToken, retryDelaySeconds, reason, nowSec } = params;
	const result = db
		.prepare(`
UPDATE jobs
SET status = 'error', finished_at = ?, lease_until = NULL, retry_at = ?,
	retry_remaining = CASE WHEN retry_remaining > 0 THEN retry_remaining - 1 ELSE 0 END,
	last_error = ?
WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?
`)
		.run(nowSec, nowSec + retryDelaySeconds, reason, STAGE1_KIND, threadId, ownershipToken);
	return Number(result.changes ?? 0) > 0;
}

export function tryClaimGlobalPhase2Job(
	db: Database,
	params: { workerId: string; leaseSeconds: number; nowSec: number; cwd: string },
): { kind: "claimed"; claim: GlobalClaim } | { kind: "skipped_not_dirty" } | { kind: "skipped_running" } {
	const { workerId, leaseSeconds, nowSec, cwd } = params;
	const jobKey = globalJobKey(cwd);
	ensureGlobalJob(db, cwd);
	const pre = db
		.prepare(
			"SELECT status, lease_until, input_watermark, last_success_watermark, retry_at, retry_remaining FROM jobs WHERE kind = ? AND job_key = ?",
		)
		.get(GLOBAL_KIND, jobKey) as
		| {
				status: string;
				lease_until: number | null;
				input_watermark: number | null;
				last_success_watermark: number | null;
				retry_at: number | null;
				retry_remaining: number;
		  }
		| undefined;
	if (!pre) return { kind: "skipped_not_dirty" };
	const ownershipToken = crypto.randomUUID();
	const claimed = db
		.prepare(`
UPDATE jobs
SET status = 'running', worker_id = ?, ownership_token = ?, started_at = ?, finished_at = NULL,
	lease_until = ?, retry_at = NULL, last_error = NULL
WHERE kind = ? AND job_key = ?
	AND NOT (status = 'running' AND lease_until IS NOT NULL AND lease_until > ?)
	AND (input_watermark IS NOT NULL AND (last_success_watermark IS NULL OR input_watermark > last_success_watermark))
	AND retry_remaining > 0
	AND (retry_at IS NULL OR retry_at <= ?)
`)
		.run(workerId, ownershipToken, nowSec, nowSec + leaseSeconds, GLOBAL_KIND, jobKey, nowSec, nowSec);
	if (Number(claimed.changes ?? 0) > 0) {
		const row = db
			.prepare("SELECT input_watermark FROM jobs WHERE kind = ? AND job_key = ? AND ownership_token = ?")
			.get(GLOBAL_KIND, jobKey, ownershipToken) as { input_watermark: number | null } | undefined;
		return {
			kind: "claimed",
			claim: {
				ownershipToken,
				inputWatermark: row?.input_watermark ?? 0,
			},
		};
	}

	if (pre.status === "running" && pre.lease_until !== null && pre.lease_until > nowSec) {
		return { kind: "skipped_running" };
	}
	const preInput = pre.input_watermark ?? 0;
	const preSuccess = pre.last_success_watermark ?? 0;
	if (preInput <= preSuccess) {
		return { kind: "skipped_not_dirty" };
	}
	if (pre.retry_remaining <= 0) {
		return { kind: "skipped_not_dirty" };
	}
	if (pre.retry_at !== null && pre.retry_at > nowSec) {
		return { kind: "skipped_not_dirty" };
	}

	const post = db
		.prepare(
			"SELECT status, lease_until, input_watermark, last_success_watermark, retry_at, retry_remaining FROM jobs WHERE kind = ? AND job_key = ?",
		)
		.get(GLOBAL_KIND, jobKey) as
		| {
				status: string;
				lease_until: number | null;
				input_watermark: number | null;
				last_success_watermark: number | null;
				retry_at: number | null;
				retry_remaining: number;
		  }
		| undefined;
	if (!post) return { kind: "skipped_not_dirty" };
	if (post.status === "running" && post.lease_until !== null && post.lease_until > nowSec) {
		return { kind: "skipped_running" };
	}

	return { kind: "skipped_not_dirty" };
}

export function heartbeatGlobalJob(
	db: Database,
	params: { ownershipToken: string; leaseSeconds: number; nowSec: number; cwd: string },
): boolean {
	const { ownershipToken, leaseSeconds, nowSec, cwd } = params;
	const result = db
		.prepare(`
UPDATE jobs
SET lease_until = ?
WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?
`)
		.run(nowSec + leaseSeconds, GLOBAL_KIND, globalJobKey(cwd), ownershipToken);
	return Number(result.changes ?? 0) > 0;
}

// Filter by cwd so each project only consolidates its own thread outputs.
// Before this filter existed, whichever project ran Phase 2 first got every
// project's data written into its memory directory (see #369).
export function listStage1OutputsForGlobal(db: Database, limit: number, cwd: string): Stage1OutputRow[] {
	const rows = db
		.prepare(`
SELECT o.thread_id, o.source_updated_at, o.raw_memory, o.rollout_summary, o.rollout_slug, o.generated_at, t.cwd
FROM stage1_outputs o
LEFT JOIN threads t ON t.id = o.thread_id
WHERE (TRIM(COALESCE(o.raw_memory, '')) != '' OR TRIM(COALESCE(o.rollout_summary, '')) != '')
  AND t.cwd = ?
  AND o.thread_id NOT IN (SELECT thread_id FROM forgotten_threads)
ORDER BY o.source_updated_at DESC
LIMIT ?
`)
		.all(normalizeScopeCwd(cwd), limit) as Array<{
		thread_id: string;
		source_updated_at: number;
		raw_memory: string;
		rollout_summary: string;
		rollout_slug: string | null;
		generated_at: number;
		cwd: string | null;
	}>;
	return rows.map(row => ({
		threadId: row.thread_id,
		sourceUpdatedAt: row.source_updated_at,
		rawMemory: row.raw_memory,
		rolloutSummary: row.rollout_summary,
		rolloutSlug: row.rollout_slug,
		generatedAt: row.generated_at,
		cwd: row.cwd ?? "",
	}));
}

export function markGlobalPhase2Succeeded(
	db: Database,
	params: { ownershipToken: string; newWatermark: number; nowSec: number; cwd: string },
): boolean {
	const { ownershipToken, newWatermark, nowSec, cwd } = params;
	const result = db
		.prepare(`
UPDATE jobs
SET status = 'done', finished_at = ?, lease_until = NULL, retry_at = NULL,
	last_error = NULL,
	last_success_watermark = CASE
		WHEN last_success_watermark IS NULL THEN ?
		WHEN last_success_watermark < ? THEN ?
		ELSE last_success_watermark
	END
WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?
`)
		.run(nowSec, newWatermark, newWatermark, newWatermark, GLOBAL_KIND, globalJobKey(cwd), ownershipToken);
	return Number(result.changes ?? 0) > 0;
}

export function markGlobalPhase2Failed(
	db: Database,
	params: { ownershipToken: string; retryDelaySeconds: number; reason: string; nowSec: number; cwd: string },
): boolean {
	const { ownershipToken, retryDelaySeconds, reason, nowSec, cwd } = params;
	const result = db
		.prepare(`
UPDATE jobs
SET status = 'error', finished_at = ?, lease_until = NULL, retry_at = ?,
	retry_remaining = CASE WHEN retry_remaining > 0 THEN retry_remaining - 1 ELSE 0 END,
	last_error = ?
WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?
`)
		.run(nowSec, nowSec + retryDelaySeconds, reason, GLOBAL_KIND, globalJobKey(cwd), ownershipToken);
	return Number(result.changes ?? 0) > 0;
}

export function markGlobalPhase2FailedUnowned(
	db: Database,
	params: { retryDelaySeconds: number; reason: string; nowSec: number; cwd: string },
): boolean {
	const { retryDelaySeconds, reason, nowSec, cwd } = params;
	const result = db
		.prepare(`
UPDATE jobs
SET status = 'error', finished_at = ?, lease_until = NULL, retry_at = ?,
	retry_remaining = CASE WHEN retry_remaining > 0 THEN retry_remaining - 1 ELSE 0 END,
	last_error = ?
WHERE kind = ? AND job_key = ? AND status = 'running'
	AND (ownership_token IS NULL OR lease_until IS NULL OR lease_until <= ?)
`)
		.run(nowSec, nowSec + retryDelaySeconds, reason, GLOBAL_KIND, globalJobKey(cwd), nowSec);
	return Number(result.changes ?? 0) > 0;
}

/** A session's standing in one project's memory, joined for review surfaces. */
export interface MemorySourceRow {
	threadId: string;
	updatedAt: number;
	rolloutPath: string;
	output?: Omit<Stage1OutputRow, "threadId" | "cwd">;
	job?: {
		status: string;
		leaseUntil: number | null;
		lastError: string | null;
		retryAt: number | null;
		retryRemaining: number;
		lastSuccessWatermark: number | null;
	};
	forgottenAt?: number;
}

/** Every session the memory pipeline has seen for `cwd`, newest first, plus sessions forgotten there. */
export function listMemorySources(db: Database, cwd: string): MemorySourceRow[] {
	const scope = normalizeScopeCwd(cwd);
	const rows = db
		.prepare(`
SELECT t.id AS thread_id, t.updated_at, t.rollout_path,
	o.source_updated_at, o.raw_memory, o.rollout_summary, o.rollout_slug, o.generated_at,
	j.status, j.lease_until, j.last_error, j.retry_at, j.retry_remaining, j.last_success_watermark,
	f.forgotten_at
FROM threads t
LEFT JOIN stage1_outputs o ON o.thread_id = t.id
LEFT JOIN jobs j ON j.kind = ? AND j.job_key = t.id
LEFT JOIN forgotten_threads f ON f.thread_id = t.id
WHERE t.cwd = ?
UNION ALL
SELECT f.thread_id, 0, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, f.forgotten_at
FROM forgotten_threads f
WHERE f.cwd = ? AND f.thread_id NOT IN (SELECT id FROM threads)
ORDER BY 2 DESC
`)
		.all(STAGE1_KIND, scope, scope) as Array<{
		thread_id: string;
		updated_at: number;
		rollout_path: string;
		source_updated_at: number | null;
		raw_memory: string | null;
		rollout_summary: string | null;
		rollout_slug: string | null;
		generated_at: number | null;
		status: string | null;
		lease_until: number | null;
		last_error: string | null;
		retry_at: number | null;
		retry_remaining: number | null;
		last_success_watermark: number | null;
		forgotten_at: number | null;
	}>;
	return rows.map(row => ({
		threadId: row.thread_id,
		updatedAt: row.updated_at,
		rolloutPath: row.rollout_path,
		output:
			row.source_updated_at === null
				? undefined
				: {
						sourceUpdatedAt: row.source_updated_at,
						rawMemory: row.raw_memory ?? "",
						rolloutSummary: row.rollout_summary ?? "",
						rolloutSlug: row.rollout_slug,
						generatedAt: row.generated_at ?? 0,
					},
		job:
			row.status === null
				? undefined
				: {
						status: row.status,
						leaseUntil: row.lease_until,
						lastError: row.last_error,
						retryAt: row.retry_at,
						retryRemaining: row.retry_remaining ?? 0,
						lastSuccessWatermark: row.last_success_watermark,
					},
		forgottenAt: row.forgotten_at ?? undefined,
	}));
}

export interface ConsolidationJobState {
	status: string;
	finishedAt: number | null;
	leaseUntil: number | null;
	lastError: string | null;
	retryAt: number | null;
	retryRemaining: number;
	/** Sources changed since the last successful consolidation. */
	dirty: boolean;
}

/** Phase 2 job state for `cwd`, or undefined before the project's first consolidation. */
export function readConsolidationJob(db: Database, cwd: string): ConsolidationJobState | undefined {
	const row = db
		.prepare(
			"SELECT status, finished_at, lease_until, last_error, retry_at, retry_remaining, input_watermark, last_success_watermark FROM jobs WHERE kind = ? AND job_key = ?",
		)
		.get(GLOBAL_KIND, globalJobKey(cwd)) as
		| {
				status: string;
				finished_at: number | null;
				lease_until: number | null;
				last_error: string | null;
				retry_at: number | null;
				retry_remaining: number;
				input_watermark: number | null;
				last_success_watermark: number | null;
		  }
		| undefined;
	if (!row) return undefined;
	return {
		status: row.status,
		finishedAt: row.finished_at,
		leaseUntil: row.lease_until,
		lastError: row.last_error,
		retryAt: row.retry_at,
		retryRemaining: row.retry_remaining,
		dirty: (row.input_watermark ?? 0) > (row.last_success_watermark ?? 0),
	};
}

/**
 * Keep a session out of `cwd`'s memory: drop what was taken from it, never read it again (even
 * after it changes), and mark the project for re-consolidation so the knowledge built on it goes.
 */
export function forgetMemorySource(db: Database, params: { threadId: string; cwd: string; nowSec: number }): void {
	const { threadId, cwd, nowSec } = params;
	db.transaction(() => {
		db.prepare("INSERT OR REPLACE INTO forgotten_threads (thread_id, cwd, forgotten_at) VALUES (?, ?, ?)").run(
			threadId,
			normalizeScopeCwd(cwd),
			nowSec,
		);
		db.prepare("DELETE FROM stage1_outputs WHERE thread_id = ?").run(threadId);
		enqueueGlobalWatermark(db, nowSec, cwd, { forceDirtyWhenNotAdvanced: true });
	})();
}

/** Undo {@link forgetMemorySource}: the session is read again on the next memory update. */
export function restoreMemorySource(db: Database, threadId: string): void {
	db.transaction(() => {
		db.prepare("DELETE FROM forgotten_threads WHERE thread_id = ?").run(threadId);
		db.prepare(`
UPDATE jobs
SET status = 'pending', input_watermark = NULL, last_success_watermark = NULL,
	retry_at = NULL, retry_remaining = ?, last_error = NULL
WHERE kind = ? AND job_key = ? AND NOT (status = 'running' AND lease_until IS NOT NULL AND lease_until > ?)
`).run(DEFAULT_RETRY_REMAINING, STAGE1_KIND, threadId, Math.floor(Date.now() / 1000));
	})();
}

/**
 * Erase `cwd`'s memory state. The sessions in `threadIds` (the project's sessions as of now) are
 * marked forgotten so the next update does not rebuild the same memory from them; sessions that
 * start or change afterwards are remembered as usual.
 */
export function eraseProjectMemory(db: Database, params: { cwd: string; threadIds: string[]; nowSec: number }): void {
	const scope = normalizeScopeCwd(params.cwd);
	db.transaction(() => {
		db.prepare("DELETE FROM stage1_outputs WHERE thread_id IN (SELECT id FROM threads WHERE cwd = ?)").run(scope);
		db.prepare("DELETE FROM jobs WHERE kind = ? AND job_key IN (SELECT id FROM threads WHERE cwd = ?)").run(
			STAGE1_KIND,
			scope,
		);
		db.prepare("DELETE FROM jobs WHERE kind = ? AND job_key = ?").run(GLOBAL_KIND, globalJobKey(params.cwd));
		db.prepare("DELETE FROM threads WHERE cwd = ?").run(scope);
		const forget = db.prepare(
			"INSERT OR REPLACE INTO forgotten_threads (thread_id, cwd, forgotten_at) VALUES (?, ?, ?)",
		);
		for (const threadId of params.threadIds) forget.run(threadId, scope, params.nowSec);
	})();
}
