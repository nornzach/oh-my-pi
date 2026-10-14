import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import {
	RpcTerminalHost,
	resolveTerminalShell,
	trimScrollback,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-terminal";
import type { RpcTerminalFrame, RpcTerminalOutputFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const ptyUnavailable = process.platform === "win32" || !fs.existsSync("/bin/sh");

let host: RpcTerminalHost | undefined;

afterEach(() => {
	host?.dispose();
	host = undefined;
});

function createHost(): { host: RpcTerminalHost; frames: RpcTerminalFrame[] } {
	const frames: RpcTerminalFrame[] = [];
	host = new RpcTerminalHost({
		output: frame => frames.push(frame),
		environment: async () => ({
			shell: "/bin/sh",
			args: [],
			cwd: process.cwd(),
			env: { PS1: "$ ", TERM: "xterm-256color" },
		}),
		flushMs: 1,
	});
	return { host, frames };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

function outputOf(frames: RpcTerminalFrame[], terminalId: string): RpcTerminalOutputFrame[] {
	return frames.filter(
		(f): f is RpcTerminalOutputFrame => f.type === "terminal_output" && f.terminalId === terminalId,
	);
}

describe.skipIf(ptyUnavailable)("RpcTerminalHost", () => {
	it("runs a login shell: typed input reaches it, output streams with cumulative seq, exit is reported", async () => {
		const { host, frames } = createHost();
		const terminal = await host.open({ cols: 80, rows: 24 });
		expect(terminal).toMatchObject({ kind: "shell", running: true, cols: 80, rows: 24 });
		expect(frames[0]).toMatchObject({ type: "terminal_opened", terminal: { terminalId: terminal.terminalId } });

		host.input(terminal.terminalId, "echo marker-$((40+2))\n");
		await waitFor(() => outputOf(frames, terminal.terminalId).some(f => f.data.includes("marker-42")), "echo output");
		host.input(terminal.terminalId, "exit 3\n");
		await waitFor(() => frames.some(f => f.type === "terminal_exit"), "exit frame");

		const outputs = outputOf(frames, terminal.terminalId);
		let total = 0;
		for (const frame of outputs) {
			total += frame.data.length;
			expect(frame.seq).toBe(total);
		}
		expect(frames.find(f => f.type === "terminal_exit")).toMatchObject({ exitCode: 3, cancelled: false });
		// An exited terminal stays listed (scrollback and status on screen) until closed.
		expect(host.list()).toEqual([
			expect.objectContaining({ terminalId: terminal.terminalId, running: false, exitCode: 3 }),
		]);
		host.close(terminal.terminalId);
		expect(host.list()).toEqual([]);
		expect(frames.at(-1)).toEqual({ type: "terminal_closed", terminalId: terminal.terminalId });
	});

	it("snapshots everything sent so far, so a remounted view replays it and skips frames up to its seq", async () => {
		const { host, frames } = createHost();
		const terminal = await host.open();
		host.input(terminal.terminalId, "echo before-snapshot\n");
		await waitFor(
			() => outputOf(frames, terminal.terminalId).some(f => f.data.includes("before-snapshot")),
			"first output",
		);

		const snapshot = host.snapshot(terminal.terminalId);
		const sentBefore = outputOf(frames, terminal.terminalId);
		expect(snapshot.seq).toBe(sentBefore.at(-1)?.seq ?? 0);
		expect(snapshot.data).toBe(sentBefore.map(f => f.data).join(""));

		host.input(terminal.terminalId, "echo after-snapshot\n");
		await waitFor(
			() => outputOf(frames, terminal.terminalId).some(f => f.data.includes("after-snapshot")),
			"later output",
		);
		const replayed =
			snapshot.data +
			outputOf(frames, terminal.terminalId)
				.filter(f => f.seq > snapshot.seq)
				.map(f => f.data)
				.join("");
		expect(replayed).toBe(host.snapshot(terminal.terminalId).data);
	});

	it("runs an interactive command where the host can type into it, revealed and kept after exit", async () => {
		const { host, frames } = createHost();
		const chunks: string[] = [];
		const run = host.runCommand(
			{
				command: "printf 'password: '; read answer; echo got=$answer",
				cwd: process.cwd(),
				shell: "/bin/sh",
				env: {},
			},
			chunk => chunks.push(chunk),
		);
		const opened = frames.find(f => f.type === "terminal_opened");
		expect(opened).toMatchObject({ reveal: true, terminal: { kind: "command", running: true } });
		if (opened?.type !== "terminal_opened") throw new Error("expected terminal_opened");
		await waitFor(() => chunks.join("").includes("password: "), "prompt");
		host.input(opened.terminal.terminalId, "hunter2\n");

		expect(await run).toMatchObject({ exitCode: 0, cancelled: false, timedOut: false });
		expect(chunks.join("")).toContain("got=hunter2");
		expect(host.list()).toEqual([expect.objectContaining({ kind: "command", running: false, exitCode: 0 })]);
	});

	it("closes the oldest finished agent terminals past five, never the user's exited shell", async () => {
		const { host, frames } = createHost();
		const shell = await host.open();
		host.input(shell.terminalId, "exit 0\n");
		await waitFor(() => host.get(shell.terminalId)?.running === false, "shell exit");

		const started: string[] = [];
		for (let i = 0; i < 7; i++) {
			const terminal = await host.startBackground({
				shell: "/bin/sh",
				cwd: process.cwd(),
				env: {},
				command: `exit ${i}`,
			});
			await host.waitForExit(terminal.terminalId, 5_000);
			started.push(terminal.terminalId);
		}

		expect(host.list().map(info => info.terminalId)).toEqual([shell.terminalId, ...started.slice(2)]);
		const closed = frames.filter(frame => frame.type === "terminal_closed").map(frame => frame.terminalId);
		expect(closed).toEqual(started.slice(0, 2));
	});

	it("kills a running shell on close and forgets it once it exits", async () => {
		const { host, frames } = createHost();
		const terminal = await host.open();
		host.close(terminal.terminalId);
		await waitFor(() => frames.some(f => f.type === "terminal_closed"), "closed frame");
		expect(frames.find(f => f.type === "terminal_exit")).toMatchObject({ terminalId: terminal.terminalId });
		expect(host.list()).toEqual([]);
		expect(() => host.input(terminal.terminalId, "x")).toThrow("Unknown terminal");
	});
});

describe("terminal helpers", () => {
	it("starts POSIX shells as login shells and Windows shells with their own flags", () => {
		expect(resolveTerminalShell("/bin/sh", "/bin/bash")).toEqual({ shell: "/bin/sh", args: ["-l"] });
		// A $SHELL that does not exist falls back to the agent's configured shell.
		expect(resolveTerminalShell("/nonexistent/zsh", "/bin/sh")).toEqual({ shell: "/bin/sh", args: ["-l"] });
		expect(resolveTerminalShell(undefined, "C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toEqual({
			shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			args: ["-NoLogo"],
		});
		expect(resolveTerminalShell(undefined, "C:\\Windows\\System32\\cmd.exe")).toMatchObject({ args: [] });
	});

	it("trims scrollback to the newest characters, starting at a nearby line boundary", () => {
		expect(trimScrollback("aaaa\nbbbb\ncccc", 8)).toBe("cccc");
		const long = `${"x".repeat(10_000)}tail`;
		expect(trimScrollback(long, 6)).toBe("xxtail");
	});
});
