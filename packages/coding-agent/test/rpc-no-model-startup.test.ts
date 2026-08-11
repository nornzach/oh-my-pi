import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";

interface RpcFrame {
	id?: string;
	type: string;
	command?: string;
	success?: boolean;
	data?: {
		providers?: Array<{
			loginAvailable?: unknown;
			oauth?: unknown;
		}>;
	};
}

type RpcProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
const packageRoot = path.join(import.meta.dir, "..");

async function stopProcess(process: RpcProcess): Promise<void> {
	try {
		process.stdin.end();
		process.kill("SIGTERM");
	} catch {
		// The process already exited.
	}
	await process.exited;
}

async function readResponse(process: RpcProcess, id: string): Promise<RpcFrame | undefined> {
	const decoder = new TextDecoder();
	for await (const line of readLines(process.stdout, AbortSignal.timeout(30_000))) {
		const frame = JSON.parse(decoder.decode(line)) as RpcFrame;
		if (frame.type === "response" && frame.id === id) return frame;
	}
	return undefined;
}

describe("RPC startup without a configured model", () => {
	test.each(["rpc", "rpc-ui"] as const)(
		"%s serves configuration commands",
		async mode => {
			using agentDir = TempDir.createSync("@omp-rpc-no-model-");
			await Bun.write(
				path.join(agentDir.path(), "settings.json"),
				JSON.stringify({ enabledModels: ["__rpc_startup_without_model__"] }),
			);
			const process = Bun.spawn(["bun", cliPath, "--mode", mode], {
				cwd: packageRoot,
				env: {
					...Bun.env,
					PI_CODING_AGENT_DIR: agentDir.path(),
					PI_NO_PTY: "1",
					PI_NO_TITLE: "1",
					NO_COLOR: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});

			try {
				process.stdin.write(`${JSON.stringify({ type: "get_providers", id: "providers" })}\n`);
				await process.stdin.flush();
				const response = await readResponse(process, "providers");
				expect(response).toMatchObject({
					id: "providers",
					type: "response",
					command: "get_providers",
					success: true,
				});
				const providers = response?.data?.providers;
				expect(Array.isArray(providers)).toBe(true);
				expect(providers?.length).toBeGreaterThan(0);
				expect(providers?.every(provider => typeof provider.loginAvailable === "boolean")).toBe(true);
				expect(providers?.every(provider => !("oauth" in provider))).toBe(true);
			} finally {
				await stopProcess(process);
			}
		},
		60_000,
	);
});
