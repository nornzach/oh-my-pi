import type { Database } from "bun:sqlite";
import type * as fsNode from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type ApiKey, completeSimple, Effort, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	getAgentDbPath,
	getMemoriesDir,
	isEnoent,
	logger,
	parseJsonlLenient,
	peekFile,
	prompt,
} from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { redactMemorySecrets as redactSecrets } from "../memory-backend/redact";
import type { MemoryBackendSaveInput, MemoryBackendSaveResult } from "../memory-backend/types";
import consolidationTemplate from "../prompts/memories/consolidation.md" with { type: "text" };
import consolidationSystemTemplate from "../prompts/memories/consolidation_system.md" with { type: "text" };
import readPathTemplate from "../prompts/memories/read-path.md" with { type: "text" };
import stageOneInputTemplate from "../prompts/memories/stage_one_input.md" with { type: "text" };
import stageOneSystemTemplate from "../prompts/memories/stage_one_system.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import {
	claimStage1Jobs,
	clearMemoryData as clearMemoryDataInDb,
	closeMemoryDb,
	countClaimableStage1Threads,
	enqueueGlobalWatermark,
	heartbeatGlobalJob,
	listStage1OutputsForGlobal,
	type MemoryThread,
	markGlobalPhase2Failed,
	markGlobalPhase2FailedUnowned,
	markGlobalPhase2Succeeded,
	markStage1Failed,
	markStage1SucceededNoOutput,
	markStage1SucceededWithOutput,
	normalizeScopeCwd,
	openMemoryDb,
	type Stage1Claim,
	type Stage1OutputRow,
	tryClaimGlobalPhase2Job,
	upsertThreads,
} from "./storage";

import {
	cfgMemoriesFallbackTokenLimit,
	cfgMemoriesMaxRawMemoriesForGlobal,
	cfgMemoriesMaxRolloutAgeDays,
	cfgMemoriesMaxRolloutsPerStartup,
	cfgMemoriesMinRolloutIdleHours,
	cfgMemoriesPhase1InputTokenLimit,
	cfgMemoriesPhase2HeartbeatSeconds,
	cfgMemoriesPhase2LeaseSeconds,
	cfgMemoriesPhase2RetryDelaySeconds,
	cfgMemoriesRolloutPayloadPercent,
	cfgMemoriesStage1Concurrency,
	cfgMemoriesStage1LeaseSeconds,
	cfgMemoriesStage1RetryDelaySeconds,
	cfgMemoriesSummaryInjectionTokenLimit,
	cfgMemoriesThreadScanLimit,
} from "./settings";
import { cfgMemoryBackend } from "../memory-backend/settings";

export interface MemoryRuntimeConfig {
	enabled: boolean;
	maxRolloutsPerStartup: number;
	maxRolloutAgeDays: number;
	minRolloutIdleHours: number;
	threadScanLimit: number;
	maxRawMemoriesForGlobal: number;
	stage1Concurrency: number;
	stage1LeaseSeconds: number;
	stage1RetryDelaySeconds: number;
	phase2LeaseSeconds: number;
	phase2RetryDelaySeconds: number;
	phase2HeartbeatSeconds: number;
	rolloutPayloadPercent: number;
	phase1InputTokenLimit: number;
	fallbackTokenLimit: number;
	summaryInjectionTokenLimit: number;
}

interface Stage1Stats {
	claimed: number;
	succeeded: number;
	succeededNoOutput: number;
	failed: number;
	produced: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

interface Stage1OutputSchema {
	raw_memory: string;
	rollout_summary: string;
	rollout_slug: string | null;
}

interface ConsolidationSkillFileSchema {
	path: string;
	content: string;
}

interface ConsolidationSkillSchema {
	name: string;
	content?: string;
	scripts?: ConsolidationSkillFileSchema[];
	templates?: ConsolidationSkillFileSchema[];
	examples?: ConsolidationSkillFileSchema[];
}
interface ConsolidationOutputSchema {
	memory_md: string;
	memory_summary: string;
	skills: ConsolidationSkillSchema[];
}

/**
 * Start the background memory startup pipeline.
 *
 * Skips for ephemeral sessions, subagent sessions, disabled settings, or DB failures.
 */
export function startMemoryStartupTask(options: {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	taskDepth: number;
}): void {
	const { session, settings, modelRegistry, agentDir, taskDepth } = options;
	const cfg = loadMemoryConfig(settings);
	if (!cfg.enabled) return;
	if (taskDepth > 0) return;
	if (!session.sessionManager.getSessionFile()) return;

	const dbPath = getAgentDbPath(agentDir);
	try {
		const db = openMemoryDb(dbPath);
		closeMemoryDb(db);
	} catch (error) {
		logger.debug("Memory startup skipped: state DB unavailable", { error: String(error) });
		return;
	}

	const signal = session.beginLocalMemoryStartup?.() ?? new AbortController().signal;
	void runMemoryStartup({ session, settings, modelRegistry, agentDir, config: cfg, signal })
		.catch(error => {
			if (!signal.aborted) logger.warn("Memory startup failed", { error: String(error) });
		})
		.finally(() => session.endLocalMemoryStartup?.(signal));
}

interface MemoryInstructionSession {
	sessionManager: Pick<AgentSession["sessionManager"], "getSessionFile">;
	agent?: { state: { messages: readonly unknown[] } };
}

interface MemoryToolDeveloperInstructionsSnapshot {
	notes: string;
	summary: string;
	learned: string;
}

// The first user message means a request was built from the current prompt,
// and any signed thinking it returns is bound to that prompt.
function memoryConversationStarted(session: MemoryInstructionSession): boolean {
	return (session.agent?.state.messages.length ?? 0) > 0;
}

interface CachedMemoryToolDeveloperInstructions {
	sessionFile: string | undefined;
	snapshot: MemoryToolDeveloperInstructionsSnapshot | undefined;
	value: string | undefined;
}

const memoryToolDeveloperInstructionsBySession = new WeakMap<
	MemoryInstructionSession,
	CachedMemoryToolDeveloperInstructions
>();
const memoryToolDeveloperInstructionsByRoot = new Map<string, MemoryToolDeveloperInstructionsSnapshot | undefined>();

function getMemoryInstructionRoot(agentDir: string, settings: Settings): string {
	return getMemoryRoot(agentDir, settings.getCwd());
}

function getMemoryInstructionSessionFile(session: MemoryInstructionSession): string | undefined {
	return session.sessionManager.getSessionFile() ?? undefined;
}

async function readMemoryToolDeveloperInstructionsSnapshot(
	agentDir: string,
	settings: Settings,
): Promise<MemoryToolDeveloperInstructionsSnapshot | undefined> {
	const cfg = loadMemoryConfig(settings);
	if (!cfg.enabled) return undefined;
	const memoryRoot = getMemoryInstructionRoot(agentDir, settings);

	return readMemorySnapshot(memoryRoot);
}

/** The injectable memory parts of one project root; each is "" when absent or unreadable. */
export async function readMemorySnapshot(memoryRoot: string): Promise<MemoryToolDeveloperInstructionsSnapshot> {
	let summary = "";
	try {
		summary = (await Bun.file(path.join(memoryRoot, "memory_summary.md")).text()).trim();
	} catch {
		// Missing or unreadable summary — injection is best-effort; fall through
		// so notes and captured lessons still surface on their own.
	}
	const [notes, learned] = await Promise.all([
		readNeutralizedLines(memoryRoot, MEMORY_NOTES_FILE),
		readLearnedLessons(memoryRoot),
	]);
	return { notes, summary, learned };
}

/** What one project's memory contributes to a new session's prompt, within the injection budget. */
export interface MemoryInjectionPlan {
	notes: string;
	summary: string;
	learned: string;
	/** Approximate tokens each part uses (~4 chars/token, as the budget is counted). */
	tokens: { notes: number; summary: number; learned: number; budget: number };
	/** Notes and lessons are injected whole, newest lesson first; these count how many fit. */
	notesIncluded: number;
	lessonsIncluded: number;
	summaryTruncated: boolean;
}

/**
 * Split the injection budget: the user's notes first (they are standing instructions), then the
 * consolidated summary, then captured lessons. Lists keep whole bullets from the top so a note or
 * lesson is either in the prompt or not; the prose summary is cut head-and-tail.
 */
export function planMemoryInjection(
	snapshot: MemoryToolDeveloperInstructionsSnapshot,
	budget: number,
): MemoryInjectionPlan {
	let remaining = Math.max(0, budget);
	const spend = (text: string): number => {
		const tokens = Math.ceil(text.length / 4);
		remaining = Math.max(0, remaining - tokens);
		return tokens;
	};
	const notes = takeWholeLines(snapshot.notes, remaining);
	const notesTokens = spend(notes.text);
	const summary = snapshot.summary && remaining > 0 ? truncateByApproxTokens(snapshot.summary, remaining).trim() : "";
	const summaryTokens = spend(summary);
	const learned = takeWholeLines(snapshot.learned, remaining);
	const learnedTokens = spend(learned.text);
	return {
		notes: notes.text,
		summary,
		learned: learned.text,
		tokens: { notes: notesTokens, summary: summaryTokens, learned: learnedTokens, budget },
		notesIncluded: notes.bullets,
		lessonsIncluded: learned.bullets,
		summaryTruncated: summary !== snapshot.summary,
	};
}

/** Leading lines of `text` that fit in `tokenLimit` (~4 chars/token), never splitting a line. */
function takeWholeLines(text: string, tokenLimit: number): { text: string; bullets: number } {
	if (!text || tokenLimit <= 0) return { text: "", bullets: 0 };
	const maxChars = tokenLimit * 4;
	const kept: string[] = [];
	let used = 0;
	let bullets = 0;
	for (const line of text.split("\n")) {
		const cost = line.length + (kept.length > 0 ? 1 : 0);
		if (used + cost > maxChars) break;
		kept.push(line);
		used += cost;
		if (isListItem(line)) bullets++;
	}
	return { text: kept.join("\n").trim(), bullets };
}

function renderMemoryToolDeveloperInstructionsSnapshot(
	snapshot: MemoryToolDeveloperInstructionsSnapshot | undefined,
	settings: Settings,
): string | undefined {
	if (!snapshot) return undefined;
	const cfg = loadMemoryConfig(settings);
	if (!cfg.enabled) return undefined;
	// Notes, summary, and lessons share ONE injection budget so the combined
	// block stays within `summaryInjectionTokenLimit`; see planMemoryInjection.
	const plan = planMemoryInjection(snapshot, cfg.summaryInjectionTokenLimit);
	if (!plan.notes && !plan.summary && !plan.learned) return undefined;

	return prompt.render(readPathTemplate, {
		notes: plan.notes,
		memory_summary: plan.summary,
		learned: plan.learned,
	});
}

function cacheMemoryToolDeveloperInstructions(
	session: MemoryInstructionSession,
	sessionFile: string | undefined,
	snapshot: MemoryToolDeveloperInstructionsSnapshot | undefined,
	settings: Settings,
): string | undefined {
	const value = renderMemoryToolDeveloperInstructionsSnapshot(snapshot, settings);
	memoryToolDeveloperInstructionsBySession.set(session, { sessionFile, snapshot, value });
	return value;
}

/**
 * Drop the per-session memory instruction snapshot after explicit memory state
 * changes that must affect the active conversation immediately, such as
 * `/memory clear`.
 */
export function clearMemoryToolDeveloperInstructionsCache(session: MemoryInstructionSession | undefined): void {
	if (session) memoryToolDeveloperInstructionsBySession.delete(session);
}

/**
 * Refresh the active session's consolidated-memory snapshot after startup maintenance.
 *
 * Startup may finish after the first prompt build and write `memory_summary.md`.
 * The session adopts that summary only while it holds no messages: once a
 * request went out, signed thinking is bound to the prompt it carried, so the
 * new summary waits for the next session, whose cache key (session file) differs.
 * It must not reread `learned.md` or `notes.md`, because a `learn` call or note
 * edit racing with startup belongs to the next session's memory prompt, not the
 * active prompt-cache prefix.
 */
export async function refreshMemoryToolDeveloperInstructionsCacheAfterStartup(
	session: MemoryInstructionSession,
	agentDir: string,
	settings: Settings,
): Promise<void> {
	if (memoryConversationStarted(session)) return;
	const sessionFile = getMemoryInstructionSessionFile(session);
	const cached = memoryToolDeveloperInstructionsBySession.get(session);
	const current = await readMemoryToolDeveloperInstructionsSnapshot(agentDir, settings);
	if (memoryConversationStarted(session)) return;
	const root = getMemoryInstructionRoot(agentDir, settings);
	const baseline = memoryToolDeveloperInstructionsByRoot.get(root);
	const cachedSnapshot = cached && cached.sessionFile === sessionFile ? cached.snapshot : undefined;
	const learned = cachedSnapshot?.learned ?? baseline?.learned ?? "";
	const notes = cachedSnapshot?.notes ?? baseline?.notes ?? "";
	const snapshot = current ? { notes, summary: current.summary, learned } : undefined;
	cacheMemoryToolDeveloperInstructions(session, sessionFile, snapshot, settings);
}

/**
 * Build memory usage instructions for prompt injection.
 */
export async function buildMemoryToolDeveloperInstructions(
	agentDir: string,
	settings: Settings,
	session?: MemoryInstructionSession,
): Promise<string | undefined> {
	if (!session) {
		const snapshot = await readMemoryToolDeveloperInstructionsSnapshot(agentDir, settings);
		memoryToolDeveloperInstructionsByRoot.set(getMemoryInstructionRoot(agentDir, settings), snapshot);
		return renderMemoryToolDeveloperInstructionsSnapshot(snapshot, settings);
	}

	const sessionFile = getMemoryInstructionSessionFile(session);
	const cached = memoryToolDeveloperInstructionsBySession.get(session);
	if (cached && cached.sessionFile === sessionFile) return cached.value;

	const snapshot = await readMemoryToolDeveloperInstructionsSnapshot(agentDir, settings);
	return cacheMemoryToolDeveloperInstructions(session, sessionFile, snapshot, settings);
}

/**
 * Clear all persisted memory state and generated artifacts.
 */
export async function clearMemoryData(agentDir: string, cwd: string): Promise<void> {
	const db = openMemoryDb(getAgentDbPath(agentDir));
	try {
		clearMemoryDataInDb(db);
	} finally {
		closeMemoryDb(db);
	}
	await fs.rm(getMemoryRoot(agentDir, cwd), { recursive: true, force: true });
}

/**
 * Force-enqueue global consolidation maintenance work.
 */
export function enqueueMemoryConsolidation(agentDir: string, cwd: string, sourceUpdatedAt = unixNow()): void {
	const db = openMemoryDb(getAgentDbPath(agentDir));
	try {
		enqueueGlobalWatermark(db, sourceUpdatedAt, cwd, { forceDirtyWhenNotAdvanced: true });
	} finally {
		closeMemoryDb(db);
	}
}

interface MemoryStartupOptions {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	config: MemoryRuntimeConfig;
	signal: AbortSignal;
	/** Project to maintain, when a host asks for one other than the session's own. */
	scope?: MemoryScope;
}

/** A project whose memory a run maintains: its cwd and the directory its sessions live in. */
export interface MemoryScope {
	cwd: string;
	sessionDir: string;
}

/** A memory run in progress for one project, as hosts show it. */
export interface MemoryActivity {
	phase: "reading" | "consolidating";
	/** Sessions read so far and expected in this run (reading phase). */
	done: number;
	total: number;
}

const memoryActivityByScope = new Map<string, Set<MemoryActivity>>();

function trackMemoryActivity(cwd: string): MemoryActivity {
	const key = normalizeScopeCwd(cwd);
	const activity: MemoryActivity = { phase: "reading", done: 0, total: 0 };
	let runs = memoryActivityByScope.get(key);
	if (!runs) {
		runs = new Set();
		memoryActivityByScope.set(key, runs);
	}
	runs.add(activity);
	return activity;
}

function untrackMemoryActivity(cwd: string, activity: MemoryActivity): void {
	const key = normalizeScopeCwd(cwd);
	const runs = memoryActivityByScope.get(key);
	runs?.delete(activity);
	if (runs?.size === 0) memoryActivityByScope.delete(key);
}

/** The memory work this process is doing for `cwd`, merged across concurrent runs. */
export function getMemoryActivity(cwd: string): MemoryActivity | undefined {
	const runs = memoryActivityByScope.get(normalizeScopeCwd(cwd));
	if (!runs || runs.size === 0) return undefined;
	const merged: MemoryActivity = { phase: "consolidating", done: 0, total: 0 };
	for (const run of runs) {
		if (run.phase !== "reading") continue;
		merged.phase = "reading";
		merged.done += run.done;
		merged.total += run.total;
	}
	return merged;
}

/**
 * Bring one project's memory up to date now, on a host's request: read every session that has
 * been idle for `minIdleMinutes` (up to `memories.maxRolloutsPerStartup`), then re-consolidate.
 * Resolves when the run ends; progress is visible through {@link getMemoryActivity}.
 */
export async function runMemoryUpdate(options: {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	scope: MemoryScope;
	minIdleMinutes: number;
	signal: AbortSignal;
}): Promise<void> {
	const config = loadMemoryConfig(options.settings);
	if (!config.enabled) return;
	await runMemoryStartup({
		...options,
		config: { ...config, minRolloutIdleHours: Math.max(0, options.minIdleMinutes) / 60 },
	});
}

function isMemoryStartupActive(options: MemoryStartupOptions): boolean {
	return !options.signal.aborted && !options.session.isDisposed && cfgMemoryBackend.get(options.settings) === "local";
}

async function runMemoryStartup(options: MemoryStartupOptions): Promise<void> {
	if (!isMemoryStartupActive(options)) return;
	const cwd = options.scope?.cwd ?? options.session.sessionManager.getCwd();
	const activity = trackMemoryActivity(cwd);
	try {
		await runPhase1(options, activity);
		if (!isMemoryStartupActive(options)) return;
		activity.phase = "consolidating";
		await runPhase2(options);
	} finally {
		untrackMemoryActivity(cwd, activity);
	}
	if (!isMemoryStartupActive(options)) return;
	// Another project's run leaves this session's prompt alone.
	if (normalizeScopeCwd(cwd) !== normalizeScopeCwd(options.session.sessionManager.getCwd())) return;
	await refreshMemoryToolDeveloperInstructionsCacheAfterStartup(options.session, options.agentDir, options.settings);
	if (!isMemoryStartupActive(options)) return;
	if (memoryConversationStarted(options.session)) return;
	await options.session.refreshBaseSystemPrompt?.();
}

async function runPhase1(options: MemoryStartupOptions, activity: MemoryActivity): Promise<void> {
	if (!isMemoryStartupActive(options)) return;
	const { session, modelRegistry, agentDir, config, scope } = options;
	const db = openMemoryDb(getAgentDbPath(agentDir));
	const nowSec = unixNow();
	const workerId = `memory-${process.pid}`;
	const memoryRoot = getMemoryRoot(agentDir, scope?.cwd ?? session.sessionManager.getCwd());
	const currentThreadId = session.sessionManager.getSessionId();

	try {
		const threads = await collectThreadsInDir(
			scope?.sessionDir ?? session.sessionManager.getSessionDir(),
			currentThreadId,
		);
		if (!isMemoryStartupActive(options)) return;
		upsertThreads(db, threads);

		const phase1Model = await resolveMemoryModel({
			modelRegistry,
			session,
			fallbackRole: "default",
		});
		if (!phase1Model) {
			logger.debug("Phase1 skipped: no model available");
			return;
		}
		const phase1ApiKey = await modelRegistry.getApiKey(phase1Model, session.sessionId);
		if (!phase1ApiKey) {
			logger.debug("Phase1 skipped: no API key for phase1 model", {
				provider: phase1Model.provider,
				model: phase1Model.id,
			});
			return;
		}

		if (!isMemoryStartupActive(options)) return;
		const claimParams = {
			threadScanLimit: config.threadScanLimit,
			maxRolloutsPerStartup: config.maxRolloutsPerStartup,
			maxRolloutAgeDays: config.maxRolloutAgeDays,
			minRolloutIdleHours: config.minRolloutIdleHours,
			leaseSeconds: config.stage1LeaseSeconds,
			runningConcurrencyCap: config.stage1Concurrency,
			workerId,
			excludeThreadIds: currentThreadId ? [currentThreadId] : [],
			cwd: scope?.cwd,
		};
		const claims = claimStage1Jobs(db, { ...claimParams, nowSec });
		if (claims.length === 0) return;
		// A host-requested run reads every waiting session, a concurrency-sized
		// batch at a time; startup stops after its first batch as before.
		if (scope) {
			activity.total = Math.min(
				config.maxRolloutsPerStartup,
				countClaimableStage1Threads(db, { ...claimParams, nowSec }) + claims.length,
			);
		} else {
			activity.total = claims.length;
		}

		const stats: Stage1Stats = {
			claimed: claims.length,
			succeeded: 0,
			succeededNoOutput: 0,
			failed: 0,
			produced: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		const runClaim = async (claim: Stage1Claim): Promise<void> => {
			try {
				await readClaim(claim);
			} finally {
				activity.done += 1;
			}
		};
		const readClaim = async (claim: Stage1Claim): Promise<void> => {
			if (!isMemoryStartupActive(options)) return;
			const result = await runStage1Job({
				claim,
				model: phase1Model,
				apiKey: modelRegistry.resolver(phase1Model, session.sessionId),
				sessionId: session.sessionId,
				modelMaxTokens: computeModelTokenBudget(phase1Model, config),
				config,
				metadata: session.agent?.metadataForProvider(phase1Model.provider),
			});
			if (!isMemoryStartupActive(options)) return;

			if (result.kind === "failed") {
				logger.error("Memory phase1 stage1 job failed", {
					threadId: claim.threadId,
					rolloutPath: claim.rolloutPath,
					reason: result.reason,
				});
				markStage1Failed(db, {
					threadId: claim.threadId,
					ownershipToken: claim.ownershipToken,
					retryDelaySeconds: config.stage1RetryDelaySeconds,
					reason: result.reason,
					nowSec: unixNow(),
				});
				stats.failed += 1;
				return;
			}

			if (result.kind === "no_output") {
				markStage1SucceededNoOutput(db, {
					threadId: claim.threadId,
					ownershipToken: claim.ownershipToken,
					sourceUpdatedAt: claim.sourceUpdatedAt,
					nowSec: unixNow(),
					cwd: claim.cwd,
				});
				stats.succeededNoOutput += 1;
				return;
			}

			markStage1SucceededWithOutput(db, {
				threadId: claim.threadId,
				ownershipToken: claim.ownershipToken,
				sourceUpdatedAt: claim.sourceUpdatedAt,
				rawMemory: result.output.rawMemory,
				rolloutSummary: result.output.rolloutSummary,
				rolloutSlug: result.output.rolloutSlug,
				nowSec: unixNow(),
				cwd: claim.cwd,
			});
			stats.succeeded += 1;
			stats.produced += 1;
			if (result.usage) {
				stats.usage.input += result.usage.input;
				stats.usage.output += result.usage.output;
				stats.usage.cacheRead += result.usage.cacheRead;
				stats.usage.cacheWrite += result.usage.cacheWrite;
				stats.usage.total += result.usage.totalTokens || 0;
			}
		};

		let batch = claims;
		while (batch.length > 0) {
			await runWithConcurrency(batch, config.stage1Concurrency, runClaim);
			if (!scope || !isMemoryStartupActive(options) || activity.done >= config.maxRolloutsPerStartup) break;
			batch = claimStage1Jobs(db, {
				...claimParams,
				maxRolloutsPerStartup: config.maxRolloutsPerStartup - activity.done,
				nowSec: unixNow(),
			});
			stats.claimed += batch.length;
			activity.total = Math.max(activity.total, activity.done + batch.length);
		}

		logger.debug("Memory phase1 completed", {
			memoryRoot,
			claimed: stats.claimed,
			succeeded: stats.succeeded,
			succeededNoOutput: stats.succeededNoOutput,
			failed: stats.failed,
			produced: stats.produced,
			usage: stats.usage,
		});
	} finally {
		closeMemoryDb(db);
	}
}

async function runPhase2(options: MemoryStartupOptions): Promise<void> {
	if (!isMemoryStartupActive(options)) return;
	const { session, modelRegistry, agentDir, config } = options;
	const cwd = options.scope?.cwd ?? session.sessionManager.getCwd();
	const db = openMemoryDb(getAgentDbPath(agentDir));
	const nowSec = unixNow();
	const workerId = `memory-${process.pid}`;
	const memoryRoot = getMemoryRoot(agentDir, cwd);

	try {
		const claimResult = tryClaimGlobalPhase2Job(db, {
			workerId,
			leaseSeconds: config.phase2LeaseSeconds,
			nowSec,
			cwd,
		});
		if (claimResult.kind !== "claimed") return;

		const claim = claimResult.claim;
		const outputs = listStage1OutputsForGlobal(db, config.maxRawMemoriesForGlobal, cwd);
		const newWatermark = computeCompletionWatermark(claim.inputWatermark, outputs);

		await syncPhase2Artifacts(memoryRoot, outputs);
		if (!isMemoryStartupActive(options)) return;
		if (outputs.length === 0) {
			await cleanupConsolidatedArtifacts(memoryRoot);
			if (!isMemoryStartupActive(options)) return;
			const marked = markGlobalPhase2Succeeded(db, {
				ownershipToken: claim.ownershipToken,
				newWatermark,
				nowSec: unixNow(),
				cwd,
			});
			if (!marked) {
				logger.warn("Phase2 empty-input completion lost ownership", { memoryRoot });
			}
			return;
		}

		if (!isMemoryStartupActive(options)) return;
		const phase2Model = await resolveMemoryModel({
			modelRegistry,
			session,
			fallbackRole: "smol",
		});
		if (!phase2Model) {
			markPhase2FailureWithFallback(db, {
				claim,
				retryDelaySeconds: config.phase2RetryDelaySeconds,
				reason: "No model available for phase2",
				memoryRoot,
				cwd,
			});
			return;
		}
		const phase2ApiKey = await modelRegistry.getApiKey(phase2Model, session.sessionId);
		if (!phase2ApiKey) {
			markPhase2FailureWithFallback(db, {
				claim,
				retryDelaySeconds: config.phase2RetryDelaySeconds,
				reason: "No API key available for phase2",
				memoryRoot,
				cwd,
			});
			return;
		}

		if (!isMemoryStartupActive(options)) return;
		let heartbeatLostOwnership = false;
		const heartbeat = setInterval(() => {
			if (!isMemoryStartupActive(options)) {
				clearInterval(heartbeat);
				return;
			}
			const ok = heartbeatGlobalJob(db, {
				ownershipToken: claim.ownershipToken,
				leaseSeconds: config.phase2LeaseSeconds,
				nowSec: unixNow(),
				cwd,
			});
			if (!ok) {
				heartbeatLostOwnership = true;
				clearInterval(heartbeat);
			}
		}, config.phase2HeartbeatSeconds * 1000);

		try {
			if (!isMemoryStartupActive(options)) return;
			const consolidated = await runConsolidationModel({
				memoryRoot,
				model: phase2Model,
				apiKey: modelRegistry.resolver(phase2Model, session.sessionId),
				sessionId: session.sessionId,
				metadata: session.agent?.metadataForProvider(phase2Model.provider),
			});
			if (!isMemoryStartupActive(options)) return;
			await applyConsolidation(memoryRoot, consolidated);
			if (!isMemoryStartupActive(options)) return;
			if (heartbeatLostOwnership) {
				throw new Error("Phase2 lease ownership lost before completion");
			}
			const marked = markGlobalPhase2Succeeded(db, {
				ownershipToken: claim.ownershipToken,
				newWatermark,
				nowSec: unixNow(),
				cwd,
			});
			if (!marked) {
				throw new Error("Phase2 could not mark success: ownership lost");
			}
		} catch (error) {
			if (!isMemoryStartupActive(options)) return;
			markPhase2FailureWithFallback(db, {
				claim,
				retryDelaySeconds: config.phase2RetryDelaySeconds,
				reason: String(error),
				memoryRoot,
				cwd,
				error,
			});
		} finally {
			clearInterval(heartbeat);
		}
	} finally {
		closeMemoryDb(db);
	}
}

function markPhase2FailureWithFallback(
	db: Database,
	params: {
		claim: { ownershipToken: string; inputWatermark: number };
		retryDelaySeconds: number;
		reason: string;
		memoryRoot: string;
		cwd: string;
		error?: unknown;
	},
): void {
	const { claim, retryDelaySeconds, reason, memoryRoot, cwd, error } = params;
	const nowSec = unixNow();
	const strictFailed = markGlobalPhase2Failed(db, {
		ownershipToken: claim.ownershipToken,
		retryDelaySeconds,
		reason,
		nowSec,
		cwd,
	});
	if (strictFailed) return;

	const unownedFailed = markGlobalPhase2FailedUnowned(db, {
		retryDelaySeconds,
		reason,
		nowSec,
		cwd,
	});
	if (!unownedFailed) {
		logger.warn("Phase2 could not mark failure (ownership lost and unowned fallback skipped)", {
			error: error ? String(error) : undefined,
			memoryRoot,
			reason,
			inputWatermark: claim.inputWatermark,
		});
	}
}

/** @internal Exported for unit-testing. */
export async function collectThreads(session: AgentSession, currentThreadId?: string): Promise<MemoryThread[]> {
	return collectThreadsInDir(session.sessionManager.getSessionDir(), currentThreadId);
}

/** Sessions stored in `sessionDir`, identified by their header; a missing directory has none. */
export async function collectThreadsInDir(sessionDir: string, currentThreadId?: string): Promise<MemoryThread[]> {
	let files: string[];
	try {
		files = await fs.readdir(sessionDir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const threads: MemoryThread[] = [];
	for (const name of files) {
		if (!name.endsWith(".jsonl")) continue;
		const fullPath = path.join(sessionDir, name);
		let stat: fsNode.Stats;
		try {
			stat = await fs.stat(fullPath);
		} catch {
			continue;
		}
		let cwd = "";
		let id = name.slice(0, -6);
		let title: string | undefined;
		try {
			// Bounded head read: session files can grow to hundreds of MBs, but the
			// session header line always lives at line 1 (or line 2 after a title
			// slot). Reading a small head slice avoids full-file read and line-split
			// allocations on startup for every past session. If the candidate line
			// falls on the slice boundary, fall back to a full read.
			const HEAD_CAP = 64 * 1024;
			let isLarge = stat.size > HEAD_CAP;
			let fileText = isLarge
				? await peekFile(fullPath, HEAD_CAP, bytes => new TextDecoder().decode(bytes))
				: await Bun.file(fullPath).text();
			let lines = fileText.split(/\r?\n/);
			let sawTitleSlot = false;
			for (let i = 0; i < lines.length; i++) {
				// If the slice was cut before this line terminated, fall back to full read
				if (isLarge && i === lines.length - 1) {
					fileText = await Bun.file(fullPath).text();
					lines = fileText.split(/\r?\n/);
					isLarge = false;
				}
				const line = lines[i].trim();
				if (!line) continue;
				const parsed = parseJsonlLenient<Record<string, unknown>>(line);
				const header = Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : undefined;
				if (!sawTitleSlot && header?.type === "title") {
					sawTitleSlot = true;
					if (typeof header.title === "string" && header.title.trim()) title = header.title.trim();
					continue;
				}
				if (header?.type === "session") {
					if (typeof header.cwd === "string") cwd = header.cwd;
					if (typeof header.id === "string") id = header.id;
				}
				break;
			}
		} catch {
			// ignore malformed session files
		}

		if (currentThreadId && id === currentThreadId) continue;
		threads.push({
			id,
			updatedAt: Math.floor(stat.mtimeMs / 1000),
			rolloutPath: fullPath,
			cwd,
			sourceKind: "cli",
			...(title ? { title } : {}),
		});
	}
	return threads;
}

function shouldPersistResponseItemForMemories(message: AgentMessage): boolean {
	const role = (message as { role: string }).role;
	if (role === "system" || role === "developer" || role === "user" || role === "assistant") {
		return true;
	}
	if (role !== "toolResult") return false;
	const toolName = (message as { toolName?: string }).toolName;
	if (toolName === "bash" || toolName === "eval" || toolName === "read" || toolName === "grep") {
		const text = extractMessageText(message);
		return text.length > 0 && text.length <= 32_000;
	}
	return false;
}

function extractPersistableMessages(payload: string): AgentMessage[] {
	const rows = parseJsonlLenient(payload);
	if (!Array.isArray(rows)) return [];
	const messages: AgentMessage[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const entry = row as Record<string, unknown>;
		if (entry.type !== "message") continue;
		const maybeMessage = entry.message;
		if (!maybeMessage || typeof maybeMessage !== "object") continue;
		const message = maybeMessage as AgentMessage;
		if (shouldPersistResponseItemForMemories(message)) {
			messages.push(message);
		}
	}
	return messages;
}

/** Byte window used when streaming rollout head/tail for stage-1 input. */
const STAGE1_ROLLOUT_WINDOW_BYTES = 1024 * 1024;

/** Persistable messages from the start of the rollout, in file order, read window by window. */
async function* persistableMessagesFromFront(file: Bun.BunFile, size: number): AsyncGenerator<AgentMessage> {
	const decoder = new TextDecoder();
	let carry: Uint8Array | undefined;
	let offset = 0;
	while (offset < size) {
		const end = Math.min(size, offset + STAGE1_ROLLOUT_WINDOW_BYTES);
		const window = await file.slice(offset, end).bytes();
		offset = end;
		const bytes = carry ? Buffer.concat([carry, window]) : window;
		const cut = offset >= size ? bytes.length : bytes.lastIndexOf(0x0a) + 1;
		carry = cut < bytes.length ? bytes.subarray(cut) : undefined;
		if (cut > 0) yield* extractPersistableMessages(decoder.decode(bytes.subarray(0, cut)));
	}
}

/** Persistable messages from the end of the rollout, in reverse file order, read window by window. */
async function* persistableMessagesFromBack(file: Bun.BunFile, size: number): AsyncGenerator<AgentMessage> {
	const decoder = new TextDecoder();
	let carry: Uint8Array | undefined;
	let end = size;
	while (end > 0) {
		const start = Math.max(0, end - STAGE1_ROLLOUT_WINDOW_BYTES);
		const window = await file.slice(start, end).bytes();
		end = start;
		const bytes = carry ? Buffer.concat([window, carry]) : window;
		// Bytes before the first newline belong to a line that starts in an earlier window.
		const cut = start === 0 ? 0 : bytes.indexOf(0x0a) + 1;
		if (start > 0 && cut === 0) {
			carry = bytes;
			continue;
		}
		carry = cut > 0 ? bytes.subarray(0, cut) : undefined;
		const messages = extractPersistableMessages(decoder.decode(bytes.subarray(cut)));
		for (let i = messages.length - 1; i >= 0; i--) yield messages[i];
	}
}

/**
 * Build the stage-1 `response_items_json` payload for a rollout file.
 *
 * Equivalent to `truncateByApproxTokens(JSON.stringify(persistableMessages), tokenLimit)`, but
 * streams the rollout in byte windows and serializes messages from the front and back only until
 * the head/tail budgets fill. Peak memory is bounded by the window size plus the largest single
 * JSONL record (a record spanning windows is carried until its newline), not by rollout size.
 */
export async function buildStage1RolloutItems(rolloutPath: string, tokenLimit: number): Promise<string> {
	const file = Bun.file(rolloutPath);
	// stat() throws for a missing rollout, matching the previous Bun.file().text() failure.
	const { size } = await file.stat();
	if (tokenLimit <= 0) return "";
	const maxChars = tokenLimit * 4;
	const headChars = Math.floor(maxChars * 0.6);
	const tailChars = maxChars - headChars;

	let head = "[";
	let truncated = false;
	for await (const message of persistableMessagesFromFront(file, size)) {
		head += head.length === 1 ? JSON.stringify(message) : `,${JSON.stringify(message)}`;
		if (head.length > maxChars) {
			truncated = true;
			break;
		}
	}
	if (!truncated) {
		const full = `${head}]`;
		if (full.length <= maxChars) return full;
	}

	let tail = "]";
	let exhausted = true;
	for await (const message of persistableMessagesFromBack(file, size)) {
		tail = `,${JSON.stringify(message)}${tail}`;
		if (tail.length >= tailChars) {
			exhausted = false;
			break;
		}
	}
	// Every message consumed: the leading separator is really the array opener.
	if (exhausted) tail = `[${tail.slice(1)}`;
	return `${head.slice(0, headChars)}\n\n...[truncated]...\n\n${tail.slice(-tailChars)}`;
}

async function runStage1Job(options: {
	claim: Stage1Claim;
	model: Model;
	apiKey: ApiKey;
	sessionId: string;
	modelMaxTokens: number;
	config: MemoryRuntimeConfig;
	metadata?: Record<string, unknown>;
}): Promise<
	| {
			kind: "output";
			output: { rawMemory: string; rolloutSummary: string; rolloutSlug: string | null };
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number };
	  }
	| { kind: "no_output" }
	| { kind: "failed"; reason: string }
> {
	const { claim, model, apiKey, modelMaxTokens, config } = options;
	try {
		const budgetTokens = Math.min(
			config.phase1InputTokenLimit,
			Math.floor(modelMaxTokens * config.rolloutPayloadPercent),
		);
		const truncatedItems = await buildStage1RolloutItems(claim.rolloutPath, budgetTokens);
		const inputPrompt = prompt.render(stageOneInputTemplate, {
			thread_id: claim.threadId,
			response_items_json: truncatedItems,
		});

		const response = await retryTransientCompletion(
			() =>
				completeSimple(
					model,
					{
						systemPrompt: [stageOneSystemTemplate],
						messages: [{ role: "user", content: [{ type: "text", text: inputPrompt }], timestamp: Date.now() }],
					},
					{
						apiKey,
						sessionId: options.sessionId,
						metadata: options.metadata,
						maxTokens: Math.max(1024, Math.min(4096, Math.floor(modelMaxTokens * 0.2))),
						reasoning: clampThinkingLevelForModel(model, Effort.Low),
					},
				),
			{ provider: model.provider },
		);

		if (response.stopReason === "error") {
			return { kind: "failed", reason: response.errorMessage || "stage1 model error" };
		}
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n")
			.trim();
		const parsed = parseJsonObject(text);
		if (!parsed) {
			return { kind: "failed", reason: "stage1 JSON parse failure" };
		}
		const schemaOutput = parseStage1OutputSchema(parsed);
		if (!schemaOutput) {
			return { kind: "failed", reason: "stage1 JSON schema validation failure" };
		}

		const rawMemory = redactSecrets(schemaOutput.raw_memory).trim();
		const rolloutSummary = redactSecrets(schemaOutput.rollout_summary).trim();
		const rolloutSlug = schemaOutput.rollout_slug === null ? null : redactSecrets(schemaOutput.rollout_slug).trim();
		if (!rawMemory || !rolloutSummary) {
			return { kind: "no_output" };
		}
		return {
			kind: "output",
			output: {
				rawMemory,
				rolloutSummary,
				rolloutSlug: rolloutSlug || null,
			},
			usage: response.usage,
		};
	} catch (error) {
		return { kind: "failed", reason: String(error) };
	}
}

async function syncPhase2Artifacts(memoryRoot: string, outputs: Stage1OutputRow[]): Promise<void> {
	const summariesDir = path.join(memoryRoot, "rollout_summaries");
	await fs.mkdir(summariesDir, { recursive: true });

	const keepFiles = new Set<string>();
	for (const row of outputs) {
		const stem = formatRolloutFilename(row.threadId, row.rolloutSlug);
		const filename = `${stem}.md`;
		keepFiles.add(filename);
		const body = [`thread_id: ${row.threadId}`, `updated_at: ${row.sourceUpdatedAt}`, "", row.rolloutSummary].join(
			"\n",
		);
		await Bun.write(path.join(summariesDir, filename), `${body.trim()}\n`);
	}

	const currentFiles = await fs.readdir(summariesDir).catch(() => [] as string[]);
	for (const file of currentFiles) {
		if (!file.endsWith(".md")) continue;
		if (keepFiles.has(file)) continue;
		await fs.rm(path.join(summariesDir, file), { force: true });
	}

	const rawBody = buildRawMemoriesMarkdown(outputs);
	await Bun.write(path.join(memoryRoot, "raw_memories.md"), rawBody);
}

async function cleanupConsolidatedArtifacts(memoryRoot: string): Promise<void> {
	await fs.rm(path.join(memoryRoot, "MEMORY.md"), { force: true });
	await fs.rm(path.join(memoryRoot, "memory_summary.md"), { force: true });
	await fs.rm(path.join(memoryRoot, "skills"), { recursive: true, force: true });
}

function buildRawMemoriesMarkdown(outputs: Stage1OutputRow[]): string {
	if (outputs.length === 0) {
		return "# Raw Memories\n\nNo raw memories yet.\n";
	}

	const blocks = outputs.map(row => {
		const header = [`## ${row.threadId}`, `updated_at: ${row.sourceUpdatedAt}`, ""].join("\n");
		return `${header}${row.rawMemory.trim()}\n`;
	});
	return `# Raw Memories\n\n${blocks.join("\n")}`;
}

async function readRolloutSummaries(memoryRoot: string): Promise<string> {
	const summariesDir = path.join(memoryRoot, "rollout_summaries");
	const names = await fs.readdir(summariesDir).catch(() => [] as string[]);
	const summaryNames = names.filter(name => name.endsWith(".md")).sort((a, b) => a.localeCompare(b));
	if (summaryNames.length === 0) return "No rollout summaries yet.";

	const blocks: string[] = [];
	for (const name of summaryNames) {
		const text = await Bun.file(path.join(summariesDir, name))
			.text()
			.catch(() => "");
		if (!text.trim()) continue;
		blocks.push(`--- ${name} ---\n${text.trim()}`);
	}
	if (blocks.length === 0) return "No rollout summaries yet.";
	return blocks.join("\n\n");
}

async function runConsolidationModel(options: {
	memoryRoot: string;
	model: Model;
	apiKey: ApiKey;
	sessionId: string;
	metadata?: Record<string, unknown>;
}): Promise<{
	memoryMd: string;
	memorySummary: string;
	skills: Array<{
		name: string;
		content: string;
		scripts: ConsolidationSkillFileSchema[];
		templates: ConsolidationSkillFileSchema[];
		examples: ConsolidationSkillFileSchema[];
	}>;
}> {
	const { memoryRoot, model, apiKey } = options;
	const rawMemories = await Bun.file(path.join(memoryRoot, "raw_memories.md")).text();
	const rolloutSummaries = await readRolloutSummaries(memoryRoot);
	const input = prompt.render(consolidationTemplate, {
		raw_memories: truncateByApproxTokens(rawMemories, 20_000),
		rollout_summaries: truncateByApproxTokens(rolloutSummaries, 12_000),
	});

	const response = await retryTransientCompletion(
		() =>
			completeSimple(
				model,
				{
					systemPrompt: [consolidationSystemTemplate],
					messages: [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }],
				},
				{
					apiKey,
					sessionId: options.sessionId,
					metadata: options.metadata,
					maxTokens: 8192,
					reasoning: clampThinkingLevelForModel(model, Effort.Medium),
				},
			),
		{ provider: model.provider },
	);
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "phase2 model error");
	}
	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n")
		.trim();
	const parsed = parseJsonObject(text);
	if (!parsed) throw new Error("phase2 JSON parse failure");
	const schemaOutput = parseConsolidationOutputSchema(parsed);
	if (!schemaOutput) throw new Error("phase2 JSON schema validation failure");
	const memoryMd = redactSecrets(schemaOutput.memory_md).trim();
	const memorySummary = redactSecrets(schemaOutput.memory_summary).trim();
	const skills = schemaOutput.skills
		.map(item => {
			const name = sanitizeSkillName(item.name.trim());
			const content = redactSecrets(item.content ?? "").trim();
			if (!name || !content) return null;
			return {
				name,
				content,
				scripts: sanitizeConsolidationSkillFiles(item.scripts, "scripts"),
				templates: sanitizeConsolidationSkillFiles(item.templates, "templates"),
				examples: sanitizeConsolidationSkillFiles(item.examples, "examples"),
			};
		})
		.filter(
			(
				item,
			): item is {
				name: string;
				content: string;
				scripts: ConsolidationSkillFileSchema[];
				templates: ConsolidationSkillFileSchema[];
				examples: ConsolidationSkillFileSchema[];
			} => item !== null,
		);
	if (!memoryMd || !memorySummary) {
		throw new Error("phase2 returned empty consolidated memory");
	}
	return { memoryMd, memorySummary, skills };
}

async function applyConsolidation(
	memoryRoot: string,
	consolidated: {
		memoryMd: string;
		memorySummary: string;
		skills: Array<{
			name: string;
			content: string;
			scripts: ConsolidationSkillFileSchema[];
			templates: ConsolidationSkillFileSchema[];
			examples: ConsolidationSkillFileSchema[];
		}>;
	},
): Promise<void> {
	await Bun.write(path.join(memoryRoot, "MEMORY.md"), `${consolidated.memoryMd.trim()}\n`);
	await Bun.write(path.join(memoryRoot, "memory_summary.md"), `${consolidated.memorySummary.trim()}\n`);
	const skillsDir = path.join(memoryRoot, "skills");
	await fs.mkdir(skillsDir, { recursive: true });
	const keep = new Set<string>();
	for (const skill of consolidated.skills) {
		const dir = path.join(skillsDir, skill.name);
		keep.add(skill.name);
		await fs.mkdir(dir, { recursive: true });
		const files = new Map<string, string>();
		files.set("SKILL.md", `${skill.content.trim()}\n`);
		for (const item of skill.scripts) {
			files.set(path.posix.join("scripts", item.path), `${item.content.trim()}\n`);
		}
		for (const item of skill.templates) {
			files.set(path.posix.join("templates", item.path), `${item.content.trim()}\n`);
		}
		for (const item of skill.examples) {
			files.set(path.posix.join("examples", item.path), `${item.content.trim()}\n`);
		}

		for (const [relativePath, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			await Bun.write(path.join(dir, ...relativePath.split("/")), content);
		}

		const keepFiles = new Set(files.keys());
		const existingFiles = await listRelativeFiles(dir);
		for (const relativePath of existingFiles) {
			if (keepFiles.has(relativePath)) continue;
			await fs.rm(path.join(dir, ...relativePath.split("/")), { force: true });
		}
		await pruneEmptyDirectories(dir);
	}
	const dirs = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
	for (const dirent of dirs) {
		if (!dirent.isDirectory()) continue;
		if (keep.has(dirent.name)) continue;
		await fs.rm(path.join(skillsDir, dirent.name), { recursive: true, force: true });
	}
}

async function listRelativeFiles(rootDir: string, prefix = ""): Promise<string[]> {
	const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
	const files: string[] = [];
	for (const entry of entries) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...(await listRelativeFiles(path.join(rootDir, entry.name), relative)));
			continue;
		}
		if (entry.isFile()) files.push(relative);
	}
	return files;
}

async function pruneEmptyDirectories(rootDir: string): Promise<void> {
	const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const child = path.join(rootDir, entry.name);
		await pruneEmptyDirectories(child);
		const childEntries = await fs.readdir(child).catch(() => []);
		if (childEntries.length === 0) {
			await fs.rm(child, { recursive: true, force: true });
		}
	}
}

function computeCompletionWatermark(claimedInputWatermark: number, outputs: Stage1OutputRow[]): number {
	const maxOutputWatermark = outputs.reduce((max, row) => Math.max(max, row.sourceUpdatedAt), claimedInputWatermark);
	return Math.max(claimedInputWatermark, maxOutputWatermark);
}

function formatRolloutFilename(threadId: string, rolloutSlug: string | null): string {
	if (!rolloutSlug) return threadId;
	const normalized = rolloutSlug
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/_+$/g, "")
		.slice(0, 20);
	if (!normalized) return threadId;
	return `${threadId}-${normalized}`;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		const match = text.match(/\{[\s\S]*\}/);
		if (!match) return undefined;
		try {
			const parsed = JSON.parse(match[0]) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function parseStage1OutputSchema(value: Record<string, unknown>): Stage1OutputSchema | undefined {
	if (!hasExactKeys(value, ["rollout_summary", "rollout_slug", "raw_memory"])) return undefined;
	if (typeof value.rollout_summary !== "string") return undefined;
	if (!(typeof value.rollout_slug === "string" || value.rollout_slug === null)) return undefined;
	if (typeof value.raw_memory !== "string") return undefined;
	return {
		rollout_summary: value.rollout_summary,
		rollout_slug: value.rollout_slug,
		raw_memory: value.raw_memory,
	};
}

function parseConsolidationOutputSchema(value: Record<string, unknown>): ConsolidationOutputSchema | undefined {
	if (!hasExactKeys(value, ["memory_md", "memory_summary", "skills"])) return undefined;
	if (typeof value.memory_md !== "string") return undefined;
	if (typeof value.memory_summary !== "string") return undefined;
	if (!Array.isArray(value.skills)) return undefined;
	const skills: ConsolidationSkillSchema[] = [];
	for (const item of value.skills) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		const data = item as Record<string, unknown>;
		if (!hasExactKeys(data, ["name", "content", "scripts", "templates", "examples"], true)) return undefined;
		if (typeof data.name !== "string") return undefined;
		if (!(typeof data.content === "string" || data.content === undefined)) return undefined;
		const scripts = parseConsolidationSkillFileArray(data.scripts);
		const templates = parseConsolidationSkillFileArray(data.templates);
		const examples = parseConsolidationSkillFileArray(data.examples);
		if (!scripts || !templates || !examples) return undefined;
		skills.push({
			name: data.name,
			content: data.content,
			scripts,
			templates,
			examples,
		});
	}
	return {
		memory_md: value.memory_md,
		memory_summary: value.memory_summary,
		skills,
	};
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[], allowMissing = false): boolean {
	const sortedKeys = Object.keys(value).sort();
	const sortedExpected = [...expectedKeys].sort();
	if (!allowMissing && sortedKeys.length !== sortedExpected.length) return false;
	for (const key of sortedKeys) {
		if (!sortedExpected.includes(key)) return false;
	}
	if (allowMissing) return true;
	for (let i = 0; i < sortedExpected.length; i += 1) {
		if (sortedKeys[i] !== sortedExpected[i]) return false;
	}
	return true;
}

function sanitizeSkillName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function parseConsolidationSkillFileArray(value: unknown): ConsolidationSkillFileSchema[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return undefined;
	const files: ConsolidationSkillFileSchema[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		const data = item as Record<string, unknown>;
		if (!hasExactKeys(data, ["path", "content"])) return undefined;
		if (typeof data.path !== "string" || typeof data.content !== "string") return undefined;
		files.push({ path: data.path, content: data.content });
	}
	return files;
}

function sanitizeConsolidationSkillFiles(
	files: ConsolidationSkillFileSchema[] | undefined,
	bucket: "scripts" | "templates" | "examples",
): ConsolidationSkillFileSchema[] {
	if (!files || files.length === 0) return [];
	const sanitized = new Map<string, string>();
	for (const file of files) {
		const relativePath = sanitizeSkillRelativePath(file.path);
		if (!relativePath) continue;
		const content = redactSecrets(file.content).trim();
		if (!content) continue;
		sanitized.set(path.posix.join(bucket, relativePath), content);
	}
	return [...sanitized.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([fullPath, content]) => ({
			path: fullPath.slice(bucket.length + 1),
			content,
		}));
}

function sanitizeSkillRelativePath(rawPath: string): string | undefined {
	const normalized = rawPath.replace(/\\/g, "/").trim();
	if (!normalized) return undefined;
	if (normalized.startsWith("/")) return undefined;
	if (normalized.includes("\0")) return undefined;
	if (normalized.includes(":")) return undefined;
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length === 0) return undefined;
	for (const part of parts) {
		if (part === "." || part === "..") return undefined;
		if (!/^[A-Za-z0-9._-]+$/.test(part)) return undefined;
	}
	return parts.join("/");
}

function extractMessageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(item => {
			if (item.type === "text") return item.text;
			if (item.type === "toolCall") return `${item.toolName} ${JSON.stringify(item.arguments)}`;
			return "";
		})
		.join("\n");
}

function truncateByApproxTokens(text: string, tokenLimit: number): string {
	if (tokenLimit <= 0) return "";
	const maxChars = tokenLimit * 4;
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.6);
	const tail = maxChars - head;
	return `${text.slice(0, head)}\n\n...[truncated]...\n\n${text.slice(-tail)}`;
}

function computeModelTokenBudget(model: Model, config: MemoryRuntimeConfig): number {
	const maxTokens =
		model.contextWindow !== null && Number.isFinite(model.contextWindow) && model.contextWindow > 0
			? model.contextWindow
			: config.fallbackTokenLimit;
	return Math.max(2048, Math.floor(maxTokens));
}

export async function resolveMemoryModel(options: {
	modelRegistry: ModelRegistry;
	session: AgentSession;
	fallbackRole: string;
}): Promise<Model | undefined> {
	const { modelRegistry, session, fallbackRole } = options;
	// A configured `memory` role is the user's pick for all memory work.
	const requestedModel =
		session.settings.getModelRole("memory") ||
		session.settings.getModelRole(fallbackRole) ||
		session.settings.getModelRole("default");
	if (requestedModel) {
		const resolved = resolveModelRoleValue(requestedModel, modelRegistry.getAll(), {
			settings: session.settings,
			matchPreferences: getModelMatchPreferences(session.settings),
		});
		if (resolved.model) return resolved.model;
	}
	return session.model ?? modelRegistry.getAll()[0];
}

export function loadMemoryConfig(settings: Settings): MemoryRuntimeConfig {
	return {
		enabled: cfgMemoryBackend.get(settings) === "local",
		maxRolloutsPerStartup: cfgMemoriesMaxRolloutsPerStartup.get(settings),
		maxRolloutAgeDays: cfgMemoriesMaxRolloutAgeDays.get(settings),
		minRolloutIdleHours: cfgMemoriesMinRolloutIdleHours.get(settings),
		threadScanLimit: cfgMemoriesThreadScanLimit.get(settings),
		maxRawMemoriesForGlobal: cfgMemoriesMaxRawMemoriesForGlobal.get(settings),
		stage1Concurrency: cfgMemoriesStage1Concurrency.get(settings),
		stage1LeaseSeconds: cfgMemoriesStage1LeaseSeconds.get(settings),
		stage1RetryDelaySeconds: cfgMemoriesStage1RetryDelaySeconds.get(settings),
		phase2LeaseSeconds: cfgMemoriesPhase2LeaseSeconds.get(settings),
		phase2RetryDelaySeconds: cfgMemoriesPhase2RetryDelaySeconds.get(settings),
		phase2HeartbeatSeconds: cfgMemoriesPhase2HeartbeatSeconds.get(settings),
		rolloutPayloadPercent: cfgMemoriesRolloutPayloadPercent.get(settings),
		phase1InputTokenLimit: cfgMemoriesPhase1InputTokenLimit.get(settings),
		fallbackTokenLimit: cfgMemoriesFallbackTokenLimit.get(settings),
		summaryInjectionTokenLimit: cfgMemoriesSummaryInjectionTokenLimit.get(settings),
	};
}

export function getMemoryRoot(agentDir: string, cwd: string): string {
	return path.join(getMemoriesDir(agentDir), encodeProjectPath(normalizeScopeCwd(cwd)));
}

/**
 * Filename of the captured-lessons file under a project's memory root.
 *
 * Written by the `learn` tool via {@link saveLearnedLesson} and read back by
 * {@link buildMemoryToolDeveloperInstructions}. Deliberately distinct from the
 * consolidation artifacts (`MEMORY.md`, `memory_summary.md`, `skills/`) so a
 * consolidation pass never clobbers manually captured lessons.
 */
const LEARNED_LESSONS_FILE = "learned.md";
/** Newest-first cap on retained lessons, bounding file growth by entry count. */
const MAX_LEARNED_LESSONS = 100;
/** Per-field char caps so a single huge capture can't bloat learned.md. */
const MAX_LEARNED_CONTENT_CHARS = 2000;
const MAX_LEARNED_CONTEXT_CHARS = 400;

/**
 * Strip prompt-injection vectors from a single line of lesson text: control/
 * format chars, angle brackets (`</skills>`), backticks, and `~~~` fences, then
 * collapse whitespace. Applied on BOTH write and read (the block renders
 * unescaped into the system prompt), mirroring managed-skill descriptions.
 */
function neutralizeInjection(text: string): string {
	return text
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/[<>`]/g, "")
		.replace(/~{2,}/g, "~")
		.replace(/\s+/g, " ")
		.trim();
}

/** Slice to `maxChars`, dropping a trailing unpaired high surrogate. */
function boundChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const sliced = text.slice(0, maxChars);
	return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced;
}

/**
 * Normalize one lesson field for storage: neutralize injection delimiters
 * FIRST, then redact secrets (so delimiter stripping can't reassemble a token
 * the redactor would have caught), then bound the length.
 */
function normalizeLearnedText(text: string, maxChars: number): string {
	return boundChars(redactSecrets(neutralizeInjection(text)).trim(), maxChars);
}

/** Per-path write chains serializing `learned.md` read-modify-write. */
const learnedWriteChains = new Map<string, Promise<unknown>>();

/**
 * Append one lesson to the project's `learned.md` (newest-first, deduped,
 * capped, secret-redacted, injection-neutralized). The file backs the `learn`
 * tool when `memory.backend` is `local`.
 */
export async function saveLearnedLesson(
	agentDir: string,
	cwd: string,
	input: MemoryBackendSaveInput,
): Promise<MemoryBackendSaveResult> {
	const content = normalizeLearnedText(input.content, MAX_LEARNED_CONTENT_CHARS);
	if (!content) {
		return { backend: "local", stored: 0, message: "Empty lesson; nothing stored." };
	}
	const context = input.context ? normalizeLearnedText(input.context, MAX_LEARNED_CONTEXT_CHARS) : "";
	const line = formatLessonLine(content, context);
	const filePath = path.join(getMemoryRoot(agentDir, cwd), LEARNED_LESSONS_FILE);
	await serializeMemoryFileWrite(filePath, () => appendLearnedLine(filePath, line));
	return { backend: "local", stored: 1, message: `Lesson saved to ${LEARNED_LESSONS_FILE}.` };
}

function formatLessonLine(content: string, context: string): string {
	return context ? `- ${content} _(context: ${context})_` : `- ${content}`;
}

/**
 * Serialize read-modify-write per file: parallel `learn` calls (sibling
 * subagents, or two shared tool calls in one turn) and edits from a host share
 * the project memory root, so an unguarded RMW would let the last writer drop
 * the other's change.
 */
async function serializeMemoryFileWrite<T>(filePath: string, write: () => Promise<T>): Promise<T> {
	const run = (learnedWriteChains.get(filePath) ?? Promise.resolve()).then(write);
	const guarded = run.catch(() => {});
	learnedWriteChains.set(filePath, guarded);
	try {
		return await run;
	} finally {
		// Drop the entry once this write is the chain tail, so the map does not
		// retain one promise per distinct memory root for the process lifetime.
		if (learnedWriteChains.get(filePath) === guarded) learnedWriteChains.delete(filePath);
	}
}

async function appendLearnedLine(filePath: string, line: string): Promise<void> {
	let existing = "";
	try {
		existing = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	// Treat the file as an ordered line list so headings, prose, and blank
	// lines keep their positions relative to the bullets they scope. Managed
	// operations touch only bullet lines: dedupe removes an existing copy of
	// the incoming lesson in place, the new lesson enters at the head of the
	// first bullet run (newest-first, matching the read path and cap docs),
	// and the cap drops the oldest (bottom-most) bullets. Hand-edited content
	// outside the list region survives every write byte-for-byte.
	const lines = existing.split("\n");
	// A well-formed file ends with "\n"; drop the terminal split artifact so
	// repeated saves stay idempotent instead of growing a blank line each time.
	if (lines.at(-1) === "") lines.pop();
	const isLesson = isListItem;
	const out = lines.filter(l => !(isLesson(l) && l.trim() === line));
	const firstBullet = out.findIndex(isLesson);
	if (firstBullet === -1) out.push(line);
	else out.splice(firstBullet, 0, line);
	let lessonCount = 0;
	for (const l of out) if (isLesson(l)) lessonCount++;
	for (let i = out.length - 1; i >= 0 && lessonCount > MAX_LEARNED_LESSONS; i--) {
		if (isLesson(out[i])) {
			out.splice(i, 1);
			lessonCount--;
		}
	}
	await Bun.write(filePath, `${out.join("\n")}\n`);
}

/**
 * Read `learned.md`, neutralizing each line on read too — a hand-edited or
 * pre-existing file bypasses write-time normalization and the block renders
 * unescaped into the system prompt. Returns "" when absent/unreadable.
 */
async function readLearnedLessons(memoryRoot: string): Promise<string> {
	return readNeutralizedLines(memoryRoot, LEARNED_LESSONS_FILE);
}

/** Read one injectable memory file with every line neutralized; "" when absent/unreadable. */
async function readNeutralizedLines(memoryRoot: string, fileName: string): Promise<string> {
	let raw = "";
	try {
		raw = (await Bun.file(path.join(memoryRoot, fileName)).text()).trim();
	} catch {
		return "";
	}
	if (!raw) return "";
	// Neutralize delimiters THEN redact per line — mirrors the write path so a
	// hand-edited line cannot reassemble a token after delimiter stripping.
	return raw
		.split("\n")
		.map(line => redactSecrets(neutralizeInjection(line)))
		.join("\n");
}

function isListItem(line: string): boolean {
	return line.trimStart().startsWith("- ");
}

/**
 * Filename of the user's own notes under a project's memory root. Written only
 * from a host (the memory workbench), never by the agent, and injected ahead of
 * the consolidated summary as standing instructions.
 */
const MEMORY_NOTES_FILE = "notes.md";
const MAX_MEMORY_NOTES = 50;
const MAX_MEMORY_NOTE_CHARS = 1000;

/** One bullet of `learned.md` or `notes.md`, as shown for review. */
export interface MemoryListEntry {
	/** The bullet line as stored; edits name the entry by it. */
	line: string;
	text: string;
	/** Lessons only: where the lesson came from. */
	context?: string;
}

/** Why an edit to notes or lessons changed nothing. */
export type MemoryListEditFailure = "empty" | "not_found" | "full";

export type MemoryListEditResult = { ok: true; line?: string } | { ok: false; reason: MemoryListEditFailure };

const LESSON_LINE = /^- (.*?)(?: _\(context: (.*)\)_)?$/;

/** Bullets of a memory list file in file order, neutralized for display; [] when absent. */
export async function readMemoryList(memoryRoot: string, kind: "notes" | "lessons"): Promise<MemoryListEntry[]> {
	let raw = "";
	try {
		raw = await Bun.file(path.join(memoryRoot, memoryListFile(kind))).text();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const entries: MemoryListEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!isListItem(line)) continue;
		const stored = line.trim();
		if (kind === "notes") {
			entries.push({ line: stored, text: redactSecrets(neutralizeInjection(stored.slice(2))) });
			continue;
		}
		const match = LESSON_LINE.exec(stored);
		const text = redactSecrets(neutralizeInjection(match?.[1] ?? stored.slice(2)));
		const context = match?.[2] ? redactSecrets(neutralizeInjection(match[2])) : undefined;
		entries.push({ line: stored, text, context });
	}
	return entries;
}

function memoryListFile(kind: "notes" | "lessons"): string {
	return kind === "notes" ? MEMORY_NOTES_FILE : LEARNED_LESSONS_FILE;
}

/**
 * Add, rewrite, or remove one bullet of the user's notes or the captured
 * lessons. Entries are named by their stored line, so an edit against a list
 * that changed underneath (another window, a `learn` call) reports `not_found`
 * instead of touching the wrong entry. Text is normalized like `learn` input.
 */
export async function editMemoryList(
	agentDir: string,
	cwd: string,
	kind: "notes" | "lessons",
	edit:
		| { action: "add"; text: string }
		| { action: "update"; line: string; text: string; context?: string }
		| { action: "delete"; line: string },
): Promise<MemoryListEditResult> {
	const filePath = path.join(getMemoryRoot(agentDir, cwd), memoryListFile(kind));
	let next: string | undefined;
	if (edit.action !== "delete") {
		const maxChars = kind === "notes" ? MAX_MEMORY_NOTE_CHARS : MAX_LEARNED_CONTENT_CHARS;
		const text = normalizeLearnedText(edit.text, maxChars);
		if (!text) return { ok: false, reason: "empty" };
		const context =
			kind === "lessons" && edit.action === "update" && edit.context
				? normalizeLearnedText(edit.context, MAX_LEARNED_CONTEXT_CHARS)
				: "";
		next = kind === "notes" ? `- ${text}` : formatLessonLine(text, context);
	}
	return serializeMemoryFileWrite(filePath, async () => {
		let existing = "";
		try {
			existing = await Bun.file(filePath).text();
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		const lines = existing.split("\n");
		if (lines.at(-1) === "") lines.pop();
		if (edit.action === "add") {
			const line = next as string;
			const bullets = lines.filter(isListItem);
			if (bullets.some(l => l.trim() === line)) return { ok: true, line };
			if (bullets.length >= MAX_MEMORY_NOTES) return { ok: false, reason: "full" };
			let lastBullet = -1;
			for (let i = 0; i < lines.length; i++) if (isListItem(lines[i])) lastBullet = i;
			lines.splice(lastBullet + 1 || lines.length, 0, line);
			await Bun.write(filePath, `${lines.join("\n")}\n`);
			return { ok: true, line };
		}
		const index = lines.findIndex(l => isListItem(l) && l.trim() === edit.line);
		if (index === -1) return { ok: false, reason: "not_found" };
		if (edit.action === "delete") {
			lines.splice(index, 1);
		} else {
			const line = next as string;
			lines[index] = line;
			// A rewrite that now matches another entry keeps one copy, in this position.
			for (let i = lines.length - 1; i >= 0; i--)
				if (i !== index && isListItem(lines[i]) && lines[i].trim() === line) lines.splice(i, 1);
		}
		const remaining = lines.some(l => l.trim() !== "");
		if (remaining) await Bun.write(filePath, `${lines.join("\n")}\n`);
		else await fs.rm(filePath, { force: true });
		return edit.action === "delete" ? { ok: true } : { ok: true, line: next };
	});
}

function encodeProjectPath(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function unixNow(): number {
	return Math.floor(Date.now() / 1000);
}

async function runWithConcurrency<T>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	const queue = [...items];
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
		while (queue.length > 0) {
			const item = queue.shift();
			if (!item) return;
			await worker(item);
		}
	});
	await Promise.all(workers);
}
