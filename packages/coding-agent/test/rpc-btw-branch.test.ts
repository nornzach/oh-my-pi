import { describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { RpcBtwController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-btw";
import type { BtwHistoryRecord } from "@oh-my-pi/pi-coding-agent/session/btw-history";

// Fork-only `btw_branch`: promotes the last completed RPC /btw answer into a
// session branch. Upstream's RPC controller has no branch path.

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", content } as unknown as AssistantMessage;
}

function harness(reply: () => Promise<{ replyText: string; assistantMessage: AssistantMessage }>) {
	const branchFromBtw = vi.fn(
		async (_question: string, _assistant: AssistantMessage, _leafId: string, _sessionId: string) => ({
			cancelled: false,
			sessionFile: "/tmp/branched.jsonl",
		}),
	);
	const session = {
		model: { id: "model", api: "test", provider: "test" },
		sessionManager: {
			getArtifactsDir: () => null,
			getSessionId: () => "session-1",
			getLeafId: () => "leaf-1",
			ensureOnDisk: async () => {},
		},
		runEphemeralTurn: vi.fn(reply),
		branchFromBtw,
	};
	const records: BtwHistoryRecord[] = [];
	const waiters: Array<() => void> = [];
	const controller = new RpcBtwController(session as never, frame => {
		if (frame.type !== "btw_record") return;
		records.push(frame.record);
		for (const wake of waiters.splice(0)) wake();
	});
	const settled = async (): Promise<BtwHistoryRecord> => {
		for (;;) {
			const done = records.find(record => record.status !== "running");
			if (done) return done;
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push(resolve);
			await promise;
		}
	};
	return { controller, branchFromBtw, settled };
}

describe("RpcBtwController btw_branch", () => {
	it("branches the visible answer from the leaf captured when the question started", async () => {
		const { controller, branchFromBtw, settled } = harness(async () => ({
			replyText: "concise answer",
			assistantMessage: assistant([
				{ type: "thinking", thinking: "private" },
				{ type: "text", text: "raw answer" },
				{ type: "text", text: "duplicate provider part" },
			]),
		}));

		await controller.ask(" why? ");
		expect(await settled()).toMatchObject({ status: "complete", answer: "concise answer" });
		expect(await controller.branch()).toEqual({ cancelled: false, sessionFile: "/tmp/branched.jsonl" });

		const [question, normalized, leafId, sessionId] = branchFromBtw.mock.calls[0] ?? [];
		expect(question).toBe("why?");
		expect(normalized?.content).toEqual([
			{ type: "thinking", thinking: "private" },
			{ type: "text", text: "concise answer" },
		]);
		expect(leafId).toBe("leaf-1");
		expect(sessionId).toBe("session-1");
		// One branch per answer.
		await expect(controller.branch()).rejects.toThrow("No completed /btw answer");
	});

	it("never makes a cancelled answer branchable, even when the reply resolves late", async () => {
		const inFlight = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		// A provider that ignores the abort signal and still resolves its reply.
		const { controller, branchFromBtw, settled } = harness(async () => {
			inFlight.resolve();
			await release.promise;
			return { replyText: "late", assistantMessage: assistant([{ type: "text", text: "late" }]) };
		});

		const record = await controller.ask("slow");
		await inFlight.promise;
		expect(controller.cancel(record.id)).toBe(true);
		expect(await settled()).toMatchObject({ status: "cancelled" });
		release.resolve();
		await Bun.sleep(0);

		await expect(controller.branch()).rejects.toThrow("No completed /btw answer");
		expect(branchFromBtw).not.toHaveBeenCalled();
	});
});
