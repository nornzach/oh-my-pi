/**
 * Queue-management RPC helpers (get_queue / queue_edit / queue_remove /
 * queue_move / queue_clear). Thin adapters over the stable-id queue ops:
 * AgentSession owns user-restorable filtering, companion grouping, and drain
 * reconciliation:
 *
 * - get_queue: both visible user-message lanes with stable entry ids.
 * - queue_edit: changes only a plain user message's text; ids, images, lane,
 *   timestamp, and hidden companions survive.
 * - queue_remove: removes the visible entry plus its hidden companions.
 * - queue_move: reorders visible entries; `toLane` switches lanes while
 *   companions remain attached.
 * - queue_clear: removes user-restorable entries and their companions while
 *   advisor cards and internal steers survive.
 */
import type { AgentSession } from "../../session/agent-session";
import type { RpcGetQueueResult, RpcQueueEditResult, RpcQueueMoveResult } from "./rpc-types";

type QueueLane = "steering" | "followUp";

function requireQueueId(queueId: unknown): string {
	if (typeof queueId !== "string" || queueId.length === 0) {
		throw new Error("queueId must be a non-empty string");
	}
	return queueId;
}

function optionalQueueLane(value: unknown, field: "lane" | "toLane"): QueueLane | undefined {
	if (value === undefined) return undefined;
	if (value === "steering" || value === "followUp") return value;
	throw new Error(`${field} must be "steering" or "followUp"`);
}

/** Both queue lanes with stable per-entry ids (insertion order). */
export function applyRpcGetQueue(session: AgentSession): RpcGetQueueResult {
	return session.listQueuedMessages();
}

/** Edit one plain queued user message by stable id. Throws on invalid input. */
export function applyRpcQueueEdit(session: AgentSession, queueId: unknown, text: unknown): RpcQueueEditResult {
	const id = requireQueueId(queueId);
	if (typeof text !== "string") throw new Error("text must be a string");
	if (!session.editQueuedMessageById(id, text)) {
		throw new Error(`Unknown queued message id: ${id}`);
	}
	return { updated: true };
}

/** Remove one queued entry by stable id. Throws on unknown id. */
export function applyRpcQueueRemove(session: AgentSession, queueId: unknown): { removed: true } {
	const id = requireQueueId(queueId);
	if (!session.removeQueuedMessageById(id)) {
		throw new Error(`Unknown queued message id: ${id}`);
	}
	return { removed: true };
}

/** Reorder by stable id with a clamped target; `toLane` switches lanes. Throws on unknown id. */
export function applyRpcQueueMove(
	session: AgentSession,
	queueId: unknown,
	toIndex: unknown,
	toLane?: unknown,
): RpcQueueMoveResult {
	const id = requireQueueId(queueId);
	if (typeof toIndex !== "number" || !Number.isFinite(toIndex)) {
		throw new Error("toIndex must be a finite number");
	}
	const lane = optionalQueueLane(toLane, "toLane");
	const moved = session.moveQueuedMessageById(id, toIndex, lane);
	if (moved === undefined) {
		throw new Error(`Unknown queued message id: ${id}`);
	}
	return moved;
}

/** Clear user-restorable queued entries, lane-scoped when `lane` is given. */
export function applyRpcQueueClear(session: AgentSession, lane?: unknown): { removed: number } {
	return { removed: session.clearQueuedMessages(optionalQueueLane(lane, "lane")) };
}
