/**
 * A shell the agent drives command by command (the `terminal` tool's
 * sessions): a login shell here, or one on an SSH host, shown in the GUI's
 * terminal panel. Its state (directory, environment, virtualenv, `sudo -s`)
 * carries from one command to the next, as it would for a person typing.
 *
 * Command boundaries come from private OSC sequences the shell prints,
 * `ESC ] 6973 ; <nonce> ; <kind> … BEL`. A hook typed once into the shell
 * (bash `PROMPT_COMMAND`/`PS0`, zsh `precmd`/`preexec`) marks where a
 * command's output starts and reports its exit status, user, and directory
 * at the next prompt; other POSIX shells get the report appended to each
 * command instead. Nothing is installed on a remote host. The nonce is
 * random per session, so output that prints a marker of its own cannot end a
 * command early. Terminals ignore unknown OSC sequences, so markers never
 * show.
 *
 * The agent never answers a password, passphrase, or new-host question: when
 * a running command (or the SSH login) stops at one, the session waits for the
 * user to type it in the terminal.
 */
import { renderTerminalLines, type RpcTerminalHost, type SessionTerminalCallbacks } from "./rpc-terminal";
import type { RpcTerminalInfo } from "./rpc-types";

const MARKER = "\x1b]6973;";
/** Raw output kept for the running command; older output is dropped first. */
const MAX_CAPTURE_CHARS = 1024 * 1024;
/** Raw output kept to recognise a password prompt on the last line. */
const RECENT_CHARS = 1024;
/** A marker longer than this is not one; its text passes through. */
const MAX_MARKER_CHARS = 4096;
/** Output quiet this long before the shell setup is typed, so it follows the login banner. */
const SETUP_QUIET_MS = 150;
/** Longest wait for that quiet: a chatty profile must not hold the setup back. */
const SETUP_QUIET_MAX_MS = 3_000;
/** Output quiet this long before the last line is checked for a password prompt. */
const PROMPT_CHECK_MS = 150;
/** Time the prompt gets to finish drawing before a command is typed after it. */
const PROMPT_SETTLE_MS = 50;

/** A last line asking for a secret: `Password:`, `[sudo] password for me:`, `Enter passphrase for key …:`. */
const SECRET_PROMPT =
	/(?:password|passphrase|passcode|pass code|verification code|one-time code|\botp\b|\bpin\b|密码|口令)[^\n]{0,120}[:：]\s*$/i;
/** OpenSSH's first-connection question; trusting a host key is the user's call. */
const HOST_KEY_PROMPT = /\(yes\/no(?:\/\[fingerprint\])?\)\?\s*$/i;

export type ShellSessionState = NonNullable<RpcTerminalInfo["state"]>;

/** A command's result so far. */
export interface ShellCommandResult {
	/** The prompt came back. */
	done: boolean;
	exitCode?: number;
	/** What the command printed, as shown, without the echoed command line. */
	lines: string[];
	/** The oldest output was dropped past {@link MAX_CAPTURE_CHARS}. */
	truncated: boolean;
	/** The user typed into the terminal while it ran. */
	userTyped: boolean;
}

interface RunningCommand {
	command: string;
	startedAt: number;
	/** Lines of echoed input before the output, when no start marker arrives. */
	echoLines: number;
	captured: string;
	/** Where output starts in {@link captured} (after the start marker). */
	outputStart?: number;
	exitCode?: number;
	done: boolean;
	truncated: boolean;
	userTyped: boolean;
}

/**
 * The shell text typed once to install the markers. Every POSIX shell must
 * parse it, so zsh- and bash-only syntax sits in `eval` strings. It turns off
 * pagers (a pager would hold a command open), clears the screen, and reports
 * its mode (`hook` or `wrap`).
 *
 * zsh and bash get a `hook` on the prompt (`precmd` / `PROMPT_COMMAND`), which
 * reports the exit status however the command ended, plus a start marker
 * (`preexec` / `PS0`) so output is split from the echoed command. Every other
 * POSIX shell (`wrap`) emits the report straight from `PS1`, which also fires
 * at every prompt — after an ordinary command, and after an interrupt that
 * discards the command line an appended probe would have ridden on. `PS1`
 * expands the literal `$?` and `$PWD` each time; the uid is read once, since a
 * shell that changes it (`sudo -s`) is a new shell without these markers.
 */
export function shellSetupScript(nonce: string): string {
	const mark = `\\033]6973;${nonce}`;
	return [
		" export PAGER=cat GIT_PAGER=cat SYSTEMD_PAGER=cat",
		`__omp_d() { printf '${mark};D;%s;%s;%s\\007' "$1" "\${EUID:-$(id -u)}" "$PWD"; }`,
		`if [ -n "\${ZSH_VERSION-}" ]; then eval '__omp_p() { __omp_d $?; }; __omp_c() { printf "${mark};C\\007"; }; precmd_functions=(__omp_p $precmd_functions); preexec_functions+=(__omp_c); PROMPT2=""'; __omp_m=hook`,
		`elif [ -n "\${BASH_VERSION-}" ]; then eval '__omp_p() { __omp_d $?; }; PROMPT_COMMAND="__omp_p\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; PS0="\\e]6973;${nonce};C\\a"; PS2=""'; __omp_m=hook`,
		`else __omp_u=$(id -u); PS1=$(printf '${mark};D;$?;%s;$PWD\\007' "$__omp_u"); PS2=''; __omp_m=wrap; fi`,
		`printf '\\033[H\\033[2J${mark};R;%s\\007' "$__omp_m"`,
	].join("; ");
}

/**
 * The remote command for an SSH session: report the login went through, then
 * become the user's login shell. Anything the terminal shows before the
 * report belongs to the login (a password or host-key question).
 */
export function sshBootstrapCommand(nonce: string): string {
	return `printf '\\033]6973;${nonce};H\\007'; exec "$SHELL" -l`;
}

/** Bytes for a named key `send` accepts. */
export const SESSION_KEYS = {
	enter: "\r",
	tab: "\t",
	esc: "\x1b",
	backspace: "\x7f",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	"ctrl-c": "\x03",
	"ctrl-d": "\x04",
	"ctrl-z": "\x1a",
} as const;

/** Length of the longest suffix of `text` that begins `prefix` (a marker split across chunks). */
function partialPrefixLength(text: string, prefix: string): number {
	for (let length = Math.min(text.length, prefix.length - 1); length > 0; length--) {
		if (prefix.startsWith(text.slice(text.length - length))) return length;
	}
	return 0;
}

/** The last line of raw output as shown, for prompt checks. */
function lastLine(raw: string): string {
	const text = Bun.stripANSI(raw);
	const line = text.slice(text.lastIndexOf("\n") + 1);
	return line.slice(line.lastIndexOf("\r", line.length - 2) + 1);
}

export class ShellSession implements SessionTerminalCallbacks {
	readonly nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
	readonly #prefix = `${MARKER}${this.nonce};`;
	#terminalId: string | undefined;
	#state: ShellSessionState = "starting";
	/** `hook` once the prompt hook reports; `wrap` when commands carry the report. */
	#mode: "hook" | "wrap" | undefined;
	/** An SSH session waits for the login report before the setup is typed. */
	#awaitingLogin: boolean;
	#setupSent = false;
	#exited = false;
	/** Raw output not yet scanned past a possible marker start. */
	#unscanned = "";
	#recent = "";
	#lastOutputAt = Date.now();
	#idleSince = 0;
	#promptTimer: NodeJS.Timeout | undefined;
	/** The question the session waits on the user for, while `input`. */
	#question: string | undefined;
	#running: RunningCommand | undefined;
	#lastCommand: RunningCommand | undefined;
	#waiters = new Set<() => void>();

	constructor(
		private readonly host: RpcTerminalHost,
		options: { remote: boolean },
	) {
		this.#awaitingLogin = options.remote;
	}

	get state(): ShellSessionState {
		return this.#state;
	}

	get exited(): boolean {
		return this.#exited;
	}

	/** The command running now, with how long it has run. */
	get running(): { command: string; seconds: number } | undefined {
		const running = this.#running;
		return running
			? { command: running.command, seconds: Math.round((Date.now() - running.startedAt) / 1000) }
			: undefined;
	}

	/** The question the user is to answer, while the session is `input`. */
	get question(): string | undefined {
		return this.#question;
	}

	/** Bind the terminal the host opened; a local shell gets its setup once its banner settles. */
	attach(terminalId: string): void {
		this.#terminalId = terminalId;
		if (!this.#awaitingLogin) void this.#sendSetup();
	}

	/** Resolves once `ready` holds, the process exits, `ms` pass, or `signal` aborts. */
	async waitUntil(ready: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
		if (ready()) return true;
		if (this.#exited || signal?.aborted) return false;
		const settled = Promise.withResolvers<void>();
		const check = () => {
			if (ready() || this.#exited) settled.resolve();
		};
		const timer = setTimeout(() => settled.resolve(), ms);
		const abort = () => settled.resolve();
		this.#waiters.add(check);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			await settled.promise;
		} finally {
			clearTimeout(timer);
			this.#waiters.delete(check);
			signal?.removeEventListener("abort", abort);
		}
		return ready();
	}

	/**
	 * Type `command` at the prompt. A multi-line command is typed as one `{ … }`
	 * group, so the shell reads it whole before running any of it and the prompt
	 * returns (and reports) once.
	 */
	async type(command: string): Promise<void> {
		if (this.#state !== "idle" || !this.#terminalId) throw new Error(`The session is ${this.#state}`);
		const grouped = command.includes("\n");
		const typed = grouped ? `{ ${command}\n}` : command;
		this.#running = {
			command,
			startedAt: Date.now(),
			echoLines: typed.split("\n").length,
			captured: "",
			done: false,
			truncated: false,
			userTyped: false,
		};
		this.#setState("busy");
		const settle = this.#idleSince + PROMPT_SETTLE_MS - Date.now();
		if (settle > 0) await Bun.sleep(settle);
		this.host.write(this.#terminalId, `${typed}\r`);
	}

	/** Type raw keystrokes into the program the session runs. */
	send(data: string): void {
		if (this.#terminalId) this.host.write(this.#terminalId, data);
	}

	/** The running (or else the last) command's result, its output rendered at the terminal's width. */
	async result(): Promise<ShellCommandResult | undefined> {
		const command = this.#running ?? this.#lastCommand;
		if (!command) return undefined;
		const info = this.#terminalId ? this.host.get(this.#terminalId) : undefined;
		const raw = command.captured.slice(command.outputStart ?? 0);
		let lines = await renderTerminalLines(raw, info?.cols ?? 100, info?.rows ?? 30);
		if (command.outputStart === undefined && !command.truncated) lines = lines.slice(command.echoLines);
		return {
			done: command.done,
			exitCode: command.exitCode,
			lines,
			truncated: command.truncated,
			userTyped: command.userTyped,
		};
	}

	onOutput(chunk: string): void {
		this.#lastOutputAt = Date.now();
		this.#recent = (this.#recent + chunk).slice(-RECENT_CHARS);
		this.#unscanned += chunk;
		for (;;) {
			const at = this.#unscanned.indexOf(this.#prefix);
			if (at === -1) {
				const keep = partialPrefixLength(this.#unscanned, this.#prefix);
				this.#capture(this.#unscanned.slice(0, this.#unscanned.length - keep));
				this.#unscanned = this.#unscanned.slice(this.#unscanned.length - keep);
				break;
			}
			const end = this.#unscanned.indexOf("\x07", at);
			if (end === -1) {
				if (this.#unscanned.length - at > MAX_MARKER_CHARS) {
					this.#capture(this.#unscanned);
					this.#unscanned = "";
				} else {
					this.#capture(this.#unscanned.slice(0, at));
					this.#unscanned = this.#unscanned.slice(at);
				}
				break;
			}
			this.#capture(this.#unscanned.slice(0, at));
			this.#marker(this.#unscanned.slice(at + this.#prefix.length, end));
			this.#unscanned = this.#unscanned.slice(end + 1);
		}
		this.#schedulePromptCheck();
	}

	onUserInput(_data: string): void {
		if (this.#running) this.#running.userTyped = true;
	}

	onExit(): void {
		this.#exited = true;
		clearTimeout(this.#promptTimer);
		if (this.#running) this.#finish(undefined);
		this.#notify();
	}

	#capture(text: string): void {
		const running = this.#running;
		if (!running || running.done || !text) return;
		running.captured += text;
		const excess = running.captured.length - MAX_CAPTURE_CHARS;
		if (excess > 0) {
			running.captured = running.captured.slice(excess);
			running.truncated = true;
			if (running.outputStart !== undefined) running.outputStart = Math.max(0, running.outputStart - excess);
		}
	}

	#marker(body: string): void {
		const [kind, ...fields] = body.split(";");
		switch (kind) {
			case "H":
				// The SSH login went through; the remote shell starts next.
				if (!this.#awaitingLogin) return;
				this.#awaitingLogin = false;
				this.#question = undefined;
				if (this.#state === "input") this.#setState("starting");
				void this.#sendSetup();
				return;
			case "R":
				this.#mode = fields[0] === "hook" ? "hook" : "wrap";
				// A hooked shell is ready at its first prompt report; others are ready now.
				if (this.#mode === "wrap" && this.#state === "starting") this.#setState("idle");
				return;
			case "C":
				if (this.#running && this.#running.outputStart === undefined) {
					this.#running.outputStart = this.#running.captured.length;
				}
				// A command the user typed at the session's prompt: busy until it reports.
				else if (!this.#running && this.#state === "idle") this.#setState("busy");
				return;
			case "D": {
				const [status, uid, ...cwd] = fields;
				const exitCode = Number.parseInt(status ?? "", 10);
				const patch: { root: boolean; cwd?: string } = { root: uid === "0" };
				if (cwd.length > 0) patch.cwd = cwd.join(";");
				if (this.#terminalId) this.host.update(this.#terminalId, patch);
				if (this.#running) this.#finish(Number.isFinite(exitCode) ? exitCode : undefined);
				// The prompt is back, so any question the command asked is answered.
				if (this.#mode && this.#state !== "idle") {
					this.#question = undefined;
					clearTimeout(this.#promptTimer);
					this.#setState("idle");
				}
				return;
			}
		}
	}

	#finish(exitCode: number | undefined): void {
		const running = this.#running;
		if (!running) return;
		running.done = true;
		running.exitCode = exitCode;
		this.#lastCommand = running;
		this.#running = undefined;
	}

	async #sendSetup(): Promise<void> {
		if (this.#setupSent || !this.#terminalId) return;
		this.#setupSent = true;
		const deadline = Date.now() + SETUP_QUIET_MAX_MS;
		while (Date.now() < deadline && Date.now() - this.#lastOutputAt < SETUP_QUIET_MS) {
			await Bun.sleep(SETUP_QUIET_MS / 3);
		}
		if (this.#exited) return;
		this.host.write(this.#terminalId, `${shellSetupScript(this.nonce)}\r`);
	}

	#schedulePromptCheck(): void {
		clearTimeout(this.#promptTimer);
		if (this.#state === "idle" || this.#exited) return;
		this.#promptTimer = setTimeout(() => this.#checkPrompt(), PROMPT_CHECK_MS);
	}

	/** Output went quiet: a last line asking for a secret hands the terminal to the user. */
	#checkPrompt(): void {
		if (this.#state === "idle" || this.#exited) return;
		const line = lastLine(this.#recent).trim();
		const asking = SECRET_PROMPT.test(line) || HOST_KEY_PROMPT.test(line);
		if (asking && this.#state !== "input") {
			this.#question = line.slice(-160);
			this.#setState("input", true);
		} else if (!asking && this.#state === "input") {
			this.#question = undefined;
			this.#setState(this.#running ? "busy" : "starting");
		}
	}

	#setState(state: ShellSessionState, reveal = false): void {
		if (state === this.#state) return;
		this.#state = state;
		if (state === "idle") this.#idleSince = Date.now();
		if (this.#terminalId) this.host.update(this.#terminalId, { state }, reveal);
		this.#notify();
	}

	#notify(): void {
		for (const waiter of this.#waiters) waiter();
	}
}
