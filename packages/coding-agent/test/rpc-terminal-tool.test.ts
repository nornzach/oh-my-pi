import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
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
		sshCommand: async () => {
			throw new Error("no ssh in this test");
		},
	});
	return { host, tool, frames };
}

/** A home with no profile, so a login shell's startup is the shell's own. */
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-home-"));
afterAll(() => fs.rmSync(emptyHome, { recursive: true, force: true }));

/**
 * A tool whose sessions run `shell` here, and whose `ssh` runs `login` before
 * the remote command, standing in for what the terminal shows before an SSH
 * login goes through.
 */
function sessionSetup(
	shell: string,
	login = "",
): { host: RpcTerminalHost; tool: TerminalTool; frames: RpcTerminalFrame[] } {
	const frames: RpcTerminalFrame[] = [];
	const env = {
		TERM: "xterm-256color",
		SHELL: shell,
		HOME: emptyHome,
		ZDOTDIR: emptyHome,
		PATH: process.env.PATH ?? "/usr/bin:/bin",
	};
	host = new RpcTerminalHost({
		output: frame => frames.push(frame),
		environment: async () => ({ shell, args: [], cwd: process.cwd(), env }),
		flushMs: 1,
	});
	const tool = new TerminalTool(host, {
		commandEnvironment: async () => ({ shell, cwd: process.cwd(), env }),
		bashApproval: () => "exec",
		sshCommand: async (_destination, remoteCommand) => ({
			application: "/bin/sh",
			args: ["-c", `${login}${remoteCommand}`],
		}),
	});
	return { host, tool, frames };
}

/** The output lines of an `exec` or `wait` result: everything after its status line. */
function outputLines(result: { content: Array<{ type: string; text?: string }> }): string[] {
	const [, ...rest] = text(result).split("\n\n");
	return rest
		.join("\n\n")
		.split("\n")
		.filter(line => line.length > 0);
}

/**
 * One shell per way a session learns where commands end: macOS `/bin/sh`
 * (bash 3.2) reports at the prompt but cannot mark where output starts;
 * Linux `/bin/sh` (dash) has no prompt hook, so each command carries its
 * report; zsh marks both ends; bash 4.4+ marks the start with `PS0`.
 */
const modernBash =
	fs.existsSync("/bin/bash") &&
	Number(
		(await $`/bin/bash -c 'echo $((BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1]))'`.quiet().nothrow().text()).trim(),
	) >= 404 &&
	!fs.realpathSync("/bin/sh").endsWith("bash");
const sessionShells = ["/bin/sh", "/bin/zsh", ...(modernBash ? ["/bin/bash"] : [])].filter(shell =>
	fs.existsSync(shell),
);

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

describe.skipIf(ptyUnavailable)("terminal sessions", () => {
	it.each(sessionShells)(
		"%s keeps its state between commands and reports each command's own output and exit code",
		async shell => {
			const { host, tool } = sessionSetup(shell);
			const open = await tool.execute("call-1", { action: "open", label: "work", wait: 15 });
			const id = open.details!.terminal!.terminalId;
			expect(host.get(id)).toMatchObject({ kind: "session", state: "idle", title: "work" });

			const dir = fs.realpathSync(emptyHome);
			await tool.execute("call-2", { action: "exec", id, command: `cd ${dir} && export OMP_SESSION_X=42` });
			const second = await tool.execute("call-3", { action: "exec", id, command: 'pwd; echo "x=$OMP_SESSION_X"' });
			expect(outputLines(second)).toEqual([dir, "x=42"]);
			expect(second.details?.exitCode).toBe(0);
			// The prompt's report moves the terminal's directory with the shell.
			expect(host.get(id)?.cwd).toBe(dir);

			// Lines run as one command: one report, after the last line.
			const multi = await tool.execute("call-4", { action: "exec", id, command: "echo one\necho two\nfalse" });
			expect(outputLines(multi)).toEqual(["one", "two"]);
			expect(multi.details?.exitCode).toBe(1);
		},
		30_000,
	);

	it("ignores a report printed without the session's nonce, so output cannot end a command early", async () => {
		const { tool, host } = sessionSetup("/bin/sh");
		const open = await tool.execute("call-1", { action: "open", wait: 15 });
		const id = open.details!.terminal!.terminalId;
		const spoofed = await tool.execute("call-2", {
			action: "exec",
			id,
			command: "printf '\\033]6973;0000;D;0;0;/\\007'; sleep 0.3; echo after",
		});
		expect(outputLines(spoofed)).toEqual(["after"]);
		expect(spoofed.details?.exitCode).toBe(0);
		expect(host.get(id)?.root).toBe(false);
	}, 30_000);

	it("refuses a second command while one runs, and wait returns the first when it ends", async () => {
		const { tool } = sessionSetup("/bin/sh");
		const id = (await tool.execute("call-1", { action: "open", wait: 15 })).details!.terminal!.terminalId;
		const slow = await tool.execute("call-2", { action: "exec", id, command: "sleep 1; echo done", wait: 0.2 });
		expect(text(slow)).toContain("still running");
		await expect(tool.execute("call-3", { action: "exec", id, command: "echo next" })).rejects.toThrow(
			/still running/,
		);
		const waited = await tool.execute("call-4", { action: "wait", id, wait: 10 });
		expect(outputLines(waited)).toEqual(["done"]);
	}, 30_000);

	it("hands a password prompt to the user: the agent cannot answer it and never sees what they type", async () => {
		const { host, tool, frames } = sessionSetup("/bin/sh");
		const id = (await tool.execute("call-1", { action: "open", wait: 15 })).details!.terminal!.terminalId;
		const asked = await tool.execute("call-2", {
			action: "exec",
			id,
			command: `printf 'Password: '; stty -echo; read secret; stty echo; echo; echo "length \${#secret}"`,
			wait: 1,
		});
		expect(text(asked)).toContain("waiting for the user");
		expect(host.get(id)?.state).toBe("input");
		// The host is asked to show the terminal to the user.
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "terminal_opened",
				reveal: true,
				terminal: expect.objectContaining({ state: "input" }),
			}),
		);
		await expect(tool.execute("call-3", { action: "send", id, text: "guess", key: "enter" })).rejects.toThrow(
			/theirs to type/,
		);

		host.input(id, "hunter22\r");
		const answered = await tool.execute("call-4", { action: "wait", id, wait: 10 });
		expect(outputLines(answered)).toContain("length 8");
		expect(text(answered)).not.toContain("hunter22");
		expect(text(answered)).toContain("The user typed");
	}, 30_000);

	it("types nothing into an SSH login until it goes through, so its password prompt stays the user's", async () => {
		const login = "printf 'me@web-1 password: '; stty -echo; read pw; stty echo; echo; ";
		const { host, tool } = sessionSetup("/bin/sh", login);
		const open = await tool.execute("call-1", { action: "open", host: "web-1", wait: 1 });
		const id = open.details!.terminal!.terminalId;
		expect(text(open)).toContain("waiting for the user");
		expect(host.get(id)).toMatchObject({ host: "web-1", state: "input" });

		host.input(id, "pw\r");
		const ready = await tool.execute("call-2", { action: "wait", id, wait: 15 });
		expect(host.get(id)?.state).toBe("idle");
		expect(text(ready)).toContain("ready");
		const remote = await tool.execute("call-3", { action: "exec", id, command: "echo remote-ok" });
		expect(outputLines(remote)).toEqual(["remote-ok"]);
	}, 30_000);
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

	it.skipIf(ptyUnavailable)(
		"asks in a root session only as the approval mode does, and bash denies still win",
		async () => {
			const { host, tool } = setup(args =>
				(args as { command: string }).command.startsWith("rm ") ? { tier: "exec", policy: "deny" } : "exec",
			);
			const shell = await host.openSession(
				{ title: "root", application: "/bin/sh", args: [], cwd: process.cwd(), env: { TERM: "xterm-256color" } },
				{ onOutput() {}, onUserInput() {}, onExit() {} },
			);
			host.update(shell.terminalId, { root: true });
			const exec = { action: "exec", id: shell.terminalId, command: "ls" };
			const send = { action: "send", id: shell.terminalId, key: "enter" };
			expect(resolveApproval(tool, exec, "yolo", {}).policy).toBe("allow");
			expect(resolveApproval(tool, send, "yolo", {}).policy).toBe("allow");
			expect(resolveApproval(tool, exec, "write", {}).policy).toBe("prompt");
			expect(resolveApproval(tool, { ...exec, command: "rm -rf /srv" }, "yolo", {}).policy).toBe("deny");
		},
	);
});
