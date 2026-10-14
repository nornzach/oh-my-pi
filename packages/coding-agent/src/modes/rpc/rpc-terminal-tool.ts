/**
 * The agent's `terminal` tool for RPC hosts that render terminals (the GUI's
 * terminal panel): read what the user's terminals show, and run long-lived
 * commands (dev servers, watchers) in new terminals the user can watch and stop.
 * Registered by `terminal_configure` with `agentTools`.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolApproval, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import terminalDescription from "../../prompts/tools/terminal.md" with { type: "text" };
import type { BackgroundCommandRequest, RpcTerminalHost } from "./rpc-terminal";
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

const terminalSchema = type({
	action: type("'list' | 'read' | 'run' | 'stop'").describe("operation"),
	"id?": type("string").describe("terminal id from list or run (read, stop)"),
	"lines?": type("number").describe(
		`lines to read from the end (default ${DEFAULT_READ_LINES}, max ${MAX_READ_LINES})`,
	),
	"command?": type("string").describe("shell command to start in a new terminal (run)"),
	"cwd?": type("string").describe("working directory for run (default: the session's)"),
	"wait?": type("number").describe(
		`seconds to wait for early output before returning (run; default ${DEFAULT_RUN_WAIT_SECONDS}, max ${MAX_RUN_WAIT_SECONDS})`,
	),
});

type TerminalParams = typeof terminalSchema.infer;

export interface TerminalToolDetails {
	action: TerminalParams["action"];
	terminal?: RpcTerminalInfo;
	terminals?: RpcTerminalInfo[];
}

export interface TerminalToolOptions {
	/** Shell, environment, and default working directory for `run`. */
	commandEnvironment: () => Promise<Omit<BackgroundCommandRequest, "command">>;
	/**
	 * The `bash` tool's approval, so `run` honors the user's bash rules (pattern
	 * denies, `tools.approval.bash`) instead of becoming a way around them.
	 */
	bashApproval: () => ToolApproval | undefined;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function describeState(info: RpcTerminalInfo): string {
	if (info.running) return "running";
	return info.exitCode === undefined ? "exited (killed)" : `exited ${info.exitCode}`;
}

/** One `list` row: `term-…-3  background  running  /repo  bun run dev`. */
function describeTerminal(info: RpcTerminalInfo): string {
	return `${info.terminalId}  ${info.kind}  ${describeState(info)}  ${info.cwd}  ${info.title}`;
}

export class TerminalTool implements AgentTool<typeof terminalSchema, TerminalToolDetails> {
	readonly name = "terminal";
	readonly label = "Terminal";
	readonly summary = "Read the user's terminals; run long-lived commands where the user can watch them";
	readonly description = terminalDescription;
	readonly parameters = terminalSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const params = args as Partial<TerminalParams>;
		if (params.action === "list" || params.action === "read") return "read";
		if (params.action === "stop") return "write";
		const bash = this.options.bashApproval();
		const decision = typeof bash === "function" ? bash({ command: params.command ?? "" }) : (bash ?? "exec");
		return typeof decision === "string"
			? { tier: decision, policyKey: "bash" }
			: { ...decision, policyKey: decision.policyKey ?? "bash" };
	};

	constructor(
		private readonly host: RpcTerminalHost,
		private readonly options: TerminalToolOptions,
	) {}

	async execute(_toolCallId: string, params: TerminalParams): Promise<AgentToolResult<TerminalToolDetails>> {
		switch (params.action) {
			case "list":
				return this.#list();
			case "read":
				return this.#read(params);
			case "run":
				return this.#run(params);
			case "stop":
				return this.#stop(params);
		}
	}

	#list(): AgentToolResult<TerminalToolDetails> {
		const terminals = this.host.list();
		const text =
			terminals.length === 0
				? "No terminals are open. Start one with run, or the user can open a shell in the Terminal panel."
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
		if (terminal.kind !== "background") {
			throw new ToolError(
				`${terminal.terminalId} is ${terminal.kind === "shell" ? "the user's shell" : "an interactive bash call"}; stop only ends commands you started with run.`,
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

	#require(id: string | undefined, action: string): RpcTerminalInfo {
		if (!id) throw new ToolError(`terminal ${action} requires an id; list shows them.`);
		const terminal = this.host.get(id);
		if (terminal) return terminal;
		const ids = this.host.list().map(info => info.terminalId);
		throw new ToolError(
			`No terminal ${JSON.stringify(id)}.${ids.length > 0 ? ` Open terminals: ${ids.join(", ")}.` : " No terminals are open."}`,
		);
	}
}
