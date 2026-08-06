/**
 * Session-tree navigation RPC actions.
 *
 * - fork_from: write an INDEPENDENT new session file containing only the path
 *   from root to `entryId` (SessionManager.copyBranchToNewSession) and do NOT
 *   switch — the host decides where it opens (GUI: a new window). Distinct
 *   from `fork` (full-session clone at head + switch) and `branch` (new
 *   branch inside the current session file).
 * - switch_leaf: move the active leaf in place (session.navigateTree, TUI
 *   tree-selector Enter parity). The full navigateTree result contract rides
 *   the wire so a hook veto (cancelled), a draft restore (editorText), or an
 *   ask re-answer (reopenAsk) is never mistaken for success.
 */

import type { ExtensionUIContext } from "../../extensibility/extensions";
import type { AgentSession } from "../../session/agent-session";
import { runAskReanswer } from "../../session/ask-reanswer";
import type { RpcSwitchLeafResult } from "./rpc-types";

export async function applyRpcForkFrom(
	session: AgentSession,
	entryId: string,
): Promise<{ sessionPath: string; sessionId: string }> {
	const result = await session.sessionManager.copyBranchToNewSession(entryId);
	if (!result) {
		throw new Error("Session is not persisting — cannot create a session from here");
	}
	return result;
}

export async function applyRpcSwitchLeaf(
	session: AgentSession,
	command: { entryId: string; summarize?: boolean; customInstructions?: string },
	uiContext?: ExtensionUIContext,
): Promise<RpcSwitchLeafResult> {
	let result = await session.navigateTree(command.entryId, {
		summarize: command.summarize,
		customInstructions: command.customInstructions,
		allowAskReopen: true,
	});
	if (result.reopenAsk && uiContext) {
		const reanswer = await runAskReanswer(session, result.reopenAsk.questions, uiContext);
		if (!reanswer) return { cancelled: true };
		result = await session.navigateTree(command.entryId, {
			summarize: command.summarize,
			customInstructions: command.customInstructions,
			allowAskReopen: true,
			reanswerAskResult: reanswer,
		});
	}
	if (result.cancelled || result.aborted || result.reopenAsk) {
		return {
			cancelled: result.cancelled,
			aborted: result.aborted,
			reopenAsk: result.reopenAsk,
			editorText: result.editorText,
			editorImages: result.editorImages,
		};
	}
	return {
		cancelled: false,
		editorText: result.editorText,
		editorImages: result.editorImages,
		activeLeafId: session.sessionManager.getLeafId() ?? undefined,
		askReanswerCommitted: result.askReanswerCommitted,
	};
}
