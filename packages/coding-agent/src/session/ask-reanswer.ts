import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionUIContext } from "../extensibility/extensions";
import type { ToolSession } from "../tools";
import { AskTool, type AskToolDetails, type AskToolInput } from "../tools/ask";
import { ToolAbortError } from "../tools/tool-errors";
import type { AgentSession } from "./agent-session";

export class AskReanswerChatRedirectError extends Error {
	constructor() {
		super("Cannot redirect to chat while re-answering an ask result from session history");
		this.name = "AskReanswerChatRedirectError";
	}
}

/**
 * Run the `ask` tool outside a normal model turn while navigating onto a
 * persisted ask result. Both the TUI and RPC clients use this path so the
 * answer shape, cancellation semantics, and chat-redirect guard stay aligned.
 */
export async function runAskReanswer(
	session: AgentSession,
	questions: AskToolInput["questions"],
	uiContext: ExtensionUIContext,
): Promise<AgentToolResult<AskToolDetails> | undefined> {
	const toolSession: ToolSession = {
		cwd: session.sessionManager.getCwd(),
		hasUI: true,
		settings: session.settings,
		getSessionFile: () => session.sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => null,
		getPlanModeState: () => session.getPlanModeState(),
	};
	const askTool = new AskTool(toolSession);
	const context = session.buildAskReanswerContext(uiContext);
	let result: AgentToolResult<AskToolDetails>;
	try {
		result = await askTool.execute("tree-reanswer", { questions }, undefined, undefined, context);
	} catch (error) {
		if (error instanceof ToolAbortError) return undefined;
		throw error;
	}
	if (result.details?.chatRedirect) throw new AskReanswerChatRedirectError();
	return result;
}
