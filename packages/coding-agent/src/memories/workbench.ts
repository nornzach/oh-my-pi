/**
 * Host-facing view of one project's local memory: what a new session is given, where it came
 * from, and the edits a person can make to it (notes, lessons, forgetting sources, erasing).
 *
 * The rollout pipeline in `./index.ts` stays the only writer of consolidated artifacts; this
 * module reads them, edits the user-owned lists, and asks the pipeline to run.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDbPath, getSessionsDir, isEnoent, logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { cfgMemoryBackend } from "../memory-backend/settings";
import type { AgentSession } from "../session/agent-session";
import { sessionDirForCwd } from "../session/session-paths";
import {
	collectThreadsInDir,
	getMemoryActivity,
	getMemoryRoot,
	loadMemoryConfig,
	type MemoryActivity,
	type MemoryInjectionPlan,
	type MemoryListEntry,
	type MemoryScope,
	planMemoryInjection,
	readMemoryList,
	readMemorySnapshot,
	resolveMemoryModel,
	runMemoryUpdate,
} from "./index";
import {
	type ConsolidationJobState,
	closeMemoryDb,
	eraseProjectMemory,
	forgetMemorySource,
	listMemorySources,
	type MemorySourceRow,
	normalizeScopeCwd,
	openMemoryDb,
	readConsolidationJob,
	restoreMemorySource,
} from "./storage";

/** Where a session stands in its project's memory. */
export type MemorySourceState =
	/** Read, and something was worth keeping. */
	| "remembered"
	/** Read; nothing in it was worth keeping. */
	| "nothing"
	/** Kept out of memory by the user. */
	| "forgotten"
	/** Being read right now. */
	| "reading"
	/** Reading failed; it is retried later. */
	| "failed"
	/** Changed too recently; read once it has been idle long enough. */
	| "waiting"
	/** Eligible and not read yet. */
	| "queued"
	/** Older than the pipeline looks back. */
	| "old";

export interface MemorySource {
	threadId: string;
	/** The session file; absent when the session was deleted after being read. */
	sessionPath?: string;
	title?: string;
	/** Last change to the session, ms since epoch (0 when unknown). */
	updatedAt: number;
	state: MemorySourceState;
	/** What was taken from it (`remembered` only). */
	summary?: string;
	/** When it was read, ms since epoch. */
	readAt?: number;
	/** It changed after being read; the new part is read on a later update. */
	changedSinceRead?: boolean;
	forgottenAt?: number;
	error?: string;
}

/** A playbook the consolidation wrote under `skills/` for the agent to consult. */
export interface MemoryPlaybook {
	name: string;
	description: string;
	content: string;
}

export interface MemoryOverview {
	cwd: string;
	/** The project's memory folder (may not exist yet). */
	root: string;
	/** The selected `memory.backend`; the workbench edits only the local one. */
	backend: string;
	enabled: boolean;
	notes: MemoryListEntry[];
	lessons: MemoryListEntry[];
	/** `memory_summary.md`: the consolidated digest every new session starts with. */
	summary: string;
	/** `MEMORY.md`: the full consolidated notes the agent can open on demand. */
	full: string;
	playbooks: MemoryPlaybook[];
	injection: Omit<MemoryInjectionPlan, "notes" | "summary" | "learned">;
	sources: MemorySource[];
	/** Memory work under way for this project, here or in another omp process. */
	activity?: MemoryActivity & { elsewhere: boolean };
	consolidation: {
		/** When the summary was last rebuilt, ms since epoch. */
		updatedAt?: number;
		/** The last rebuild failed with this error and will be retried. */
		error?: string;
		/** Sources changed since the last rebuild. */
		pending: boolean;
	};
	limits: { idleHours: number; maxAgeDays: number; perUpdate: number };
	/** Models the next update would use, as `provider/id`. */
	models: { read?: string; consolidate?: string };
}

/** The project scope for `cwd`: its memory key and where its sessions are stored. */
export function memoryScopeFor(agentDir: string, cwd: string): MemoryScope {
	const resolved = path.resolve(cwd);
	return { cwd: resolved, sessionDir: sessionDirForCwd(resolved, getSessionsDir(agentDir)) };
}

/** Everything a host shows about one project's memory. */
export async function readMemoryOverview(options: {
	agentDir: string;
	settings: Settings;
	scope: MemoryScope;
	session?: AgentSession;
	modelRegistry?: ModelRegistry;
}): Promise<MemoryOverview> {
	const { agentDir, settings, scope } = options;
	const config = loadMemoryConfig(settings);
	const root = getMemoryRoot(agentDir, scope.cwd);
	const [snapshot, notes, lessons, full, playbooks, summaryStat, threads] = await Promise.all([
		readMemorySnapshot(root),
		readMemoryList(root, "notes"),
		readMemoryList(root, "lessons"),
		readText(path.join(root, "MEMORY.md")),
		readPlaybooks(path.join(root, "skills")),
		statOrUndefined(path.join(root, "memory_summary.md")),
		collectThreadsInDir(scope.sessionDir),
	]);
	const {
		notes: _n,
		summary: _s,
		learned: _l,
		...injection
	} = planMemoryInjection(snapshot, config.summaryInjectionTokenLimit);

	const nowSec = Math.floor(Date.now() / 1000);
	const db = openMemoryDb(getAgentDbPath(agentDir));
	let rows: MemorySourceRow[];
	let job: ConsolidationJobState | undefined;
	try {
		rows = listMemorySources(db, scope.cwd);
		job = readConsolidationJob(db, scope.cwd);
	} finally {
		closeMemoryDb(db);
	}

	const byId = new Map(rows.map(row => [row.threadId, row]));
	const sources: MemorySource[] = [];
	const seen = new Set<string>();
	const scopeKey = normalizeScopeCwd(scope.cwd);
	for (const thread of threads) {
		// A session moved into this bucket from another project belongs to that project.
		if (thread.cwd && normalizeScopeCwd(path.resolve(thread.cwd)) !== scopeKey) continue;
		seen.add(thread.id);
		sources.push(
			describeSource(byId.get(thread.id), {
				threadId: thread.id,
				sessionPath: thread.rolloutPath,
				title: thread.title,
				updatedAt: thread.updatedAt,
				nowSec,
				idleHours: config.minRolloutIdleHours,
				maxAgeDays: config.maxRolloutAgeDays,
			}),
		);
	}
	for (const row of rows) {
		if (seen.has(row.threadId)) continue;
		// A deleted session still matters while memory holds something from it.
		if (!row.output && row.forgottenAt === undefined) continue;
		sources.push(
			describeSource(row, {
				threadId: row.threadId,
				updatedAt: row.updatedAt,
				nowSec,
				idleHours: config.minRolloutIdleHours,
				maxAgeDays: config.maxRolloutAgeDays,
			}),
		);
	}
	sources.sort((a, b) => b.updatedAt - a.updatedAt);

	const activity = describeActivity(scope, {
		reading: sources.some(s => s.state === "reading"),
		consolidating: job?.status === "running" && (job.leaseUntil ?? 0) > nowSec,
	});

	const backend = cfgMemoryBackend.get(settings);
	return {
		cwd: scope.cwd,
		root,
		backend,
		enabled: config.enabled,
		notes,
		lessons,
		summary: snapshot.summary,
		full,
		playbooks,
		injection,
		sources,
		activity,
		consolidation: {
			updatedAt: summaryStat?.mtimeMs,
			error: job?.status === "error" && job.lastError ? job.lastError : undefined,
			pending: job?.dirty ?? false,
		},
		limits: {
			idleHours: config.minRolloutIdleHours,
			maxAgeDays: config.maxRolloutAgeDays,
			perUpdate: config.maxRolloutsPerStartup,
		},
		models: await describeMemoryModels(options.session, options.modelRegistry),
	};
}

/** Memory work under way for a project: this process's own runs, else leases held by another omp. */
export function readMemoryActivity(agentDir: string, scope: MemoryScope): MemoryOverview["activity"] {
	if (getMemoryActivity(scope.cwd)) return describeActivity(scope, { reading: false, consolidating: false });
	const nowSec = Math.floor(Date.now() / 1000);
	const db = openMemoryDb(getAgentDbPath(agentDir));
	try {
		const job = readConsolidationJob(db, scope.cwd);
		const reading = listMemorySources(db, scope.cwd).some(
			row => row.job?.status === "running" && (row.job.leaseUntil ?? 0) > nowSec,
		);
		return describeActivity(scope, {
			reading,
			consolidating: job?.status === "running" && (job.leaseUntil ?? 0) > nowSec,
		});
	} finally {
		closeMemoryDb(db);
	}
}

function describeActivity(
	scope: MemoryScope,
	leases: { reading: boolean; consolidating: boolean },
): MemoryOverview["activity"] {
	const local = getMemoryActivity(scope.cwd);
	if (local) return { ...local, elsewhere: false };
	if (!leases.reading && !leases.consolidating) return undefined;
	return { phase: leases.reading ? "reading" : "consolidating", done: 0, total: 0, elsewhere: true };
}

function describeSource(
	row: MemorySourceRow | undefined,
	file: {
		threadId: string;
		sessionPath?: string;
		title?: string;
		updatedAt: number;
		nowSec: number;
		idleHours: number;
		maxAgeDays: number;
	},
): MemorySource {
	const base = {
		threadId: file.threadId,
		...(file.sessionPath ? { sessionPath: file.sessionPath } : {}),
		...(file.title ? { title: file.title } : {}),
		updatedAt: file.updatedAt * 1000,
	};
	if (row?.forgottenAt !== undefined) return { ...base, state: "forgotten", forgottenAt: row.forgottenAt * 1000 };
	const job = row?.job;
	if (job?.status === "running" && (job.leaseUntil ?? 0) > file.nowSec) return { ...base, state: "reading" };
	const output = row?.output;
	if (output && (output.rolloutSummary.trim() || output.rawMemory.trim())) {
		return {
			...base,
			state: "remembered",
			summary: output.rolloutSummary.trim(),
			readAt: output.generatedAt * 1000,
			...(output.sourceUpdatedAt < file.updatedAt ? { changedSinceRead: true } : {}),
		};
	}
	if (job?.status === "done" && (job.lastSuccessWatermark ?? 0) >= file.updatedAt) {
		return { ...base, state: "nothing" };
	}
	if (job?.status === "error" && job.lastError) return { ...base, state: "failed", error: job.lastError };
	const age = file.nowSec - file.updatedAt;
	if (age > file.maxAgeDays * 86_400) return { ...base, state: "old" };
	if (age < file.idleHours * 3_600) return { ...base, state: "waiting" };
	return { ...base, state: "queued" };
}

async function describeMemoryModels(
	session: AgentSession | undefined,
	modelRegistry: ModelRegistry | undefined,
): Promise<MemoryOverview["models"]> {
	if (!session || !modelRegistry) return {};
	try {
		const [read, consolidate] = await Promise.all([
			resolveMemoryModel({ modelRegistry, session, fallbackRole: "default" }),
			resolveMemoryModel({ modelRegistry, session, fallbackRole: "smol" }),
		]);
		return {
			...(read ? { read: `${read.provider}/${read.id}` } : {}),
			...(consolidate ? { consolidate: `${consolidate.provider}/${consolidate.id}` } : {}),
		};
	} catch (error) {
		logger.debug("Memory overview: model resolution failed", { error: String(error) });
		return {};
	}
}

async function readText(filePath: string): Promise<string> {
	try {
		return (await Bun.file(filePath).text()).trim();
	} catch (err) {
		if (isEnoent(err)) return "";
		throw err;
	}
}

async function statOrUndefined(filePath: string): Promise<{ mtimeMs: number } | undefined> {
	try {
		return await fs.stat(filePath);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

async function readPlaybooks(skillsDir: string): Promise<MemoryPlaybook[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(skillsDir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const playbooks: MemoryPlaybook[] = [];
	for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
		const content = await readText(path.join(skillsDir, entry, "SKILL.md"));
		if (!content) continue;
		const { frontmatter, body } = parseFrontmatter(content, { level: "off" });
		const name = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : entry;
		const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
		playbooks.push({ name, description, content: body.trim() });
	}
	return playbooks;
}

/** Runs this process started, by project; a second request joins the one in flight. */
const updatesInFlight = new Map<string, Promise<void>>();

/**
 * Start bringing a project's memory up to date in the background. Returns false when this
 * process is already updating it; progress shows in {@link readMemoryOverview}'s `activity`.
 */
export function startMemoryUpdate(options: {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	scope: MemoryScope;
	minIdleMinutes: number;
}): boolean {
	const key = normalizeScopeCwd(options.scope.cwd);
	if (updatesInFlight.has(key)) return false;
	const run = runMemoryUpdate({ ...options, signal: new AbortController().signal })
		.catch(error => logger.warn("Memory update failed", { cwd: options.scope.cwd, error: String(error) }))
		.finally(() => updatesInFlight.delete(key));
	updatesInFlight.set(key, run);
	return true;
}

/** Resolves when this process's update of `scope` (if any) has finished. */
export async function memoryUpdateSettled(scope: MemoryScope): Promise<void> {
	await updatesInFlight.get(normalizeScopeCwd(scope.cwd));
}

/** Keep one session out of a project's memory, or take it back in. */
export function setMemorySourceForgotten(
	agentDir: string,
	scope: MemoryScope,
	threadId: string,
	forgotten: boolean,
): void {
	const db = openMemoryDb(getAgentDbPath(agentDir));
	try {
		if (forgotten) forgetMemorySource(db, { threadId, cwd: scope.cwd, nowSec: Math.floor(Date.now() / 1000) });
		else restoreMemorySource(db, threadId);
	} finally {
		closeMemoryDb(db);
	}
}

/**
 * Erase what omp remembers about a project — consolidated knowledge, notes, lessons, and what
 * was read from each session. The sessions that exist now stay forgotten, so the memory is not
 * rebuilt from them; later sessions are remembered as usual while memory is on.
 */
export async function eraseMemory(agentDir: string, scope: MemoryScope): Promise<void> {
	const threads = await collectThreadsInDir(scope.sessionDir);
	const scopeKey = normalizeScopeCwd(scope.cwd);
	const threadIds = threads
		.filter(thread => !thread.cwd || normalizeScopeCwd(path.resolve(thread.cwd)) === scopeKey)
		.map(thread => thread.id);
	const db = openMemoryDb(getAgentDbPath(agentDir));
	try {
		eraseProjectMemory(db, { cwd: scope.cwd, threadIds, nowSec: Math.floor(Date.now() / 1000) });
	} finally {
		closeMemoryDb(db);
	}
	await fs.rm(getMemoryRoot(agentDir, scope.cwd), { recursive: true, force: true });
}
