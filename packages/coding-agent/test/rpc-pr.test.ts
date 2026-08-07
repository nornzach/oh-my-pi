import * as piAi from "@oh-my-pi/pi-ai";
import * as modelSelection from "@oh-my-pi/pi-coding-agent/commit/model-selection";
import {
	buildRpcPrDetail,
	buildRpcPrDraft,
	buildRpcPrFileDiff,
	buildRpcPrList,
	buildRpcPrRepo,
	checkoutRpcPr,
	createRpcPr,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-pr";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as gh from "@oh-my-pi/pi-coding-agent/tools/gh";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { afterEach, describe, expect, it, vi } from "vitest";

// All GitHub access funnels through git.github.* — spying there covers every
// command without a live gh or network. The session stub only needs getCwd
// (draft additionally needs settings/modelRegistry, mocked at their modules).
function stubSession(cwd = "/repo"): AgentSession {
	return {
		sessionManager: { getCwd: () => cwd },
		settings: {},
		modelRegistry: {},
	} as unknown as AgentSession;
}

function mockGithubRepo(): void {
	vi.spyOn(git.github, "available").mockReturnValue(true);
	vi.spyOn(git.repo, "root").mockResolvedValue("/repo");
	vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
		if (args[0] === "repo" && args[1] === "view") {
			return { nameWithOwner: "acme/widgets", defaultBranchRef: { name: "main" } };
		}
		throw new Error(`unexpected gh call: ${args.join(" ")}`);
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("rpc-pr", () => {
	it("pr_repo reports availability states", async () => {
		vi.spyOn(git.github, "available").mockReturnValue(false);
		expect(await buildRpcPrRepo(stubSession())).toEqual({ available: false, reason: "gh_missing" });

		vi.spyOn(git.github, "available").mockReturnValue(true);
		vi.spyOn(git.repo, "root").mockResolvedValue(null);
		expect(await buildRpcPrRepo(stubSession("/nowhere"))).toEqual({ available: false, reason: "not_a_repo" });

		mockGithubRepo();
		expect(await buildRpcPrRepo(stubSession())).toEqual({
			available: true,
			repo: "acme/widgets",
			defaultBranch: "main",
		});
	});

	it("pr_list maps rows with rollup CI counts", async () => {
		mockGithubRepo();
		vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args[0] === "repo") return { nameWithOwner: "acme/widgets", defaultBranchRef: { name: "main" } };
			if (args[0] === "pr" && args[1] === "list") {
				return [
					{
						number: 42,
						title: "Add widget",
						url: "https://github.com/acme/widgets/pull/42",
						isDraft: true,
						author: { login: "zach" },
						headRefName: "feat/widget",
						baseRefName: "main",
						additions: 120,
						deletions: 30,
						updatedAt: "2026-08-01T00:00:00Z",
						reviewDecision: "REVIEW_REQUIRED",
						statusCheckRollup: [
							{ status: "COMPLETED", conclusion: "SUCCESS" },
							{ status: "COMPLETED", conclusion: "FAILURE" },
							{ status: "IN_PROGRESS", conclusion: null },
						],
					},
				];
			}
			throw new Error(`unexpected: ${args.join(" ")}`);
		});
		const list = await buildRpcPrList(stubSession(), { state: "open", limit: 10 });
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			number: 42,
			isDraft: true,
			authorLogin: "zach",
			checks: { success: 1, failure: 1, pending: 1 },
		});
	});

	it("pr_get maps detail with files and checks", async () => {
		mockGithubRepo();
		vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args[0] === "repo") return { nameWithOwner: "acme/widgets", defaultBranchRef: { name: "main" } };
			if (args[0] === "pr" && args[1] === "view") {
				return {
					number: 7,
					title: "Fix crash",
					url: "https://github.com/acme/widgets/pull/7",
					isDraft: false,
					author: { login: "roboomp" },
					body: "body text",
					baseRefName: "main",
					headRefName: "fix/crash",
					mergeStateStatus: "CLEAN",
					additions: 5,
					deletions: 2,
					reviewDecision: "APPROVED",
					files: [{ path: "src/a.ts", additions: 5, deletions: 2, changeType: "MODIFIED" }],
					statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
				};
			}
			throw new Error(`unexpected: ${args.join(" ")}`);
		});
		const detail = await buildRpcPrDetail(stubSession(), { number: 7 });
		expect(detail.files).toEqual([{ path: "src/a.ts", changeType: "MODIFIED", additions: 5, deletions: 2 }]);
		expect(detail.checks).toEqual([{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }]);
		expect(detail.mergeStateStatus).toBe("CLEAN");
	});

	it("pr_diff slices the requested file out of the unified diff", async () => {
		mockGithubRepo();
		const unified = [
			"diff --git a/src/a.ts b/src/a.ts",
			"index 111..222 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"diff --git a/src/b.ts b/src/b.ts",
			"index 333..444 100644",
			"--- a/src/b.ts",
			"+++ b/src/b.ts",
			"@@ -1 +1 @@",
			"-gone",
			"+here",
			"",
		].join("\n");
		vi.spyOn(git.github, "text").mockResolvedValue(unified);
		const { diff } = await buildRpcPrFileDiff(stubSession(), { number: 3, path: "src/b.ts" });
		expect(diff).toContain("diff --git a/src/b.ts b/src/b.ts");
		expect(diff).not.toContain("src/a.ts");
		await expect(buildRpcPrFileDiff(stubSession(), { number: 3, path: "src/missing.ts" })).rejects.toMatchObject({
			code: "pr_not_found",
		});
	});

	it("pr_create passes body via file and parses the PR URL", async () => {
		mockGithubRepo();
		const textSpy = vi.spyOn(git.github, "text").mockResolvedValue("https://github.com/acme/widgets/pull/99\n");
		const result = await createRpcPr(stubSession(), {
			title: "My PR",
			body: "## Summary\nstuff",
			base: "main",
			draft: true,
		});
		expect(result).toEqual({ url: "https://github.com/acme/widgets/pull/99", number: 99 });
		const args = textSpy.mock.calls[0]?.[1] as string[];
		expect(args).toContain("--draft");
		expect(args).toContain("--base");
		expect(args[args.indexOf("--body-file") + 1]).toMatch(/body\.md$/);
	});

	it("pr_draft feeds commits+files to the model and parses the tool call", async () => {
		mockGithubRepo();
		vi.spyOn(git.branch, "current").mockResolvedValue("feat/widget");
		vi.spyOn(git.log, "subjectsInRange").mockResolvedValue(["feat: add widget", "fix: widget crash"]);
		vi.spyOn(git, "diff").mockImplementation(async (_cwd, options) => {
			if (options?.nameOnly) return "src/widget.ts\nsrc/widget.test.ts\n";
			if (options?.stat) return " src/widget.ts | 10 +++++++++-\n 2 files changed";
			return "";
		});
		vi.spyOn(modelSelection, "resolvePrimaryModel").mockResolvedValue({
			model: {},
			apiKey: async () => "key",
			thinkingLevel: undefined,
		} as never);
		vi.spyOn(piAi, "completeSimple").mockResolvedValue({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "pr_draft",
					arguments: { title: "feat: add widget", body: "## Summary\n- adds a widget" },
				},
			],
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as never);
		const draft = await buildRpcPrDraft(stubSession(), {});
		expect(draft.title).toBe("feat: add widget");
		expect(draft.body).toContain("adds a widget");
	});

	it("pr_checkout returns the worktree path and branch from gh machinery", async () => {
		mockGithubRepo();
		vi.spyOn(gh, "checkoutPullRequest").mockResolvedValue({
			worktreePath: "/wt/42-deadbeef",
			localBranch: "pr-42",
		} as never);
		expect(await checkoutRpcPr(stubSession(), { number: 42 })).toEqual({ path: "/wt/42-deadbeef", branch: "pr-42" });
	});
});
