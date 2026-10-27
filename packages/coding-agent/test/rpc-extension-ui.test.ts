import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	type PendingExtensionRequest,
	reportDroppedPrompt,
	type RpcExtensionUIResponse,
	requestRpcAskDialog,
	requestRpcDialog,
	requestRpcSelect,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

function requireRequest(frame: object | undefined): { id: string } {
	if (!frame || !("id" in frame)) {
		throw new Error("Expected the RPC dialog request to carry an id");
	}
	const id = frame.id;
	if (typeof id !== "string") throw new Error("Expected the RPC dialog request id to be a string");
	return { id };
}

function respond(pendingRequests: Map<string, PendingExtensionRequest>, id: string, payload: object): void {
	const request = pendingRequests.get(id);
	if (!request) throw new Error(`Expected pending RPC dialog request ${id}`);
	request.resolve({ type: "extension_ui_response", id, ...payload } as RpcExtensionUIResponse);
}

async function startStartupDialogFixture(temp: TempDir): Promise<Bun.Subprocess<"pipe", "pipe", "pipe">> {
	const extensionPath = temp.join("startup.mjs");
	await Bun.write(
		extensionPath,
		`
export default function(pi) {
  globalThis.fetch = async () => { throw new Error("Offline startup fixture refuses network"); };
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (await ctx.ui.confirm("Startup confirmation", "Continue initialization?")) {
        const name = await ctx.ui.input("Startup name");
        await pi.setSessionName(name);
      }
    } catch (error) {
      // Even a fresh dialog after disconnect must fail rather than pausing
      // the extension's timeout forever.
      await ctx.ui.select("Disconnected startup", ["Retry"]);
      throw error;
    }
  });
}
`,
	);
	return Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "..", "src", "cli.ts"),
			"--trusted-extension",
			extensionPath,
			"--mode",
			"rpc",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd: temp.path(),
			env: {
				PATH: Bun.env.PATH,
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				CI: "true",
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		},
	);
}

const dbQuestion: ExtensionAskDialogQuestion = {
	id: "db",
	question: "Which database?",
	options: [{ label: "Postgres" }, { label: "SQLite", description: "Embedded" }],
	recommended: 1,
};
const featuresQuestion: ExtensionAskDialogQuestion = {
	id: "features",
	question: "Which features?",
	options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
	multi: true,
};

/**
 * Scripted model: a user message ending in ask arguments as JSON becomes an ask call (omp may prepend
 * context to the first user message); a tool result ends the turn.
 */
const scriptedAskProvider = `
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";

export default function (pi) {
	pi.registerProvider("scripted", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "scripted-key",
		api: "scripted-ask",
		models: [{
			id: "ask",
			name: "Scripted ask",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 1024,
		}],
		streamSimple: (model, context) => {
			const stream = createAssistantMessageEventStream();
			const last = context.messages.findLast(entry => entry.role === "user" || entry.role === "toolResult");
			const text = last?.role === "user" ? last.content.map(part => part.text ?? "").join("") : "";
			const argsAt = text.indexOf('{"questions"');
			const message = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				timestamp: Date.now(),
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			};
			stream.push({ type: "start", partial: message });
			if (argsAt >= 0) {
				const toolCall = { type: "toolCall", id: "ask-" + context.messages.length, name: "ask", arguments: JSON.parse(text.slice(argsAt)) };
				message.content = [toolCall];
				message.stopReason = "toolUse";
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
			}
			stream.push({ type: "done", reason: message.stopReason, message });
			return stream;
		},
	});
}
`;

describe("RPC extension UI", () => {
	it("answers startup dialogs before ready and gates queued commands and negotiation until initialization completes", async () => {
		await using temp = await TempDir.create("@rpc-startup-ui-");
		const child = await startStartupDialogFixture(temp);
		const stderr = new Response(child.stderr).text();
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		const observed: string[] = [];
		let state: unknown;
		try {
			// Both arrive before session_start finishes; negotiation must not change
			// the framing advertised by ready or let ordinary commands race init.
			await send({ type: "negotiate_protocol", protocolVersion: 2, id: "negotiate" });
			await send({ type: "get_state", id: "early-state" });
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "extension_ui_request" && frame.method === "confirm") {
					observed.push("confirm");
					await send({ type: "extension_ui_response", id: frame.id, confirmed: true });
				} else if (frame.type === "extension_ui_request" && frame.method === "input") {
					observed.push("input");
					await send({ type: "extension_ui_response", id: frame.id, value: "initialized-by-host" });
				} else if (frame.type === "ready") {
					observed.push("ready");
					expect(frame.protocolVersion).toBe(1);
				} else if (frame.type === "response" && frame.id === "negotiate") {
					observed.push("negotiate");
					expect(frame).toMatchObject({ success: true, data: { protocolVersion: 2 } });
				} else if (frame.type === "response" && frame.id === "early-state") {
					observed.push("state");
					state = frame;
					child.stdin.end();
				}
			}
			expect(await child.exited).toBe(0);
			expect(observed).toEqual(["confirm", "input", "ready", "negotiate", "state"]);
			expect(state).toMatchObject({ success: true, data: { sessionName: "initialized-by-host" } });
		} finally {
			child.kill();
			await child.exited;
			await stderr;
		}
	}, 30_000);

	it("settles active and subsequent startup dialogs when stdin disconnects instead of wedging initialization", async () => {
		await using temp = await TempDir.create("@rpc-startup-disconnect-");
		const child = await startStartupDialogFixture(temp);
		const stderr = new Response(child.stderr).text();
		let disconnected = false;
		let extensionError: unknown;
		try {
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "extension_ui_request" && frame.method === "confirm") {
					disconnected = true;
					child.stdin.end();
				} else if (frame.type === "extension_error") {
					extensionError = frame;
				}
			}
			expect(disconnected).toBe(true);
			expect(await child.exited).toBe(0);
			expect(extensionError).toMatchObject({
				event: "session_start",
				error: expect.stringContaining("RPC client disconnected"),
			});
		} finally {
			child.kill();
			await child.exited;
			await stderr;
		}
	}, 30_000);

	it("returns a dropped prompt and its images to the host editor", () => {
		const output = vi.fn<(frame: object) => void>();

		reportDroppedPrompt(output, {
			text: "keep my exact prompt",
			images: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
		});

		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: expect.any(String),
			method: "set_editor_text",
			text: "keep my exact prompt",
			images: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
			prepend: true,
		});
	});

	it("keeps extension dialogs headless while tool selections round-trip", async () => {
		await using temp = await TempDir.create("@rpc-headless-tool-ui-");
		const fixturePath = temp.join("runtime.ts");
		const sourceDir = path.resolve(import.meta.dir, "../src");
		await Bun.write(
			fixturePath,
			`
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
globalThis.fetch = async () => { throw new Error("Offline UI fixture refuses network"); };
let extensionState;
const { session } = await createAgentSession({
  cwd: process.cwd(),
  toolNames: [],
  enableMCP: false,
  enableLsp: false,
  disableExtensionDiscovery: true,
  settings: Settings.isolated({ "compaction.enabled": false }),
  extensions: [pi => {
    pi.on("session_start", async (_event, ctx) => {
      const confirmed = await ctx.ui.confirm("Extension confirm", "Must not reach the host");
      ctx.ui.notify("Extension notification");
      extensionState = { hasUI: ctx.hasUI, confirmed };
    });
  }],
});
await runRpcMode(session, {
  headless: true,
  setToolUIContext(ui, hasUI) {
    void ui.select("Tool choice", ["Keep", "Deploy"]).then(selected => {
      ui.notify(JSON.stringify({ toolHasUI: hasUI, selected, extension: extensionState }));
    });
  },
});
`,
		);
		const child = Bun.spawn([process.execPath, fixturePath], {
			cwd: temp.path(),
			env: {
				PATH: Bun.env.PATH,
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				CI: "true",
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		});
		const stderr = new Response(child.stderr).text();
		const requests: Record<string, unknown>[] = [];
		let result: unknown;
		try {
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (!isRecord(frame) || frame.type !== "extension_ui_request") continue;
				requests.push(frame);
				if (frame.method === "select") {
					child.stdin.write(
						`${JSON.stringify({ type: "extension_ui_response", id: frame.id, value: "Deploy" })}\n`,
					);
					await child.stdin.flush();
				} else if (frame.method === "notify") {
					if (typeof frame.message === "string") result = JSON.parse(frame.message);
					break;
				} else {
					throw new Error(`Unexpected extension UI: ${JSON.stringify(frame)}`);
				}
			}
		} finally {
			child.stdin.end();
			await child.exited;
		}
		expect(result, await stderr).toEqual({
			toolHasUI: true,
			selected: "Deploy",
			extension: { hasUI: false, confirmed: false },
		});
		expect(requests.map(frame => frame.method)).toEqual(["select", "notify"]);
		expect(requests[0]).toMatchObject({ title: "Tool choice", options: ["Keep", "Deploy"] });
	}, 30_000);
	it("keeps the label-only wire shape for bare options", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcSelect(pendingRequests, output, "Action", ["Keep", "Deploy"]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: request.id,
			method: "select",
			title: "Action",
			options: ["Keep", "Deploy"],
			timeout: undefined,
		});

		respond(pendingRequests, request.id, { value: "Keep" });
		expect(await result).toBe("Keep");
	});

	it("emits aligned descriptions and resolves with the selected label", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcSelect(pendingRequests, output, "Action", [
			"Keep",
			{ label: "Deploy", description: " Push to production " },
			{ label: "Preview", description: "   " },
		]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: request.id,
			method: "select",
			title: "Action",
			options: ["Keep", "Deploy", "Preview"],
			optionDetails: [{}, { description: "Push to production" }, {}],
			timeout: undefined,
		});

		respond(pendingRequests, request.id, { value: "Deploy" });
		expect(await result).toBe("Deploy");
	});

	it("cancels the remote dialog when its signal aborts", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const controller = new AbortController();
		const result = requestRpcDialog(
			pendingRequests,
			output,
			{ signal: controller.signal },
			false,
			{ method: "confirm", title: "High-risk command", message: "Allow this command?" },
			response => ("confirmed" in response ? response.confirmed : false),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected the RPC dialog request to carry an id");
		}

		controller.abort();

		expect(await result).toBe(false);
		expect(output).toHaveBeenNthCalledWith(1, {
			type: "extension_ui_request",
			id: request.id,
			method: "confirm",
			title: "High-risk command",
			message: "Allow this command?",
		});
		expect(output).toHaveBeenNthCalledWith(2, {
			type: "extension_ui_request",
			id: expect.any(String),
			method: "cancel",
			targetId: request.id,
		});
		expect(pendingRequests.size).toBe(0);
	});

	it("rejects secret login input, completes ordinary OAuth input, and logs the stored account out", async () => {
		await using temp = await TempDir.create("@rpc-login-");
		const extensionPath = temp.join("login.mjs");
		await Bun.write(
			extensionPath,
			`
export default function(pi) {
  globalThis.fetch = async () => { throw new Error("Offline login fixture refuses network"); };
  // rpc-alias is a second login for rpc-ordinary's credentials, like openai-codex-device.
  for (const [id, secret, storeCredentialsAs] of [["rpc-secret", true], ["rpc-ordinary", false], ["rpc-alias", false, "rpc-ordinary"]]) {
    pi.registerProvider(id, {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      models: [{
        id: "fixture",
        name: "Offline fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 4096,
        maxTokens: 512,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }],
      oauth: {
        name: id,
        storeCredentialsAs,
        login: async callbacks => {
          callbacks.onAuth({ url: "https://example.invalid/authorize" });
          return callbacks.onPrompt({ message: id, ...(secret ? { secret: true } : {}) });
        }
      }
    });
  }
}
`,
		);
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "..", "src", "cli.ts"),
				"--trusted-extension",
				extensionPath,
				"--mode",
				"rpc",
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
			],
			{
				cwd: temp.path(),
				env: {
					PATH: Bun.env.PATH,
					HOME: temp.join("home"),
					PI_CODING_AGENT_DIR: temp.join("agent"),
					XDG_CONFIG_HOME: temp.join("config"),
					XDG_DATA_HOME: temp.join("data"),
					XDG_CACHE_HOME: temp.join("cache"),
					CI: "true",
					PI_NO_TITLE: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 20_000,
			},
		);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC login fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const inputTitles: string[] = [];
		let secretResponse: unknown;
		let ordinaryResponse: unknown;
		let loggedInProvidersResponse: unknown;
		let noProviderResponse: unknown;
		let accountsResponse: unknown;
		let logoutResponse: unknown;
		let staleLogoutResponse: unknown;
		let providersResponse: unknown;
		let loggedOutCredentialId: unknown;
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};

		try {
			await send({ type: "login", providerId: "rpc-secret", id: "secret" });
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "extension_ui_request" && frame.method === "input") {
					if (typeof frame.id !== "string" || typeof frame.title !== "string") {
						throw new Error("RPC input request did not carry string id and title");
					}
					inputTitles.push(frame.title);
					await send({ type: "extension_ui_response", id: frame.id, value: crypto.randomUUID() });
				} else if (frame.type === "response" && frame.id === "secret") {
					secretResponse = frame;
					await send({ type: "login", providerId: "rpc-ordinary", id: "ordinary" });
				} else if (frame.type === "response" && frame.id === "ordinary") {
					ordinaryResponse = frame;
					await send({ type: "get_login_providers", id: "loggedIn" });
				} else if (frame.type === "response" && frame.id === "loggedIn") {
					loggedInProvidersResponse = frame;
					await send({ type: "get_logout_accounts", providerId: "rpc-alias", id: "accounts" });
				} else if (frame.type === "response" && frame.id === "accounts") {
					accountsResponse = frame;
					const accounts = isRecord(frame.data) && Array.isArray(frame.data.accounts) ? frame.data.accounts : [];
					loggedOutCredentialId = isRecord(accounts[0]) ? accounts[0].credentialId : undefined;
					await send({
						type: "logout",
						providerId: "rpc-alias",
						credentialId: loggedOutCredentialId,
						id: "logout",
					});
				} else if (frame.type === "response" && frame.id === "logout") {
					logoutResponse = frame;
					await send({
						type: "logout",
						providerId: "rpc-ordinary",
						credentialId: loggedOutCredentialId,
						id: "stale",
					});
				} else if (frame.type === "response" && frame.id === "stale") {
					staleLogoutResponse = frame;
					// Without a provider the credential store would list every provider's accounts.
					await send({ type: "get_logout_accounts", id: "noProvider" });
				} else if (frame.type === "response" && frame.id === "noProvider") {
					noProviderResponse = frame;
					await send({ type: "get_login_providers", id: "providers" });
				} else if (frame.type === "response" && frame.id === "providers") {
					providersResponse = frame;
					break;
				}
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}

		if (!providersResponse) throw new Error(`RPC login fixture did not finish: ${await stderr}`);
		await stderr;
		expect(secretResponse).toMatchObject({
			type: "response",
			command: "login",
			success: false,
			error: expect.stringContaining("requires secret input"),
		});
		expect(inputTitles).toEqual(["rpc-ordinary"]);
		expect(ordinaryResponse).toMatchObject({ type: "response", command: "login", success: true });
		expect(loggedInProvidersResponse).toMatchObject({
			data: {
				providers: expect.arrayContaining([
					expect.objectContaining({ id: "rpc-ordinary", authenticated: true }),
					// The alias stores under rpc-ordinary, so it is authenticated by the same credential.
					expect.objectContaining({ id: "rpc-alias", authenticated: true }),
				]),
			},
		});
		expect(accountsResponse).toMatchObject({
			success: true,
			data: { accounts: [expect.objectContaining({ provider: "rpc-ordinary", active: true })] },
		});
		expect(logoutResponse).toEqual({ id: "logout", type: "response", command: "logout", success: true, data: {} });
		expect(staleLogoutResponse).toMatchObject({
			command: "logout",
			success: false,
			error: expect.stringContaining("is not stored for rpc-ordinary"),
		});
		expect(noProviderResponse).toMatchObject({ command: "get_logout_accounts", success: false });
		expect(providersResponse).toMatchObject({
			success: true,
			data: {
				providers: expect.arrayContaining([
					expect.objectContaining({ id: "rpc-secret", authenticated: false }),
					expect.objectContaining({ id: "rpc-ordinary", authenticated: false }),
					expect.objectContaining({ id: "rpc-alias", authenticated: false }),
				]),
			},
		});
	}, 30_000);

	it("cancels a login when the host dismisses its authorization URL", async () => {
		await using temp = await TempDir.create("@rpc-login-cancel-");
		await using fixture = await startLoginFixture(
			temp,
			`
export default function(pi) {
  globalThis.fetch = async () => { throw new Error("Offline login fixture refuses network"); };
  const logins = {
    // Paste-code flows ask for the code while the browser step is still pending.
    "rpc-paste": async callbacks => {
      callbacks.onAuth({ url: "https://example.invalid/authorize" });
      return callbacks.onPrompt({ message: "Paste the authorization code" });
    },
    // Loopback flows wait on their callback server until the login signal stops them.
    "rpc-wait": callbacks => new Promise((_resolve, reject) => {
      callbacks.onAuth({ url: "https://example.invalid/authorize" });
      callbacks.signal?.addEventListener("abort", () => reject(new Error("callback server stopped")), { once: true });
    }),
  };
  for (const [id, login] of Object.entries(logins)) {
    pi.registerProvider(id, {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      models: [{
        id: "fixture",
        name: "Offline fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 4096,
        maxTokens: 512,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }],
      oauth: { name: id, login }
    });
  }
}
`,
		);
		const { login, idOf } = fixture;

		// Done acknowledges the URL; it must not cancel the login.
		const acknowledged = await login("rpc-paste", request =>
			request.method === "open_url" ? { value: "done" } : request.method === "input" ? { value: "code" } : undefined,
		);
		expect(acknowledged.response).toMatchObject({ command: "login", success: true });
		expect(acknowledged.requests.some(request => request.method === "cancel")).toBe(false);

		// A host that never answers the URL gets its dialog closed when the login ends.
		const unanswered = await login("rpc-paste", request =>
			request.method === "input" ? { value: "code" } : undefined,
		);
		expect(unanswered.response).toMatchObject({ command: "login", success: true });
		expect(unanswered.requests).toContainEqual(
			expect.objectContaining({ method: "cancel", targetId: idOf(unanswered.requests, "open_url") }),
		);

		// The paste-code prompt closes with the login instead of waiting out its timeout.
		const pasteCancelled = await login("rpc-paste", request =>
			request.method === "open_url" ? { cancelled: true } : undefined,
		);
		expect(pasteCancelled.response).toMatchObject({
			command: "login",
			success: false,
			error: "Login cancelled",
			code: "login_cancelled",
		});
		expect(pasteCancelled.requests).toContainEqual(
			expect.objectContaining({ method: "cancel", targetId: idOf(pasteCancelled.requests, "input") }),
		);

		// A provider waiting on its callback is stopped through the login signal.
		const waitCancelled = await login("rpc-wait", request =>
			request.method === "open_url" ? { cancelled: true } : undefined,
		);
		expect(waitCancelled.response).toMatchObject({ command: "login", success: false, code: "login_cancelled" });

		// Dismissing the paste-code prompt is the same cancel; a prompt that timed out is a failure.
		const promptCancelled = await login("rpc-paste", request =>
			request.method === "input" ? { cancelled: true } : undefined,
		);
		expect(promptCancelled.response).toMatchObject({ command: "login", success: false, code: "login_cancelled" });
		const promptTimedOut = await login("rpc-paste", request =>
			request.method === "input" ? { cancelled: true, timedOut: true } : undefined,
		);
		expect(promptTimedOut.response).toMatchObject({ command: "login", success: false });
		expect(promptTimedOut.response).not.toHaveProperty("code");
	}, 30_000);

	it("shows Anthropic's paste-code prompt with its URL dialog and closes both when the browser signs in", async () => {
		await using temp = await TempDir.create("@rpc-login-paste-");
		// Offline token endpoint: it accepts the codes this test hands out and
		// refuses every other request (identity and model discovery fail quietly).
		await using fixture = await startLoginFixture(
			temp,
			`
export default function() {
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.anthropic.com/v1/oauth/token")) {
      const { code } = JSON.parse(String(init?.body));
      if (code === "browser-code" || code === "pasted-code") {
        return Response.json({ access_token: "at-" + code, refresh_token: "rt", expires_in: 3600 });
      }
      return new Response("bad code", { status: 400 });
    }
    throw new Error("Offline login fixture refuses network");
  };
}
`,
		);
		const { login, idOf } = fixture;
		const authorizeParams = (requests: Record<string, unknown>[]) =>
			new URL(String(requests.find(request => request.method === "open_url")?.url)).searchParams;

		// The browser reaches the callback first: the unanswered paste prompt and URL dialog close.
		const browser: Promise<Response>[] = [];
		const viaBrowser = await login("anthropic", request => {
			if (request.method !== "open_url") return undefined;
			const params = new URL(String(request.url)).searchParams;
			const callback = new URL(params.get("redirect_uri") ?? "");
			callback.searchParams.set("code", "browser-code");
			callback.searchParams.set("state", params.get("state") ?? "");
			browser.push(fetch(callback));
			return undefined;
		});
		await Promise.all(browser);
		expect(viaBrowser.response).toMatchObject({ command: "login", success: true });
		const urlId = idOf(viaBrowser.requests, "open_url");
		const promptId = idOf(viaBrowser.requests, "input");
		expect(viaBrowser.requests).toContainEqual(expect.objectContaining({ method: "input", authCodeFor: urlId }));
		expect(viaBrowser.requests).toContainEqual(expect.objectContaining({ method: "cancel", targetId: promptId }));
		expect(viaBrowser.requests).toContainEqual(expect.objectContaining({ method: "cancel", targetId: urlId }));

		// Pasting the code completes the sign-in the same way.
		let state = "";
		const viaPaste = await login("anthropic", request => {
			if (request.method === "open_url") state = authorizeParams([request]).get("state") ?? "";
			return request.method === "input" ? { value: `pasted-code#${state}` } : undefined;
		});
		expect(viaPaste.response).toMatchObject({ command: "login", success: true });
	}, 30_000);
});

/**
 * Starts omp in RPC mode with `extensionSource` loaded as a trusted extension.
 * `login` runs one login, answering each UI request with `answer`'s payload,
 * and returns the requests it emitted with the final response.
 */
async function startLoginFixture(temp: TempDir, extensionSource: string) {
	const extensionPath = temp.join("login.mjs");
	await Bun.write(extensionPath, extensionSource);
	const child = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "..", "src", "cli.ts"),
			"--trusted-extension",
			extensionPath,
			"--mode",
			"rpc",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd: temp.path(),
			env: {
				PATH: Bun.env.PATH,
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				CI: "true",
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		},
	);
	const stdout = new Response(child.stdout).body;
	if (!stdout) throw new Error("RPC login fixture did not expose stdout");
	const stderr = new Response(child.stderr).text();
	const frames = readJsonl<unknown>(stdout)[Symbol.asyncIterator]();
	const send = async (frame: object) => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
		await child.stdin.flush();
	};
	const login = async (providerId: string, answer: (request: Record<string, unknown>) => object | undefined) => {
		const id = crypto.randomUUID();
		await send({ type: "login", providerId, id });
		const requests: Record<string, unknown>[] = [];
		while (true) {
			const next = await frames.next();
			if (next.done) throw new Error(`RPC login fixture exited during ${providerId}: ${await stderr}`);
			const frame = next.value;
			if (!isRecord(frame)) continue;
			if (frame.type === "response" && frame.id === id) return { requests, response: frame };
			if (frame.type !== "extension_ui_request") continue;
			requests.push(frame);
			const payload = answer(frame);
			if (payload) await send({ type: "extension_ui_response", id: frame.id, ...payload });
		}
	};
	const idOf = (requests: Record<string, unknown>[], method: string) =>
		requests.find(request => request.method === method)?.id;
	return {
		login,
		idOf,
		async [Symbol.asyncDispose]() {
			child.stdin.end();
			child.kill();
			await child.exited;
		},
	};
}

describe("RPC ask dialog", () => {
	it("sends every question in one ask frame and returns the validated answers", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion, featuresQuestion]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		expect(output).toHaveBeenCalledTimes(1);
		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: request.id,
			method: "ask",
			questions: [dbQuestion, featuresQuestion],
			timeout: undefined,
		});

		respond(pendingRequests, request.id, {
			answers: [
				{ id: "db", selectedOptions: ["Postgres"], customInput: "   " },
				{ id: "features", selectedOptions: ["Search", "Auth"], customInput: "  Export  " },
			],
		});
		expect(await result).toEqual({
			kind: "submit",
			results: [
				{
					id: "db",
					question: "Which database?",
					options: ["Postgres", "SQLite"],
					multi: false,
					selectedOptions: ["Postgres"],
					customInput: undefined,
				},
				{
					id: "features",
					question: "Which features?",
					options: ["Auth", "Billing", "Search"],
					multi: true,
					selectedOptions: ["Search", "Auth"],
					customInput: "Export",
				},
			],
		});
	});

	const validDb = { id: "db", selectedOptions: ["Postgres"] };
	const validFeatures = { id: "features", selectedOptions: ["Auth"] };
	it.each([
		["too few answers", [validDb]],
		["answers out of question order", [validFeatures, validDb]],
		["an unknown option label", [{ id: "db", selectedOptions: ["MySQL"] }, validFeatures]],
		["a duplicated option", [validDb, { id: "features", selectedOptions: ["Auth", "Auth"] }]],
		["two options on a single-select", [{ id: "db", selectedOptions: ["Postgres", "SQLite"] }, validFeatures]],
		[
			"an option plus custom input on a single-select",
			[{ id: "db", selectedOptions: ["Postgres"], customInput: "DuckDB" }, validFeatures],
		],
	])("rejects %s", async (_case, answers) => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion, featuresQuestion]);

		respond(pendingRequests, requireRequest(output.mock.calls[0]?.[0]).id, { answers });

		await expect(result).rejects.toThrow(Error);
		expect(pendingRequests.size).toBe(0);
	});

	it.each([
		["omp's timer fires", 5, undefined],
		["the host reports its own timeout", undefined, { cancelled: true, timedOut: true }],
	])("answers every question with its recommended option when %s", async (_case, timeout, response) => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const onTimeout = vi.fn();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion, featuresQuestion], {
			timeout,
			onTimeout,
		});
		if (response) respond(pendingRequests, requireRequest(output.mock.calls[0]?.[0]).id, response);

		expect(await result).toEqual({
			kind: "submit",
			results: [
				{
					id: "db",
					question: "Which database?",
					options: ["Postgres", "SQLite"],
					multi: false,
					selectedOptions: ["SQLite"],
					customInput: undefined,
					timedOut: true,
				},
				{
					id: "features",
					question: "Which features?",
					options: ["Auth", "Billing", "Search"],
					multi: true,
					selectedOptions: ["Auth"],
					customInput: undefined,
					timedOut: true,
				},
			],
		});
		expect(onTimeout).toHaveBeenCalledTimes(1);
		// omp settled the dialog; only its own timer must tell the host to close it.
		const request = requireRequest(output.mock.calls[0]?.[0]);
		const cancels = output.mock.calls
			.map(([frame]) => frame)
			.filter(frame => "method" in frame && frame.method === "cancel");
		expect(cancels).toEqual(
			timeout === undefined ? [] : [expect.objectContaining({ method: "cancel", targetId: request.id })],
		);
	});

	it("resolves a plain host cancel as a cancelled dialog", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const onTimeout = vi.fn();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion], { onTimeout });

		respond(pendingRequests, requireRequest(output.mock.calls[0]?.[0]).id, { cancelled: true });

		expect(await result).toBeUndefined();
		expect(onTimeout).not.toHaveBeenCalled();
	});

	it("keeps select prompts until the host opts in, then sends each ask as one dialog", async () => {
		await using temp = await TempDir.create("@rpc-ask-dialog-");
		const extensionPath = temp.join("scripted-ask.ts");
		await Bun.write(extensionPath, scriptedAskProvider);
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "..", "src", "cli.ts"),
				"--trusted-extension",
				extensionPath,
				"--mode",
				"rpc-ui",
				"--no-session",
			],
			{
				cwd: temp.path(),
				env: {
					PATH: Bun.env.PATH,
					HOME: temp.join("home"),
					PI_CODING_AGENT_DIR: temp.join("agent"),
					XDG_CONFIG_HOME: temp.join("config"),
					XDG_DATA_HOME: temp.join("data"),
					XDG_CACHE_HOME: temp.join("cache"),
					CI: "true",
					PI_NO_TITLE: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 30_000,
			},
		);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC ask fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		const selectRequests: Record<string, unknown>[] = [];
		const askRequests: Record<string, unknown>[] = [];
		const toolResults: unknown[] = [];
		let optInResponse: unknown;
		let finished = false;

		try {
			// The provider exists only once the extension loads, so select it over RPC.
			await send({ type: "set_model", id: "model", provider: "scripted", modelId: "ask" });
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "response" && frame.id === "model") {
					if (frame.success !== true) throw new Error(`Scripted model unavailable: ${JSON.stringify(frame)}`);
					await send({ type: "prompt", id: "fallback", message: JSON.stringify({ questions: [dbQuestion] }) });
				} else if (frame.type === "extension_ui_request" && frame.method === "select") {
					selectRequests.push(frame);
					await send({ type: "extension_ui_response", id: frame.id, value: "Postgres" });
				} else if (frame.type === "extension_ui_request" && frame.method === "ask") {
					askRequests.push(frame);
					await send({
						type: "extension_ui_response",
						id: frame.id,
						answers: [
							{ id: "db", selectedOptions: [], customInput: "DuckDB" },
							{ id: "features", selectedOptions: ["Auth", "Search"] },
						],
					});
				} else if (frame.type === "tool_execution_end" && frame.toolName === "ask") {
					toolResults.push(frame.result);
				} else if (frame.type === "prompt_result" && frame.id === "fallback") {
					await send({ type: "set_ask_dialog", id: "opt-in", enabled: true });
				} else if (frame.type === "response" && frame.id === "opt-in") {
					optInResponse = frame;
					await send({
						type: "prompt",
						id: "dialog",
						message: JSON.stringify({ questions: [dbQuestion, featuresQuestion] }),
					});
				} else if (frame.type === "prompt_result" && frame.id === "dialog") {
					finished = true;
					break;
				}
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}

		if (!finished) throw new Error(`RPC ask fixture did not finish: ${await stderr}`);
		await stderr;
		expect(selectRequests).toHaveLength(1);
		expect(selectRequests[0]).toMatchObject({ method: "select", title: "Which database?" });
		expect(optInResponse).toEqual({
			id: "opt-in",
			type: "response",
			command: "set_ask_dialog",
			success: true,
			data: { enabled: true },
		});
		expect(askRequests).toEqual([
			{
				type: "extension_ui_request",
				id: expect.any(String),
				method: "ask",
				questions: [dbQuestion, featuresQuestion],
			},
		]);
		expect(toolResults).toEqual([
			expect.objectContaining({ details: expect.objectContaining({ selectedOptions: ["Postgres"] }) }),
			expect.objectContaining({
				details: {
					results: [
						expect.objectContaining({ id: "db", selectedOptions: [], customInput: "DuckDB" }),
						expect.objectContaining({ id: "features", selectedOptions: ["Auth", "Search"] }),
					],
				},
			}),
		]);
	}, 60_000);
});
