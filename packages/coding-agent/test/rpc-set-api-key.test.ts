import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER_FIXTURE = `
export default function(pi) {
  globalThis.fetch = async () => { throw new Error("Offline fixture refuses network"); };
  // rpc-secret's login asks for a secret, which RPC login refuses; rpc-alias stores under rpc-ordinary.
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
        login: async callbacks => callbacks.onPrompt({ message: id, ...(secret ? { secret: true } : {}) })
      }
    });
  }
}
`;

describe("RPC set_api_key", () => {
	it("signs in a secret-prompting provider, stores aliases under their credential, and rejects bad input without echoing the key", async () => {
		await using temp = await TempDir.create("@rpc-set-api-key-");
		const extensionPath = temp.join("providers.mjs");
		await Bun.write(extensionPath, PROVIDER_FIXTURE);
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
		if (!stdout) throw new Error("RPC fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();

		// Responses by id; each call resolves when its frame arrives.
		const waiting = new Map<string, PromiseWithResolvers<Record<string, unknown>>>();
		const arrived = new Map<string, Record<string, unknown>>();
		const pump = (async () => {
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame) || frame.type !== "response" || typeof frame.id !== "string") continue;
				const resolver = waiting.get(frame.id);
				if (resolver) resolver.resolve(frame);
				else arrived.set(frame.id, frame);
			}
		})();
		const call = async (id: string, frame: object): Promise<Record<string, unknown>> => {
			child.stdin.write(`${JSON.stringify({ ...frame, id })}\n`);
			await child.stdin.flush();
			const early = arrived.get(id);
			if (early) return early;
			const resolver = Promise.withResolvers<Record<string, unknown>>();
			waiting.set(id, resolver);
			return resolver.promise;
		};

		const secretKey = "sk-live-secret-value-123";
		try {
			const secretLogin = await call("login", { type: "login", providerId: "rpc-secret" });
			const stored = await call("stored", {
				type: "set_api_key",
				providerId: "rpc-secret",
				apiKey: `  ${secretKey}  `,
			});
			const viaAlias = await call("alias", { type: "set_api_key", providerId: "rpc-alias", apiKey: "sk-alias-key" });
			const providers = await call("providers", { type: "get_login_providers" });
			const accounts = await call("accounts", { type: "get_logout_accounts", providerId: "rpc-secret" });
			const empty = await call("empty", { type: "set_api_key", providerId: "rpc-secret", apiKey: "   " });
			const unknown = await call("unknown", {
				type: "set_api_key",
				providerId: "no-such-provider",
				apiKey: secretKey,
			});
			const badType = await call("badType", { type: "set_api_key", providerId: "rpc-secret", apiKey: 42 });

			// The login this command exists to replace.
			expect(secretLogin).toMatchObject({ success: false, error: expect.stringContaining("requires secret input") });
			expect(stored).toMatchObject({ command: "set_api_key", success: true, data: { providerId: "rpc-secret" } });
			expect(viaAlias).toMatchObject({ success: true, data: { providerId: "rpc-alias" } });
			expect(providers).toMatchObject({
				data: {
					providers: expect.arrayContaining([
						expect.objectContaining({ id: "rpc-secret", authenticated: true }),
						// The alias stores under rpc-ordinary, so both read as signed in by the same credential.
						expect.objectContaining({ id: "rpc-ordinary", authenticated: true }),
						expect.objectContaining({ id: "rpc-alias", authenticated: true }),
					]),
				},
			});
			// The stored row is a login credential logout can remove.
			expect(accounts).toMatchObject({
				success: true,
				data: { accounts: [expect.objectContaining({ provider: "rpc-secret" })] },
			});
			expect(empty).toMatchObject({ success: false, error: expect.stringContaining("must not be empty") });
			expect(unknown).toMatchObject({ success: false, error: expect.stringContaining("Unknown login provider") });
			expect(badType).toMatchObject({ success: false });
			// A failure must never carry the secret back to the host.
			expect(JSON.stringify([empty, unknown, badType])).not.toContain(secretKey);
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
			await pump.catch(() => {});
		}
		await stderr;
	}, 30_000);
});
