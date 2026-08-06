import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	applyRpcAddDirectory,
	applyRpcMoveSession,
	applyRpcRemoveDirectory,
	buildRpcWorkspaceDirectories,
	RpcWorkspaceBusyError,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-workspace";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

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
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-rpc-workspace-");
		setAgentDir(tempDir.path());
	});

	afterEach(async () => {
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
