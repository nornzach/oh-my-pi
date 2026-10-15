/**
 * Memory workbench RPC: a host reviews and edits one project's local memory.
 * Every mutation answers with the project's fresh overview so the host never
 * renders a half-applied state.
 */
import * as path from "node:path";
import { editMemoryList } from "../../memories";
import {
	eraseMemory,
	memoryScopeFor,
	readMemoryActivity,
	readMemoryOverview,
	setMemorySourceForgotten,
	startMemoryUpdate,
} from "../../memories/workbench";
import type { AgentSession } from "../../session/agent-session";
import type { RpcMemoryEdit, RpcMemoryEditResult, RpcMemoryOverview, RpcMemoryUpdateResult } from "./rpc-types";

/** Sessions changed within this many minutes are still being worked in; "update now" leaves them. */
const DEFAULT_UPDATE_IDLE_MINUTES = 10;

function scopeOf(session: AgentSession, cwd: string | undefined) {
	const target = cwd?.trim() ? cwd : session.sessionManager.getCwd();
	if (!path.isAbsolute(target)) throw new Error(`Memory project must be an absolute path: ${target}`);
	return memoryScopeFor(session.settings.getAgentDir(), target);
}

export async function buildRpcMemoryOverview(session: AgentSession, cwd?: string): Promise<RpcMemoryOverview> {
	return readMemoryOverview({
		agentDir: session.settings.getAgentDir(),
		settings: session.settings,
		scope: scopeOf(session, cwd),
		session,
		modelRegistry: session.modelRegistry,
	});
}

export function buildRpcMemoryActivity(session: AgentSession, cwd?: string): Pick<RpcMemoryOverview, "activity"> {
	return { activity: readMemoryActivity(session.settings.getAgentDir(), scopeOf(session, cwd)) };
}

function startUpdate(session: AgentSession, cwd: string | undefined, minIdleMinutes: number): boolean {
	return startMemoryUpdate({
		session,
		settings: session.settings,
		modelRegistry: session.modelRegistry,
		agentDir: session.settings.getAgentDir(),
		scope: scopeOf(session, cwd),
		minIdleMinutes,
	});
}

/** Start reading the project's waiting sessions and rebuilding its knowledge. */
export async function applyRpcMemoryUpdate(
	session: AgentSession,
	cwd?: string,
	minIdleMinutes = DEFAULT_UPDATE_IDLE_MINUTES,
): Promise<RpcMemoryUpdateResult> {
	const started = startUpdate(session, cwd, minIdleMinutes);
	return { started, overview: await buildRpcMemoryOverview(session, cwd) };
}

export async function applyRpcMemoryEdit(
	session: AgentSession,
	edit: RpcMemoryEdit,
	cwd?: string,
): Promise<RpcMemoryEditResult> {
	const agentDir = session.settings.getAgentDir();
	const scope = scopeOf(session, cwd);
	let result: RpcMemoryEditResult["result"] = { ok: true };
	switch (edit.kind) {
		case "note":
		case "lesson": {
			const kind = edit.kind === "note" ? "notes" : "lessons";
			if (edit.action === "add") {
				if (edit.kind !== "note") throw new Error("Lessons are captured by the agent; only notes can be added.");
				result = await editMemoryList(agentDir, scope.cwd, kind, { action: "add", text: edit.text });
			} else if (edit.action === "update") {
				result = await editMemoryList(agentDir, scope.cwd, kind, {
					action: "update",
					line: edit.line,
					text: edit.text,
					context: edit.context,
				});
			} else {
				result = await editMemoryList(agentDir, scope.cwd, kind, { action: "delete", line: edit.line });
			}
			break;
		}
		case "source": {
			setMemorySourceForgotten(agentDir, scope, edit.threadId, edit.action === "forget");
			// Forgetting rebuilds the knowledge without the session; restoring reads it again.
			startUpdate(session, scope.cwd, DEFAULT_UPDATE_IDLE_MINUTES);
			break;
		}
		case "erase": {
			await eraseMemory(agentDir, scope);
			break;
		}
	}
	return { result, overview: await buildRpcMemoryOverview(session, scope.cwd) };
}
