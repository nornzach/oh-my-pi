import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { encodeRpcFrame, MAX_RPC_FRAME_BYTES } from "../src/modes/rpc/rpc-frame";
import {
	attachRpcMessageEntryIds,
	attachRpcTranscriptEntryIds,
	pageRpcMessages,
	type RpcMessageSnapshot,
} from "../src/modes/rpc/rpc-messages";
import type { SessionEntry } from "../src/session/session-entries";

function message(index: number, bytes = 32 * 1024): AgentMessage {
	return { role: "user", content: `${index}:${"x".repeat(bytes)}`, timestamp: index };
}

const snapshot: RpcMessageSnapshot = {
	sessionId: "session-1",
	leafId: "leaf-1",
	messageCount: 40,
};

describe("RPC message pagination", () => {
	it("exposes persisted tree ids for cloned and display-rewritten messages", () => {
		const user = message(1, 8);
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			provider: "openai",
			model: "gpt-test",
			timestamp: 2,
			stopReason: "stop",
		} as AgentMessage;
		const branch = [
			{ type: "message", id: "user-entry", parentId: null, timestamp: "2026-01-01", message: user },
			{
				type: "message",
				id: "assistant-entry",
				parentId: "user-entry",
				timestamp: "2026-01-01",
				message: assistant,
			},
		] as SessionEntry[];
		const displayAssistant = {
			...assistant,
			content: [{ type: "text", text: "deobfuscated answer" }],
		} as AgentMessage;

		expect(attachRpcMessageEntryIds([structuredClone(user), displayAssistant], branch)).toMatchObject([
			{ role: "user", entryId: "user-entry" },
			{ role: "assistant", entryId: "assistant-entry" },
		]);
	});

	it("exposes persisted ids for tool results and exact transcript projections", () => {
		const toolResult = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 3,
		} as AgentMessage;
		const branch = [
			{ type: "message", id: "tool-entry", parentId: null, timestamp: "2026-01-01", message: toolResult },
		] as SessionEntry[];

		expect(attachRpcMessageEntryIds([toolResult], branch)).toMatchObject([{ entryId: "tool-entry" }]);
		expect(attachRpcMessageEntryIds([toolResult], [], () => "settled-entry")).toMatchObject([
			{ entryId: "settled-entry" },
		]);
		expect(attachRpcTranscriptEntryIds(structuredClone([toolResult]), ["tool-entry"])).toMatchObject([
			{ entryId: "tool-entry" },
		]);
	});

	it("reconstructs a large history from v1-safe pages without loss or overlap", () => {
		const messages = Array.from({ length: snapshot.messageCount }, (_, index) => message(index));
		const reconstructed: AgentMessage[] = [];
		let cursor: string | undefined;
		let pageCount = 0;

		do {
			const page = pageRpcMessages(messages, snapshot, { cursor, limit: 256 });
			const encoded = encodeRpcFrame({
				id: `page-${pageCount}`,
				type: "response",
				command: "get_messages_page",
				success: true,
				data: page,
			});
			expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
			expect(JSON.parse(encoded).success).toBe(true);
			reconstructed.push(...page.messages);
			cursor = page.nextCursor;
			pageCount++;
		} while (cursor);

		expect(pageCount).toBeGreaterThan(1);
		expect(reconstructed).toEqual(messages);
	});

	it("rejects a cursor after the session snapshot changes", () => {
		const messages = Array.from({ length: snapshot.messageCount }, (_, index) => message(index, 1024));
		const first = pageRpcMessages(messages, snapshot, { limit: 5 });
		expect(first.nextCursor).toBeDefined();

		expect(() =>
			pageRpcMessages(messages, { ...snapshot, leafId: "leaf-2" }, { cursor: first.nextCursor, limit: 5 }),
		).toThrow("RPC message cursor is stale");
	});

	it("returns one individually oversized message so negotiated v2 can carry it losslessly", () => {
		const messages = [message(0, 2 * 1024 * 1024), message(1, 128)];
		const first = pageRpcMessages(
			messages,
			{ sessionId: "session-2", leafId: "leaf-2", messageCount: messages.length },
			{ limit: 10 },
		);

		expect(first.messages).toEqual([messages[0]]);
		expect(first.nextCursor).toBeDefined();
	});
});
