import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";
import { discoverAuthStorage } from "../src/sdk";

interface RpcFrame {
	id?: string;
	type: string;
	command?: string;
	success?: boolean;
	models?: Array<{
		provider?: unknown;
		id?: unknown;
	}>;
	data?: {
		refreshPending?: boolean;
		generation?: number;
		models?: Array<{
			provider?: unknown;
			id?: unknown;
		}>;
		providers?: Array<{
			id?: unknown;
			authenticated?: unknown;
			loginAvailable?: unknown;
			modelCount?: unknown;
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
	const lines = readLines(process.stdout, AbortSignal.timeout(30_000))[Symbol.asyncIterator]();
	return readResponseFrom(lines, id);
}

async function readResponseFrom(lines: AsyncIterator<Uint8Array>, id: string): Promise<RpcFrame | undefined> {
	const decoder = new TextDecoder();
	while (true) {
		const next = await lines.next();
		if (next.done) return undefined;
		const frame = JSON.parse(decoder.decode(next.value)) as RpcFrame;
		if (frame.type === "response" && frame.id === id) return frame;
	}
}

async function readFrameTypeFrom(lines: AsyncIterator<Uint8Array>, type: string): Promise<RpcFrame | undefined> {
	const decoder = new TextDecoder();
	while (true) {
		const next = await lines.next();
		if (next.done) return undefined;
		const frame = JSON.parse(decoder.decode(next.value)) as RpcFrame;
		if (frame.type === type) return frame;
	}
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

describe("RPC model catalog freshness", () => {
	test("pushes a catalog update when bounded discovery completes after the listing response", async () => {
		let modelListCalls = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname !== "/v1/models") return new Response("not found", { status: 404 });
				modelListCalls += 1;
				await Bun.sleep(7_000);
				return Response.json({ data: [{ id: "event-model" }] });
			},
		});
		using agentDir = TempDir.createSync("@omp-rpc-catalog-event-");
		const modelsPath = path.join(agentDir.path(), "models.yml");
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  event-provider:",
				"    api: openai-completions",
				`    baseUrl: http://127.0.0.1:${server.port}/v1`,
				"    auth: none",
				"    models:",
				"      - id: initial-model",
			].join("\n"),
		);
		await Bun.write(
			path.join(agentDir.path(), "settings.json"),
			JSON.stringify({ enabledModels: ["event-provider/*"] }),
		);
		const process = Bun.spawn(["bun", cliPath, "--mode", "rpc"], {
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
		const lines = readLines(process.stdout, AbortSignal.timeout(30_000))[Symbol.asyncIterator]();

		try {
			process.stdin.write(`${JSON.stringify({ type: "get_available_models", id: "warm-list" })}\n`);
			await process.stdin.flush();
			await readResponseFrom(lines, "warm-list");
			await Bun.sleep(20);
			await Bun.write(
				modelsPath,
				[
					"providers:",
					"  event-provider:",
					"    api: openai-completions",
					`    baseUrl: http://127.0.0.1:${server.port}/v1`,
					"    auth: none",
					"    discovery:",
					"      type: openai-models-list",
					"      timeoutMs: 9000",
				].join("\n"),
			);
			process.stdin.write(`${JSON.stringify({ type: "get_available_models", id: "slow-list" })}\n`);
			await process.stdin.flush();
			const response = await readResponseFrom(lines, "slow-list");
			expect(response?.data?.refreshPending).toBe(true);

			const update = await readFrameTypeFrom(lines, "model_catalog_update");
			expect(update?.data).toBeUndefined();
			expect(update?.models).toEqual([expect.objectContaining({ id: "event-model" })]);
			expect(modelListCalls).toBeGreaterThanOrEqual(1);
		} finally {
			await stopProcess(process);
			server.stop(true);
		}
	}, 60_000);

	test("reloads credentials committed by another sidecar process before projecting providers", async () => {
		using agentDir = TempDir.createSync("@omp-rpc-cross-process-auth-");
		await Bun.write(
			path.join(agentDir.path(), "models.yml"),
			[
				"providers:",
				"  shared-provider:",
				"    api: openai-completions",
				"    baseUrl: https://models.example.com/v1",
				"    models:",
				"      - id: shared-model",
			].join("\n"),
		);
		await Bun.write(
			path.join(agentDir.path(), "settings.json"),
			JSON.stringify({ enabledModels: ["shared-provider/*"] }),
		);
		const process = Bun.spawn(["bun", cliPath, "--mode", "rpc"], {
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
		const lines = readLines(process.stdout, AbortSignal.timeout(30_000))[Symbol.asyncIterator]();

		try {
			process.stdin.write(`${JSON.stringify({ type: "get_providers", id: "before-auth" })}\n`);
			await process.stdin.flush();
			const before = await readResponseFrom(lines, "before-auth");
			expect(before?.data?.providers?.find(provider => provider.id === "shared-provider")).toBeUndefined();

			const writer = await discoverAuthStorage(agentDir.path());
			try {
				await writer.set("shared-provider", { type: "api_key", key: "sk-shared-test", source: "login" });
			} finally {
				writer.close();
			}

			process.stdin.write(`${JSON.stringify({ type: "get_providers", id: "after-auth" })}\n`);
			await process.stdin.flush();
			const after = await readResponseFrom(lines, "after-auth");
			expect(after?.data?.providers?.find(provider => provider.id === "shared-provider")).toMatchObject({
				authenticated: true,
			});
		} finally {
			await stopProcess(process);
		}
	}, 60_000);

	test("model and provider inventories reload models.yml changes without restarting the sidecar", async () => {
		using agentDir = TempDir.createSync("@omp-rpc-model-refresh-");
		const modelsPath = path.join(agentDir.path(), "models.yml");
		const writeModels = (modelId: string) =>
			Bun.write(
				modelsPath,
				[
					"providers:",
					"  hot-provider:",
					"    api: openai-completions",
					"    baseUrl: https://models.example.com/v1",
					"    auth: none",
					"    models:",
					`      - id: ${modelId}`,
				].join("\n"),
			);
		await writeModels("model-a");
		await Bun.write(
			path.join(agentDir.path(), "settings.json"),
			JSON.stringify({ enabledModels: ["hot-provider/*"] }),
		);
		const process = Bun.spawn(["bun", cliPath, "--mode", "rpc"], {
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
		const lines = readLines(process.stdout, AbortSignal.timeout(30_000))[Symbol.asyncIterator]();

		try {
			process.stdin.write(`${JSON.stringify({ type: "get_available_models", id: "before" })}\n`);
			await process.stdin.flush();
			const before = await readResponseFrom(lines, "before");
			expect(before?.data?.models).toEqual([expect.objectContaining({ provider: "hot-provider", id: "model-a" })]);

			await Bun.sleep(20);
			await writeModels("model-b");
			process.stdin.write(`${JSON.stringify({ type: "get_available_models", id: "after" })}\n`);
			await process.stdin.flush();
			const after = await readResponseFrom(lines, "after");
			expect(after?.data?.models).toEqual([expect.objectContaining({ provider: "hot-provider", id: "model-b" })]);

			await Bun.sleep(20);
			await Bun.write(modelsPath, "providers: {}\n");
			process.stdin.write(`${JSON.stringify({ type: "get_providers", id: "deleted" })}\n`);
			await process.stdin.flush();
			const deleted = await readResponseFrom(lines, "deleted");
			expect(deleted?.data?.providers?.some(provider => provider.id === "hot-provider")).toBe(false);
		} finally {
			await stopProcess(process);
		}
	}, 60_000);
});
