/**
 * RPC mode guards for restricted (chat) sessions — end-to-end over the real
 * process: `--chat` spawn flag → Args.chat → buildSessionOptions → sdk
 * restrictToolNames → AgentSession.restrictToolNames → rpc-mode guards →
 * `mode_unavailable_in_chat` error codes. Runs without an API key: every
 * rejection happens before any model call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";

interface RpcFrame {
	id?: string;
	type: string;
	command?: string;
	success?: boolean;
	code?: string;
	data?: unknown;
}

const MODE_COMMANDS = [
	{ type: "set_plan_mode", id: "plan", enabled: true },
	{ type: "set_goal", id: "goal", objective: "test" },
	{ type: "set_loop_mode", id: "loop", enabled: true },
	{ type: "set_vibe_mode", id: "vibe", enabled: true },
] as const;

const children: Array<ReturnType<typeof Bun.spawn>> = [];

afterEach(() => {
	for (const child of children.splice(0)) child.kill();
});

function spawnRpc(args: string[]): { child: ReturnType<typeof Bun.spawn>; lines: ReadableStream<Uint8Array> } {
	const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
	// Same env shape as rpc-malformed-input.test.ts: real user config (the CLI
	// refuses to boot against an empty PI_CODING_AGENT_DIR), session artifacts
	// land in the caller's temp cwd like the existing spawn tests.
	const child = Bun.spawn(["bun", cliPath, "--mode", "rpc-ui", ...args], {
		cwd: path.join(import.meta.dir, ".."),
		env: { ...Bun.env, PI_NO_TITLE: "1", PI_NO_PTY: "1" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	return { child, lines: child.stdout as ReadableStream<Uint8Array> };
}

async function sendAndCollect(
	child: ReturnType<typeof Bun.spawn>,
	stdout: ReadableStream<Uint8Array>,
	frames: readonly Record<string, unknown>[],
): Promise<Map<string, RpcFrame>> {
	const ids = new Set(frames.map(frame => String(frame.id)));
	const stdin = child.stdin;
	if (!stdin || typeof stdin === "number") throw new Error("expected piped stdin");
	for (const frame of frames) stdin.write(`${JSON.stringify(frame)}\n`);
	await stdin.flush();

	const answers = new Map<string, RpcFrame>();
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + 60_000;
	while (answers.size < ids.size && Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line) continue;
			let frame: RpcFrame;
			try {
				frame = JSON.parse(line) as RpcFrame;
			} catch {
				continue;
			}
			if (frame.type === "response" && frame.id && ids.has(frame.id)) answers.set(frame.id, frame);
		}
	}
	reader.releaseLock();
	return answers;
}

describe("mode guards in a restricted (chat) session — end-to-end", () => {
	test("all mode-arming RPCs refuse with mode_unavailable_in_chat, disarm allowed", async () => {
		const { child, lines } = spawnRpc(["--chat"]);
		const answers = await sendAndCollect(child, lines, [
			...MODE_COMMANDS,
			{ type: "set_plan_mode", id: "disarm", enabled: false },
		]);

		for (const id of ["plan", "goal", "loop", "vibe"]) {
			const frame = answers.get(id);
			expect(frame, `missing response for ${id}`).toBeDefined();
			expect(frame?.success).toBe(false);
			expect(frame?.code).toBe("mode_unavailable_in_chat");
		}
		// Disarming is always legal — it can only leave the session safer.
		expect(answers.get("disarm")?.success).toBe(true);
	}, 90_000);

	test("an unrestricted (agent) session arms plan mode normally", async () => {
		const { child, lines } = spawnRpc([]);
		const answers = await sendAndCollect(child, lines, [
			{ type: "set_plan_mode", id: "arm", enabled: true },
			{ type: "set_plan_mode", id: "disarm", enabled: false },
		]);

		expect(answers.get("arm")?.success).toBe(true);
		expect((answers.get("arm")?.data as { enabled?: boolean } | undefined)?.enabled).toBe(true);
		expect(answers.get("disarm")?.success).toBe(true);
	}, 90_000);
});
