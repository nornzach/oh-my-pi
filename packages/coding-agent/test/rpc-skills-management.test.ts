import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getManagedSkillsDir } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { applyRpcManageSkill, buildRpcSkillDetail } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-skills";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

describe("skill management RPC contract", () => {
	let tempRoot: string;
	let originalAgentDir: string;
	let session: AgentSession;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-skills-"));
		setAgentDir(path.join(tempRoot, ".omp", "agent"));
		session = {
			skills: [],
			skillsSettings: {},
			sessionManager: { getCwd: () => tempRoot },
		} as unknown as AgentSession;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempRoot);
	});

	it("creates, previews, updates, and deletes only the managed skill file", async () => {
		await expect(
			applyRpcManageSkill(session, "create", "review-notes", "Review release notes.", "# Review\n\nCheck facts."),
		).resolves.toEqual({ action: "create", name: "review-notes" });

		const created = await buildRpcSkillDetail(session, "review-notes");
		expect(created).toMatchObject({
			name: "review-notes",
			description: "Review release notes.",
			managed: true,
			provider: "omp-managed",
		});
		expect(created.body).toBe("# Review\n\nCheck facts.");
		expect(created.body).not.toContain("description:");

		await applyRpcManageSkill(session, "update", "review-notes", "Review carefully.", "# Updated");
		expect((await buildRpcSkillDetail(session, "review-notes")).body).toBe("# Updated");

		await applyRpcManageSkill(session, "delete", "review-notes");
		expect(await Bun.file(path.join(getManagedSkillsDir(), "review-notes", "SKILL.md")).exists()).toBe(false);
		await expect(buildRpcSkillDetail(session, "review-notes")).rejects.toThrow(/not found/);
	});

	it("never treats a renderer-supplied path as a skill lookup", async () => {
		await expect(buildRpcSkillDetail(session, "../../etc/passwd")).rejects.toThrow(/not found/);
		await expect(applyRpcManageSkill(session, "create", "../escape", "x", "y")).rejects.toThrow(/Invalid skill name/);
	});
});
