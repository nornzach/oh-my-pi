import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import type { ToolApproval } from "@oh-my-pi/pi-agent-core";
import { RpcTerminalHost } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-terminal";
import { TerminalTool } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-terminal-tool";
import type { RpcTerminalFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";

const ptyUnavailable = process.platform === "win32" || !fs.existsSync("/bin/sh");

let host: RpcTerminalHost | undefined;

afterEach(() => {
	host?.dispose();
	host = undefined;
});

function setup(bashApproval: ToolApproval | undefined = "exec"): {
	host: RpcTerminalHost;
	tool: TerminalTool;
	frames: RpcTerminalFrame[];
} {
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
	const tool = new TerminalTool(host, {
		commandEnvironment: async () => ({ shell: "/bin/sh", cwd: process.cwd(), env: { TERM: "xterm-256color" } }),
		bashApproval: () => bashApproval,
	});
	return { host, tool, frames };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => part.text ?? "").join("\n");
}

describe.skipIf(ptyUnavailable)("terminal tool", () => {
	it("runs a long-lived command in a new terminal that outlives the call, reads it as shown, and stops it", async () => {
		const { host, tool, frames } = setup();
		// `\r` returns to the line start, so the screen shows "XY" over "se".
		const run = await tool.execute("call-1", {
			action: "run",
			command: "printf 'serving abc\\rXY\\n'; while :; do sleep 1; done",
			wait: 1,
		});
		const terminal = run.details?.terminal;
		expect(terminal).toMatchObject({ kind: "background", running: true });
		expect(text(run)).toContain("XYrving abc");
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "terminal_opened",
				terminal: expect.objectContaining({ kind: "background" }),
			}),
		);
		// Still running after the call returned.
		expect(host.get(terminal!.terminalId)?.running).toBe(true);

		// The body after the header line is the screen, not the raw byte stream.
		const read = await tool.execute("call-2", { action: "read", id: terminal!.terminalId });
		expect(text(read).split("\n\n").at(-1)).toBe("XYrving abc");

		const stop = await tool.execute("call-3", { action: "stop", id: terminal!.terminalId });
		expect(stop.details?.terminal?.running).toBe(false);
		// The stopped terminal keeps its output for the user.
		expect(host.list()).toEqual([expect.objectContaining({ terminalId: terminal!.terminalId, running: false })]);
	});

	it("reports a command that exits during the wait, and refuses to stop the user's shell", async () => {
		const { host, tool } = setup();
		const run = await tool.execute("call-1", { action: "run", command: "echo built; exit 4", wait: 5 });
		expect(run.details?.terminal).toMatchObject({ running: false, exitCode: 4 });
		expect(text(run)).toContain("exited 4");

		const shell = await host.open();
		await expect(tool.execute("call-2", { action: "stop", id: shell.terminalId })).rejects.toThrow(/user's shell/);
		expect(host.get(shell.terminalId)?.running).toBe(true);
	});
});

describe("terminal tool approval", () => {
	it("runs commands under the user's bash rules, while reading stays a read", () => {
		const { tool } = setup();
		// `tools.approval.bash: deny` must not be bypassed through the terminal tool.
		expect(resolveApproval(tool, { action: "run", command: "ls" }, "yolo", { bash: "deny" }).policy).toBe("deny");
		expect(resolveApproval(tool, { action: "read", id: "t" }, "always-ask", { bash: "deny" }).policy).toBe("allow");

		// A bash pattern rule that denies the command denies the run too.
		const { tool: guarded } = setup(args =>
			(args as { command: string }).command.startsWith("rm ") ? { tier: "exec", policy: "deny" } : "exec",
		);
		expect(resolveApproval(guarded, { action: "run", command: "rm -rf build" }, "yolo", {}).policy).toBe("deny");
		expect(resolveApproval(guarded, { action: "run", command: "bun run dev" }, "yolo", {}).policy).toBe("allow");
	});
});
