import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions, createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

/** Read the header off a persisted session file. */
async function readHeader(sessionFile: string): Promise<SessionHeader | undefined> {
	const entries = await loadEntriesFromFile(sessionFile);
	return entries.find((entry): entry is SessionHeader => entry.type === "session");
}

/** Write a minimal session file with the given kind, returning its path. */
async function writeSessionFile(sessionDir: string, id: string, kind?: "chat"): Promise<string> {
	await fs.mkdir(sessionDir, { recursive: true });
	const file = path.join(sessionDir, `${id}.jsonl`);
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: new Date().toISOString(),
		cwd: sessionDir,
		...(kind ? { kind } : {}),
	};
	await Bun.write(file, `${JSON.stringify(header)}\n`);
	return file;
}

describe("session kind — creation stamps the header", () => {
	it('stamps kind:"chat" when created with the chat option, and omits it otherwise', async () => {
		const cwd = makeTempDir("@omp-chat-create-");
		const sessionDir = path.join(cwd, "sessions");

		const chat = SessionManager.create(cwd, sessionDir, undefined, { kind: "chat" });
		expect(chat.getHeader()?.kind).toBe("chat");

		const agent = SessionManager.create(cwd, sessionDir);
		expect(agent.getHeader()?.kind).toBeUndefined();
	});

	it("persists kind through a save/load round-trip", async () => {
		const cwd = makeTempDir("@omp-chat-roundtrip-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, { kind: "chat" });
		await manager.ensureOnDisk();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");

		// Reopen from disk: the header must still carry the kind.
		const reopened = await SessionManager.open(sessionFile);
		expect(reopened.getHeader()?.kind).toBe("chat");
	});
});

describe("session kind — peekSessionKind cold read", () => {
	it("reads chat, defaults agent for an unstamped header, and returns agent for an unreadable file", async () => {
		const dir = makeTempDir("@omp-chat-peek-");
		const chatFile = await writeSessionFile(dir, "chat-one", "chat");
		const agentFile = await writeSessionFile(dir, "agent-one");

		expect(await SessionManager.peekSessionKind(chatFile)).toBe("chat");
		// Absent kind = agent (backward compatibility with every pre-existing session).
		expect(await SessionManager.peekSessionKind(agentFile)).toBe("agent");
		// Unreadable file degrades to agent rather than throwing.
		expect(await SessionManager.peekSessionKind(path.join(dir, "missing.jsonl"))).toBe("agent");
	});
});

describe("session kind — fork inheritance", () => {
	it("carries kind onto a forked session (fork must not silently revert to agent)", async () => {
		const cwd = makeTempDir("@omp-chat-fork-");
		const sessionDir = path.join(cwd, "sessions");
		const sourceFile = await writeSessionFile(sessionDir, "chat-source", "chat");

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});
		expect(forked.getHeader()?.kind).toBe("chat");

		const forkedFile = forked.getSessionFile();
		if (!forkedFile) throw new Error("expected a forked session file");
		await forked.flush();
		expect((await readHeader(forkedFile))?.kind).toBe("chat");
	});

	it("leaves an agent fork unstamped", async () => {
		const cwd = makeTempDir("@omp-agent-fork-");
		const sessionDir = path.join(cwd, "sessions");
		const sourceFile = await writeSessionFile(sessionDir, "agent-source");

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});
		expect(forked.getHeader()?.kind).toBeUndefined();
	});
});

describe("--chat flag → session options", () => {
	it("empties the tool set and restricts the registry", async () => {
		const cwd = makeTempDir("@omp-chat-flag-");
		const parsed = parseArgs(["--chat"]);
		expect(parsed.chat).toBe(true);
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const settings = await Settings.loadIsolated({ cwd, agentDir: cwd, inMemory: true });
		const registry = new ModelRegistry(authStorage);
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, { kind: "chat" });
		const options = await buildSessionOptions(parsed, [], manager, registry, settings);

		expect(options.toolNames).toEqual([]);
		// restrictToolNames is what makes the registry build EMPTY — without it the
		// registry retains every built-in and `alwaysInclude` re-adds extension tools.
		expect(options.restrictToolNames).toBe(true);
		expect(options.appendSystemPrompt).toContain("NO tools");
	});

	it("re-derives chat mode from the header on resume, without --chat on the argv", async () => {
		const cwd = makeTempDir("@omp-chat-resume-");
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const settings = await Settings.loadIsolated({ cwd, agentDir: cwd, inMemory: true });
		const registry = new ModelRegistry(authStorage);
		// A resumed chat session: header says chat, argv does not.
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, { kind: "chat" });
		const parsed = parseArgs([]);
		expect(parsed.chat).toBeUndefined();

		const options = await buildSessionOptions(parsed, [], manager, registry, settings);
		expect(options.toolNames).toEqual([]);
		expect(options.restrictToolNames).toBe(true);
	});

	it("leaves an agent session's tools untouched", async () => {
		const cwd = makeTempDir("@omp-agent-flag-");
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const settings = await Settings.loadIsolated({ cwd, agentDir: cwd, inMemory: true });
		const registry = new ModelRegistry(authStorage);
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const options = await buildSessionOptions(parseArgs([]), [], manager, registry, settings);

		expect(options.toolNames).toBeUndefined();
		expect(options.restrictToolNames).toBeUndefined();
	});

	it("honors an explicit --tools list over chat's empty set", async () => {
		const cwd = makeTempDir("@omp-chat-tools-");
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const settings = await Settings.loadIsolated({ cwd, agentDir: cwd, inMemory: true });
		const registry = new ModelRegistry(authStorage);
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, { kind: "chat" });
		const options = await buildSessionOptions(
			parseArgs(["--chat", "--tools", "read"]),
			[],
			manager,
			registry,
			settings,
		);

		expect(options.toolNames).toEqual(["read"]);
	});
});

describe("--chat + autoResume", () => {
	it("creates a fresh chat session instead of resuming an agent session (I1)", async () => {
		const cwd = makeTempDir("@omp-chat-autoresume-");
		const sessionDir = path.join(cwd, "sessions");
		// A pre-existing agent session that autoResume would otherwise pick up.
		await writeSessionFile(sessionDir, "prior-agent");

		const settings = await Settings.loadIsolated({ cwd, agentDir: cwd, inMemory: true });
		settings.override("autoResume", true);
		const parsed = parseArgs(["--chat"]);
		parsed.sessionDir = sessionDir;

		const manager = await createSessionManager(parsed, cwd, settings);
		// --chat must win: a fresh chat session, never the resumed agent one.
		expect(manager?.getHeader()?.kind).toBe("chat");
		expect(manager?.getEntries().length).toBe(0);
		// parsed.continue must stay false — this is not a resume.
		expect(parsed.continue).toBeFalsy();
	});
});

describe("session kind — inheritance through session-producing operations", () => {
	it("persistCopy carries kind onto the copy", async () => {
		const cwd = makeTempDir("@omp-chat-persistcopy-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, { kind: "chat" });

		const copy = await manager.persistCopy();
		expect(copy.getHeader()?.kind).toBe("chat");

		const copyFile = copy.getSessionFile();
		if (!copyFile) throw new Error("expected a persisted copy file");
		expect((await readHeader(copyFile))?.kind).toBe("chat");
	});

	it("persistCopy leaves an agent copy unstamped", async () => {
		const cwd = makeTempDir("@omp-agent-persistcopy-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));

		const copy = await manager.persistCopy();
		expect(copy.getHeader()?.kind).toBeUndefined();
	});

	it("copyBranchToNewSession carries kind onto the branched session (fork_from RPC path)", async () => {
		const cwd = makeTempDir("@omp-chat-copybranch-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, { kind: "chat" });
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		const leafId = manager.getLeafId();
		if (!leafId) throw new Error("expected a leaf entry after appendMessage");

		const result = await manager.copyBranchToNewSession(leafId);
		if (!result) throw new Error("expected a branched session");
		expect((await readHeader(result.sessionPath))?.kind).toBe("chat");
	});

	it("AgentSession.newSession births a chat-stamped file inside a chat sidecar (I1)", async () => {
		const cwd = makeTempDir("@omp-chat-newsession-");
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, { kind: "chat" });

		const toolSession: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
		};
		const tools = await createTools(toolSession);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled anthropic model");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools },
		});
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		try {
			expect(await session.newSession()).toBe(true);
			// The new session inherits the chat kind — never an agent-stamped file.
			expect(sessionManager.getHeader()?.kind).toBe("chat");

			await sessionManager.ensureOnDisk();
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("expected a persisted session file");
			expect((await readHeader(file))?.kind).toBe("chat");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("branch from a root entry keeps the continuing session chat-stamped (I1)", async () => {
		const cwd = makeTempDir("@omp-chat-branchroot-");
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, { kind: "chat" });

		const toolSession: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
		};
		const tools = await createTools(toolSession);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled anthropic model");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools },
		});
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		try {
			// A root entry (parentId null) takes the newSession path, not createBranchedSession.
			sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
			const rootId = sessionManager.getLeafId();
			if (!rootId) throw new Error("expected a root entry");
			const entry = sessionManager.getEntry(rootId);
			expect(entry?.parentId).toBeNull();

			const result = await session.branch(rootId);
			expect(result.cancelled).toBe(false);
			expect(sessionManager.getHeader()?.kind).toBe("chat");

			await sessionManager.ensureOnDisk();
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("expected a persisted session file");
			expect((await readHeader(file))?.kind).toBe("chat");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("exposes restrictToolNames on AgentSession — the wiring the mode guards depend on", async () => {
		const cwd = makeTempDir("@omp-chat-restrict-flag-");
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"), undefined, { kind: "chat" });
		const toolSession: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
		};
		const tools = await createTools(toolSession);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled anthropic model");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools },
		});
		// A guard that never sees the flag is a dead guard: the RPC mode guards
		// (plan/goal/loop/vibe) refuse only when this reads true.
		const chatSession = new AgentSession({ agent, sessionManager, settings, modelRegistry, restrictToolNames: true });
		try {
			expect(chatSession.restrictToolNames).toBe(true);
		} finally {
			await chatSession.dispose();
		}

		const agentSession = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		try {
			expect(agentSession.restrictToolNames).toBe(false);
		} finally {
			await agentSession.dispose();
			authStorage.close();
		}
	});

	it("AgentSession.newSession in an agent sidecar leaves the new header unstamped", async () => {
		const cwd = makeTempDir("@omp-agent-newsession-");
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));

		const toolSession: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
		};
		const tools = await createTools(toolSession);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled anthropic model");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools },
		});
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		try {
			expect(await session.newSession()).toBe(true);
			expect(sessionManager.getHeader()?.kind).toBeUndefined();
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
