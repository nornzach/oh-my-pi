import { afterEach, describe, expect, it } from "bun:test";
import { showHostedComponent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-custom-ui";
import { RpcTerminalHost } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-terminal";
import type {
	RpcTerminalFrame,
	RpcTerminalOpenedFrame,
	RpcTerminalOutputFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { Component } from "@oh-my-pi/pi-tui";

let host: RpcTerminalHost | undefined;

afterEach(() => {
	host?.dispose();
	host = undefined;
});

function createHost(): { host: RpcTerminalHost; frames: RpcTerminalFrame[] } {
	const frames: RpcTerminalFrame[] = [];
	host = new RpcTerminalHost({
		output: frame => frames.push(frame),
		environment: async () => ({ shell: "/bin/sh", args: [], cwd: process.cwd(), env: {} }),
		flushMs: 1,
	});
	return { host, frames };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(5);
	}
}

function opened(frames: RpcTerminalFrame[]): RpcTerminalOpenedFrame {
	const frame = frames.find((f): f is RpcTerminalOpenedFrame => f.type === "terminal_opened");
	if (!frame) throw new Error("no terminal_opened frame");
	return frame;
}

function screenText(frames: RpcTerminalFrame[], terminalId: string): string {
	return frames
		.filter((f): f is RpcTerminalOutputFrame => f.type === "terminal_output" && f.terminalId === terminalId)
		.map(f => f.data)
		.join("");
}

/** A component that paints one line and finishes with the first key it receives. */
function echoComponent(done: (key: string) => void, disposed: string[]): Component & { dispose(): void } {
	return {
		render: () => ["hosted-marker"],
		invalidate: () => {},
		handleInput: (data: string) => done(data),
		dispose: () => disposed.push("disposed"),
	};
}

describe("showHostedComponent", () => {
	it("paints the component into a revealed virtual terminal and resolves with the value it reports", async () => {
		const { host, frames } = createHost();
		const disposed: string[] = [];
		const result = showHostedComponent<string>(host, "Extension", (_tui, _theme, _keys, done) =>
			echoComponent(done, disposed),
		);
		const frame = opened(frames);
		expect(frame.reveal).toBe(true);
		expect(frame.terminal).toMatchObject({ kind: "command", title: "Extension", running: true });
		const { terminalId } = frame.terminal;
		await waitFor(() => screenText(frames, terminalId).includes("hosted-marker"), "component paint");

		host.resize(terminalId, 60, 12);
		host.input(terminalId, "y");
		expect(await result).toBe("y");
		expect(disposed).toEqual(["disposed"]);
		expect(frames.some(f => f.type === "terminal_exit" && f.terminalId === terminalId)).toBe(true);
		// Finished terminals take no more input.
		host.input(terminalId, "n");
	});

	it("resolves undefined when the user closes the terminal and forgets it", async () => {
		const { host, frames } = createHost();
		const disposed: string[] = [];
		const result = showHostedComponent<string>(host, "Extension", (_tui, _theme, _keys, done) =>
			echoComponent(done, disposed),
		);
		const { terminalId } = opened(frames).terminal;
		await waitFor(() => screenText(frames, terminalId).includes("hosted-marker"), "component paint");

		host.close(terminalId);
		expect(await result).toBeUndefined();
		expect(disposed).toEqual(["disposed"]);
		expect(frames.some(f => f.type === "terminal_closed" && f.terminalId === terminalId)).toBe(true);
		expect(host.list()).toEqual([]);
	});

	it("rejects with the factory's error and finishes the terminal", async () => {
		const { host, frames } = createHost();
		const result = showHostedComponent<string>(host, "Extension", () => {
			throw new Error("factory failed");
		});
		await expect(result).rejects.toThrow("factory failed");
		const { terminalId } = opened(frames).terminal;
		expect(host.get(terminalId)?.running).toBe(false);
	});

	it("rejects without opening a terminal when the signal is already aborted", async () => {
		const { host, frames } = createHost();
		const controller = new AbortController();
		controller.abort(new Error("gone"));
		await expect(
			showHostedComponent<string>(host, "Extension", (_tui, _theme, _keys, done) => echoComponent(done, []), {
				signal: controller.signal,
			}),
		).rejects.toThrow("gone");
		expect(frames).toEqual([]);
	});
});
