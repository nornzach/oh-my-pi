import { MCPManager } from "../../mcp/manager";
import type { AgentSession } from "../../session/agent-session";
import { TanCommandController } from "../controllers/tan-command-controller";
import type { InteractiveModeContext } from "../types";

/** Start the existing /tan engine without constructing a terminal UI. */
export async function startRpcTan(session: AgentSession, work: string): Promise<{ jobId: string }> {
	let diagnostic = "Unable to dispatch background tan.";
	const context = {
		session,
		sessionManager: session.sessionManager,
		settings: session.settings,
		mcpManager: MCPManager.instance(),
		showStatus: (message: string) => {
			diagnostic = message;
		},
		showError: (message: string) => {
			diagnostic = message;
		},
		// The RPC client rehydrates after the command response; no terminal
		// transcript exists to rebuild in the sidecar process.
		rebuildChatFromMessages: () => {},
	} as unknown as InteractiveModeContext;
	const jobId = await new TanCommandController(context).start(work);
	if (!jobId) throw new Error(diagnostic);
	return { jobId };
}
