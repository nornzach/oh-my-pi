import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MarketplaceManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { buildRpcMcpServersResult } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-domains";
import { applyRpcMarketplaceAction } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-marketplace";
import {
	applyRpcMcpAdd,
	applyRpcMcpReauth,
	applyRpcMcpReauthCancel,
	applyRpcMcpTest,
	type RpcMcpOAuthUi,
	RpcMcpReauthBusyError,
	resetRpcMcpOAuthStateForTests,
	serializeMcpReload,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mcp-extra";
import {
	dispatchRpcInputFrame,
	type PendingExtensionRequest,
	type RpcInputFrameDeps,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import {
	applyRpcDeletePluginSetting,
	applyRpcSetPluginFeatures,
	applyRpcSetPluginSetting,
	buildRpcPluginDetail,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-plugins";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import * as fileLock from "@oh-my-pi/pi-utils/file-lock";

/**
 * Contract tests for the C1 management RPC helpers (mcp add/test/reauth,
 * marketplace_action, plugin detail/settings). Asserts the wire-result shapes
 * from the C1 contract: throwaway-manager probing, the oauth_busy concurrency
 * code, source-form validation, detail composition, and schema-validation
 * feedback. Real config/lockfile fixtures under temp dirs; the pi-utils path
 * spies mirror plugin-config.test.ts / marketplace/manager.test.ts.
 */

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-c1-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	resetRpcMcpOAuthStateForTests();
	removeSyncWithRetries(tmpRoot);
});

function stubSession(overrides?: { refreshMCPTools?: AgentSession["refreshMCPTools"] }): AgentSession {
	return {
		sessionManager: { getCwd: () => tmpRoot },
		modelRegistry: { authStorage: undefined },
		settings: { get: () => undefined },
		refreshMCPTools: overrides?.refreshMCPTools ?? vi.fn(async () => {}),
		setMCPPromptCommands: vi.fn(),
	} as unknown as AgentSession;
}

function stubOAuthUi(): RpcMcpOAuthUi {
	return {
		openUrl: vi.fn(),
		notify: vi.fn(),
		input: vi.fn(async () => undefined),
	};
}

/** Route MCP config reads/writes into the temp root. */
function spyMcpConfigPaths(): { userPath: string; projectPath: string } {
	const userPath = path.join(tmpRoot, "user-mcp.json");
	const projectPath = path.join(tmpRoot, "project-mcp.json");
	vi.spyOn(piUtils, "getMCPConfigPath").mockImplementation((scope: "user" | "project") =>
		scope === "user" ? userPath : projectPath,
	);
	return { userPath, projectPath };
}

function writeMcpConfig(filePath: string, servers: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify({ mcpServers: servers }, null, 2));
}

// Closed loopback port: ECONNREFUSED is immediate and deterministic.
const UNREACHABLE_HTTP_CONFIG = { transport: "http", url: "http://127.0.0.1:1/" } as const;

describe("applyRpcMcpTest", () => {
	it("probes with a throwaway manager and never touches MCPManager.instance()", async () => {
		const instanceSpy = vi.spyOn(MCPManager, "instance");
		const result = await applyRpcMcpTest(stubSession(), undefined, UNREACHABLE_HTTP_CONFIG);
		// The probe ran (and failed fast against the closed port)...
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
		// ...without ever consulting the shared manager singleton.
		expect(instanceSpy).not.toHaveBeenCalled();
	});

	it("probes a configured server by name, still throwaway-only", async () => {
		const { projectPath } = spyMcpConfigPaths();
		writeMcpConfig(projectPath, { probe: { type: "http", url: "http://127.0.0.1:1/" } });
		const instanceSpy = vi.spyOn(MCPManager, "instance");
		const result = await applyRpcMcpTest(stubSession(), "probe", undefined);
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
		expect(instanceSpy).not.toHaveBeenCalled();
	});

	it("reports unknown server names in the result error channel", async () => {
		spyMcpConfigPaths();
		const result = await applyRpcMcpTest(stubSession(), "ghost", undefined);
		expect(result).toEqual({
			ok: false,
			error: 'Server "ghost" not found. Run get_mcp_servers to see configured servers.',
		});
	});

	it("requires exactly one of name|config", async () => {
		const session = stubSession();
		expect((await applyRpcMcpTest(session, undefined, undefined)).ok).toBe(false);
		expect((await applyRpcMcpTest(session, "x", UNREACHABLE_HTTP_CONFIG)).ok).toBe(false);
	});

	it("rejects invalid inline configs through the shared validator", async () => {
		const result = await applyRpcMcpTest(stubSession(), undefined, { transport: "stdio" });
		expect(result.ok).toBe(false);
		expect(result.error).toContain('stdio server requires "command" field');
	});
});

describe("applyRpcMcpReauth mutex", () => {
	it("refuses a concurrent claim with code oauth_busy, then releases", async () => {
		spyMcpConfigPaths();
		const session = stubSession();
		const ui = stubOAuthUi();

		// The claim is taken synchronously on entry; the first reauth then fails
		// fast on the unknown server but still holds the claim this tick.
		const first = applyRpcMcpReauth(session, "server-a", ui);
		const second = applyRpcMcpReauth(session, "server-b", ui);
		await expect(second).rejects.toThrow(RpcMcpReauthBusyError);
		await expect(second).rejects.toMatchObject({ code: "oauth_busy" });

		// First claim settles (unknown server) and the mutex releases.
		await expect(first).resolves.toEqual({ ok: false, error: 'Server "server-a" not found.' });
		await expect(applyRpcMcpReauth(session, "server-c", ui)).resolves.toEqual({
			ok: false,
			error: 'Server "server-c" not found.',
		});
	});

	it("mcp_reauth_cancel reports false when nothing is in flight", () => {
		expect(applyRpcMcpReauthCancel("server-a")).toEqual({ cancelled: false });
	});
});

describe("serializeMcpReload", () => {
	it("runs shared-manager mutations one at a time and recovers after rejection", async () => {
		const firstGate = Promise.withResolvers<void>();
		const events: string[] = [];
		const first = serializeMcpReload(async () => {
			events.push("first:start");
			await firstGate.promise;
			events.push("first:end");
		});
		const second = serializeMcpReload(async () => {
			events.push("second:start");
		});

		await Promise.resolve();
		expect(events).toEqual(["first:start"]);
		firstGate.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual(["first:start", "first:end", "second:start"]);

		await expect(
			serializeMcpReload(async () => {
				throw new Error("reload failed");
			}),
		).rejects.toThrow("reload failed");
		await expect(serializeMcpReload(async () => "next")).resolves.toBe("next");
	});
});

describe("applyRpcMcpAdd", () => {
	beforeEach(() => {
		// The native FileLock binding is unavailable in some test environments
		// (stale prebuilt natives); the lock primitive is config-writer's own
		// contract — here the read-modify-write just needs to run.
		vi.spyOn(fileLock, "withFileLock").mockImplementation(async (_filePath, fn) => await fn());
	});

	it("writes the config (colon-namespaced name) and returns the refreshed server row", async () => {
		const { projectPath } = spyMcpConfigPaths();
		const refreshMCPTools = vi.fn(async () => {});
		const session = stubSession({ refreshMCPTools });

		const result = await applyRpcMcpAdd(
			session,
			"acme:tools",
			{ transport: "stdio", command: "acme-mcp", args: ["--serve"] },
			"project",
		);

		// Wire shape: { added: true, server } with the new C1 fields projected.
		expect(result.added).toBe(true);
		expect(result.server).toMatchObject({
			name: "acme:tools",
			transport: "stdio",
			status: "disconnected",
			toolCount: 0,
			enabled: true,
			authed: false,
			scope: "project",
			command: "acme-mcp",
			authState: "none",
		});
		// The reload finish ran (no manager in tests → refresh with empty tools).
		expect(refreshMCPTools).toHaveBeenCalledWith([]);
		// The config file holds the raw entry (validateServerName allows ":").
		const written = JSON.parse(fs.readFileSync(projectPath, "utf-8"));
		expect(written.mcpServers["acme:tools"]).toMatchObject({ type: "stdio", command: "acme-mcp", args: ["--serve"] });
	});

	it("rejects duplicate adds (envelope-level failure, no error channel on the shape)", async () => {
		spyMcpConfigPaths();
		const session = stubSession();
		const config = { transport: "stdio", command: "acme-mcp" } as const;
		await applyRpcMcpAdd(session, "acme", config);
		await expect(applyRpcMcpAdd(session, "acme", config)).rejects.toThrow(/already exists/);
	});
});

describe("buildRpcMcpServersResult C1 fields", () => {
	it("projects scope/command/url/authState from config + manager state", async () => {
		const { userPath, projectPath } = spyMcpConfigPaths();
		writeMcpConfig(userPath, {
			remote: { type: "http", url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer x" } },
			needsAuth: {
				type: "http",
				url: "https://mcp.example.com/oauth",
				auth: { type: "oauth", credentialId: "mcp_oauth:profile:default:https://mcp.example.com/oauth" },
			},
		});
		writeMcpConfig(projectPath, {
			local: { type: "stdio", command: "local-mcp" },
		});

		const { servers } = await buildRpcMcpServersResult(stubSession());
		const byName = new Map(servers.map(server => [server.name, server]));

		expect(byName.get("remote")).toMatchObject({
			scope: "user",
			transport: "http",
			url: "https://mcp.example.com/sse",
			authed: true,
			authState: "authorized",
		});
		expect(byName.get("needsAuth")).toMatchObject({ scope: "user", authState: "required", authed: false });
		expect(byName.get("local")).toMatchObject({ scope: "project", command: "local-mcp", authState: "none" });
	});
});

describe("applyRpcMarketplaceAction", () => {
	it("rejects a bare-name source for add", async () => {
		const result = await applyRpcMarketplaceAction(stubSession(), { action: "add", source: "just-a-name" });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Unrecognized source format");
	});

	it("requires a source for add", async () => {
		const result = await applyRpcMarketplaceAction(stubSession(), { action: "add" });
		expect(result).toEqual({ ok: false, error: "Missing `source` for marketplace add." });
	});
});

// ── Plugin detail & settings ────────────────────────────────────────────────

const PLUGIN_NAME = "test-plugin";

function writePluginFixture(): void {
	const pluginsDir = path.join(tmpRoot, "plugins");
	const nodeModules = path.join(pluginsDir, "node_modules");
	fs.mkdirSync(path.join(nodeModules, PLUGIN_NAME), { recursive: true });
	fs.writeFileSync(
		path.join(pluginsDir, "package.json"),
		JSON.stringify({ dependencies: { [PLUGIN_NAME]: "1.0.0" } }),
	);
	fs.writeFileSync(
		path.join(nodeModules, PLUGIN_NAME, "package.json"),
		JSON.stringify({
			name: PLUGIN_NAME,
			version: "1.0.0",
			omp: {
				features: {
					alpha: { description: "Alpha feature", default: true },
					beta: { default: false },
				},
				settings: {
					threshold: { type: "number", min: 0, max: 10, description: "Max threshold" },
					apiToken: { type: "string", secret: true, default: "manifest-secret" },
					passwordHint: { type: "string" },
				},
			},
		}),
	);
	fs.writeFileSync(
		path.join(pluginsDir, "omp-plugins.lock.json"),
		JSON.stringify({
			plugins: { [PLUGIN_NAME]: { version: "1.0.0", enabled: true, enabledFeatures: ["alpha"] } },
			settings: { [PLUGIN_NAME]: { threshold: 5, apiToken: "schema-secret", passwordHint: "name-secret" } },
		}),
	);
	vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
	vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(nodeModules);
	vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json"));
	vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(pluginsDir, "omp-plugins.lock.json"));
	vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
}

describe("buildRpcPluginDetail", () => {
	it("composes manifest features and settings without exposing secret values", async () => {
		writePluginFixture();
		const detail = await buildRpcPluginDetail(stubSession(), PLUGIN_NAME);
		expect(detail).toEqual({
			id: PLUGIN_NAME,
			enabled: true,
			features: [
				{ id: "alpha", description: "Alpha feature", enabled: true },
				{ id: "beta", enabled: false },
			],
			settingsSchema: {
				threshold: { type: "number", min: 0, max: 10, description: "Max threshold" },
				apiToken: { type: "string", secret: true },
				passwordHint: { type: "string" },
			},
			values: { threshold: 5 },
			configuredKeys: ["threshold", "apiToken", "passwordHint"],
		});
		expect(JSON.stringify(detail)).not.toContain("schema-secret");
		expect(JSON.stringify(detail)).not.toContain("manifest-secret");
		expect(JSON.stringify(detail)).not.toContain("name-secret");
	});

	it("loads marketplace runtime packages by id and persists their feature selection", async () => {
		writePluginFixture();
		const marketPath = path.join(tmpRoot, "market-plugin");
		fs.mkdirSync(marketPath, { recursive: true });
		fs.writeFileSync(
			path.join(marketPath, "package.json"),
			JSON.stringify({
				name: "market-plugin",
				version: "2.0.0",
				omp: { features: { alpha: { default: true }, beta: { default: false } } },
			}),
		);
		vi.spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([
			{
				id: "market-plugin@catalog",
				scope: "user",
				entries: [
					{
						scope: "user",
						installPath: marketPath,
						version: "2.0.0",
						installedAt: "2026-08-06T00:00:00.000Z",
						lastUpdated: "2026-08-06T00:00:00.000Z",
						enabled: true,
					},
				],
			},
		]);

		const initial = await buildRpcPluginDetail(stubSession(), "market-plugin@catalog");
		expect(initial).toMatchObject({
			id: "market-plugin",
			enabled: true,
			features: [
				{ id: "alpha", enabled: true },
				{ id: "beta", enabled: false },
			],
		});

		expect(await applyRpcSetPluginFeatures(stubSession(), "market-plugin@catalog", ["beta"])).toEqual({ ok: true });
		const lock = JSON.parse(fs.readFileSync(path.join(tmpRoot, "plugins", "omp-plugins.lock.json"), "utf-8"));
		expect(lock.plugins["market-plugin"].enabledFeatures).toEqual(["beta"]);
	});

	it("throws for unknown plugins (envelope-level failure)", async () => {
		writePluginFixture();
		await expect(buildRpcPluginDetail(stubSession(), "ghost")).rejects.toThrow('Plugin "ghost" not found.');
	});
});

describe("applyRpcSetPluginSetting", () => {
	it("surfaces schema validation feedback in the error field", async () => {
		writePluginFixture();
		const result = await applyRpcSetPluginSetting(stubSession(), PLUGIN_NAME, "threshold", 99);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Must be <= 10");
	});

	it("rejects keys outside the declared schema", async () => {
		writePluginFixture();
		const result = await applyRpcSetPluginSetting(stubSession(), PLUGIN_NAME, "nope", 1);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Unknown setting "nope"');
	});

	it("persists valid values through PluginManager (never touches the lockfile directly)", async () => {
		writePluginFixture();
		expect(await applyRpcSetPluginSetting(stubSession(), PLUGIN_NAME, "threshold", 7)).toEqual({ ok: true });
		const lock = JSON.parse(fs.readFileSync(path.join(tmpRoot, "plugins", "omp-plugins.lock.json"), "utf-8"));
		expect(lock.settings[PLUGIN_NAME].threshold).toBe(7);
	});

	it("deletes values through PluginManager", async () => {
		writePluginFixture();
		expect(await applyRpcDeletePluginSetting(stubSession(), PLUGIN_NAME, "threshold")).toEqual({ ok: true });
		const detail = await buildRpcPluginDetail(stubSession(), PLUGIN_NAME);
		expect(detail.values).toEqual({});
		expect(detail.configuredKeys).toEqual(["apiToken", "passwordHint"]);
	});
});

describe("background dispatch (dispatchRpcInputFrame)", () => {
	const makeDeps = (handleCommand: RpcInputFrameDeps["handleCommand"]) => {
		const outputs: object[] = [];
		const deps: RpcInputFrameDeps = {
			handleCommand,
			output: obj => {
				outputs.push(obj);
			},
			errorResponse: (id, command, message) => ({
				id,
				type: "response",
				command,
				success: false,
				error: message,
			}),
			pendingExtensionRequests: new Map<string, PendingExtensionRequest>(),
			onHostToolResult: () => {},
			onHostToolUpdate: () => {},
			onHostUriResult: () => {},
		};
		return { deps, outputs };
	};

	it("mcp_reauth runs in the background so mcp_reauth_cancel can overtake it", async () => {
		const { promise: reauthPending, resolve: resolveReauth } = Promise.withResolvers<RpcResponse>();
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type === "mcp_reauth") return await reauthPending;
			if (command.type === "mcp_reauth_cancel") {
				resolveReauth({
					id: "r1",
					type: "response",
					command: "mcp_reauth",
					success: true,
					data: { ok: false, error: "cancelled" },
				});
				return {
					id: command.id,
					type: "response",
					command: "mcp_reauth_cancel",
					success: true,
					data: { cancelled: true },
				};
			}
			throw new Error(`unexpected command type: ${command.type}`);
		};
		const { deps, outputs } = makeDeps(handleCommand);

		// Background-dispatched: returns undefined without awaiting the login.
		expect(dispatchRpcInputFrame({ id: "r1", type: "mcp_reauth", name: "srv" }, deps)).toBeUndefined();
		// The cancel frame overtakes the in-flight reauth and settles it.
		await dispatchRpcInputFrame({ id: "c1", type: "mcp_reauth_cancel", name: "srv" }, deps);
		await new Promise<void>(resolve => setImmediate(resolve));

		const commands = outputs.map(frame => (frame as { command?: string }).command);
		expect(commands).toEqual(["mcp_reauth_cancel", "mcp_reauth"]);
	});

	it("mcp_test runs in the background", () => {
		const { promise: gate } = Promise.withResolvers<RpcResponse>();
		const { deps } = makeDeps(async () => await gate);
		expect(dispatchRpcInputFrame({ id: "t1", type: "mcp_test", name: "srv" }, deps)).toBeUndefined();
	});
});
