/**
 * The agent's `terminal` tool for RPC hosts that render terminals (the GUI's
 * terminal panel): read what the user's terminals show, run long-lived
 * commands (dev servers, watchers) in new terminals the user can watch and
 * stop, and drive shell sessions, here or over SSH, command by command where
 * the user sees every step. Registered by `terminal_configure` with `agentTools`.
 */
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolApproval, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import terminalDescription from "../../prompts/tools/terminal.md" with { type: "text" };
import { truncateForPrompt } from "../../tools/approval";
import {
	type BackgroundCommandRequest,
	type RpcTerminalHost,
	resolveTerminalShell,
	type SessionTerminalRequest,
} from "./rpc-terminal";
import { SESSION_KEYS, ShellSession, sshBootstrapCommand } from "./rpc-terminal-session";
import type { RpcTerminalInfo } from "./rpc-types";

const DEFAULT_READ_LINES = 100;
const MAX_READ_LINES = 500;
/** Text a single read returns at most; older lines are dropped first. */
const MAX_READ_CHARS = 48_000;
const DEFAULT_RUN_WAIT_SECONDS = 3;
const MAX_RUN_WAIT_SECONDS = 30;
/** Lines of early output a `run` result carries. */
const RUN_OUTPUT_LINES = 60;
/** How long `stop` waits for the process to exit after killing it. */
const STOP_WAIT_MS = 5_000;
/** Lines of final output a `stop` result carries. */
const STOP_OUTPUT_LINES = 20;
/** How long `open`, `exec`, and `wait` wait for the prompt by default. */
const DEFAULT_SESSION_WAIT_SECONDS = 30;
const MAX_SESSION_WAIT_SECONDS = 300;
const DEFAULT_SEND_WAIT_SECONDS = 2;
/** Lines of a command's output an `exec` or `wait` result carries; older lines are dropped first. */
const COMMAND_OUTPUT_LINES = 400;
/** Lines of screen a `send` result carries. */
const SEND_OUTPUT_LINES = 40;
/** Live sessions at once; past this, `open` asks the agent to stop one first. */
const MAX_LIVE_SESSIONS = 8;
/** Shells whose sessions report their prompts; another login shell falls back to the configured one. */
const POSIX_SHELLS = new Set(["bash", "zsh", "sh", "dash", "ksh", "mksh", "ash"]);

const terminalSchema = type({
	action: type("'list' | 'read' | 'run' | 'stop' | 'open' | 'exec' | 'send' | 'wait'").describe("operation"),
	"id?": type("string").describe("terminal id from list, run, or open (read, stop, exec, send, wait)"),
	"lines?": type("number").describe(
		`lines to read from the end (default ${DEFAULT_READ_LINES}, max ${MAX_READ_LINES})`,
	),
	"command?": type("string").describe("shell command: run starts it in a new terminal; exec types it into session id"),
	"host?": type("string").describe(
		"SSH destination for open: a configured host, ~/.ssh/config alias, or user@host[:port]; omit for a shell on this machine",
	),
	"label?": type("string").describe("short name for the session's terminal tab (open)"),
	"cwd?": type("string").describe("working directory (run; open on this machine; default: the session's)"),
	"text?": type("string").describe("text to type into the program running in id (send)"),
	"key?": type(
		"'enter' | 'tab' | 'esc' | 'backspace' | 'up' | 'down' | 'left' | 'right' | 'ctrl-c' | 'ctrl-d' | 'ctrl-z'",
	).describe("key to press after text (send)"),
	"wait?": type("number").describe(
		`seconds to wait: run for early output (default ${DEFAULT_RUN_WAIT_SECONDS}, max ${MAX_RUN_WAIT_SECONDS}); open, exec, and wait for the prompt to return (default ${DEFAULT_SESSION_WAIT_SECONDS}, max ${MAX_SESSION_WAIT_SECONDS}); send for the program's response (default ${DEFAULT_SEND_WAIT_SECONDS})`,
	),
});

type TerminalParams = typeof terminalSchema.infer;

export interface TerminalToolDetails {
	action: TerminalParams["action"];
	terminal?: RpcTerminalInfo;
	terminals?: RpcTerminalInfo[];
	/** A session command's exit code, once it finished. */
	exitCode?: number;
}

/** How to start `ssh` for a session: the program and its arguments. */
export interface SshSessionCommand {
	application: string;
	args: string[];
}

export interface TerminalToolOptions {
	/** Shell, environment, and default working directory for `run` and local sessions. */
	commandEnvironment: () => Promise<Omit<BackgroundCommandRequest, "command">>;
	/**
	 * The `bash` tool's approval, so `run` and `exec` honor the user's bash rules
	 * (pattern denies, `tools.approval.bash`) instead of becoming a way around them.
	 */
	bashApproval: () => ToolApproval | undefined;
	/** `ssh` to `destination`, running `remoteCommand` on a TTY; throws for a destination it rejects. */
	sshCommand: (destination: string, remoteCommand: string) => Promise<SshSessionCommand>;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function describeState(info: RpcTerminalInfo): string {
	if (info.running) return info.state ?? "running";
	return info.exitCode === undefined ? "exited (killed)" : `exited ${info.exitCode}`;
}

/** Where a terminal runs, for results and approval prompts: `term-…-3 (ssh web-1, root)`. */
function describeWhere(info: RpcTerminalInfo): string {
	const notes = [info.host ? `ssh ${info.host}` : undefined, info.root ? "root" : undefined].filter(Boolean);
	return notes.length > 0 ? `${info.terminalId} (${notes.join(", ")})` : info.terminalId;
}

/** One `list` row: `term-…-3  session  idle  ssh web-1  /srv/app  web-1`. */
function describeTerminal(info: RpcTerminalInfo): string {
	const host = info.host ? `  ssh ${info.host}` : "";
	const root = info.root ? "  root" : "";
	return `${info.terminalId}  ${info.kind}  ${describeState(info)}${host}${root}  ${info.cwd}  ${info.title}`;
}

/** Keep the newest lines within the read limits, saying how many were dropped. */
function boundLines(lines: string[], maxLines: number, truncated = false): string {
	let kept = lines.slice(-maxLines);
	let text = kept.join("\n");
	while (text.length > MAX_READ_CHARS && kept.length > 1) {
		kept = kept.slice(Math.ceil(kept.length / 10));
		text = kept.join("\n");
	}
	const omitted = lines.length - kept.length;
	if (omitted > 0) return `[${omitted} earlier lines omitted; read shows the screen]\n${text}`;
	return truncated ? `[earlier output omitted]\n${text}` : text;
}

export class TerminalTool implements AgentTool<typeof terminalSchema, TerminalToolDetails> {
	readonly name = "terminal";
	readonly label = "Terminal";
	readonly summary =
		"Read the user's terminals; run long-lived commands and drive shell sessions, here or over SSH, where the user can watch";
	readonly description = terminalDescription;
	readonly parameters = terminalSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly #sessions = new Map<string, ShellSession>();

	readonly approval = (args: unknown): ToolApprovalDecision => {
		const params = args as Partial<TerminalParams>;
		switch (params.action) {
			case "list":
			case "read":
			case "wait":
				return "read";
			case "stop":
				return "write";
			case "open":
				return params.host ? this.#bashDecision(`ssh ${params.host}`) : { tier: "exec", policyKey: "bash" };
			case "send":
				return { tier: "exec", policyKey: "bash" };
			default:
				return this.#bashDecision(params.command ?? "");
		}
	};

	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<TerminalParams>;
		const terminal = params.id ? this.host.get(params.id) : undefined;
		const where = terminal ? describeWhere(terminal) : params.host ? `ssh ${params.host}` : undefined;
		const keys = [params.text, params.key].filter(part => part !== undefined && part !== "");
		return [
			...(where ? [`Terminal: ${where}`] : []),
			...(params.command ? [`Command: ${truncateForPrompt(params.command)}`] : []),
			...(params.action === "send" && keys.length > 0 ? [`Keys: ${truncateForPrompt(keys.join(" + "))}`] : []),
		];
	};

	constructor(
		private readonly host: RpcTerminalHost,
		private readonly options: TerminalToolOptions,
	) {}

	async execute(
		_toolCallId: string,
		params: TerminalParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<TerminalToolDetails>> {
		switch (params.action) {
			case "list":
				return this.#list();
			case "read":
				return this.#read(params);
			case "run":
				return this.#run(params);
			case "stop":
				return this.#stop(params);
			case "open":
				return this.#open(params, signal);
			case "exec":
				return this.#exec(params, signal);
			case "send":
				return this.#send(params, signal);
			case "wait":
				return this.#wait(params, signal);
		}
	}

	/** The `bash` tool's decision for `command`, scoped to the user's bash policy. */
	#bashDecision(command: string): ToolApprovalDecision {
		const bash = this.options.bashApproval();
		const decision = typeof bash === "function" ? bash({ command }) : (bash ?? "exec");
		return typeof decision === "string"
			? { tier: decision, policyKey: "bash" }
			: { ...decision, policyKey: decision.policyKey ?? "bash" };
	}

	#list(): AgentToolResult<TerminalToolDetails> {
		const terminals = this.host.list();
		const text =
			terminals.length === 0
				? "No terminals are open. Start a session with open or a command with run, or the user can open a shell in the Terminal panel."
				: terminals.map(describeTerminal).join("\n");
		return { content: [{ type: "text", text }], details: { action: "list", terminals } };
	}

	async #read(params: TerminalParams): Promise<AgentToolResult<TerminalToolDetails>> {
		const terminal = this.#require(params.id, "read");
		const lines = Math.trunc(clamp(params.lines, DEFAULT_READ_LINES, 1, MAX_READ_LINES));
		let output = await this.host.readText(terminal.terminalId, lines);
		if (output.length > MAX_READ_CHARS) {
			output = `[earlier output omitted]\n${output.slice(output.indexOf("\n", output.length - MAX_READ_CHARS) + 1)}`;
		}
		const header = `${describeTerminal(terminal)}\n`;
		const text = output.length > 0 ? `${header}\n${output}` : `${header}\n(no output yet)`;
		return { content: [{ type: "text", text }], details: { action: "read", terminal } };
	}

	async #run(params: TerminalParams): Promise<AgentToolResult<TerminalToolDetails>> {
		const command = params.command?.trim();
		if (!command) throw new ToolError("terminal run requires a command.");
		const environment = await this.options.commandEnvironment();
		const started = await this.host.startBackground({
			...environment,
			command,
			cwd: params.cwd ?? environment.cwd,
		});
		const waitMs = clamp(params.wait, DEFAULT_RUN_WAIT_SECONDS, 0, MAX_RUN_WAIT_SECONDS) * 1000;
		const exited = await this.host.waitForExit(started.terminalId, waitMs);
		const terminal = this.host.get(started.terminalId) ?? started;
		const output = await this.host.readText(terminal.terminalId, RUN_OUTPUT_LINES);
		const status = exited
			? `It already ${describeState(terminal)}; its terminal keeps the output.`
			: "It shows in the omp app's Terminal panel and keeps running after this call; read it with read, end it with stop.";
		const text = [
			`Started ${terminal.terminalId} in ${terminal.cwd}${terminal.pid ? ` (pid ${terminal.pid})` : ""}.`,
			status,
			"",
			output.length > 0 ? output : "(no output yet)",
		].join("\n");
		return { content: [{ type: "text", text }], details: { action: "run", terminal } };
	}

	async #stop(params: TerminalParams): Promise<AgentToolResult<TerminalToolDetails>> {
		const terminal = this.#require(params.id, "stop");
		if (terminal.kind !== "background" && terminal.kind !== "session") {
			throw new ToolError(
				`${terminal.terminalId} is ${terminal.kind === "shell" ? "the user's shell" : "an interactive bash call"}; stop only ends terminals you started with run or open.`,
			);
		}
		if (terminal.running) {
			this.host.kill(terminal.terminalId);
			await this.host.waitForExit(terminal.terminalId, STOP_WAIT_MS);
		}
		const final = this.host.get(terminal.terminalId) ?? terminal;
		const output = await this.host.readText(final.terminalId, STOP_OUTPUT_LINES);
		const text = [
			final.running
				? `${final.terminalId} did not exit within ${STOP_WAIT_MS / 1000}s of being killed.`
				: `Stopped ${final.terminalId} (${describeState(final)}).`,
			...(output.length > 0 ? ["", output] : []),
		].join("\n");
		return { content: [{ type: "text", text }], details: { action: "stop", terminal: final } };
	}

	async #open(params: TerminalParams, signal?: AbortSignal): Promise<AgentToolResult<TerminalToolDetails>> {
		const live = this.host.list().filter(info => info.kind === "session" && info.running).length;
		if (live >= MAX_LIVE_SESSIONS) {
			throw new ToolError(`${live} sessions are open; stop one you no longer need before opening another.`);
		}
		const environment = await this.options.commandEnvironment();
		const destination = params.host?.trim();
		const session = new ShellSession(this.host, { remote: Boolean(destination) });
		let request: SessionTerminalRequest;
		if (destination) {
			const ssh = await this.options.sshCommand(destination, sshBootstrapCommand(session.nonce));
			request = {
				title: params.label?.trim() || destination,
				host: destination,
				application: ssh.application,
				args: ssh.args,
				cwd: environment.cwd,
				env: environment.env,
			};
		} else {
			// The user's login shell, as their own terminals run, when it can report its prompts.
			let shell = resolveTerminalShell(environment.env.SHELL, environment.shell);
			const name = path.basename(shell.shell).replace(/\.exe$/i, "");
			if (!POSIX_SHELLS.has(name)) shell = resolveTerminalShell(undefined, environment.shell);
			request = {
				title: params.label?.trim() || path.basename(shell.shell),
				application: shell.shell,
				args: shell.args,
				cwd: params.cwd ?? environment.cwd,
				env: environment.env,
			};
		}
		const opened = await this.host.openSession(request, session);
		session.attach(opened.terminalId);
		this.#sessions.set(opened.terminalId, session);
		const waitMs = clamp(params.wait, DEFAULT_SESSION_WAIT_SECONDS, 0, MAX_SESSION_WAIT_SECONDS) * 1000;
		await session.waitUntil(() => session.state === "idle", waitMs, signal);
		const terminal = this.host.get(opened.terminalId) ?? opened;
		const where = destination ? `on ${destination}` : "on this machine";
		let text: string;
		if (session.state === "idle") {
			text = `Opened ${describeWhere(terminal)} ${where}, in ${terminal.cwd}. Run commands in it with exec; it shows in the omp app's Terminal panel.`;
		} else if (session.exited) {
			const screen = await this.host.readText(terminal.terminalId, STOP_OUTPUT_LINES);
			text = `${terminal.terminalId} ended before its shell was ready (${describeState(terminal)}).\n\n${screen}`;
		} else {
			text = await this.#notReady(terminal, session);
		}
		return { content: [{ type: "text", text }], details: { action: "open", terminal } };
	}

	async #exec(params: TerminalParams, signal?: AbortSignal): Promise<AgentToolResult<TerminalToolDetails>> {
		const command = params.command?.trim();
		if (!command) throw new ToolError("terminal exec requires a command.");
		const { terminal, session } = this.#requireSession(params.id, "exec");
		if (session.state !== "idle") throw new ToolError(await this.#notReady(terminal, session));
		await session.type(command);
		const waitMs = clamp(params.wait, DEFAULT_SESSION_WAIT_SECONDS, 0, MAX_SESSION_WAIT_SECONDS) * 1000;
		await session.waitUntil(() => session.state === "idle", waitMs, signal);
		// An abandoned call must not leave the command running unattended.
		if (signal?.aborted && session.state !== "idle") session.send(SESSION_KEYS["ctrl-c"]);
		return this.#commandResult("exec", terminal.terminalId, session);
	}

	async #wait(params: TerminalParams, signal?: AbortSignal): Promise<AgentToolResult<TerminalToolDetails>> {
		const terminal = this.#require(params.id, "wait");
		const waitMs = clamp(params.wait, DEFAULT_SESSION_WAIT_SECONDS, 0, MAX_SESSION_WAIT_SECONDS) * 1000;
		const session = this.#sessions.get(terminal.terminalId);
		if (session) {
			await session.waitUntil(() => session.state === "idle", waitMs, signal);
			return this.#commandResult("wait", terminal.terminalId, session);
		}
		await this.host.waitForExit(terminal.terminalId, waitMs);
		const final = this.host.get(terminal.terminalId) ?? terminal;
		const output = await this.host.readText(final.terminalId, RUN_OUTPUT_LINES);
		const text = `${describeTerminal(final)}\n\n${output.length > 0 ? output : "(no output yet)"}`;
		return { content: [{ type: "text", text }], details: { action: "wait", terminal: final } };
	}

	async #send(params: TerminalParams, signal?: AbortSignal): Promise<AgentToolResult<TerminalToolDetails>> {
		const terminal = this.#require(params.id, "send");
		const data = `${params.text ?? ""}${params.key ? SESSION_KEYS[params.key] : ""}`;
		if (!data) throw new ToolError("terminal send requires text or a key.");
		if (!terminal.running) throw new ToolError(`${terminal.terminalId} has ${describeState(terminal)}.`);
		const session = this.#sessions.get(terminal.terminalId);
		if (session) {
			if (session.state === "input") {
				throw new ToolError(
					`${terminal.terminalId} is waiting for the user to answer ${JSON.stringify(session.question ?? "a prompt")}; that answer is theirs to type. Call wait.`,
				);
			}
			if (session.state !== "busy") {
				throw new ToolError(
					`Nothing is running in ${terminal.terminalId}; send types into a running program. Run commands with exec.`,
				);
			}
			session.send(data);
			const waitMs = clamp(params.wait, DEFAULT_SEND_WAIT_SECONDS, 0, MAX_RUN_WAIT_SECONDS) * 1000;
			await session.waitUntil(() => session.state === "idle", waitMs, signal);
		} else if (terminal.kind === "background") {
			this.host.write(terminal.terminalId, data);
			await this.host.waitForExit(
				terminal.terminalId,
				clamp(params.wait, DEFAULT_SEND_WAIT_SECONDS, 0, MAX_RUN_WAIT_SECONDS) * 1000,
			);
		} else {
			throw new ToolError(
				`${terminal.terminalId} is ${terminal.kind === "shell" ? "the user's shell" : "an interactive bash call"}; send only types into terminals you started with run or open.`,
			);
		}
		const final = this.host.get(terminal.terminalId) ?? terminal;
		const screen = await this.host.readText(final.terminalId, SEND_OUTPUT_LINES);
		const text = `${describeTerminal(final)}\n\n${screen.length > 0 ? screen : "(nothing on screen)"}`;
		return { content: [{ type: "text", text }], details: { action: "send", terminal: final } };
	}

	/** A session command's result: its output and how it ended, or why it has not. */
	async #commandResult(
		action: "exec" | "wait",
		terminalId: string,
		session: ShellSession,
	): Promise<AgentToolResult<TerminalToolDetails>> {
		const terminal = this.host.get(terminalId);
		if (!terminal) throw new ToolError(`${terminalId} was closed.`);
		const result = await session.result();
		const where = `${describeWhere(terminal)} in ${terminal.cwd}`;
		let status: string;
		if (result?.done) {
			status = `${where}: exit ${result.exitCode ?? "unknown"}`;
		} else if (session.exited) {
			status = `${terminal.terminalId}'s session ended (${describeState(terminal)}).`;
		} else if (!result) {
			status = await this.#notReady(terminal, session);
		} else if (session.state === "input") {
			status = `${where}: waiting for the user to answer ${JSON.stringify(session.question ?? "a prompt")} in the terminal; that answer is theirs to type. Call wait to continue.`;
		} else {
			status = `${where}: still running after ${session.running?.seconds ?? 0}s. Call wait to keep waiting, read to see the screen, or send ctrl-c to interrupt.`;
		}
		const notes = result?.userTyped ? ["(The user typed into this terminal while the command ran.)"] : [];
		const output = result ? boundLines(result.lines, COMMAND_OUTPUT_LINES, result.truncated) : "";
		const text = [status, ...notes, ...(output ? ["", output] : [])].join("\n");
		return {
			content: [{ type: "text", text }],
			details: {
				action,
				terminal,
				...(result?.done && result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
			},
		};
	}

	/** Why a session cannot take a command now. */
	async #notReady(terminal: RpcTerminalInfo, session: ShellSession): Promise<string> {
		switch (session.state) {
			case "input":
				return `${terminal.terminalId} is waiting for the user to answer ${JSON.stringify(session.question ?? "a prompt")} in the terminal; that answer is theirs to type. Call wait.`;
			case "busy": {
				const running = session.running;
				return running
					? `${terminal.terminalId} is still running ${JSON.stringify(truncateForPrompt(running.command))} (${running.seconds}s). Call wait, send ctrl-c to interrupt it, or open another session.`
					: `${terminal.terminalId} is running a command the user typed. Call wait, or open another session.`;
			}
			case "starting": {
				const screen = await this.host.readText(terminal.terminalId, STOP_OUTPUT_LINES);
				return `${terminal.terminalId}'s shell has not reported ready. Sessions need bash, zsh, or another POSIX shell; read shows what the terminal says.${screen ? `\n\n${screen}` : ""}`;
			}
			default:
				return `${terminal.terminalId} is ready.`;
		}
	}

	#requireSession(id: string | undefined, action: string): { terminal: RpcTerminalInfo; session: ShellSession } {
		const terminal = this.#require(id, action);
		const session = this.#sessions.get(terminal.terminalId);
		if (!session || terminal.kind !== "session") {
			throw new ToolError(`${terminal.terminalId} is not a session you opened; exec runs in sessions from open.`);
		}
		if (!terminal.running)
			throw new ToolError(`${terminal.terminalId}'s session ended (${describeState(terminal)}).`);
		return { terminal, session };
	}

	#require(id: string | undefined, action: string): RpcTerminalInfo {
		if (!id) throw new ToolError(`terminal ${action} requires an id; list shows them.`);
		for (const known of this.#sessions.keys()) {
			if (!this.host.get(known)) this.#sessions.delete(known);
		}
		const terminal = this.host.get(id);
		if (terminal) return terminal;
		const ids = this.host.list().map(info => info.terminalId);
		throw new ToolError(
			`No terminal ${JSON.stringify(id)}.${ids.length > 0 ? ` Open terminals: ${ids.join(", ")}.` : " No terminals are open."}`,
		);
	}
}
