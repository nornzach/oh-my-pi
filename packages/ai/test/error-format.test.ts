import { describe, expect, it } from "bun:test";
import { formatMessage } from "@oh-my-pi/pi-ai/error";

const SOCKET_CLOSE_MESSAGE = "The socket connection was closed unexpectedly";

describe("provider socket-close errors", () => {
	it("explains the interruption, retry behavior, and original transport detail", async () => {
		const message = await formatMessage(new TypeError(SOCKET_CLOSE_MESSAGE), { provider: "openai" });

		expect(message).toContain('response from provider "openai" was interrupted before it completed');
		expect(message).toContain("omp will retry automatically when replay is safe");
		expect(message).toContain(SOCKET_CLOSE_MESSAGE);
	});

	it("does not rewrite unrelated provider errors", async () => {
		const message = await formatMessage(new Error("invalid request"), { provider: "openai" });

		expect(message).toBe("invalid request");
	});
});
