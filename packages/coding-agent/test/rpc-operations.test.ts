import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { manageRpcSshHost } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-operations";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { readSSHConfigFile } from "@oh-my-pi/pi-coding-agent/ssh/config-writer";
import { getHostInfo } from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { sanitizeHostName } from "@oh-my-pi/pi-coding-agent/ssh/utils";
import { getRemoteHostDir, getSSHConfigPath, TempDir } from "@oh-my-pi/pi-utils";

describe("SSH management RPC", () => {
	let tempDir: TempDir;
	let session: AgentSession;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-rpc-ssh-");
		session = {
			sessionManager: { getCwd: () => tempDir.path() },
		} as unknown as AgentSession;
	});

	afterEach(() => tempDir.removeSync());

	it("persists create, rename, and delete without leaving stale aliases", async () => {
		await manageRpcSshHost(session, "create", "project", "build", undefined, undefined, {
			host: "build.example.com",
			username: "runner",
			port: 2222,
		});
		await manageRpcSshHost(session, "update", "project", "prod", "build", "project", {
			host: "prod.example.com",
			username: "deploy",
		});

		const filePath = getSSHConfigPath("project", tempDir.path());
		const renamed = await readSSHConfigFile(filePath);
		expect(renamed.hosts?.build).toBeUndefined();
		expect(renamed.hosts?.prod).toEqual({ host: "prod.example.com", username: "deploy" });

		await manageRpcSshHost(session, "delete", "project", "prod");
		expect((await readSSHConfigFile(filePath)).hosts).toEqual({});
	});

	it("rejects a duplicate alias instead of overwriting it", async () => {
		await manageRpcSshHost(session, "create", "project", "build", undefined, undefined, {
			host: "one.example.com",
		});
		await expect(
			manageRpcSshHost(session, "create", "project", "build", undefined, undefined, {
				host: "two.example.com",
			}),
		).rejects.toThrow('Host "build" already exists');
		expect((await readSSHConfigFile(getSSHConfigPath("project", tempDir.path()))).hosts?.build?.host).toBe(
			"one.example.com",
		);
	});

	it("removes cached host capabilities when an alias is recreated", async () => {
		const name = `rpc-cache-${crypto.randomUUID()}`;
		const cachePath = path.join(getRemoteHostDir(), `${sanitizeHostName(name)}.json`);
		await Bun.write(
			cachePath,
			JSON.stringify({ version: 4, os: "linux", shell: "bash", transferShell: "bash", compatEnabled: false }),
		);
		try {
			expect((await getHostInfo(name))?.os).toBe("linux");
			await manageRpcSshHost(session, "create", "project", name, undefined, undefined, {
				host: "replacement.example.com",
			});
			expect(await getHostInfo(name)).toBeUndefined();
		} finally {
			await fs.rm(cachePath, { force: true });
		}
	});
});
