import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { rebindRpcSessionCwd } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import {
	applyRpcAddDirectory,
	applyRpcMoveSession,
	applyRpcRemoveDirectory,
	buildRpcWorkspaceDirectories,
	RpcWorkspaceBusyError,
	RpcWorkspaceRestoreError,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-workspace";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, getProjectAgentDir, getProjectDir, setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Contract tests for the workspace-directory RPC commands (TUI /dirs,
 * /add-dir, /remove-dir, /move parity). Runs against a real SessionManager in
 * a temp agent dir so persistence, header rewrites, and on-disk relocation
 * are exercised; AgentSession is stubbed down to the surface the RPC module
 * consumes (isStreaming / settings.flush / refreshBaseSystemPrompt /
 * moveSession → SessionManager.moveTo, mirroring AgentSession.moveSession).
 */

interface SessionStub {
	session: AgentSession;
	refreshBaseSystemPrompt: ReturnType<typeof vi.fn>;
	flush: ReturnType<typeof vi.fn>;
	moveSession: ReturnType<typeof vi.fn>;
}

function stubSession(
	manager: SessionManager,
	options?: { streaming?: boolean; flushError?: Error; moveError?: Error },
): SessionStub {
	const refreshBaseSystemPrompt = vi.fn(async () => {});
	const flush = vi.fn(async () => {
		if (options?.flushError) throw options.flushError;
	});
	const moveSession = vi.fn(async (newCwd: string) => {
		if (options?.moveError) throw options.moveError;
		await manager.moveTo(newCwd);
	});
	const session = {
		isStreaming: options?.streaming ?? false,
		sessionManager: manager,
		settings: { flush },
		refreshBaseSystemPrompt,
		moveSession,
	} as unknown as AgentSession;
	return { session, refreshBaseSystemPrompt, flush, moveSession };
}

describe("RPC workspace directories", () => {
	let tempDir: TempDir;
	let originalProjectDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		originalProjectDir = getProjectDir();
		tempDir = TempDir.createSync("@omp-rpc-workspace-");
		setAgentDir(tempDir.path());
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await tempDir.remove().catch(() => {});
	});

	function mkdir(...segments: string[]): string {
		const dir = path.join(tempDir.path(), ...segments);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	function createManager(cwd: string): SessionManager {
		return SessionManager.create(cwd);
	}

	describe("get_directories", () => {
		it("lists the cwd as the only primary root on a fresh session", () => {
			const cwd = mkdir("project");
			const { session } = stubSession(createManager(cwd));
			expect(buildRpcWorkspaceDirectories(session)).toEqual({
				directories: [{ path: path.resolve(cwd), primary: true }],
			});
		});

		it("lists additional roots after the primary, in order", async () => {
			const cwd = mkdir("project");
			const extra = mkdir("extra");
			const { session } = stubSession(createManager(cwd));
			await applyRpcAddDirectory(session, extra);
			expect(buildRpcWorkspaceDirectories(session)).toEqual({
				directories: [
					{ path: path.resolve(cwd), primary: true },
					{ path: path.resolve(extra), primary: false },
				],
			});
		});
	});

	describe("add_directory", () => {
		it("adds an existing directory and refreshes the base system prompt", async () => {
			const cwd = mkdir("project");
			const extra = mkdir("extra");
			const { session, refreshBaseSystemPrompt } = stubSession(createManager(cwd));
			const result = await applyRpcAddDirectory(session, extra);
			expect(result.directories).toEqual([
				{ path: path.resolve(cwd), primary: true },
				{ path: path.resolve(extra), primary: false },
			]);
			expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		});

		it("resolves relative paths against the session cwd", async () => {
			const cwd = mkdir("project");
			mkdir("project", "sub");
			const { session } = stubSession(createManager(cwd));
			const result = await applyRpcAddDirectory(session, "sub");
			expect(result.directories[1]).toEqual({ path: path.join(path.resolve(cwd), "sub"), primary: false });
		});

		it("treats an already-present directory as a no-op without a prompt refresh", async () => {
			const cwd = mkdir("project");
			const extra = mkdir("extra");
			const { session, refreshBaseSystemPrompt } = stubSession(createManager(cwd));
			await applyRpcAddDirectory(session, extra);
			const result = await applyRpcAddDirectory(session, extra);
			expect(result.directories).toHaveLength(2);
			expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		});

		it("refuses adding the cwd itself", async () => {
			const cwd = mkdir("project");
			const { session } = stubSession(createManager(cwd));
			await expect(applyRpcAddDirectory(session, ".")).rejects.toThrow(
				"The current working directory is already the primary workspace root.",
			);
		});

		it("refuses a missing directory", async () => {
			const cwd = mkdir("project");
			const { session } = stubSession(createManager(cwd));
			const missing = path.join(tempDir.path(), "missing");
			await expect(applyRpcAddDirectory(session, missing)).rejects.toThrow(`Directory does not exist: ${missing}`);
		});

		it("refuses a non-directory path", async () => {
			const cwd = mkdir("project");
			const file = path.join(tempDir.path(), "file.txt");
			fs.writeFileSync(file, "x");
			const { session } = stubSession(createManager(cwd));
			await expect(applyRpcAddDirectory(session, file)).rejects.toThrow(`Not a directory: ${file}`);
		});

		it("refuses while streaming with the busy code", async () => {
			const cwd = mkdir("project");
			const { session } = stubSession(createManager(cwd), { streaming: true });
			const err = await applyRpcAddDirectory(session, tempDir.path()).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(RpcWorkspaceBusyError);
			expect((err as RpcWorkspaceBusyError).code).toBe("busy");
			expect((err as Error).message).toBe("Cannot add a directory while streaming.");
		});
	});

	describe("remove_directory", () => {
		it("removes an additional root and refreshes the base system prompt", async () => {
			const cwd = mkdir("project");
			const extra = mkdir("extra");
			const { session, refreshBaseSystemPrompt } = stubSession(createManager(cwd));
			await applyRpcAddDirectory(session, extra);
			const result = await applyRpcRemoveDirectory(session, extra);
			expect(result.directories).toEqual([{ path: path.resolve(cwd), primary: true }]);
			expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(2);
		});

		it("refuses removing the primary working directory with the /move pointer", async () => {
			const cwd = mkdir("project");
			const { session, refreshBaseSystemPrompt } = stubSession(createManager(cwd));
			await expect(applyRpcRemoveDirectory(session, cwd)).rejects.toThrow(
				"Cannot remove the working directory; use /move to change it.",
			);
			// Path spellings resolve to the same refusal (cwd-relative ".", trailing separator).
			await expect(applyRpcRemoveDirectory(session, ".")).rejects.toThrow(
				"Cannot remove the working directory; use /move to change it.",
			);
			expect(refreshBaseSystemPrompt).not.toHaveBeenCalled();
		});

		it("treats an unknown directory as a no-op without a prompt refresh", async () => {
			const cwd = mkdir("project");
			const extra = mkdir("extra");
			const { session, refreshBaseSystemPrompt } = stubSession(createManager(cwd));
			const result = await applyRpcRemoveDirectory(session, extra);
			expect(result.directories).toEqual([{ path: path.resolve(cwd), primary: true }]);
			expect(refreshBaseSystemPrompt).not.toHaveBeenCalled();
		});

		it("refuses while streaming with the busy code", async () => {
			const cwd = mkdir("project");
			const { session } = stubSession(createManager(cwd), { streaming: true });
			const err = await applyRpcRemoveDirectory(session, tempDir.path()).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(RpcWorkspaceBusyError);
			expect((err as Error).message).toBe("Cannot remove a directory while streaming.");
		});
	});

	describe("move_session", () => {
		async function memoryFixture(sourceBackend: "off" | "hindsight") {
			const cwd = mkdir("source");
			const dest = mkdir("destination");
			const recalledBanks: string[] = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					const pathname = new URL(request.url).pathname;
					if (request.method === "PUT") return Response.json({});
					if (pathname.endsWith("/memories/recall")) {
						const bank = pathname.split("/")[4]!;
						recalledBanks.push(bank);
						return Response.json({ results: [{ id: bank, text: `${bank}-memory-canary` }] });
					}
					return new Response("Unexpected request", { status: 404 });
				},
			});
			const authStorage = createInMemoryAuthStorage();
			let session: AgentSession | undefined;
			const dispose = async () => {
				try {
					await session?.dispose();
				} finally {
					authStorage.close();
					await server.stop(true);
				}
			};
			try {
				for (const directory of [cwd, dest]) {
					await Bun.write(
						path.join(getProjectAgentDir(directory), "config.yml"),
						Bun.YAML.stringify({
							memory: { backend: directory === cwd ? sourceBackend : "hindsight" },
							hindsight: {
								apiUrl: server.url.href,
								bankId: directory === cwd ? "source" : "destination",
								autoRecall: true,
								autoRetain: false,
								mentalModelsEnabled: false,
							},
						}),
					);
				}
				const settings = await Settings.loadIsolated({ cwd, agentDir: tempDir.path() });
				const manager = createManager(cwd);
				authStorage.setRuntimeApiKey("openai", "test-key");
				({ session } = await createAgentSession({
					cwd,
					agentDir: tempDir.path(),
					sessionManager: manager,
					authStorage,
					modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
					settings,
					model: getBundledModel("openai", "gpt-4o-mini"),
					toolNames: ["read"],
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					rules: [],
					preloadedCustomToolPaths: [],
				}));
				const model = createMockModel({ handler: { content: ["ok"] } });
				session.agent.streamFn = model.stream;
				return { session, manager, cwd, dest, model, recalledBanks, [Symbol.asyncDispose]: dispose };
			} catch (error) {
				await dispose();
				throw error;
			}
		}

		it.each(["off", "hindsight"] as const)(
			"waits for the destination memory prompt before acknowledging a move from %s and recalls only the destination next turn",
			async sourceBackend => {
				await using fixture = await memoryFixture(sourceBackend);
				const { session, manager, dest, model, recalledBanks } = fixture;
				await session.prompt("Summarize the source project.");
				const rebindEntered = Promise.withResolvers<void>();
				const releaseRebind = Promise.withResolvers<void>();
				const refresh = session.refreshBaseSystemPrompt.bind(session);
				vi.spyOn(session, "refreshBaseSystemPrompt").mockImplementation(async () => {
					if (session.getHindsightSessionState()?.bankId === "destination") {
						rebindEntered.resolve();
						await releaseRebind.promise;
					}
					await refresh();
				});
				let completed = false;
				const move = applyRpcMoveSession(session, dest, {
					applyCwdChange: newCwd => rebindRpcSessionCwd(session, newCwd, async () => {}),
				}).then(result => {
					completed = true;
					return result;
				});
				try {
					await Promise.race([
						rebindEntered.promise,
						move.then(() => {
							throw new Error("Move acknowledged before destination memory rebind");
						}),
					]);
					expect(manager.getCwd()).toBe(dest);
					expect(completed).toBe(false);
				} finally {
					releaseRebind.resolve();
					await move;
				}
				expect(await move).toEqual({ cwd: dest });
				await session.prompt("Summarize the destination project.");
				expect(recalledBanks).toEqual(sourceBackend === "off" ? ["destination"] : ["source", "destination"]);
				const prompt = model.calls[1]!.context.systemPrompt!.join("\n");
				expect(prompt).toContain("destination-memory-canary");
				expect(prompt).not.toContain("source-memory-canary");
			},
		);

		it.each([false, true])("recovers a failed memory rebind without a stale active backend (rollback failure: %s)", async rollbackFails => {
			await using fixture = await memoryFixture("hindsight");
			const { session, manager, cwd, dest } = fixture;
			await session.prompt("Remember the source project.");
			await manager.ensureOnDisk();
			const sourceFile = manager.getSessionFile()!;
			const sourceState = session.getHindsightSessionState()!;
			const flush = sourceState.flushRetainQueue.bind(sourceState);
			vi.spyOn(sourceState, "flushRetainQueue").mockImplementation(async () => {
				if (manager.getCwd() === dest) throw new Error("source memory drain failed");
				await flush();
			});
			if (rollbackFails) vi.spyOn(manager, "rollbackMove").mockRejectedValue(new Error("rollback disk failure"));
			const failure = await applyRpcMoveSession(session, dest, {
				applyCwdChange: newCwd => rebindRpcSessionCwd(session, newCwd, async () => {}),
			}).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toContain("source memory drain failed");
			if (rollbackFails) {
				expect(failure).toBeInstanceOf(RpcWorkspaceRestoreError);
				expect((failure as Error).message).toContain(dest);
				expect((failure as Error).message).toContain("session closed");
				expect(manager.getCwd()).toBe(dest);
				expect(await Bun.file(sourceFile).exists()).toBe(false);
				expect(session.getHindsightSessionState()).toBeUndefined();
			} else {
				expect((failure as Error).message).toContain(`workspace restored to ${cwd}`);
				expect(manager.getCwd()).toBe(cwd);
				expect(getProjectDir()).toBe(cwd);
				expect(manager.getSessionFile()).toBe(sourceFile);
				expect(await Bun.file(sourceFile).exists()).toBe(true);
				await session.prompt("Summarize the restored project.");
				expect(fixture.recalledBanks).not.toContain("destination");
				expect(session.getHindsightSessionState()?.bankId).toBe("source");
			}
		});

		it("relocates the session file to the destination's session dir and rewrites the header cwd", async () => {
			const cwd = mkdir("project");
			const dest = mkdir("dest");
			const manager = createManager(cwd);
			manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
			await manager.ensureOnDisk();
			const oldSessionFile = manager.getSessionFile();
			if (!oldSessionFile) throw new Error("Expected a session file");
			expect(fs.existsSync(oldSessionFile)).toBe(true);

			const { session, flush } = stubSession(manager);
			const applyCwdChange = vi.fn(async (_newCwd: string) => {});
			const result = await applyRpcMoveSession(session, dest, { applyCwdChange });

			expect(result.cwd).toBe(path.resolve(dest));
			expect(manager.getCwd()).toBe(path.resolve(dest));
			expect(flush).toHaveBeenCalledTimes(1);
			expect(applyCwdChange).toHaveBeenCalledWith(path.resolve(dest));

			const newSessionFile = manager.getSessionFile();
			if (!newSessionFile) throw new Error("Expected a session file after the move");
			expect(newSessionFile).not.toBe(oldSessionFile);
			expect(fs.existsSync(oldSessionFile)).toBe(false);
			expect(fs.existsSync(newSessionFile)).toBe(true);
			const headerLine = fs
				.readFileSync(newSessionFile, "utf8")
				.split("\n")
				.find(line => line.includes('"type":"session"'));
			if (!headerLine) throw new Error("Expected a session header entry in the moved file");
			const header = JSON.parse(headerLine) as { cwd?: string };
			expect(header.cwd).toBe(path.resolve(dest));
		});

		it("drops the destination from the additional roots when it becomes the cwd", async () => {
			const cwd = mkdir("project");
			const dest = mkdir("dest");
			const { session } = stubSession(createManager(cwd));
			await applyRpcAddDirectory(session, dest);
			const result = await applyRpcMoveSession(session, dest, { applyCwdChange: async () => {} });
			expect(buildRpcWorkspaceDirectories(session)).toEqual({
				directories: [{ path: result.cwd, primary: true }],
			});
		});

		it("refuses a missing destination without touching the session", async () => {
			const cwd = mkdir("project");
			const manager = createManager(cwd);
			const { session, flush, moveSession } = stubSession(manager);
			const missing = path.join(tempDir.path(), "missing");
			await expect(applyRpcMoveSession(session, missing, { applyCwdChange: async () => {} })).rejects.toThrow(
				`Directory does not exist: ${missing}`,
			);
			expect(manager.getCwd()).toBe(path.resolve(cwd));
			expect(flush).not.toHaveBeenCalled();
			expect(moveSession).not.toHaveBeenCalled();
		});

		it("aborts before moving when the settings flush fails", async () => {
			const cwd = mkdir("project");
			const dest = mkdir("dest");
			const manager = createManager(cwd);
			const { session, moveSession } = stubSession(manager, { flushError: new Error("disk full") });
			await expect(applyRpcMoveSession(session, dest, { applyCwdChange: async () => {} })).rejects.toThrow(
				"Failed to save pending settings: disk full",
			);
			expect(moveSession).not.toHaveBeenCalled();
			expect(manager.getCwd()).toBe(path.resolve(cwd));
		});

		it("wraps a session-manager failure as a move failure", async () => {
			const cwd = mkdir("project");
			const dest = mkdir("dest");
			const manager = createManager(cwd);
			const { session } = stubSession(manager, { moveError: new Error("rename failed") });
			await expect(applyRpcMoveSession(session, dest, { applyCwdChange: async () => {} })).rejects.toThrow(
				"Move failed: rename failed",
			);
			expect(manager.getCwd()).toBe(path.resolve(cwd));
		});

		it("refuses while streaming with the busy code", async () => {
			const cwd = mkdir("project");
			const { session } = stubSession(createManager(cwd), { streaming: true });
			const err = await applyRpcMoveSession(session, tempDir.path(), { applyCwdChange: async () => {} }).catch(
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(RpcWorkspaceBusyError);
			expect((err as Error).message).toBe("Cannot move while streaming.");
		});
	});
});
