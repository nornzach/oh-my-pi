/**
 * Pull-request RPC commands backing the GUI's PR Center (plan/21).
 *
 * Everything shells out to the `gh` CLI through git.github.* — no octokit,
 * no new auth path (failures map to gh_missing / not_a_repo /
 * no_github_remote typed codes). Heavy lifting reuses the github TOOL's
 * exported, cache-aware readers: getOrFetchPr (view + files) and
 * getOrFetchPrDiff (one fetch, per-file byte-offset slices). pr_diff is
 * per-file on purpose: the file index rides pr_get and slices are fetched
 * lazily, keeping frames far under the 8 MiB gh output cap.
 *
 * pr_draft is the one model call: completeSimple with an omptype tool schema
 * (commit/analysis/summary.ts pattern) fed by branch commits + name-status +
 * diffstat. pr_checkout reuses checkoutPullRequest (gh.ts, exported) so PR
 * worktrees land in the same ~/.omp/wt scheme as plan/20 tabs.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { completeSimple, validateToolCall } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { resolvePrimaryModel } from "../../commit/model-selection";
import { extractToolCall } from "../../commit/utils";
import type { AgentSession } from "../../session/agent-session";
import { toReasoningEffort } from "../../thinking";
import { checkoutPullRequest, parsePrUnifiedDiff } from "../../tools/gh";
import * as git from "../../utils/git";
import prDraftSystemPrompt from "./prompts/pr-draft-system.md" with { type: "text" };
import prDraftUserPrompt from "./prompts/pr-draft-user.md" with { type: "text" };
import type { RpcPrCreateResult, RpcPrDetail, RpcPrDraftResult, RpcPrListItem, RpcPrRepo } from "./rpc-types";

/** Typed RPC errors: `code` lands in the response envelope's `code` field. */
export class RpcPrError extends Error {
	constructor(
		readonly code:
			| "gh_missing"
			| "not_a_repo"
			| "no_github_remote"
			| "pr_not_found"
			| "pr_create_failed"
			| "pr_checkout_failed"
			| "pr_draft_failed",
		message: string,
	) {
		super(message);
	}
}

const PrDraftToolSchema = type({ title: "string", body: "string" });

const PrDraftTool = {
	name: "pr_draft",
	description: "Return the drafted PR title and body.",
	parameters: PrDraftToolSchema,
};

interface GhRepoView {
	nameWithOwner?: string;
	defaultBranchRef?: { name?: string } | null;
}

interface GhPrListRow {
	number?: number;
	title?: string;
	url?: string;
	isDraft?: boolean;
	author?: { login?: string } | null;
	headRefName?: string;
	baseRefName?: string;
	additions?: number;
	deletions?: number;
	updatedAt?: string;
	reviewDecision?: string | null;
	statusCheckRollup?: Array<{ status?: string; conclusion?: string | null }> | null;
}

const PR_LIST_FIELDS =
	"number,title,url,isDraft,author,headRefName,baseRefName,additions,deletions,updatedAt,reviewDecision,statusCheckRollup";

/** Resolve gh + the GitHub repo for the session cwd, or throw the typed reason. */
async function requireGithubRepo(cwd: string): Promise<{ repo: string; defaultBranch: string | null }> {
	if (!git.github.available()) {
		throw new RpcPrError("gh_missing", "GitHub CLI (gh) is not installed — see https://cli.github.com");
	}
	const repoRoot = await git.repo.root(cwd);
	if (!repoRoot) throw new RpcPrError("not_a_repo", `Not a git repository: ${cwd}`);
	let view: GhRepoView;
	try {
		view = await git.github.json<GhRepoView>(
			repoRoot,
			["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
			undefined,
			{
				repoProvided: false,
			},
		);
	} catch (error) {
		throw new RpcPrError(
			"no_github_remote",
			`No GitHub remote for ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!view.nameWithOwner) throw new RpcPrError("no_github_remote", `No GitHub remote for ${repoRoot}`);
	return { repo: view.nameWithOwner, defaultBranch: view.defaultBranchRef?.name ?? null };
}

export async function buildRpcPrRepo(session: AgentSession): Promise<RpcPrRepo> {
	const cwd = session.sessionManager.getCwd();
	if (!git.github.available()) return { available: false, reason: "gh_missing" };
	if (!(await git.repo.root(cwd))) return { available: false, reason: "not_a_repo" };
	try {
		const { repo, defaultBranch } = await requireGithubRepo(cwd);
		return { available: true, repo, defaultBranch };
	} catch (error) {
		if (error instanceof RpcPrError && error.code === "no_github_remote")
			return { available: false, reason: "no_github_remote" };
		throw error;
	}
}

export async function buildRpcPrList(
	session: AgentSession,
	input: { state?: "open" | "closed" | "merged" | "all"; limit?: number },
): Promise<RpcPrListItem[]> {
	const cwd = session.sessionManager.getCwd();
	const { repo } = await requireGithubRepo(cwd);
	const rows = await git.github.json<GhPrListRow[]>(
		cwd,
		[
			"pr",
			"list",
			"--repo",
			repo,
			"--state",
			input.state ?? "open",
			"--limit",
			String(input.limit ?? 50),
			"--json",
			PR_LIST_FIELDS,
		],
		undefined,
		{ repoProvided: true },
	);
	return rows.map(row => ({
		number: row.number ?? 0,
		title: row.title ?? "",
		url: row.url ?? "",
		isDraft: row.isDraft ?? false,
		authorLogin: row.author?.login ?? "ghost",
		headRefName: row.headRefName ?? "",
		baseRefName: row.baseRefName ?? "",
		additions: row.additions ?? 0,
		deletions: row.deletions ?? 0,
		updatedAt: row.updatedAt ?? "",
		reviewDecision: row.reviewDecision ?? null,
		checks: rollupCounts(row.statusCheckRollup),
	}));
}

interface GhPrDetailRow extends GhPrListRow {
	body?: string | null;
	mergeStateStatus?: string;
	files?: Array<{ path?: string; additions?: number; deletions?: number; changeType?: string }> | null;
	statusCheckRollup?: Array<{ name?: string; context?: string; status?: string; conclusion?: string | null }> | null;
}

const PR_DETAIL_FIELDS =
	"number,title,url,isDraft,author,body,baseRefName,headRefName,mergeStateStatus,additions,deletions,reviewDecision,files,statusCheckRollup";

export async function buildRpcPrDetail(session: AgentSession, input: { number: number }): Promise<RpcPrDetail> {
	const cwd = session.sessionManager.getCwd();
	const { repo } = await requireGithubRepo(cwd);
	let row: GhPrDetailRow;
	try {
		row = await git.github.json<GhPrDetailRow>(
			cwd,
			["pr", "view", String(input.number), "--repo", repo, "--json", PR_DETAIL_FIELDS],
			undefined,
			{ repoProvided: true },
		);
	} catch (error) {
		throw new RpcPrError(
			"pr_not_found",
			`PR #${input.number}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return {
		number: row.number ?? input.number,
		title: row.title ?? "",
		url: row.url ?? "",
		isDraft: row.isDraft ?? false,
		authorLogin: row.author?.login ?? "ghost",
		body: row.body ?? "",
		baseRefName: row.baseRefName ?? "",
		headRefName: row.headRefName ?? "",
		mergeStateStatus: row.mergeStateStatus ?? "",
		additions: row.additions ?? 0,
		deletions: row.deletions ?? 0,
		reviewDecision: row.reviewDecision ?? null,
		files: (row.files ?? []).map(file => ({
			path: file.path ?? "",
			changeType: file.changeType ?? "modified",
			additions: file.additions ?? 0,
			deletions: file.deletions ?? 0,
		})),
		checks: (row.statusCheckRollup ?? []).map(check => ({
			name: check.name ?? check.context ?? "check",
			status: check.status ?? "",
			conclusion: check.conclusion ?? null,
		})),
	};
}

/** One file's unified-diff slice (lazy per expand — the index rides pr_get). */
export async function buildRpcPrFileDiff(
	session: AgentSession,
	input: { number: number; path: string },
): Promise<{ diff: string }> {
	const cwd = session.sessionManager.getCwd();
	const { repo } = await requireGithubRepo(cwd);
	let text: string;
	try {
		text = await git.github.text(
			cwd,
			["pr", "diff", String(input.number), "--repo", repo, "--color", "never"],
			undefined,
			{
				repoProvided: true,
			},
		);
	} catch (error) {
		throw new RpcPrError(
			"pr_not_found",
			`PR #${input.number}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const payload = parsePrUnifiedDiff(text);
	const file = payload.files.find(entry => entry.path === input.path);
	if (!file) throw new RpcPrError("pr_not_found", `PR #${input.number} has no file ${input.path}`);
	return { diff: payload.unified.slice(file.startOffset, file.endOffset) };
}

/** AI-draft title/body from the head branch's commits + change summary. */
export async function buildRpcPrDraft(
	session: AgentSession,
	input: { base?: string; head?: string },
): Promise<RpcPrDraftResult> {
	const cwd = session.sessionManager.getCwd();
	const { defaultBranch } = await requireGithubRepo(cwd);
	const base = input.base ?? defaultBranch ?? "HEAD~1";
	const head = input.head ?? (await git.branch.current(cwd)) ?? "HEAD";

	const [commits, nameOnlyText, diffStat] = await Promise.all([
		git.log.subjectsInRange(cwd, base, head, 50),
		git.diff(cwd, { base, head, nameOnly: true }),
		git.diff(cwd, { base, head, stat: true }),
	]);
	const files = nameOnlyText.split("\n").filter(Boolean);
	if (commits.length === 0 && files.length === 0) {
		throw new RpcPrError("pr_draft_failed", `No changes between ${base} and ${head}`);
	}

	const resolved = await resolvePrimaryModel(undefined, session.settings, session.modelRegistry);
	const userPrompt = prompt.render(prDraftUserPrompt, {
		base,
		head,
		commitCount: String(commits.length),
		commits: commits.join("\n"),
		fileCount: String(files.length),
		files: files.join("\n").slice(0, 6000),
		diffStat: diffStat.slice(0, 3000),
	});
	const message = await completeSimple(
		resolved.model,
		{
			systemPrompt: [prompt.render(prDraftSystemPrompt)],
			messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
			tools: [PrDraftTool],
		},
		{ apiKey: resolved.apiKey, maxTokens: 1500, reasoning: toReasoningEffort(resolved.thinkingLevel) },
	);
	const call = extractToolCall(message, PrDraftTool.name);
	if (!call) throw new RpcPrError("pr_draft_failed", "The model did not return a draft");
	const draft = validateToolCall([PrDraftTool], call) as (typeof PrDraftToolSchema)["infer"];
	return { title: draft.title.trim(), body: draft.body.trim() };
}

export async function createRpcPr(
	session: AgentSession,
	input: { title: string; body: string; base?: string; head?: string; draft?: boolean },
): Promise<RpcPrCreateResult> {
	const cwd = session.sessionManager.getCwd();
	const { repo } = await requireGithubRepo(cwd);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pr-body-"));
	try {
		const bodyFile = path.join(tempDir, "body.md");
		await fs.writeFile(bodyFile, input.body);
		const args = ["pr", "create", "--repo", repo, "--title", input.title, "--body-file", bodyFile];
		if (input.base) args.push("--base", input.base);
		if (input.head) args.push("--head", input.head);
		if (input.draft) args.push("--draft");
		const output = await git.github.text(cwd, args, undefined, { repoProvided: true });
		const url = output.match(/https:\/\/\S+\/pull\/\d+/)?.[0];
		const number = url ? Number(url.split("/").pop()) : Number.NaN;
		if (!url || !Number.isFinite(number)) {
			throw new RpcPrError("pr_create_failed", `gh pr create returned no PR URL: ${output.slice(0, 300)}`);
		}
		return { url, number };
	} catch (error) {
		if (error instanceof RpcPrError) throw error;
		throw new RpcPrError("pr_create_failed", error instanceof Error ? error.message : String(error));
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

/** Checkout a PR into its worktree (gh.ts machinery) — the GUI opens a bound tab on it. */
export async function checkoutRpcPr(
	session: AgentSession,
	input: { number: number },
): Promise<{ path: string; branch: string }> {
	const cwd = session.sessionManager.getCwd();
	await requireGithubRepo(cwd);
	try {
		// ToolSession's required fields beyond cwd are inert for checkout — the
		// machinery only reads cwd (verified gh.ts:3270-3373), so null getters
		// and the live settings instance satisfy the type without behavior change.
		const outcome = await checkoutPullRequest(
			{
				cwd,
				hasUI: false,
				settings: session.settings,
				getSessionFile: () => null,
				getSessionSpawns: () => null,
			},
			undefined,
			{ prRef: String(input.number), repo: undefined, force: false },
		);
		return { path: outcome.worktreePath, branch: outcome.localBranch };
	} catch (error) {
		throw new RpcPrError("pr_checkout_failed", error instanceof Error ? error.message : String(error));
	}
}

function rollupCounts(rollup: GhPrListRow["statusCheckRollup"]): { success: number; failure: number; pending: number } {
	const counts = { success: 0, failure: 0, pending: 0 };
	for (const check of rollup ?? []) {
		if (check.conclusion === "SUCCESS" || check.conclusion === "NEUTRAL" || check.conclusion === "SKIPPED")
			counts.success += 1;
		else if (check.conclusion) counts.failure += 1;
		else counts.pending += 1;
	}
	return counts;
}
