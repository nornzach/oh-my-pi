/**
 * `/btw` side questions for RPC hosts: the `btw`, `btw_cancel`, `btw_inject` and
 * `get_btw_history` commands plus the `btw_delta` / `btw_record` frames.
 *
 * Mirrors the TUI `BtwController` without its panels: one side question runs
 * at a time against the main session, answers stream as frames, and every
 * turn is checkpointed into the session's BTW history sidecar, so the TUI and
 * RPC hosts read and continue the same topics.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger, toError } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { assistantMessageWithReplyText } from "../controllers/btw-controller";
import {
	BtwHistoryConflictError,
	type BtwHistoryRecord,
	BtwHistoryStore,
	type BtwHistoryTurn,
	getBtwLatestTurn,
	getBtwRecordInject,
	getBtwTurnKey,
} from "../../session/btw-history";
import { beginBtwTurn, patchLatestBtwTurn, runBtwTurn } from "../../session/btw-turn";
import { cfgBtwInject } from "../settings";
import type { RpcBtwDeltaFrame, RpcBtwHistoryRecord, RpcBtwInjectState, RpcBtwRecordFrame } from "./rpc-types";

type RpcBtwOutputFrame =
	| RpcBtwDeltaFrame
	| RpcBtwRecordFrame
	| { type: "notice"; level: "error"; message: string; source: "btw-history" };

/** Last successfully completed turn, kept so `btw_branch` can promote it. */
interface CompletedBtw {
	question: string;
	assistantMessage: AssistantMessage;
	leafId: string;
	sessionId: string;
}

interface RunningBtw {
	record: BtwHistoryRecord;
	store: BtwHistoryStore;
	abort: AbortController;
	/** `btw.inject` when the question was asked: only such an answer's block can be sent. */
	inject: boolean;
}

type BtwSession = Pick<
	AgentSession,
	"model" | "runEphemeralTurn" | "sessionManager" | "branchFromBtw" | "settings" | "prompt"
>;

const CANCELLED_WHILE_STARTING = "The /btw question was cancelled before it started";

/** The TUI-only `title` heading stays off the wire; hosts head a topic by its question. */
function toRpcRecord({ title: _title, ...record }: BtwHistoryRecord, inject?: RpcBtwInjectState): RpcBtwHistoryRecord {
	return inject ? { ...record, inject } : record;
}

export class RpcBtwController {
	readonly #session: BtwSession;
	readonly #output: (frame: RpcBtwOutputFrame) => void;
	#store: BtwHistoryStore | undefined;
	/** `sessionId \0 artifactsDir` the store was opened for. */
	#storeKey: string | undefined;
	#running: RunningBtw | undefined;
	/** Completed turn eligible for `btw_branch` until the next question starts. */
	#completed: CompletedBtw | undefined;
	/** Topic of the `btw` command between validation and its first checkpoint (`null`: a new topic). */
	#startingTopic: string | null | undefined;
	/** Bumped by every cancel and session change; a `btw` still starting from before gives up. */
	#epoch = 0;
	/** Terminal checkpoint writes still in flight. */
	readonly #writes = new Set<Promise<void>>();
	/** Terminal checkpoints that failed, keyed by record id (latest wins); retried before any move. */
	readonly #unsaved = new Map<string, RunningBtw>();
	/**
	 * Steering prompts by turn key (TUI parity): only answers asked here with `btw.inject` on get
	 * an entry, so history from another process or an earlier run never sends.
	 */
	readonly #injects = new Map<string, RpcBtwInjectState>();

	constructor(session: BtwSession, output: (frame: RpcBtwOutputFrame) => void) {
		this.#session = session;
		this.#output = output;
	}

	/**
	 * Promote the last completed answer into a session branch (fork-only
	 * `btw_branch` command; the TUI branches from its own controller).
	 */
	async branch(): Promise<{
		cancelled: boolean;
		sessionFile: string | undefined;
	}> {
		const completed = this.#completed;
		if (!completed) throw new Error("No completed /btw answer is available to branch.");
		const result = await this.#session.branchFromBtw(
			completed.question,
			completed.assistantMessage,
			completed.leafId,
			completed.sessionId,
		);
		if (!result.cancelled) this.#completed = undefined;
		return result;
	}

	/**
	 * Start a side question (or a follow-up in topic `recordId`); resolves once it is
	 * checkpointed as running. The turn itself starts after the caller has answered.
	 */
	async ask(question: string, recordId?: string): Promise<RpcBtwHistoryRecord> {
		const trimmed = typeof question === "string" ? question.trim() : "";
		if (!trimmed) throw new Error("btw requires a non-empty question");
		if (this.#startingTopic !== undefined || this.#running) {
			throw new Error("A /btw question is still running; cancel it first");
		}
		this.#startingTopic = recordId ?? null;
		this.#completed = undefined;
		const epoch = this.#epoch;
		try {
			await this.#settleWrites();
			const store = await this.#openStore(true);
			if (epoch !== this.#epoch) throw new Error(CANCELLED_WHILE_STARTING);
			const previous = recordId === undefined ? undefined : store.getRecords().find(r => r.id === recordId);
			if (recordId !== undefined && !previous) throw new Error(`Unknown /btw topic: ${recordId}`);
			if (!this.#session.model) throw new Error("No active model available for /btw.");
			const manager = this.#session.sessionManager;
			await manager.ensureOnDisk();
			if (epoch !== this.#epoch) throw new Error(CANCELLED_WHILE_STARTING);
			const { record, history, conversationKey } = beginBtwTurn(trimmed, manager.getLeafId(), previous);
			try {
				await store.upsert(record);
			} catch (error) {
				throw new Error(`Could not save /btw history: ${toError(error).message}`, { cause: error });
			}
			const running: RunningBtw = {
				record,
				store,
				abort: new AbortController(),
				inject: cfgBtwInject.get(this.#session.settings),
			};
			this.#running = running;
			this.#output({ type: "btw_record", record: toRpcRecord(record) });
			if (epoch !== this.#epoch) {
				// Cancelled or the session changed while the first checkpoint was written.
				this.#finish(running, { status: "cancelled", updatedAt: Date.now() });
				throw new Error(CANCELLED_WHILE_STARTING);
			}
			// A macrotask: the `btw` response is written first, so it never trails this turn's frames.
			setTimeout(() => void this.#run(running, trimmed, history, conversationKey), 0);
			return toRpcRecord(record);
		} finally {
			this.#startingTopic = undefined;
		}
	}

	/** Cancel the running or starting question (only if it is topic `recordId`, when given). */
	cancel(recordId?: string): boolean {
		const running = this.#running;
		if (running) {
			if (recordId !== undefined && running.record.id !== recordId) return false;
			this.#epoch++;
			this.#finish(running, { status: "cancelled", updatedAt: Date.now() });
			running.abort.abort();
			return true;
		}
		const starting = this.#startingTopic;
		if (starting === undefined || (recordId !== undefined && starting !== recordId)) return false;
		this.#epoch++;
		return true;
	}

	/** Newest first, re-read from disk when idle; a running topic carries its live partial answer. */
	async history(): Promise<readonly RpcBtwHistoryRecord[]> {
		const store = await this.#openStore(this.#running === undefined && this.#startingTopic === undefined);
		const running = this.#running;
		const records = new Map(store.getRecords().map(record => [record.id, record]));
		for (const unsaved of this.#unsaved.values()) {
			if (unsaved.store === store) records.set(unsaved.record.id, unsaved.record);
		}
		if (running?.store === store) records.set(running.record.id, running.record);
		return [...records.values()]
			.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
			.map(record => this.#toRpc(record));
	}

	/**
	 * Send topic `recordId`'s steering prompt to the main session as a user message: a steer
	 * while the agent runs, else a new turn, with templates and slash commands left unexpanded
	 * (TUI parity). Resolves once the prompt is admitted or refused; a refused send turns back
	 * to `ready` so it can be retried, and a sent one is never sent again.
	 */
	async inject(recordId: string): Promise<{ sent: boolean; reason?: string }> {
		const store = await this.#openStore(false);
		const record =
			this.#unsaved.get(recordId)?.record ?? store.getRecords().find(candidate => candidate.id === recordId);
		const text = record ? getBtwRecordInject(record) : undefined;
		const key = record ? getBtwTurnKey(record) : undefined;
		if (!record || !text || !key || this.#injects.get(key) === undefined) {
			throw new Error("This /btw answer has no steering prompt to send");
		}
		if (this.#injects.get(key) !== "ready") return { sent: this.#injects.get(key) === "sent" };
		const outcome = Promise.withResolvers<{ sent: boolean; reason?: string }>();
		let settled = false;
		let queued = false;
		// The first outcome wins: the prompt's own promise also settles when the turn ends.
		const settle = (sent: boolean, reason?: string): void => {
			if (settled) return;
			settled = true;
			this.#injects.set(key, sent ? "sent" : "ready");
			this.#output({ type: "btw_record", record: this.#toRpc(record) });
			outcome.resolve(reason ? { sent, reason } : { sent });
		};
		this.#injects.set(key, "sending");
		this.#output({ type: "btw_record", record: this.#toRpc(record) });
		this.#session
			.prompt(text, {
				expandPromptTemplates: false,
				streamingBehavior: "steer",
				throwOnDrop: true,
				onPromptQueued: () => {
					queued = true;
				},
				onPromptAdmitted: () => settle(true),
			})
			.then(
				// A drop while queueing resolves without admission: nothing was sent.
				() => settle(false),
				// Already in the steer queue: it was sent, so keep the mark.
				(error: unknown) => (queued ? settle(true) : settle(false, toError(error).message)),
			);
		return outcome.promise;
	}

	#toRpc(record: BtwHistoryRecord): RpcBtwHistoryRecord {
		return toRpcRecord(record, this.#injects.get(getBtwTurnKey(record)));
	}

	/**
	 * Before the session is replaced or the process exits: cancel the running or starting
	 * question and land every terminal checkpoint. Throws, after one retry, when a checkpoint
	 * still cannot be saved, so the caller keeps the session instead of losing that answer.
	 */
	async close(): Promise<void> {
		this.#epoch++;
		this.cancel();
		await this.#settleWrites();
	}

	/**
	 * Await terminal checkpoints, retrying failed ones once against their original revision.
	 * A retry that conflicts (the topic was deleted or rewritten on disk) can never succeed:
	 * the record is reported lost and dropped instead of blocking every later session change.
	 */
	async #settleWrites(): Promise<void> {
		while (this.#writes.size > 0) await Promise.all(this.#writes);
		for (const [id, failed] of this.#unsaved) {
			try {
				await failed.store.retry(failed.record);
				this.#unsaved.delete(id);
			} catch (error) {
				if (error instanceof BtwHistoryConflictError) {
					this.#unsaved.delete(id);
					const message = `/btw answer ${id} was not saved: ${error.message}; it changed or was removed on disk`;
					logger.error(message);
					this.#output({
						type: "notice",
						level: "error",
						message,
						source: "btw-history",
					});
					continue;
				}
				throw new Error(
					`/btw history could not be saved: ${toError(error).message}. Fix the storage and retry; unsaved answers remain in this session.`,
					{ cause: error },
				);
			}
		}
	}

	/**
	 * The current session's store with every queued checkpoint landed, so a just-finished
	 * turn reads as finished. `fresh` re-reads a persisted store from disk, picking up topics
	 * another process (the TUI) wrote; callers pass it only while nothing runs here. A store
	 * whose write failed (already reported) is replaced by a fresh read instead of failing
	 * every later call.
	 */
	async #openStore(fresh: boolean): Promise<BtwHistoryStore> {
		const manager = this.#session.sessionManager;
		const artifactsDir = manager.getArtifactsDir() ?? undefined;
		const key = `${manager.getSessionId()}\0${artifactsDir ?? ""}`;
		const cached = this.#storeKey === key ? this.#store : undefined;
		if (cached) {
			try {
				await cached.flush();
				// Without an artifacts dir the store is the only copy: never drop it.
				if (!fresh || artifactsDir === undefined) return cached;
			} catch {
				// A failed checkpoint was already reported as a `notice`; re-read from disk below.
				if ([...this.#unsaved.values()].some(unsaved => unsaved.store === cached)) return cached;
			}
		} else if (this.#running) {
			// Replaced outside a host command (an extension switched sessions): the old
			// session's question must not keep streaming into this one's view.
			this.cancel();
		}
		const store = await BtwHistoryStore.open(artifactsDir);
		// A concurrent open for the same session already replaced the cache: keep one store.
		if (this.#storeKey === key && this.#store !== cached) return this.#store!;
		this.#store = store;
		this.#storeKey = key;
		return store;
	}

	async #run(
		running: RunningBtw,
		question: string,
		history: readonly BtwHistoryTurn[] | undefined,
		conversationKey: string,
	): Promise<void> {
		if (this.#running !== running) return;
		try {
			const { replyText, assistantMessage } = await runBtwTurn(this.#session, {
				question,
				history,
				inject: running.inject,
				conversationKey,
				signal: running.abort.signal,
				onTextDelta: delta => {
					if (this.#running !== running) return;
					const latest = getBtwLatestTurn(running.record);
					running.record = patchLatestBtwTurn(running.record, {
						answer: latest.answer + delta,
						updatedAt: Date.now(),
					});
					this.#output({
						type: "btw_delta",
						recordId: running.record.id,
						delta,
					});
				},
			});
			// Cancelled (or superseded) while the reply resolved: the turn is not
			// complete, so it must not become branchable.
			if (this.#running !== running) return;
			this.#finish(running, {
				answer: replyText,
				status: "complete",
				updatedAt: Date.now(),
			});
			const leafId = running.record.leafId;
			const sessionId = this.#session.sessionManager?.getSessionId() ?? null;
			// A null leaf (ephemeral start) can't be branched — branchFromBtw requires it.
			// Branch the visible answer (TUI parity), not raw provider parts.
			this.#completed =
				leafId && sessionId
					? {
							question,
							assistantMessage: assistantMessageWithReplyText(assistantMessage, replyText),
							leafId,
							sessionId,
						}
					: undefined;
		} catch (error) {
			this.#finish(running, {
				status: "error",
				error: toError(error).message,
				updatedAt: Date.now(),
			});
		}
	}

	/** Record the turn's terminal state once; later outcomes of the same turn are ignored. */
	#finish(running: RunningBtw, patch: Partial<BtwHistoryTurn>): void {
		if (this.#running !== running) return;
		this.#running = undefined;
		running.record = patchLatestBtwTurn(running.record, patch);
		// Only an answer asked with the inject instruction can be sent, even if the setting is turned on later.
		if (running.inject && getBtwRecordInject(running.record) !== undefined) {
			this.#injects.set(getBtwTurnKey(running.record), "ready");
		}
		this.#output({ type: "btw_record", record: this.#toRpc(running.record) });
		const write = running.store.upsert(running.record).then(
			() => {
				this.#unsaved.delete(running.record.id);
			},
			error => {
				this.#unsaved.set(running.record.id, running);
				const message = `Could not save /btw history: ${toError(error).message}`;
				logger.error(message);
				this.#output({
					type: "notice",
					level: "error",
					message,
					source: "btw-history",
				});
			},
		);
		this.#writes.add(write);
		void write.finally(() => this.#writes.delete(write));
	}
}
