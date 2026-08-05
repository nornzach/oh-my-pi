/**
 * Structured plan approval for RPC mode.
 *
 * The TUI approves plans through an overlay (`InteractiveMode.handlePlanApproval`);
 * print mode auto-aborts on proposal. RPC mode needs a third path: the agent's
 * `write` to `xd://propose` must not hit `dispatchResolutionDevice`'s "No plan is
 * awaiting approval" throw, and the host must be able to review and resolve the
 * plan over the wire.
 *
 * This controller mirrors the two existing non-TUI precedents:
 * - print-mode's proposal handler (`preparePlanForReview` + plan-file promotion
 *   + mode_change journal entry), and
 * - the shared silent-abort on proposal (`markPlanInternalAbortPending` + `abort`)
 *   so the model cannot re-dispatch `xd://propose` in a loop while the host decides.
 *
 * Approval drives the same session methods as `InteractiveMode.#approvePlan`:
 * exit plan mode, (optionally) reset/compact context, pin the plan reference,
 * and dispatch the synthetic plan-approved prompt. Behavioral deltas vs the TUI
 * are documented on {@link RpcPlanApprovalController.resolve}.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../../internal-urls";
import { humanizePlanTitle } from "../../plan-mode/approved-plan";
import { readPlanFile } from "../../plan-mode/plan-files";
import planModeApprovedPrompt from "../../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../../prompts/system/plan-mode-compact-instructions.md" with {
	type: "text",
};
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { PROPOSE_DEVICE_NAME, type PlanProposalHandler, writeDeviceDispatch } from "../../tools/resolve";
import type { RpcPlanApprovalOption, RpcPlanApprovalResult, RpcPlanProposalFrame } from "./rpc-types";

/** Options advertised on the `plan_proposal` frame (TUI review parity). */
const PLAN_PROPOSAL_OPTIONS = ["execute", "compact", "keep_context", "refine"];

export interface RpcPendingPlanProposal {
	planFilePath: string;
	title: string;
}

interface RpcPlanApprovalControllerDeps {
	session: AgentSession;
	output: (frame: RpcPlanProposalFrame) => void;
	/** Fire-and-forget error reporting for dispatched turns (mirrors the prompt command's onError). */
	onError: (error: Error) => void;
}

export class RpcPlanApprovalController {
	readonly #deps: RpcPlanApprovalControllerDeps;
	#pending: RpcPendingPlanProposal | undefined;
	#handler: PlanProposalHandler | undefined;

	constructor(deps: RpcPlanApprovalControllerDeps) {
		this.#deps = deps;
	}

	get pending(): RpcPendingPlanProposal | undefined {
		return this.#pending;
	}

	/** True when this controller's proposal handler is the installed one. */
	get armed(): boolean {
		return this.#handler !== undefined && this.#deps.session.peekPlanProposalHandler() === this.#handler;
	}

	/**
	 * Arm/disarm from the live plan-mode state. Called on `set_plan_mode`, on
	 * startup (a resumed session may restore plan mode from the journal), and
	 * after session changes. Never clobbers a foreign handler (e.g. prewalk's
	 * plan-yolo installs its own).
	 */
	syncArmed(): void {
		const enabled = this.#deps.session.getPlanModeState()?.enabled === true;
		if (enabled) this.#arm();
		else this.#disarm();
	}

	#arm(): void {
		if (this.#handler) return;
		const existing = this.#deps.session.peekPlanProposalHandler();
		if (existing) return;
		const session = this.#deps.session;
		this.#handler = async title => {
			// Print-mode's handler, verbatim: validate + shape the proposal, promote
			// the reviewed plan path into plan-mode state, and journal it.
			const result = await session.preparePlanForReview(title);
			const details = result.details;
			if (details) {
				const state = session.getPlanModeState();
				if (state?.enabled) {
					session.setPlanModeState({ ...state, planFilePath: details.planFilePath });
				}
				session.sessionManager.appendModeChange("plan", { planFilePath: details.planFilePath });
				this.#pending = { planFilePath: details.planFilePath, title: details.title };
			}
			return result;
		};
		session.setPlanProposalHandler(this.#handler);
	}

	#disarm(): void {
		if (!this.#handler) return;
		if (this.#deps.session.peekPlanProposalHandler() === this.#handler) {
			this.#deps.session.setPlanProposalHandler(null);
		}
		this.#handler = undefined;
		this.#pending = undefined;
	}

	#localProtocolOptions(): LocalProtocolOptions {
		const sessionManager = this.#deps.session.sessionManager;
		return {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		};
	}

	/**
	 * Session-event hook; subscribe alongside the main event forwarder. Emits the
	 * `plan_proposal` frame once the proposal tool result lands, then silently
	 * aborts the turn — the same stop both the TUI (`#abortPlanApprovalTurnSilently`)
	 * and print mode perform so the model cannot resubmit in a loop while the host
	 * reviews.
	 */
	async handleSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type !== "tool_execution_end" || event.isError) return;
		const dispatch = writeDeviceDispatch(event.toolName, event.result);
		if (dispatch?.tool !== PROPOSE_DEVICE_NAME || dispatch.mode !== "execute") return;
		const pending = this.#pending;
		if (!pending) return;
		const planContent =
			(await readPlanFile(pending.planFilePath, {
				localProtocolOptions: this.#localProtocolOptions(),
				cwd: this.#deps.session.sessionManager.getCwd(),
			})) ?? "";
		this.#deps.output({
			type: "plan_proposal",
			planFilePath: pending.planFilePath,
			title: pending.title,
			planContent,
			options: [...PLAN_PROPOSAL_OPTIONS],
		});
		const session = this.#deps.session;
		session.markPlanInternalAbortPending();
		try {
			await session.abort();
		} finally {
			session.clearPlanInternalAbortPending();
		}
	}

	/**
	 * Dispatch a turn without blocking the RPC command queue (the execution turn
	 * streams events like any `prompt` command). Mirrors the TUI's streaming guard:
	 * queue behind an in-flight turn, falling back to `followUp` on the busy race.
	 */
	#dispatchTurn(text: string, options: { synthetic: boolean }): void {
		const session = this.#deps.session;
		const task = (async () => {
			if (session.isStreaming) {
				await session.followUp(text, undefined, { synthetic: options.synthetic });
				return;
			}
			try {
				await session.prompt(text, { synthetic: options.synthetic });
			} catch (error) {
				if (!(error instanceof AgentBusyError)) throw error;
				await session.followUp(text, undefined, { synthetic: options.synthetic });
			}
		})();
		void task.catch(error => {
			this.#deps.onError(error instanceof Error ? error : new Error(String(error)));
		});
	}

	/**
	 * Resolve the pending proposal from a `plan_approval` command.
	 *
	 * Reject maps to the TUI's dismiss (no feedback — stay in plan mode) or
	 * "Refine plan" (feedback re-prompted as a user turn, plan mode stays active).
	 *
	 * Approve mirrors `InteractiveMode.#approvePlan` with these documented deltas:
	 * - RPC plan mode never swapped the tool set or model on entry, so there is
	 *   nothing to restore on exit (the TUI restores both).
	 * - The TUI's model-tier slider (`executionModel`) is overlay-only; execution
	 *   continues on the current model.
	 * - The compact path passes the distillation prompt as `customInstructions`
	 *   to `session.compact` (the TUI rides a private `internalGuidance` channel,
	 *   issue #4359); a failed/cancelled compaction leaves the approval standing
	 *   but undispatched with the plan reference pinned, matching the TUI's
	 *   cancelled branch.
	 * - The TUI's in-overlay plan edits are host-side: the host edits the plan
	 *   file itself before approving, and the approved content is re-read from
	 *   disk here (same as the TUI's final disk re-read when unedited).
	 */
	async resolve(command: {
		approved: boolean;
		option?: RpcPlanApprovalOption;
		feedback?: string;
	}): Promise<RpcPlanApprovalResult> {
		const pending = this.#pending;
		if (!pending) {
			throw new Error("No plan is awaiting approval");
		}
		this.#pending = undefined;
		const session = this.#deps.session;

		if (!command.approved) {
			const feedback = command.feedback?.trim();
			if (feedback) {
				this.#dispatchTurn(feedback, { synthetic: false });
				return { approved: false, dispatched: true };
			}
			return { approved: false, dispatched: false, reason: "rejected" };
		}

		const option = command.option ?? "execute";
		const planFilePath = pending.planFilePath;
		const planContent = await readPlanFile(planFilePath, {
			localProtocolOptions: this.#localProtocolOptions(),
			cwd: session.sessionManager.getCwd(),
		});
		if (!planContent) {
			throw new Error(`Plan file not found at ${planFilePath}`);
		}

		// Exit plan mode (session-level subset of TUI #exitPlanMode — see deltas).
		session.setPlanModeState(undefined);
		this.#disarm();
		session.sessionManager.appendModeChange("none");

		if (option === "execute") {
			// Fresh session carrying the session-local artifacts forward, mirroring
			// #approvePlan's handleClearCommand + artifact copy. The plan file must
			// be rewritten into the new session's local root because local:// is
			// session-scoped.
			const oldLocalRoot = resolveLocalUrlToPath("local://", this.#localProtocolOptions());
			await session.newSession();
			const newLocalRoot = resolveLocalUrlToPath("local://", this.#localProtocolOptions());
			await copyLocalArtifactsForFreshSession(oldLocalRoot, newLocalRoot);
			const newLocalPath = resolveLocalUrlToPath(planFilePath, this.#localProtocolOptions());
			await fs.mkdir(path.dirname(newLocalPath), { recursive: true });
			await fs.writeFile(newLocalPath, planContent);
		} else if (option === "compact") {
			// Pin the reference BEFORE compaction so queued turns see the approved
			// plan (mirrors #approvePlan's compact branch).
			session.setPlanReferencePath(planFilePath);
			const compactionPrompt = prompt.render(planModeCompactInstructionsPrompt, { planFilePath });
			try {
				await session.compact(compactionPrompt);
			} catch (error) {
				// Cancelled/failed compaction: approval stands, execution is not
				// dispatched, and the plan reference stays pinned for the host's
				// next prompt (TUI cancelled branch).
				return {
					approved: true,
					dispatched: false,
					reason: `compaction failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}

		session.setPlanReferencePath(planFilePath);
		session.markPlanReferenceSent();
		// Seed an auto session name from the plan title (no-op when already named).
		const seededName = humanizePlanTitle(pending.title);
		if (seededName && !session.sessionManager.getSessionName()) {
			await session.setSessionName(seededName, "auto");
		}
		const planModePrompt = prompt.render(planModeApprovedPrompt, {
			planFilePath,
			contextPreserved: option !== "execute",
		});
		this.#dispatchTurn(planModePrompt, { synthetic: true });
		return { approved: true, dispatched: true };
	}
}

/** Mirror of `InteractiveMode.#copyLocalArtifactsForFreshSession`. */
async function copyLocalArtifactsForFreshSession(sourceRoot: string, destinationRoot: string): Promise<void> {
	if (sourceRoot === destinationRoot) return;
	let sourceRootStat: { isDirectory(): boolean };
	try {
		sourceRootStat = await fs.lstat(sourceRoot);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	if (!sourceRootStat.isDirectory()) return;
	await fs.mkdir(destinationRoot, { recursive: true });
	await copyLocalArtifactEntries(sourceRoot, destinationRoot);
}

async function copyLocalArtifactEntries(sourceDir: string, destinationDir: string): Promise<void> {
	const entries = await fs.readdir(sourceDir, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = path.join(sourceDir, entry.name);
		const destinationPath = path.join(destinationDir, entry.name);
		if (entry.isDirectory()) {
			await fs.mkdir(destinationPath, { recursive: true });
			await copyLocalArtifactEntries(sourcePath, destinationPath);
			continue;
		}
		if (entry.isFile()) {
			await fs.mkdir(path.dirname(destinationPath), { recursive: true });
			await fs.copyFile(sourcePath, destinationPath);
		}
	}
}
