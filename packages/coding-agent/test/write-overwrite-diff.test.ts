import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool, type WriteToolDetails } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

function details(result: { details?: WriteToolDetails }): WriteToolDetails {
	return result.details ?? {};
}

describe("write tool overwrite diff", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-overwrite-diff-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("attaches an edit-format diff when overwriting different content", async () => {
		const filePath = path.join(tmpDir, "existing.txt");
		await fs.writeFile(filePath, "line1\nline2\nline3\n");

		const tool = new WriteTool(createSession(tmpDir));
		const result = await tool.execute("call-overwrite", {
			path: filePath,
			content: "line1\nCHANGED\nline3\n",
		});

		// GUI DiffView contract: overwrite flag plus a numbered unified diff,
		// old content → new content, same shape as edit's perFileResults[].diff.
		const d = details(result);
		expect(d.overwritten).toBe(true);
		expect(d.diff).toContain("-2|line2");
		expect(d.diff).toContain("+2|CHANGED");
		expect(d.firstChangedLine).toBe(2);
	});

	it("omits the overwrite fields when creating a new file", async () => {
		const filePath = path.join(tmpDir, "fresh.txt");

		const tool = new WriteTool(createSession(tmpDir));
		const result = await tool.execute("call-create", { path: filePath, content: "brand new\n" });

		const d = details(result);
		expect(d.overwritten).toBeUndefined();
		expect(d.diff).toBeUndefined();
		expect(d.firstChangedLine).toBeUndefined();
	});

	it("flags the overwrite but omits the diff when content is unchanged", async () => {
		const filePath = path.join(tmpDir, "same.txt");
		await fs.writeFile(filePath, "same content\n");

		const tool = new WriteTool(createSession(tmpDir));
		const result = await tool.execute("call-same", { path: filePath, content: "same content\n" });

		const d = details(result);
		expect(d.overwritten).toBe(true);
		expect(d.diff).toBeUndefined();
		expect(d.firstChangedLine).toBeUndefined();
	});
});
