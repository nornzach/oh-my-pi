/**
 * Queue-management RPC helpers (get_queue / queue_remove / queue_move /
 * queue_clear). Thin adapters over the stable-id queue ops: the Agent class
 * owns id assignment and lane mutation, AgentSession owns the
 * user-restorable filtering and drain reconciliation — nothing is
 * reimplemented here:
 *
 * - get_queue: AgentSession.listQueuedMessages (user-restorable, displayable
 *   entries only; advisor cards/hidden companions/internal steers excluded).
 * - queue_remove: AgentSession.removeQueuedMessageById; unknown id throws so
 *   the caller maps it to an error response.
 * - queue_move: AgentSession.moveQueuedMessageById (clamped; `toLane`
 *   switches lanes, stable id survives).
 * - queue_clear: AgentSession.clearQueuedMessages — mirrors the default
 *   AgentSession.clearQueue keep-filter, lane-scoped on request.
 */
import type { AgentSession } from "../../session/agent-session";
import type { RpcGetQueueResult, RpcQueueMoveResult } from "./rpc-types";

/** Both queue lanes with stable per-entry ids (insertion order). */
export function applyRpcGetQueue(session: AgentSession): RpcGetQueueResult {
	return session.listQueuedMessages();
}

/** Remove one queued entry by stable id. Throws on unknown id. */
export function applyRpcQueueRemove(session: AgentSession, queueId: string): { removed: true } {
	if (!session.removeQueuedMessageById(queueId)) {
		throw new Error(`Unknown queued message id: ${queueId}`);
	}
	return { removed: true };
}

/** Reorder by stable id with a clamped target; `toLane` switches lanes. Throws on unknown id. */
export function applyRpcQueueMove(
	session: AgentSession,
	queueId: string,
	toIndex: number,
	toLane?: "steering" | "followUp",
): RpcQueueMoveResult {
	const moved = session.moveQueuedMessageById(queueId, toIndex, toLane);
	if (moved === undefined) {
		throw new Error(`Unknown queued message id: ${queueId}`);
	}
	return moved;
}

/** Clear user-restorable queued entries, lane-scoped when `lane` is given. */
export function applyRpcQueueClear(session: AgentSession, lane?: "steering" | "followUp"): { removed: number } {
	return { removed: session.clearQueuedMessages(lane) };
}
