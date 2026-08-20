import { describe, expect, it, vi } from "bun:test";
import {
	type PendingExtensionRequest,
	reportDroppedPrompt,
	requestRpcDialog,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

describe("RPC extension UI", () => {
	it("returns a dropped prompt and its images to the host editor", () => {
		const output = vi.fn<(frame: object) => void>();

		reportDroppedPrompt(output, {
			text: "keep my exact prompt",
			images: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
		});

		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: expect.any(String),
			method: "set_editor_text",
			text: "keep my exact prompt",
			images: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
			prepend: true,
		});
	});

	it("cancels the remote dialog when its signal aborts", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const controller = new AbortController();
		const result = requestRpcDialog(
			pendingRequests,
			output,
			{ signal: controller.signal },
			false,
			{ method: "confirm", title: "High-risk command", message: "Allow this command?" },
			response => ("confirmed" in response ? response.confirmed : false),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected the RPC dialog request to carry an id");
		}

		controller.abort();

		expect(await result).toBe(false);
		expect(output).toHaveBeenNthCalledWith(1, {
			type: "extension_ui_request",
			id: request.id,
			method: "confirm",
			title: "High-risk command",
			message: "Allow this command?",
		});
		expect(output).toHaveBeenNthCalledWith(2, {
			type: "extension_ui_request",
			id: expect.any(String),
			method: "cancel",
			targetId: request.id,
		});
		expect(pendingRequests.size).toBe(0);
	});
});
