import type { AskToolDetails } from "@oh-my-pi/pi-tui/tools/ask";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionUIContext } from "../extensibility/extensions";
import type { ToolSession } from "../tools";
import { AskTool } from "../tools/ask";
import { ToolAbortError } from "../tools/tool-errors";
import type { AgentSession } from "./agent-session";

/**
 * Run the `ask` tool outside a normal model turn while navigating onto a
 * persisted ask result. Both the TUI and RPC clients use this path so the
 * answer shape and cancellation semantics stay aligned.
 */
export async function runAskReanswer(
	session: AgentSession,
	html: string,
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
	try {
		return await askTool.execute("tree-reanswer", { html }, undefined, undefined, context);
	} catch (error) {
		if (error instanceof ToolAbortError) return undefined;
		throw error;
	}
}
