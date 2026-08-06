import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../../session/agent-session";
import { runBtwTurn } from "../controllers/btw-controller";

interface CompletedBtw {
	question: string;
	assistantMessage: AssistantMessage;
	leafId: string;
	sessionId: string;
}

export interface RpcBtwResult {
	question: string;
	replyText: string;
	canBranch: boolean;
}

/** Headless /btw lifecycle; the renderer owns presentation and clipboard. */
export class RpcBtwController {
	#completed: CompletedBtw | undefined;

	constructor(readonly session: AgentSession) {}

	async start(question: string): Promise<RpcBtwResult> {
		const trimmed = question.trim();
		if (!trimmed) throw new Error("Usage: /btw <question>");
		if (!this.session.model) throw new Error("No active model available for /btw.");

		const manager = this.session.sessionManager;
		const leafId = manager?.getLeafId() ?? null;
		const sessionId = manager?.getSessionId() ?? this.session.sessionId;
		this.#completed = undefined;
		const { replyText, assistantMessage } = await runBtwTurn(this.session, trimmed);
		const canBranch =
			leafId !== null &&
			manager?.getLeafId() === leafId &&
			manager.getSessionId() === sessionId &&
			!this.session.isStreaming;
		if (leafId !== null) {
			this.#completed = { question: trimmed, assistantMessage, leafId, sessionId };
		}
		return { question: trimmed, replyText, canBranch };
	}

	async branch(): Promise<{ cancelled: boolean; sessionFile: string | undefined }> {
		const completed = this.#completed;
		if (!completed) throw new Error("No completed /btw answer is available to branch.");
		const result = await this.session.branchFromBtw(
			completed.question,
			completed.assistantMessage,
			completed.leafId,
			completed.sessionId,
		);
		if (!result.cancelled) this.#completed = undefined;
		return result;
	}
}
