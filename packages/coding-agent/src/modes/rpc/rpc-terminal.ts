/**
 * Interactive terminals for RPC hosts (the GUI's terminal panel).
 *
 * Each terminal is a native PTY in this process: the user's login shell, one
 * interactive bash tool call, or a long-lived command the agent started with
 * the `terminal` tool. Output leaves as unsolicited `terminal_output`
 * frames, coalesced per terminal; a bounded scrollback lets a host whose view
 * remounts (renderer reload, another window) replay recent output. Terminals
 * live until the host closes them or the process exits, so an exited one keeps
 * its scrollback and exit status on screen.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { InteractiveTerminalHost, InteractiveTerminalRequest } from "../../extensibility/extensions/types";
import { type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import { loadXtermTerminal } from "@oh-my-pi/pi-tui/tools/terminal-output";
import { logger } from "@oh-my-pi/pi-utils";
import type { RpcTerminalFrame, RpcTerminalInfo, RpcTerminalSnapshot } from "./rpc-types";

/** Coalescing window for `terminal_output` frames. */
const FLUSH_MS = 8;
/** A pending chunk this large flushes without waiting for the window. */
const FLUSH_CHARS = 32 * 1024;
/** Scrollback kept per terminal for {@link RpcTerminalHost.snapshot}. */
export const TERMINAL_SCROLLBACK_CHARS = 256 * 1024;
/** Rows of history {@link RpcTerminalHost.readText} keeps while replaying scrollback. */
const READ_SCROLLBACK_ROWS = 5_000;
/**
 * Finished agent terminals kept for the user to read back. The agent's
 * commands and restarted dev servers would otherwise pile up as dead tabs;
 * past this many the oldest are closed. User shells are never closed for them.
 */
const KEPT_EXITED_AGENT_TERMINALS = 5;
/** Size a terminal starts at until the host reports its view. */
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

/** The user's shell and its arguments for a login terminal. */
export interface TerminalShell {
	shell: string;
	args: string[];
}

/** Where a terminal's process starts. Resolved per open so a changed shell setting applies. */
export interface TerminalEnvironment extends TerminalShell {
	cwd: string;
	env: Record<string, string>;
}

export interface RpcTerminalHostOptions {
	output: (frame: RpcTerminalFrame) => void;
	/** Shell, working directory, and environment for a new login terminal. */
	environment: () => Promise<TerminalEnvironment>;
	flushMs?: number;
	scrollbackChars?: number;
}

interface TerminalEntry {
	info: RpcTerminalInfo;
	session: PtySession;
	pending: string;
	/** Characters sent in `terminal_output` frames so far (the last frame's `seq`). */
	emitted: number;
	flushTimer: NodeJS.Timeout | undefined;
	scrollback: string;
	/** `terminal_close` arrived while the process still ran; drop the entry once it exits. */
	closeRequested: boolean;
	/** Settles when the process exits (or never started). */
	exited: PromiseWithResolvers<void>;
}

/** A long-lived command for {@link RpcTerminalHost.startBackground}: no timeout, no abort. */
export type BackgroundCommandRequest = Omit<InteractiveTerminalRequest, "timeoutMs" | "signal">;

/**
 * Choose the shell a login terminal runs: `$SHELL` when it is executable,
 * otherwise the agent's configured shell. POSIX shells start as login shells
 * (`-l`), so the user's profile applies; Windows shells take their own banner flag.
 */
export function resolveTerminalShell(userShell: string | undefined, configuredShell: string): TerminalShell {
	const shell = userShell && path.isAbsolute(userShell) && isExecutable(userShell) ? userShell : configuredShell;
	// Both separators: a Windows path must classify the same on any host.
	const name = (shell.split(/[\\/]/).pop() ?? shell).toLowerCase();
	if (name === "cmd.exe" || name === "cmd") return { shell, args: [] };
	if (name.startsWith("powershell") || name.startsWith("pwsh")) return { shell, args: ["-NoLogo"] };
	return { shell, args: ["-l"] };
}

function isExecutable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function clampSize(cols: number | undefined, rows: number | undefined): { cols: number; rows: number } {
	const c = Number.isFinite(cols) ? Math.trunc(cols as number) : DEFAULT_COLS;
	const r = Number.isFinite(rows) ? Math.trunc(rows as number) : DEFAULT_ROWS;
	return { cols: Math.min(1000, Math.max(2, c)), rows: Math.min(500, Math.max(1, r)) };
}

/** Title for a command terminal: its first line, bounded. */
function commandTitle(command: string): string {
	const firstLine = command.trim().split("\n", 1)[0] ?? "";
	return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

/** Keep the newest `max` characters, starting at a line boundary when one is near the cut. */
export function trimScrollback(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.length - max;
	const newline = text.indexOf("\n", cut);
	return newline !== -1 && newline - cut < 4096 ? text.slice(newline + 1) : text.slice(cut);
}

export class RpcTerminalHost {
	readonly #output: (frame: RpcTerminalFrame) => void;
	readonly #environment: () => Promise<TerminalEnvironment>;
	readonly #flushMs: number;
	readonly #scrollbackChars: number;
	readonly #terminals = new Map<string, TerminalEntry>();
	/** Per-process id prefix: a restarted host must not reuse ids a client still holds. */
	readonly #idPrefix = crypto.randomUUID().slice(0, 8);
	#nextId = 1;
	#disposed = false;

	constructor(options: RpcTerminalHostOptions) {
		this.#output = options.output;
		this.#environment = options.environment;
		this.#flushMs = options.flushMs ?? FLUSH_MS;
		this.#scrollbackChars = options.scrollbackChars ?? TERMINAL_SCROLLBACK_CHARS;
	}

	/** Open a login shell terminal; resolves once its process is spawned. */
	async open(options: { cols?: number; rows?: number; cwd?: string } = {}): Promise<RpcTerminalInfo> {
		if (this.#disposed) throw new Error("Terminal host is shut down");
		const environment = await this.#environment();
		const cwd = options.cwd ?? environment.cwd;
		const { cols, rows } = clampSize(options.cols, options.rows);
		const entry = this.#create({ kind: "shell", title: path.basename(environment.shell), cwd, cols, rows });
		const started = Promise.withResolvers<void>();
		let spawned = false;
		let run: Promise<PtyRunResult>;
		try {
			run = entry.session.startArgv(
				{ application: environment.shell, args: environment.args, cwd, env: environment.env, cols, rows },
				(err, chunk) => {
					if (!err && chunk) this.#append(entry, chunk);
				},
				(err, pid) => {
					if (err) return;
					spawned = true;
					entry.info.pid = pid;
					started.resolve();
				},
			);
		} catch (error) {
			this.#terminals.delete(entry.info.terminalId);
			throw error;
		}
		run.then(
			result => {
				started.resolve();
				this.#exited(entry, result);
			},
			(error: unknown) => {
				if (!spawned) {
					// Never ran: the caller's open fails and no frame names it.
					this.#terminals.delete(entry.info.terminalId);
					started.reject(error);
					return;
				}
				this.#append(entry, `\r\n[terminal failed: ${error instanceof Error ? error.message : String(error)}]\r\n`);
				this.#exited(entry, { exitCode: undefined, cancelled: false, timedOut: false });
			},
		);
		await started.promise;
		this.#output({ type: "terminal_opened", terminal: { ...entry.info } });
		return { ...entry.info };
	}

	/**
	 * Run one interactive command where the host can show it. Resolves when the
	 * command exits; the terminal stays open, read-only, until the host closes it.
	 */
	runCommand(request: InteractiveTerminalRequest, onChunk: (chunk: string) => void): Promise<PtyRunResult> {
		if (this.#disposed) return Promise.reject(new Error("Terminal host is shut down"));
		const { entry, run } = this.#startCommand("command", request, onChunk);
		this.#output({ type: "terminal_opened", terminal: { ...entry.info }, reveal: true });
		return run;
	}

	/**
	 * Start a long-lived command the agent launched (a dev server, a watcher)
	 * where the host can show it. Resolves once the process is spawned; it runs
	 * on, independent of any tool call, until it exits or {@link kill}.
	 */
	async startBackground(request: BackgroundCommandRequest): Promise<RpcTerminalInfo> {
		if (this.#disposed) throw new Error("Terminal host is shut down");
		const started = Promise.withResolvers<void>();
		const { entry, run } = this.#startCommand("background", request, undefined, pid => {
			entry.info.pid = pid;
			started.resolve();
		});
		this.#output({ type: "terminal_opened", terminal: { ...entry.info } });
		// A command that fails to spawn settles `run` without a start report.
		void run.then(() => started.resolve());
		await started.promise;
		return { ...entry.info };
	}

	#startCommand(
		kind: "command" | "background",
		request: InteractiveTerminalRequest,
		onChunk?: (chunk: string) => void,
		onStart?: (pid: number) => void,
	): { entry: TerminalEntry; run: Promise<PtyRunResult> } {
		const { cols, rows } = clampSize(undefined, undefined);
		const entry = this.#create({ kind, title: commandTitle(request.command), cwd: request.cwd, cols, rows });
		const run = entry.session
			.start(
				{
					command: request.command,
					cwd: request.cwd,
					env: request.env,
					timeoutMs: request.timeoutMs,
					signal: request.signal,
					shell: request.shell,
					cols,
					rows,
				},
				(err, chunk) => {
					if (err || !chunk) return;
					this.#append(entry, chunk);
					onChunk?.(chunk);
				},
				(err, pid) => {
					if (!err) onStart?.(pid);
				},
			)
			.then(
				result => {
					this.#exited(entry, result);
					return result;
				},
				(error: unknown) => {
					const notice = `PTY error: ${error instanceof Error ? error.message : String(error)}\r\n`;
					this.#append(entry, notice);
					onChunk?.(notice);
					const result: PtyRunResult = { exitCode: undefined, cancelled: false, timedOut: false };
					this.#exited(entry, result);
					return result;
				},
			);
		return { entry, run };
	}

	/** Forward keystrokes; input to an exited terminal is dropped. */
	input(terminalId: string, data: string): void {
		const entry = this.#require(terminalId);
		if (!entry.info.running) return;
		try {
			entry.session.write(data);
		} catch {
			// The process exited between the check and the write.
		}
	}

	resize(terminalId: string, cols: number, rows: number): void {
		const entry = this.#require(terminalId);
		const size = clampSize(cols, rows);
		entry.info.cols = size.cols;
		entry.info.rows = size.rows;
		if (!entry.info.running) return;
		try {
			entry.session.resize(size.cols, size.rows);
		} catch {
			// Not started yet or already exited; the next resize applies.
		}
	}

	/** Close a terminal: kill a running process, forget an exited one. */
	close(terminalId: string): void {
		const entry = this.#require(terminalId);
		if (!entry.info.running) {
			this.#forget(entry);
			return;
		}
		entry.closeRequested = true;
		try {
			entry.session.kill();
		} catch {
			// Already gone; the exit path forgets it.
		}
	}

	/** Kill a running terminal's process; the terminal stays, with its output and exit status, until closed. */
	kill(terminalId: string): void {
		const entry = this.#require(terminalId);
		if (!entry.info.running) return;
		try {
			entry.session.kill();
		} catch {
			// Already gone; the exit path records it.
		}
	}

	list(): RpcTerminalInfo[] {
		return [...this.#terminals.values()].map(entry => ({ ...entry.info }));
	}

	get(terminalId: string): RpcTerminalInfo | undefined {
		const entry = this.#terminals.get(terminalId);
		return entry ? { ...entry.info } : undefined;
	}

	/** Resolves `true` once the terminal's process has exited, `false` if it still runs after `timeoutMs`. */
	async waitForExit(terminalId: string, timeoutMs: number): Promise<boolean> {
		const entry = this.#require(terminalId);
		if (!entry.info.running) return true;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<false>(resolve => {
			timer = setTimeout(() => resolve(false), timeoutMs);
		});
		try {
			return await Promise.race([entry.exited.promise.then(() => true as const), timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * The terminal's text as a person sees it: the retained scrollback replayed
	 * through a terminal emulator at the terminal's size, so cursor moves, line
	 * edits, and redraws resolve to what is on screen. Returns the last `lines`
	 * lines (soft-wrapped rows joined), trailing blank lines dropped.
	 */
	async readText(terminalId: string, lines: number): Promise<string> {
		const entry = this.#require(terminalId);
		this.#flush(entry);
		const Terminal = await loadXtermTerminal();
		const term = new Terminal({
			cols: entry.info.cols,
			rows: entry.info.rows,
			scrollback: READ_SCROLLBACK_ROWS,
			allowProposedApi: true,
		});
		try {
			term.write(entry.scrollback);
			const buffer = term.buffer.active;
			const logical: string[] = [];
			for (let row = 0; row < buffer.length; row++) {
				const line = buffer.getLine(row);
				const text = line?.translateToString(false) ?? "";
				if (line?.isWrapped && logical.length > 0) logical[logical.length - 1] += text;
				else logical.push(text);
			}
			const rows = logical.map(text => text.trimEnd());
			while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
			return rows.slice(-Math.max(1, lines)).join("\n");
		} finally {
			term.dispose();
		}
	}

	/**
	 * Recent output for a host that lost its view. Pending output is flushed
	 * first, so every `terminal_output` written before this answer has
	 * `seq <= ` the returned `seq` and is already part of `data`.
	 */
	snapshot(terminalId: string): RpcTerminalSnapshot {
		const entry = this.#require(terminalId);
		this.#flush(entry);
		return { terminal: { ...entry.info }, data: entry.scrollback, seq: entry.emitted };
	}

	/** Bind {@link runCommand} as the UI context's interactive terminal. */
	asInteractiveTerminal(): InteractiveTerminalHost {
		return { runCommand: (request, onChunk) => this.runCommand(request, onChunk) };
	}

	/** Kill every terminal; later opens fail. */
	dispose(): void {
		this.#disposed = true;
		for (const entry of this.#terminals.values()) {
			if (entry.flushTimer) clearTimeout(entry.flushTimer);
			if (!entry.info.running) continue;
			try {
				entry.session.kill();
			} catch {
				// Already gone.
			}
		}
		this.#terminals.clear();
	}

	#create(info: Pick<RpcTerminalInfo, "kind" | "title" | "cwd" | "cols" | "rows">): TerminalEntry {
		const terminalId = `term-${this.#idPrefix}-${this.#nextId++}`;
		const entry: TerminalEntry = {
			info: { terminalId, ...info, running: true },
			emitted: 0,
			session: new PtySession(),
			pending: "",
			flushTimer: undefined,
			scrollback: "",
			closeRequested: false,
			exited: Promise.withResolvers<void>(),
		};
		this.#terminals.set(terminalId, entry);
		return entry;
	}

	#require(terminalId: string): TerminalEntry {
		const entry = this.#terminals.get(terminalId);
		if (!entry) throw new Error(`Unknown terminal: ${terminalId}`);
		return entry;
	}

	#append(entry: TerminalEntry, chunk: string): void {
		entry.scrollback = trimScrollback(entry.scrollback + chunk, this.#scrollbackChars);
		entry.pending += chunk;
		if (entry.pending.length >= FLUSH_CHARS) {
			this.#flush(entry);
			return;
		}
		entry.flushTimer ??= setTimeout(() => this.#flush(entry), this.#flushMs);
	}

	#flush(entry: TerminalEntry): void {
		if (entry.flushTimer) {
			clearTimeout(entry.flushTimer);
			entry.flushTimer = undefined;
		}
		if (!entry.pending || !this.#terminals.has(entry.info.terminalId)) return;
		const data = entry.pending;
		entry.pending = "";
		entry.emitted += data.length;
		this.#output({ type: "terminal_output", terminalId: entry.info.terminalId, data, seq: entry.emitted });
	}

	#exited(entry: TerminalEntry, result: PtyRunResult): void {
		if (!entry.info.running) return;
		entry.exited.resolve();
		this.#flush(entry);
		entry.info.running = false;
		entry.info.exitCode = result.exitCode;
		if (this.#terminals.has(entry.info.terminalId)) {
			this.#output({
				type: "terminal_exit",
				terminalId: entry.info.terminalId,
				exitCode: result.exitCode,
				cancelled: result.cancelled,
				timedOut: result.timedOut,
			});
		}
		if (entry.closeRequested) this.#forget(entry);
		else this.#pruneExited();
		logger.debug("Terminal exited", { terminalId: entry.info.terminalId, exitCode: result.exitCode });
	}

	/** Close the oldest finished agent terminals beyond {@link KEPT_EXITED_AGENT_TERMINALS}. */
	#pruneExited(): void {
		const exited = [...this.#terminals.values()].filter(
			candidate => candidate.info.kind !== "shell" && !candidate.info.running,
		);
		for (const stale of exited.slice(0, Math.max(0, exited.length - KEPT_EXITED_AGENT_TERMINALS))) {
			this.#forget(stale);
		}
	}

	#forget(entry: TerminalEntry): void {
		if (entry.flushTimer) clearTimeout(entry.flushTimer);
		this.#terminals.delete(entry.info.terminalId);
		this.#output({ type: "terminal_closed", terminalId: entry.info.terminalId });
	}
}
