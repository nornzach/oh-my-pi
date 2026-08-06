import { describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { RpcBtwController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-btw";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return { content } as unknown as AssistantMessage;
}

describe("RpcBtwController", () => {
	it("runs an ephemeral turn and branches its normalized answer from the captured leaf", async () => {
		const branchFromBtw = vi.fn(
			async (_question: string, _assistant: AssistantMessage, _leafId: string, _sessionId: string) => ({
				cancelled: false,
				sessionFile: "/tmp/branched.jsonl",
			}),
		);
		const session = {
			model: { id: "model" },
			sessionId: "agent-session",
			sessionManager: {
				getLeafId: () => "leaf-1",
				getSessionId: () => "session-1",
			},
			isStreaming: false,
			runEphemeralTurn: vi.fn(async () => ({
				replyText: "concise answer",
				assistantMessage: assistant([
					{ type: "thinking", thinking: "private" },
					{ type: "text", text: "raw answer" },
					{ type: "text", text: "duplicate provider part" },
				]),
			})),
			branchFromBtw,
		} as unknown as AgentSession;
		const controller = new RpcBtwController(session);

		expect(await controller.start(" why? ")).toEqual({
			question: "why?",
			replyText: "concise answer",
			canBranch: true,
		});
		expect(await controller.branch()).toEqual({ cancelled: false, sessionFile: "/tmp/branched.jsonl" });
		expect(branchFromBtw).toHaveBeenCalledTimes(1);
		const [question, normalized, leafId, sessionId] = branchFromBtw.mock.calls[0] ?? [];
		expect(question).toBe("why?");
		expect(normalized?.content).toEqual([
			{ type: "thinking", thinking: "private" },
			{ type: "text", text: "concise answer" },
		]);
		expect(leafId).toBe("leaf-1");
		expect(sessionId).toBe("session-1");
	});
});
