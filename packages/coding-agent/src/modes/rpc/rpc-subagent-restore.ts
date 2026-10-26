/**
 * A session's finished subagents, read back from its transcripts.
 *
 * The RPC roster lives in memory, so a session opened in a new process (a GUI
 * tab reopened from history) listed no agents and could not read their
 * transcripts. The interactive mode reads its saved agents back for the Agent
 * Hub; RPC rebuilds its roster rows from what the transcripts already hold:
 * the `task` results name each agent, its assignment and the call that spawned
 * it, and the job reports after them (`async-result` messages, `wait`/`job`
 * results) say how it ended. Each agent's own transcript, beside the
 * session's, gives its label (its title), model and usage, and does the same
 * for the agents it spawned.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import type { AgentHistorySummary } from "../../registry/agent-registry";
import { readPersistedAgentHistory } from "../../registry/persisted-agents";
import { readSessionTitle } from "../../session/session-loader";
import type { RpcSubagentSnapshot } from "./rpc-types";

type AgentStatus = AgentProgress["status"];
type JsonRecord = Record<string, unknown>;

const TERMINAL: Record<string, AgentStatus> = {
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
	cancelled: "aborted",
};

/** Cheap line filters: only these lines can name a spawn, the call that made it, or a job outcome. */
const RELEVANT_MARKERS = ['"toolName":"task"', '"name":"task"', '"jobs":['];

function recordOf(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampOf(entry: JsonRecord): number {
	const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

/** A `task` result's agent: an exit code, an abort or an error says how it ended. */
function resultStatus(result: JsonRecord): AgentStatus {
	if (result.aborted === true) return "aborted";
	if (stringOf(result.error) || (numberOf(result.exitCode) ?? 0) !== 0) return "failed";
	return "completed";
}

interface Spawn {
	row: RpcSubagentSnapshot;
	settled: boolean;
}

/**
 * The agents one transcript's entries spawned, in spawn order. An agent no
 * entry reports as finished is `aborted`: the process that ran it is gone.
 */
export function subagentsFromEntries(
	entries: readonly unknown[],
	artifactsDir: string,
	parentSubagentId?: string,
): RpcSubagentSnapshot[] {
	const spawns = new Map<string, Spawn>();
	// When each `task` call was made: its agents start then, while a blocking
	// call's result is saved only once they all finish.
	const calledAt = new Map<string, number>();
	const settle = (id: string, status: AgentStatus | undefined, at: number, durationMs?: number) => {
		const spawn = spawns.get(id);
		if (!spawn || !status) return;
		spawn.settled = true;
		spawn.row.status = status;
		spawn.row.lastUpdate = Math.max(spawn.row.lastUpdate, at);
		if (spawn.row.progress) {
			spawn.row.progress = {
				...spawn.row.progress,
				status,
				durationMs: Math.max(numberOf(spawn.row.progress.durationMs) ?? 0, durationMs ?? 0),
			};
		}
	};

	for (const raw of entries) {
		const entry = recordOf(raw);
		if (!entry) continue;
		const at = timestampOf(entry);
		const message = recordOf(entry.message);
		if (entry.type === "message" && message?.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content.map(recordOf)) {
				const callId = stringOf(part?.id);
				if (part?.type === "toolCall" && part.name === "task" && callId) calledAt.set(callId, at);
			}
			continue;
		}
		const details = recordOf(entry.type === "message" ? message?.details : entry.details);
		if (!details) continue;

		if (entry.type === "message" && message?.role === "toolResult" && message.toolName === "task") {
			const parentToolCallId = stringOf(message.toolCallId);
			const progress = Array.isArray(details.progress) ? details.progress.map(recordOf) : [];
			const results = Array.isArray(details.results) ? details.results.map(recordOf) : [];
			for (const item of [...progress, ...results]) {
				const id = stringOf(item?.id);
				if (!item || !id || spawns.has(id)) continue;
				const last = progress.find(candidate => candidate?.id === id);
				spawns.set(id, {
					row: {
						id,
						index: numberOf(item.index) ?? spawns.size,
						agent: stringOf(item.agent) ?? "task",
						agentSource: stringOf(item.agentSource) as RpcSubagentSnapshot["agentSource"],
						description: stringOf(item.description),
						status: "aborted",
						task: stringOf(item.task),
						assignment: stringOf(item.assignment),
						lastUpdate: at,
						spawnedAt: (parentToolCallId && calledAt.get(parentToolCallId)) || at,
						progress: last ? ({ ...last } as unknown as AgentProgress) : undefined,
						parentToolCallId,
						parentSubagentId,
						kind: "sub",
					},
					settled: false,
				});
			}
			// A blocking call reports every agent's outcome in its own result.
			for (const result of results) {
				const id = stringOf(result?.id);
				if (!result || !id) continue;
				const spawn = spawns.get(id);
				if (spawn && !spawn.row.description) spawn.row.description = stringOf(result.description);
				settle(id, resultStatus(result), at, numberOf(result.durationMs));
			}
			// A progress row that already ended (a blocking call's final snapshot).
			for (const item of progress) {
				const id = stringOf(item?.id);
				if (id && !spawns.get(id)?.settled)
					settle(id, TERMINAL[String(item?.status)], at, numberOf(item?.durationMs));
			}
			continue;
		}

		// Background jobs report back later: an `async-result` message, or a
		// `wait`/`job` result listing them. A task job's id is its agent's.
		if (Array.isArray(details.jobs)) {
			for (const job of details.jobs.map(recordOf)) {
				if (!job) continue;
				const id = stringOf(job.agentId) ?? stringOf(job.agentUrlId) ?? stringOf(job.jobId) ?? stringOf(job.id);
				if (id) settle(id, TERMINAL[String(job.status)], at, numberOf(job.durationMs));
			}
		}
	}

	return [...spawns.values()].map(({ row, settled }) => ({
		...row,
		progress: row.progress && !settled ? { ...row.progress, status: "aborted" } : row.progress,
		sessionFile: path.join(artifactsDir, `${row.id}.jsonl`),
	}));
}

/** The entries of `sessionFile` that can name a spawn or a job outcome; none when it is missing. */
async function readRelevantEntries(sessionFile: string): Promise<unknown[]> {
	let text: string;
	try {
		text = await Bun.file(sessionFile).text();
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const entries: unknown[] = [];
	for (const line of text.split("\n")) {
		if (!RELEVANT_MARKERS.some(marker => line.includes(marker))) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// A torn last line, or a line the marker matched inside a string.
		}
	}
	return entries;
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * `progress` with the model and usage its transcript recorded. A background
 * agent's saved progress is its spawn-time snapshot, all zeros.
 */
function withHistory(progress: AgentProgress | undefined, history: AgentHistorySummary): AgentProgress | undefined {
	const metrics = history.metrics;
	if (!progress || (!metrics && !history.resolvedModel)) return progress;
	return {
		...progress,
		resolvedModel: progress.resolvedModel ?? history.resolvedModel,
		resolvedModelIsFallback: progress.resolvedModelIsFallback ?? history.resolvedModelIsFallback,
		modelRole: progress.modelRole ?? history.modelRole,
		...(metrics
			? {
					requests: Math.max(numberOf(progress.requests) ?? 0, metrics.requests),
					toolCount: Math.max(numberOf(progress.toolCount) ?? 0, metrics.tools),
					tokens: Math.max(numberOf(progress.tokens) ?? 0, metrics.tokens),
					cost: Math.max(numberOf(progress.cost) ?? 0, metrics.cost),
					contextTokens: progress.contextTokens ?? metrics.contextTokens,
					durationMs: numberOf(progress.durationMs) || metrics.durationMs,
				}
			: {}),
	};
}

/**
 * Every finished subagent of the session at `sessionFile`, nested ones too,
 * parents before their children, at most `limit`. Agents whose transcript is
 * gone keep their row without one.
 */
export async function readPersistedSubagents(sessionFile: string, limit: number): Promise<RpcSubagentSnapshot[]> {
	const rows: RpcSubagentSnapshot[] = [];
	const seen = new Set<string>();
	const queue: Array<{ file: string; parentSubagentId?: string }> = [{ file: sessionFile }];
	while (queue.length > 0 && rows.length < limit) {
		const { file, parentSubagentId } = queue.shift()!;
		const artifactsDir = file.slice(0, -".jsonl".length);
		const entries = await readRelevantEntries(file);
		for (const row of subagentsFromEntries(entries, artifactsDir, parentSubagentId)) {
			if (seen.has(row.id) || rows.length >= limit) continue;
			seen.add(row.id);
			const transcript = row.sessionFile && (await exists(row.sessionFile)) ? row.sessionFile : undefined;
			const [history, title] = transcript
				? await Promise.all([
						readPersistedAgentHistory({ id: row.id, sessionFile: transcript }, () => true),
						readSessionTitle(transcript),
					])
				: [{}, undefined];
			// A background agent's label lands after its spawn was saved; its transcript title keeps it.
			const description = row.description ?? title;
			const progress = withHistory(row.progress, history);
			rows.push({
				...row,
				description,
				sessionFile: transcript,
				progress:
					progress && description ? { ...progress, description: progress.description ?? description } : progress,
			});
			if (transcript) queue.push({ file: transcript, parentSubagentId: row.id });
		}
	}
	return rows;
}
