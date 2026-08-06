import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyRpcWriteLocalPaste } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-paste";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/**
 * Contract tests for write_local_paste: the paste lands in the session's
 * local:// store where the read tool's resolver will find it, and the name
 * counter skips existing files so concurrent GUI windows on one session can
 * never overwrite each other.
 */

let artifactsDir: string;

function stubSession(): AgentSession {
	return {
		sessionManager: {
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "test-session",
		},
	} as unknown as AgentSession;
}

beforeEach(async () => {
	artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-paste-test-"));
});

afterEach(async () => {
	await fs.rm(artifactsDir, { recursive: true, force: true });
});

describe("applyRpcWriteLocalPaste", () => {
	it("writes the content into the session local store and returns its URI", async () => {
		const content = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n");
		const result = await applyRpcWriteLocalPaste(stubSession(), content);
		expect(result).toEqual({ name: "paste-1.md", url: "local://paste-1.md" });
		const written = await fs.readFile(path.join(artifactsDir, "local", "paste-1.md"), "utf8");
		expect(written).toBe(content);
	});

	it("allocates the next free name when files already exist", async () => {
		await fs.mkdir(path.join(artifactsDir, "local"), { recursive: true });
		await fs.writeFile(path.join(artifactsDir, "local", "paste-1.md"), "first");
		await fs.writeFile(path.join(artifactsDir, "local", "paste-2.md"), "second");
		const result = await applyRpcWriteLocalPaste(stubSession(), "third");
		expect(result).toEqual({ name: "paste-3.md", url: "local://paste-3.md" });
		expect(await fs.readFile(path.join(artifactsDir, "local", "paste-1.md"), "utf8")).toBe("first");
		expect(await fs.readFile(path.join(artifactsDir, "local", "paste-2.md"), "utf8")).toBe("second");
	});

	it("keeps allocating across sequential writes in one session", async () => {
		const first = await applyRpcWriteLocalPaste(stubSession(), "one");
		const second = await applyRpcWriteLocalPaste(stubSession(), "two");
		expect(first.name).toBe("paste-1.md");
		expect(second.name).toBe("paste-2.md");
	});

	it("claims distinct files across concurrent writers", async () => {
		const [first, second] = await Promise.all([
			applyRpcWriteLocalPaste(stubSession(), "alpha"),
			applyRpcWriteLocalPaste(stubSession(), "beta"),
		]);
		expect(new Set([first.name, second.name])).toEqual(new Set(["paste-1.md", "paste-2.md"]));
		const contents = await Promise.all(
			[first, second].map(result => fs.readFile(path.join(artifactsDir, "local", result.name), "utf8")),
		);
		expect(new Set(contents)).toEqual(new Set(["alpha", "beta"]));
	});
});
