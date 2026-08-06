/**
 * C1 MCP server management for RPC mode: `mcp_add`, `mcp_test`, `mcp_reauth`,
 * `mcp_reauth_cancel`. Mirrors the TUI `/mcp` command-controller flows
 * (mcp-command-controller.ts) against the same config files, managers, and
 * OAuth machinery:
 *
 * - `mcp_add`: `/mcp add` + wizard-complete parity — locked atomic config write
 *   (`addMCPServer`), then the serialized full `reloadServers`-equivalent
 *   finish mirrored from rpc-actions.ts.
 * - `mcp_test`: `/mcp test` parity — probes with a THROWAWAY `new MCPManager(cwd)`
 *   (never `MCPManager.instance()`, so the probe cannot touch the shared
 *   connection pool), mirroring `withPreparedMcpConnection` in
 *   slash-commands/helpers/mcp.ts. Bounded by a 30s timeout guard.
 * - `mcp_reauth`: `/mcp reauth` parity — endpoint discovery, PKCE+DCR OAuth via
 *   `MCPOAuthFlow`, credential persistence preserving raw `${ENV}` placeholders
 *   (`#persistOAuthResult` semantics), then the same reload finish. The browser
 *   URL and manual-code paste-back ride the EXISTING `extension_ui_request`
 *   `open_url`/`input` frames via the injected {@link RpcMcpOAuthUi}; the TUI's
 *   `editor.onEscape` hook is replaced by an AbortController claimed at the
 *   module level (`mcp_reauth_cancel`). A second reauth claimed while one is in
 *   flight throws {@link RpcMcpReauthBusyError} (envelope `code:"oauth_busy"`).
 *
 * Cancellation mirrors `MCPOAuthCancelledError` with a local class: importing
 * the TUI's from mcp-command-controller.ts would drag pi-tui component deps
 * into the RPC path.
 */
import * as path from "node:path";
import { getMCPConfigPath, logger } from "@oh-my-pi/pi-utils";
import { expandEnvVarsDeep } from "../../discovery/helpers";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	MCPManager,
	type OAuthEndpoints,
} from "../../mcp";
import { connectToServer, disconnectServer, listTools } from "../../mcp/client";
import { validateServerConfig } from "../../mcp/config";
import { addMCPServer, readMCPConfigFile, updateMCPServer } from "../../mcp/config-writer";
import { lookupMcpOAuthCredentialForServer, removeManagedMcpOAuthCredential } from "../../mcp/oauth-credentials";
import { MCPOAuthFlow, type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "../../mcp/oauth-flow";
import type { MCPAuthConfig, MCPServerConfig, MCPServerConnection } from "../../mcp/types";
import type { AgentSession } from "../../session/agent-session";
import { buildRpcMcpServersResult } from "./rpc-domains";
import type {
	RpcMcpAddResult,
	RpcMcpReauthCancelResult,
	RpcMcpReauthResult,
	RpcMcpServerInput,
	RpcMcpTestResult,
} from "./rpc-types";

const MCP_TEST_TIMEOUT_MS = 30_000;
const MCP_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, onTimeout?: () => void): Promise<T> {
	const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => {
		onTimeout?.();
		reject(new Error(message));
	}, timeoutMs);
	return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function raceAbortSignal<T>(promise: Promise<T>, signal: AbortSignal, createError: () => Error): Promise<T> {
	if (signal.aborted) return Promise.reject(createError());

	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => aborted.reject(createError());
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted.promise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

/** Map the wire config form onto the on-disk MCPServerConfig shape. */
export function rpcMcpInputToServerConfig(input: RpcMcpServerInput): MCPServerConfig {
	const timeout = input.timeoutMs !== undefined ? { timeout: input.timeoutMs } : {};
	switch (input.transport) {
		case "stdio":
			return {
				type: "stdio",
				command: input.command ?? "",
				...(input.args ? { args: input.args } : {}),
				...(input.env ? { env: input.env } : {}),
				...timeout,
			};
		case "http":
			return {
				type: "http",
				url: input.url ?? "",
				...(input.headers ? { headers: input.headers } : {}),
				...timeout,
			};
		case "sse":
			return {
				type: "sse",
				url: input.url ?? "",
				...(input.headers ? { headers: input.headers } : {}),
				...timeout,
			};
		default:
			// Wire frames are cast, not shape-validated — a transport outside the
			// declared union must fail loudly instead of returning undefined.
			throw new Error(`Unsupported transport: ${input.transport}`);
	}
}

/**
 * Module-level serialization chain for shared-MCPManager mutations initiated
 * by RPC management commands. `mcp_reauth` is background-dispatched, so its
 * reload finish can otherwise interleave with mcp_add/mcp_action: connections
 * resolving after a concurrent disconnectAll are dropped unclosed
 * (manager.ts connect guard), and overlapping discoveries double-connect.
 * Only runtime-manager mutation is serialized — config-file writes and the
 * browser OAuth flow stay outside — so mcp_reauth_cancel can still overtake an
 * in-flight login.
 */
let mcpReloadChain: Promise<void> = Promise.resolve();

/** Run `reload` after every previously chained manager mutation settles. The chain itself never rejects. */
export function serializeMcpReload<T>(reload: () => Promise<T>): Promise<T> {
	const result = mcpReloadChain.then(reload, reload);
	mcpReloadChain = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

/**
 * The reloadServers-equivalent finish every MCP mutation ends in, mirrored
 * from rpc-actions.ts (`mcp_action` remove): full disconnect, prompt-command
 * reset, rediscovery with the startup settings-derived filters, then a runtime
 * tool rebind.
 */
async function reloadRpcMcpServers(session: AgentSession): Promise<void> {
	await serializeMcpReload(async () => {
		const manager = MCPManager.instance();
		if (manager) {
			await manager.disconnectAll();
			// Prompt enrichment is asynchronous. Clear commands before rediscovery so
			// removed/disabled servers cannot leave stale `/server:prompt` entries.
			session.setMCPPromptCommands([]);
			await manager.discoverAndConnect({
				enableProjectConfig: session.settings.get("mcp.enableProjectConfig") ?? true,
				filterExa: true,
				filterBrowser: session.settings.get("browser.enabled") ?? false,
			});
		}
		await session.refreshMCPTools(manager?.getTools() ?? []);
	});
}

// ============================================================================
// mcp_add
// ============================================================================

/**
 * Add an MCP server to a config file and bring the runtime state up to date.
 * Throws on validation/persistence failures (they ride the envelope
 * `success:false` — the result shape has no error channel).
 */
export async function applyRpcMcpAdd(
	session: AgentSession,
	name: string,
	input: RpcMcpServerInput,
	scope?: "user" | "project",
): Promise<RpcMcpAddResult> {
	if (!name.trim()) throw new Error("Server name cannot be empty");
	const cwd = session.sessionManager.getCwd();
	const config = rpcMcpInputToServerConfig(input);
	const filePath = getMCPConfigPath(scope ?? "project", cwd);
	// Locked atomic write with validateServerName/validateServerConfig parity
	// (names may contain `:` for plugin-namespaced servers).
	await addMCPServer(filePath, name, config);

	// The serialized full reload is the only shared-manager mutation here.
	// A targeted connect immediately before disconnectAll was redundant and
	// could itself race a background reauth reload.
	await reloadRpcMcpServers(session);

	const { servers } = await buildRpcMcpServersResult(session);
	const server = servers.find(entry => entry.name === name);
	if (!server) {
		throw new Error(`Server "${name}" was added but is not visible in the refreshed server list.`);
	}
	return { added: true, server };
}

// ============================================================================
// mcp_test
// ============================================================================

/**
 * Find a configured server for probing. Mirrors `getMcpConfiguredServers`
 * (slash-commands/helpers/mcp.ts): project config shadows user config and
 * disabled servers are invisible to `/mcp test`.
 */
async function findRpcMcpTestTarget(cwd: string, name: string): Promise<MCPServerConfig | undefined> {
	const [userConfig, projectConfig] = await Promise.all([
		readMCPConfigFile(getMCPConfigPath("user", cwd)),
		readMCPConfigFile(getMCPConfigPath("project", cwd)),
	]);
	const projectHit = projectConfig.mcpServers?.[name];
	if (projectHit && projectHit.enabled !== false) return projectHit;
	const userHit = userConfig.mcpServers?.[name];
	if (userHit && userHit.enabled !== false) return userHit;
	return undefined;
}

async function probeRpcMcpServer(
	session: AgentSession,
	cwd: string,
	probeName: string,
	serverConfig: MCPServerConfig,
	signal: AbortSignal,
): Promise<RpcMcpTestResult> {
	let connection: MCPServerConnection | undefined;
	try {
		// THROWAWAY manager, NEVER MCPManager.instance(): the probe must not
		// touch the shared connection pool (mirrors withPreparedMcpConnection).
		const manager = new MCPManager(cwd);
		// Auth storage must be wired in before prepareConfig so OAuth-backed
		// servers can refresh credentials and inject Authorization headers.
		manager.setAuthStorage(session.modelRegistry.authStorage);
		const resolvedConfig = await manager.prepareConfig(serverConfig);
		connection = await connectToServer(probeName, resolvedConfig, { signal });
		const tools = await listTools(connection, { signal });
		return { ok: true, toolNames: tools.map(tool => tool.name), toolCount: tools.length };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		if (connection) {
			// Await cleanup so the stdio subprocess / HTTP DELETE has actually
			// released the resource before this probe returns (withPreparedMcpConnection).
			try {
				await disconnectServer(connection);
			} catch (error) {
				logger.warn("MCP disconnect after temporary connection failed", { name: probeName, error });
			}
		}
	}
}

/**
 * Probe an MCP server by name (from user/project config files) or by inline
 * config. Never throws: every outcome rides the result's `ok`/`error` fields.
 * Not side-effect free (may spawn stdio, may refresh OAuth tokens).
 */
export async function applyRpcMcpTest(
	session: AgentSession,
	name: string | undefined,
	input: RpcMcpServerInput | undefined,
): Promise<RpcMcpTestResult> {
	if ((name === undefined) === (input === undefined)) {
		return { ok: false, error: "Provide exactly one of `name` (configured server) or `config` (inline definition)." };
	}
	const cwd = session.sessionManager.getCwd();
	let serverConfig: MCPServerConfig;
	let probeName: string;
	if (name !== undefined) {
		const found = await findRpcMcpTestTarget(cwd, name);
		if (!found) {
			return { ok: false, error: `Server "${name}" not found. Run get_mcp_servers to see configured servers.` };
		}
		serverConfig = found;
		probeName = name;
	} else {
		serverConfig = rpcMcpInputToServerConfig(input!);
		const validationErrors = validateServerConfig("test", serverConfig);
		if (validationErrors.length > 0) {
			return { ok: false, error: `Invalid server config: ${validationErrors.join("; ")}` };
		}
		probeName = `mcp_test_${Date.now()}`;
	}
	const timeout = new AbortController();
	try {
		return await withTimeout(
			probeRpcMcpServer(session, cwd, probeName, serverConfig, timeout.signal),
			MCP_TEST_TIMEOUT_MS,
			`Connection test timed out after ${MCP_TEST_TIMEOUT_MS / 1000} seconds`,
			() => timeout.abort("MCP connection test timed out"),
		);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

// ============================================================================
// mcp_reauth / mcp_reauth_cancel
// ============================================================================

/**
 * UI bridge the OAuth flow drives: the browser URL rides the EXISTING
 * `extension_ui_request method:"open_url"` frame (the login command's emission
 * pattern), progress rides `notify`, and the manual code paste-back rides the
 * EXISTING `method:"input"` dialog plumbing.
 */
export interface RpcMcpOAuthUi {
	openUrl(info: { url: string; launchUrl?: string; instructions?: string }): void;
	notify(message: string): void;
	/**
	 * `signal` is the reauth cancel channel: aborting dismisses the remote
	 * input dialog (method:"cancel" frame) and resolves the pending extension
	 * request instead of leaking it.
	 */
	input(title: string, placeholder?: string, signal?: AbortSignal): Promise<string | undefined>;
}

/** Refused concurrency: a second mcp_reauth claimed while one is in flight. */
export class RpcMcpReauthBusyError extends Error {
	readonly code = "oauth_busy";
	constructor(activeName: string) {
		super(
			`MCP OAuth reauthorization already in progress for "${activeName}". Complete or cancel it before starting another.`,
		);
		this.name = "RpcMcpReauthBusyError";
	}
}

/** Local mirror of the TUI's MCPOAuthCancelledError (see module docstring). */
class RpcMcpOAuthCancelledError extends Error {
	constructor(message = "OAuth flow cancelled") {
		super(message);
		this.name = "RpcMcpOAuthCancelledError";
	}
}

type ActiveReauth = { name: string; abort: AbortController };
/**
 * Module-level single-claim mutex: exactly one mcp_reauth in flight per RPC
 * process (NOT a queue — a concurrent claim throws RpcMcpReauthBusyError).
 * The AbortController replaces the TUI's `editor.onEscape` cancel hook.
 */
let activeReauth: ActiveReauth | undefined;

/**
 * RPC-local equivalent of the TUI's process-global oauthManualInput claim
 * (mcp-command-controller.ts:784-789): at most one MCP manual-code prompt
 * outstanding. The claim's promise is driven by the `input` dialog bridge.
 */
type RpcManualInputClaim = { promise: Promise<string>; clear: (reason?: string) => void };
let pendingManualInput: { reject: (error: Error) => void } | undefined;

function tryClaimRpcManualInput(ui: RpcMcpOAuthUi, signal?: AbortSignal): RpcManualInputClaim | undefined {
	if (pendingManualInput) return undefined;
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const pending = { reject };
	pendingManualInput = pending;
	const claim: RpcManualInputClaim = {
		promise,
		clear: (reason = "Manual MCP OAuth input cleared") => {
			if (pendingManualInput !== pending) return;
			pendingManualInput = undefined;
			reject(new Error(reason));
		},
	};
	void ui.input("MCP OAuth authorization", "Paste the authorization code (or full redirect URL):", signal).then(
		value => {
			if (pendingManualInput !== pending) return;
			pendingManualInput = undefined;
			// Dialog dismissed without a value: treat as a user cancel, matching
			// the TUI's neutral-cancel semantics rather than a flow failure.
			if (value === undefined) reject(new RpcMcpOAuthCancelledError());
			else resolve(value);
		},
		error => {
			if (pendingManualInput !== pending) return;
			pendingManualInput = undefined;
			reject(error instanceof Error ? error : new Error(String(error)));
		},
	);
	return claim;
}

/** Test-only: drop in-flight reauth/manual-input state between tests. */
export function resetRpcMcpOAuthStateForTests(): void {
	activeReauth = undefined;
	pendingManualInput = undefined;
}

/**
 * Mirror of `#findConfiguredServer`: writable user/project config files first,
 * then the standalone `mcp.json`/`.mcp.json` fallbacks in the project root
 * (the mcp-json provider's discovery paths; mcp.json wins on a same-name hit).
 */
async function findRpcConfiguredServer(
	cwd: string,
	name: string,
): Promise<{ filePath: string; scope: "user" | "project"; config: MCPServerConfig } | null> {
	const userPath = getMCPConfigPath("user", cwd);
	const projectPath = getMCPConfigPath("project", cwd);
	const [userConfig, projectConfig] = await Promise.all([readMCPConfigFile(userPath), readMCPConfigFile(projectPath)]);
	if (userConfig.mcpServers?.[name]) {
		return { filePath: userPath, scope: "user", config: userConfig.mcpServers[name] };
	}
	if (projectConfig.mcpServers?.[name]) {
		return { filePath: projectPath, scope: "project", config: projectConfig.mcpServers[name] };
	}
	const standalonePaths = [path.join(cwd, "mcp.json"), path.join(cwd, ".mcp.json")];
	const fallbackConfigs = await Promise.all(
		standalonePaths.map(async standalonePath => {
			try {
				return await readMCPConfigFile(standalonePath);
			} catch {
				// Malformed JSON in a standalone file — skip and continue lookup.
				return null;
			}
		}),
	);
	for (const [index, fallbackConfig] of fallbackConfigs.entries()) {
		const config = fallbackConfig?.mcpServers?.[name];
		if (config) {
			return { filePath: standalonePaths[index]!, scope: "project", config };
		}
	}
	return null;
}

/**
 * Mirror of `#resolveServerForAuth`: also recognizes runtime-discovered
 * servers that live in no writable config (Claude Code marketplace plugins,
 * `.cursor/mcp.json`, …). Persisted changes for those write into the *user*
 * config under the same (possibly `:`-namespaced) name so the native provider
 * shadows the discovered entry on the next reload.
 */
async function resolveRpcServerForAuth(
	cwd: string,
	name: string,
): Promise<{ filePath: string; scope: "user" | "project"; config: MCPServerConfig; discovered: boolean } | null> {
	const found = await findRpcConfiguredServer(cwd, name);
	if (found) return { ...found, discovered: false };

	const manager = MCPManager.instance();
	const config = manager?.getServerConfig(name);
	const source = manager?.getSource(name);
	if (!config || !source) return null;

	return {
		filePath: getMCPConfigPath("user", cwd),
		scope: "user",
		config,
		discovered: true,
	};
}

function stripRpcOAuthAuth(config: MCPServerConfig): MCPServerConfig {
	const next = { ...config } as MCPServerConfig & { auth?: MCPAuthConfig };
	delete next.auth;
	return next;
}

/**
 * Mirror of `#handleTestConnection`: connect once with the shared manager's
 * auth resolution (or a throwaway manager when none is running), then
 * disconnect immediately.
 */
async function testRpcMcpConnection(
	session: AgentSession,
	config: MCPServerConfig,
	options?: { oauth?: boolean },
): Promise<void> {
	const testName = `test_${Date.now()}`;
	const manager = MCPManager.instance();
	let resolvedConfig: MCPServerConfig;
	if (manager) {
		resolvedConfig = await manager.prepareConfig(config, options);
	} else {
		const tempManager = new MCPManager(session.sessionManager.getCwd());
		tempManager.setAuthStorage(session.modelRegistry.authStorage);
		resolvedConfig = await tempManager.prepareConfig(config, options);
	}
	const connection = await connectToServer(testName, resolvedConfig);
	await disconnectServer(connection);
}

/**
 * Mirror of `#resolveOAuthEndpointsFromServer` (without the tool-level
 * authChallenge path — RPC reauth is always user-initiated).
 */
async function resolveRpcOAuthEndpointsFromServer(
	session: AgentSession,
	config: MCPServerConfig,
): Promise<OAuthEndpoints> {
	// Stdio servers manage credentials inside the child process; OMP's OAuth
	// flow only applies to http/sse transports.
	if (config.type !== "http" && config.type !== "sse") {
		const remoteUrl = config.args?.find(arg => /^https?:\/\//.test(arg));
		const httpHint = `{ "type": "http", "url": ${JSON.stringify(remoteUrl ?? "<remote url>")} }`;
		const usesMcpRemote = [config.command, ...(config.args ?? [])].some(part => part?.includes("mcp-remote"));
		throw new Error(
			usesMcpRemote
				? `this server proxies OAuth through mcp-remote, which caches tokens machine-wide in ~/.mcp-auth (shared across every OMP profile). Clear ~/.mcp-auth to force a fresh login, or replace the proxy with ${httpHint} so OMP manages OAuth per profile.`
				: `stdio servers manage their own credentials, so OMP has no OAuth to reauthorize. If the service supports OAuth over HTTP, configure it as ${httpHint} instead.`,
		);
	}
	// First test whether the server actually needs auth by connecting without OAuth.
	let connectionError: Error | undefined;
	try {
		await testRpcMcpConnection(session, stripRpcOAuthAuth(config), { oauth: false });
	} catch (error) {
		connectionError = error as Error;
	}
	if (!connectionError) {
		throw new Error("Server connection succeeded without OAuth; reauthorization is not required.");
	}

	const authResult = analyzeAuthError(connectionError, config.url);
	let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;

	if (!oauth && config.url) {
		oauth = await discoverOAuthEndpoints(config.url, authResult.authServerUrl, authResult.resourceMetadataUrl, {
			protectedScopes: authResult.scopes,
		});
	}
	if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
		// JSON-error-body path skips `discoverOAuthEndpoints`; fetch the
		// advertised protected-resource metadata for the required scopes.
		const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
		if (scopes) oauth = { ...oauth, scopes };
	}

	if (!oauth) {
		throw new Error("Could not discover OAuth endpoints from server response.");
	}

	return oauth;
}

/**
 * Mirror of `#persistOAuthResult`: the auth block records the credential
 * pointer plus refresh material, the oauth block echoes the client id for
 * pre-auth reuse, and only a user-supplied client secret is ever written —
 * DCR-issued secrets stay embedded in the stored credential. `config` is the
 * raw on-disk value, so `${ENV}` placeholders are preserved verbatim.
 */
function persistRpcOAuthResult(
	config: MCPServerConfig,
	result: { credentialId: string; clientId?: string; resource?: string },
	opts: {
		tokenUrl: string;
		resource?: string;
		stripSameOriginResource?: boolean;
		clientId?: string;
		userClientSecret?: string;
	},
): MCPServerConfig {
	const clientId = result.clientId ?? opts.clientId ?? config.oauth?.clientId;
	const resource =
		result.resource ?? (opts.stripSameOriginResource ? undefined : opts.resource) ?? config.auth?.resource;
	return {
		...config,
		auth: {
			type: "oauth",
			credentialId: result.credentialId,
			tokenUrl: opts.tokenUrl,
			clientId,
			clientSecret: opts.userClientSecret,
			resource,
		},
		oauth: {
			...config.oauth,
			clientId,
		},
	};
}

/**
 * Drive `MCPOAuthFlow` (PKCE+DCR via OAuthCallbackFlow.login) with RPC UI
 * bridges. Mirror of `#handleOAuthFlow`: 5-minute timeout raced against the
 * abort signal, credential persisted to auth storage with embedded refresh
 * material. The external signal is the cancel channel (mcp_reauth_cancel);
 * its abort maps to {@link RpcMcpOAuthCancelledError}, never a failure.
 */
async function runRpcMcpOAuthFlow(
	session: AgentSession,
	ui: RpcMcpOAuthUi,
	authUrl: string,
	tokenUrl: string,
	clientId: string,
	clientSecret: string,
	scopes: string,
	opts: {
		registrationUrl?: string;
		prompt?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
		resource?: string;
		stripSameOriginResource?: boolean;
		serverUrl?: string;
		externalSignal: AbortSignal;
	},
): Promise<{ credentialId: string; clientId?: string; resource?: string }> {
	const authStorage = session.modelRegistry.authStorage;
	let parsedAuthUrl: URL;

	// Validate OAuth URLs
	try {
		parsedAuthUrl = new URL(authUrl);
		new URL(tokenUrl);
	} catch {
		throw new Error(`Invalid OAuth URLs. Please check:\n  Authorization URL: ${authUrl}\n  Token URL: ${tokenUrl}`);
	}

	const resolvedClientId = clientId.trim() || parsedAuthUrl.searchParams.get("client_id") || undefined;
	const resolvedClientSecret = clientSecret.trim() || undefined;

	if (pendingManualInput) {
		throw new Error(
			"OAuth login already in progress for another provider. Complete or cancel it before starting MCP OAuth.",
		);
	}
	let manualInputClaim: RpcManualInputClaim | undefined;
	const oauthTimeout = new AbortController();
	// External cancels and the timeout path both abort; the flag distinguishes
	// "user cancelled" (neutral result) from "deadline elapsed" (error).
	let userCancelled = false;
	const requestUserCancel = (reason: string): void => {
		userCancelled = true;
		if (!oauthTimeout.signal.aborted) oauthTimeout.abort(reason);
	};
	const externalSignal = opts.externalSignal;
	const onExternalAbort = (): void => {
		const reason = externalSignal.reason;
		requestUserCancel(typeof reason === "string" ? reason : "MCP OAuth flow cancelled");
	};
	if (externalSignal.aborted) {
		onExternalAbort();
	} else {
		externalSignal.addEventListener("abort", onExternalAbort, { once: true });
	}
	try {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: authUrl,
				tokenUrl,
				registrationUrl: opts.registrationUrl,
				clientId: resolvedClientId,
				clientSecret: resolvedClientSecret,
				scopes: scopes || undefined,
				prompt: opts.prompt,
				redirectUri: opts.redirectUri,
				callbackPort: opts.callbackPort,
				callbackPath: opts.callbackPath,
				resource: opts.resource,
				stripSameOriginResource: opts.stripSameOriginResource,
			},
			{
				onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
					ui.openUrl(info);
				},
				onProgress: (message: string) => {
					ui.notify(message);
				},
				onManualCodeInput: () => {
					if (manualInputClaim) return manualInputClaim.promise;
					const claim = tryClaimRpcManualInput(ui, externalSignal);
					if (!claim) {
						throw new Error(
							"OAuth login already in progress for another provider. Complete or cancel it before starting MCP OAuth.",
						);
					}
					manualInputClaim = claim;
					return claim.promise;
				},
				signal: oauthTimeout.signal,
			},
		);

		const createAbortError = (): Error => {
			const reason = String(oauthTimeout.signal.reason ?? "MCP OAuth flow aborted");
			return userCancelled ? new RpcMcpOAuthCancelledError() : new Error(reason);
		};
		if (oauthTimeout.signal.aborted) throw createAbortError();

		// Execute the OAuth flow with a 5 minute timeout. Race the login itself
		// against the abort signal because a cancel may fire before MCPOAuthFlow
		// reaches OAuthCallbackFlow.#waitForCallback, where the underlying
		// callback server normally observes the signal.
		const credentials = await withTimeout(
			raceAbortSignal(flow.login(), oauthTimeout.signal, createAbortError),
			MCP_OAUTH_TIMEOUT_MS,
			"OAuth flow timed out after 5 minutes",
			() => oauthTimeout.abort("MCP OAuth flow timed out"),
		);

		// Deterministic per-URL id: every profile resolves its own credential row
		// under the same key, so shared project configs stay profile-isolated.
		// Random fallback only for flows that never knew the server URL.
		const credentialId = opts.serverUrl
			? mcpOAuthCredentialId(opts.serverUrl)
			: `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

		// Embed refresh material so the credential is self-contained: token
		// refresh must work for configs that carry no auth block at all.
		const oauthCredential: MCPStoredOAuthCredential = {
			type: "oauth",
			...credentials,
			tokenUrl,
			clientId: flow.resolvedClientId ?? resolvedClientId,
			clientSecret: flow.registeredClientSecret ?? resolvedClientSecret,
			resource: flow.resource,
			authorizationUrl: flow.authorizationUrl,
		};

		await authStorage.set(credentialId, oauthCredential);

		return {
			credentialId,
			clientId: flow.resolvedClientId,
			resource: flow.resource,
		};
	} catch (error) {
		// User-initiated cancel (external signal or dismissed manual input) →
		// neutral result, not a failure.
		if (userCancelled || error instanceof RpcMcpOAuthCancelledError) {
			throw new RpcMcpOAuthCancelledError();
		}

		const errorMsg = error instanceof Error ? error.message : String(error);
		if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
			throw new Error("OAuth flow timed out. Please try again.");
		} else if (errorMsg.includes("403") || errorMsg.includes("unauthorized")) {
			throw new Error("OAuth authorization failed. Please check your client credentials.");
		} else if (errorMsg.includes("invalid_grant")) {
			throw new Error("OAuth authorization code is invalid or expired. Please try again.");
		} else if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("fetch failed")) {
			throw new Error("Could not connect to OAuth server. Please check the URLs and your network connection.");
		}
		throw new Error(`OAuth authentication failed: ${errorMsg}`);
	} finally {
		externalSignal.removeEventListener("abort", onExternalAbort);
		manualInputClaim?.clear("Manual MCP OAuth input cleared");
	}
}

async function runRpcMcpReauth(
	session: AgentSession,
	name: string,
	ui: RpcMcpOAuthUi,
	signal: AbortSignal,
): Promise<RpcMcpReauthResult> {
	const cwd = session.sessionManager.getCwd();
	const found = await resolveRpcServerForAuth(cwd, name);
	if (!found) {
		throw new Error(`Server "${name}" not found.`);
	}
	if (found.config.enabled === false) {
		throw new Error(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
	}

	const authStorage = session.modelRegistry.authStorage;
	const currentAuth = (found.config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
	const baseConfig = stripRpcOAuthAuth(found.config);
	const runtimeBaseConfig = expandEnvVarsDeep(baseConfig);
	// Resolve endpoints first: this fails fast for stdio transports and probes
	// http/sse with { oauth: false }, so nothing destructive has happened yet
	// if the server turns out not to need (or support) OAuth. Use the same
	// env-expanded config shape runtime discovery passes to MCPManager; the raw
	// file value may contain `${...}` placeholders.
	const oauth = await resolveRpcOAuthEndpointsFromServer(session, runtimeBaseConfig);
	const serverUrl =
		runtimeBaseConfig.type === "http" || runtimeBaseConfig.type === "sse" ? runtimeBaseConfig.url : undefined;
	// Client credentials drive the token exchange, so they must come from the
	// env-expanded runtime config; `found.config`/`currentAuth` may still hold
	// `${...}` placeholders. DCR secrets are embedded in the stored credential
	// and never echoed back into config files.
	const runtimeAuth = currentAuth ? expandEnvVarsDeep(currentAuth) : undefined;
	const configuredClientId = runtimeBaseConfig.oauth?.clientId ?? runtimeAuth?.clientId;
	const existingCredential = lookupMcpOAuthCredentialForServer(authStorage, currentAuth, serverUrl)?.credential;
	const flowClientId = oauth.clientId ?? configuredClientId ?? existingCredential?.clientId ?? "";
	const storedClientSecret =
		existingCredential?.clientId === flowClientId ? existingCredential.clientSecret : undefined;
	const flowClientSecret =
		runtimeBaseConfig.oauth?.clientSecret ?? runtimeAuth?.clientSecret ?? storedClientSecret ?? "";
	// Persisted separately below: keep the raw `${...}` placeholder in the file
	// rather than writing the resolved secret back to (possibly shared) config.
	const userClientSecret = found.config.oauth?.clientSecret ?? currentAuth?.clientSecret;

	const currentAuthResource = currentAuth?.resource ? expandEnvVarsDeep(currentAuth.resource) : undefined;
	const oauthResource =
		oauth.resource ?? currentAuthResource ?? ("url" in runtimeBaseConfig ? runtimeBaseConfig.url : undefined);
	const oauthResourceIsFallback = !oauth.resource && !currentAuthResource;

	const oauthResult = await runRpcMcpOAuthFlow(
		session,
		ui,
		oauth.authorizationUrl,
		oauth.tokenUrl,
		flowClientId,
		flowClientSecret,
		oauth.scopes ?? "",
		{
			callbackPort: found.config.oauth?.callbackPort,
			callbackPath: found.config.oauth?.callbackPath,
			redirectUri: found.config.oauth?.redirectUri,
			prompt: found.config.oauth?.prompt,
			registrationUrl: oauth.registrationUrl,
			serverUrl,
			resource: oauthResource,
			stripSameOriginResource: oauthResourceIsFallback,
			externalSignal: signal,
		},
	);

	// The flow overwrote (or minted) this profile's row; a superseded pointer
	// row from the legacy random-id era is now orphaned. GC only after success
	// so cancelling the browser step leaves the previous session signed in.
	if (currentAuth?.type === "oauth" && currentAuth.credentialId !== oauthResult.credentialId) {
		await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
	}

	// Definition-only entries resolve through the url-keyed binding alone; skip
	// the write-back so a committed project mcp.json stays clean.
	const urlKeyedId = serverUrl ? mcpOAuthCredentialId(serverUrl) : undefined;
	const shouldPersist = currentAuth || oauthResult.credentialId !== urlKeyedId;
	const updatedConfig = shouldPersist
		? persistRpcOAuthResult(baseConfig, oauthResult, {
				tokenUrl: oauth.tokenUrl,
				clientId: oauth.clientId,
				userClientSecret,
				resource: oauthResource,
				stripSameOriginResource: oauthResourceIsFallback,
			})
		: baseConfig;
	if (shouldPersist) {
		await updateMCPServer(found.filePath, name, updatedConfig);
	}

	// Same reload finish as mcp_add.
	await reloadRpcMcpServers(session);
	return { ok: true };
}

/**
 * Re-drive OAuth authorization for an MCP server. Claims the module-level
 * mutex synchronously on entry — a concurrent claim rejects with
 * {@link RpcMcpReauthBusyError}. Resolves ONLY after login + persist (raw
 * `${ENV}` placeholders preserved) + the MCP reload finish completes; user
 * cancellation resolves `{ ok:false, error:"cancelled" }` and every other
 * failure rides `{ ok:false, error }`.
 */
export async function applyRpcMcpReauth(
	session: AgentSession,
	name: string,
	ui: RpcMcpOAuthUi,
): Promise<RpcMcpReauthResult> {
	if (!name.trim()) throw new Error("Server name cannot be empty");
	if (activeReauth) throw new RpcMcpReauthBusyError(activeReauth.name);
	const abort = new AbortController();
	activeReauth = { name, abort };
	try {
		return await runRpcMcpReauth(session, name, ui, abort.signal);
	} catch (error) {
		if (error instanceof RpcMcpOAuthCancelledError) return { ok: false, error: "cancelled" };
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		if (activeReauth?.abort === abort) activeReauth = undefined;
	}
}

/**
 * Abort an in-flight reauth (replaces the TUI's `editor.onEscape` hook).
 * `cancelled:false` when no reauth for that name is in flight.
 */
export function applyRpcMcpReauthCancel(name: string): RpcMcpReauthCancelResult {
	if (!activeReauth || activeReauth.name !== name) return { cancelled: false };
	activeReauth.abort.abort("Reauthorization cancelled by user");
	return { cancelled: true };
}
