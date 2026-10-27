/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur (message frames stamped with `messageId`)
 * - Prompt completion: one `prompt_result` per accepted prompt, correlated by the command `id`
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type AgentTool, agentPauseGate, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type ImageContent, type Model, PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { buildCopyTargets } from "@oh-my-pi/pi-tui/overlays/copy-targets";
import {
	type WordCompletionEngine,
	type WordCompletionMethod,
	type WordCompletionQuery,
	wordCompletionQuery,
} from "@oh-my-pi/pi-tui/prompt/word-completion";
import { getAvailableThemesWithPaths, getResolvedThemeColors, type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import { $env, isRecord, logger, Snowflake, setProjectDir, toError } from "@oh-my-pi/pi-utils";
import { orderedSettings } from "../../config/all-settings";
import { resolveRoleChain } from "../../config/model-resolver";
import { roleCandidatePool } from "../../config/model-roles";
import { lookup as lookupSetting } from "../../config/registry";
import { cfgPlanDefaultOnStartup, cfgPlanEnabled } from "../../plan-mode/settings";
import { cfgSttLanguage } from "../../stt/settings";
import { cfgSpeechVoice } from "../../tts/settings";
import {
	type ExtensionAskDialogQuestion,
	type ExtensionAskDialogResult,
	type ExtensionAskDialogSubmitResult,
	type ExtensionCustomOptions,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
	type InteractiveTerminalHost,
	timedOutAskDialogResult,
} from "../../extensibility/extensions";
import {
	type BuiltSkillPromptMessage,
	loadSkillPrompt,
	parseSkillInvocation,
	type Skill,
	type SkillPromptInput,
	type SkillRediscoverySource,
} from "../../extensibility/skills";
import { rebindMemoryBackendForCwd } from "../../hindsight/backend";
import { requestTextPrediction, textPredictionBackend } from "../../predict/client";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentSession, type NavigateTreeResult, SessionBusyError } from "../../session/agent-session";
import type { MCPManager } from "../../mcp/manager";
import { reconnectMcpManagerServer } from "../../mcp/oauth-reauth";
import type { DroppedPrompt, RestoredQueuedMessage } from "../../session/agent-session-types";
import { CACHE_WARMING_MODES } from "../../session/cache-warmer";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import { findMostRecentNonEmptySession, findRecentSessionContinuation } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { setSessionPinned } from "../../session/session-pins";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { listLogoutAccounts, logoutCredential } from "../../slash-commands/helpers/logout";
import { describeRedeemOutcome, toResetUsageAccounts } from "../../slash-commands/helpers/reset-usage";
import { sttClient } from "../../stt/asr-client";
import { resolveSttModelSpec } from "../../stt/models";
import type { ToolSession } from "../../tools";
import { interactivePtyEnv } from "../../tools/bash-interactive";
import { DebugTool } from "../../tools/debug";
import { cfgSttEnabled } from "../../stt/settings";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { DEFAULT_TTS_VOICE } from "../../tts/models";
import { ttsClient } from "../../tts/tts-client";
import { resolveLocalSpeechModelId } from "../../tts/vocalizer";
import { decodeWav, encodeWav } from "../../tts/wav";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../../tools/todo";
import type { EventBus } from "../../utils/event-bus";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import {
	formatPersistenceDurabilityFailure,
	formatPersistenceFailure,
	formatPersistenceNotice,
} from "../persistence-failure";
import { initializeExtensions } from "../runtime-init";
import { cfgSpellingAutocomplete } from "../settings";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import { applyRpcHookEnabled, applyRpcMcpAction, applyRpcPluginEnabled, applyRpcSkillEnabled } from "./rpc-actions";
import { applyRpcAbortSubagent, applyRpcReviveSubagent, buildRpcAgentDefinitions } from "./rpc-agents";
import { RpcBtwController } from "./rpc-btw";
import { isReadOnlyCollabCommand, RpcCollabController } from "./rpc-collab";
import { RpcHostDictationBridge } from "./rpc-host-dictation";
import { selectRpcEntries } from "./rpc-compat";
import { buildRpcCommandArgCompletions } from "./rpc-completions";
import {
	buildRpcHooksResult,
	buildRpcMarketplacesResult,
	buildRpcMcpServersResult,
	buildRpcMemoryReport,
	buildRpcPluginsResult,
	buildRpcPromptTemplatesResult,
	buildRpcSkillsResult,
} from "./rpc-domains";
import {
	buildRpcProvidersResult,
	buildRpcSettingsSchema,
	buildRpcUsageResult,
	validateRpcSettingValue,
} from "./rpc-extensions";
import { applyRpcImportForeignSession, buildRpcForeignSessionList } from "./rpc-foreign";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "./rpc-frame";
import { getRpcGitChanges, getRpcGitDiff } from "./rpc-git-diff";
import { RpcGoalController } from "./rpc-goal";
import { claimRpcInput, readRpcInputFrames } from "./rpc-input";
import { RpcDictationBridge, type RpcDictationControllerFactory } from "./rpc-dictation";
import { RpcLiveBridge, type RpcLiveSessionFactory } from "./rpc-live";
import { RpcTerminalHost, resolveTerminalShell } from "./rpc-terminal";
import { resolveCliEntryCmd } from "../../subprocess/worker-client";
import { createAdvisorConfigOverlay } from "../advisor-config-overlay";
import { TerminalTool } from "./rpc-terminal-tool";
import { RpcBrowserHost } from "./rpc-browser-host";
import { applyRpcMarketplaceAction } from "./rpc-marketplace";
import {
	applyRpcMcpAdd,
	applyRpcMcpReauth,
	applyRpcMcpReauthCancel,
	applyRpcMcpTest,
	type RpcMcpOAuthUi,
	RpcMcpReauthBusyError,
} from "./rpc-mcp-extra";
import { applyRpcMemoryEdit, applyRpcMemoryUpdate, buildRpcMemoryActivity, buildRpcMemoryOverview } from "./rpc-memory";
import {
	attachRpcMessageEntryIds,
	attachRpcTranscriptEntryIds,
	pageRpcMessages,
	RPC_MESSAGES_PAGE_BUSY_ERROR,
	RpcMessagesPageError,
} from "./rpc-messages";
import { buildRpcModelRoleMetadata, buildRpcModelRoles } from "./rpc-model-roles";
import { RpcGoalModeController, RpcLoopModeController, RpcVibeModeController } from "./rpc-modes";
import { runRpcOmfg } from "./rpc-omfg";
import {
	buildRpcOmpUpdate,
	buildRpcSecurityDashboard,
	buildRpcSecurityScan,
	buildRpcSecurityValidationPrompt,
	buildRpcSshHosts,
	cancelRpcSecurityScan,
	manageRpcSshHost,
	setRpcSecurityDisposition,
	startRpcSecurityScan,
	testRpcSshHost,
} from "./rpc-operations";
import { RpcOutputWriter } from "./rpc-output";
import { applyRpcWriteLocalPaste } from "./rpc-paste";
import { RpcPlanApprovalController } from "./rpc-plan";
import {
	applyRpcDeletePluginSetting,
	applyRpcSetPluginFeatures,
	applyRpcSetPluginSetting,
	buildRpcGuiThemes,
	buildRpcPluginDetail,
} from "./rpc-plugins";
import {
	buildRpcPrDetail,
	buildRpcPrDraft,
	buildRpcPrFileDiff,
	buildRpcPrList,
	buildRpcPrRepo,
	checkoutRpcPr,
	createRpcPr,
	RpcPrError,
} from "./rpc-pr";
import {
	RpcExtensionUserMessageTracker,
	RpcPromptResults,
	type RpcPromptTicket,
	watchAndReportPromptResult,
} from "./rpc-prompt-results";
import {
	applyRpcGetQueue,
	applyRpcQueueClear,
	applyRpcQueueEdit,
	applyRpcQueueMove,
	applyRpcQueueRemove,
} from "./rpc-queue";
import {
	buildRpcActiveTools,
	buildRpcContextReport,
	buildRpcJobs,
	previewRpcShareSession,
	shareRpcSession,
} from "./rpc-reports";
import {
	applyRpcFresh,
	applyRpcGetForceTool,
	applyRpcReloadPlugins,
	applyRpcSetForceTool,
	applyRpcSetPrewalk,
	applyRpcShakeContext,
} from "./rpc-session-actions";
import { RpcSessionEventForwarder } from "./rpc-session-events";
import { isSessionSettled } from "../../session/session-settle";
import { applyRpcForkFrom, applyRpcSwitchLeaf } from "./rpc-session-extra";
import { RpcSessionSettleWatcher, watchedScheduledTurnProbe } from "./rpc-session-settle";
import { buildRpcSessionTree } from "./rpc-session-tree";
import { applyRpcManageSkill, buildRpcSkillDetail } from "./rpc-skills";
import { RpcSubagentRegistry, readRpcSubagentTranscript, resolveOwnedLiveSubagent } from "./rpc-subagents";
import { startRpcTan } from "./rpc-tan";
import { type HostedComponentFactory, showHostedComponent } from "./rpc-custom-ui";
import type {
	RpcAbortAndRestoreQueueResult,
	RpcAvailableModelsResult,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcExtensionUISelectOptionDetail,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcModelCatalogUpdateFrame,
	RpcOpenSessionResult,
	RpcReloadPluginsResult,
	RpcRemoveQueuedMessageResult,
	RpcResponse,
	RpcSessionState,
	RpcSettingProvenance,
	RpcSubagentSubscriptionLevel,
	RpcTerminalCliSubcommand,
} from "./rpc-types";
import {
	applyRpcAddDirectory,
	applyRpcMoveSession,
	applyRpcRemoveDirectory,
	buildRpcWorkspaceDirectories,
	RpcWorkspaceBusyError,
	RpcWorkspaceRestoreError,
} from "./rpc-workspace";
import { buildRpcGitStatus, createRpcWorktree, RpcWorktreeError, removeRpcWorktree } from "./rpc-worktree";

const INVALID_TEXT_CURSOR_ERROR = "cursor must be an integer UTF-16 offset within text";

function isTextCursor(text: unknown, cursor: unknown): text is string {
	return (
		typeof text === "string" &&
		typeof cursor === "number" &&
		Number.isInteger(cursor) &&
		cursor >= 0 &&
		cursor <= text.length
	);
}

/**
 * Composer ghost-text query at a UTF-16 cursor offset, gated like the TUI
 * editor's: only at the end of a line, and only for a prose word.
 */
function wordQueryAt(text: string, cursor: number): WordCompletionQuery | undefined {
	if (cursor < text.length && text[cursor] !== "\n") return undefined;
	const lines = text.split("\n");
	let cursorLine = 0;
	let lineStart = 0;
	while (lineStart + lines[cursorLine]!.length < cursor) lineStart += lines[cursorLine++]!.length + 1;
	return wordCompletionQuery(lines, cursorLine, cursor - lineStart);
}

interface QueuedWordPrediction {
	engine: WordCompletionEngine;
	query: WordCompletionQuery;
	resolve(suffix: string | null): void;
	reject(error: unknown): void;
}

/**
 * `predict_word` answers for one RPC session, with the TUI provider's flow
 * control: one engine request in flight, and a newer request replaces the one
 * waiting behind it (the replaced request answers `null`), so a burst of
 * typing costs the shared daemon at most two inferences.
 */
export class RpcWordPredictor {
	#busy = false;
	#queued: QueuedWordPrediction | undefined;
	readonly #request: typeof requestTextPrediction;

	/** `request` is a test seam. */
	constructor(request: typeof requestTextPrediction = requestTextPrediction) {
		this.#request = request;
	}

	/**
	 * Ghost-text suffix for the word ending at `cursor`, or `null` when the
	 * engine is off, nothing applies, or a newer request superseded this one.
	 * Rejects when the prediction daemon cannot answer.
	 */
	predict(method: WordCompletionMethod, text: string, cursor: number): Promise<string | null> {
		if (method === "off") return Promise.resolve(null);
		const query = wordQueryAt(text, cursor);
		if (!query) return Promise.resolve(null);
		if (!this.#busy) return this.#run(method, query);
		this.#queued?.resolve(null);
		const { promise, resolve, reject } = Promise.withResolvers<string | null>();
		this.#queued = { engine: method, query, resolve, reject };
		return promise;
	}

	async #run(engine: WordCompletionEngine, query: WordCompletionQuery): Promise<string | null> {
		this.#busy = true;
		try {
			const { suggestion } = await this.#request(engine, query.before, query.prefix);
			return suggestion?.suffix || null;
		} finally {
			this.#busy = false;
			const next = this.#queued;
			this.#queued = undefined;
			if (next) void this.#run(next.engine, next.query).then(next.resolve, next.reject);
		}
	}
}

// Re-export types for consumers
export type * from "./rpc-types";

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

/** Pending extension UI request map that can fail closed when the RPC client disconnects. */
export class RpcPendingExtensionRequests extends Map<string, PendingExtensionRequest> {
	#closedError: Error | undefined;

	override set(id: string, request: PendingExtensionRequest): this {
		if (this.#closedError) {
			request.reject(this.#closedError);
			return this;
		}
		return super.set(id, request);
	}

	/** Reject every active and future extension UI request. */
	rejectAll(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const requests = Array.from(this.values());
		this.clear();
		for (const request of requests) {
			request.reject(this.#closedError);
		}
	}
}

type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;

/** Return a prompt that never reached the agent to an RPC host's editor. */
export function reportDroppedPrompt(
	output: (frame: RpcExtensionUIRequest | object) => void,
	prompt: DroppedPrompt,
): void {
	output({
		type: "extension_ui_request",
		id: Snowflake.next() as string,
		method: "set_editor_text",
		text: prompt.text,
		images: prompt.images,
		prepend: true,
	} satisfies RpcExtensionUIRequest);
}

export type RpcSessionChangeCommand = Extract<
	RpcCommand,
	| { type: "new_session" }
	| { type: "drop_session" }
	| { type: "switch_session" }
	| { type: "branch" }
	| { type: "fork" }
>;

export type RpcQueueModeCommand = Extract<
	RpcCommand,
	{ type: "set_steering_mode" } | { type: "set_follow_up_mode" } | { type: "set_interrupt_mode" }
>;

export type RpcSessionChangeResult =
	| { type: "new_session"; data: { cancelled: boolean } }
	| { type: "drop_session"; data: { cancelled: boolean } }
	| { type: "switch_session"; data: { cancelled: boolean } }
	| { type: "branch"; data: { text: string; cancelled: boolean } }
	| { type: "fork"; data: { cancelled: boolean } };

export type RpcSessionChangeSession = Pick<
	AgentSession,
	"newSession" | "switchSession" | "branch" | "fork" | "isStreaming" | "isCompacting"
>;

export type RpcSkillCommandSession = Pick<
	AgentSession,
	"buildUserSkillPrompt" | "renderUserSkillPrompt" | "promptCustomMessage" | "skills" | "skillsSettings"
> &
	SkillRediscoverySource;
export type RpcSkillCommandResult = { agentInvoked: true };

export interface RpcSkillInvocation extends SkillPromptInput {
	skill: Skill;
	queueChipText: string;
}

/**
 * Fast in-memory pre-check for a skill invocation: settings gate, text shape,
 * and skill lookup. Returns null when the message is not a runnable skill
 * command. Performs no I/O — safe to run on the RPC serial queue.
 */
export function resolveRpcSkillInvocation(session: RpcSkillCommandSession, text: string): RpcSkillInvocation | null {
	if (!session.skillsSettings?.enableSkillCommands) return null;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return null;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return null;
	return {
		skill,
		args: parsed.args,
		prompt: parsed.prompt,
		queueChipText: text,
	};
}

/**
 * Slow half of a skill invocation: builds the skill prompt message (file I/O)
 * and dispatches it through the full prompt pipeline (usage preflight,
 * compaction checks, provider calls). Resolves once the turn is scheduled.
 * Must not run on the RPC serial queue's response path — register it with
 * watchAndReportPromptResult and answer the command once it is admitted.
 */
export async function runRpcSkillCommand(
	session: RpcSkillCommandSession,
	invocation: RpcSkillInvocation,
	streamingBehavior: "steer" | "followUp" = "steer",
	prebuilt?: BuiltSkillPromptMessage,
	onPromptAdmitted?: () => void,
	images?: ImageContent[],
): Promise<boolean> {
	const built = prebuilt ?? (await session.buildUserSkillPrompt(invocation.skill, invocation));
	return session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: images?.length ? [{ type: "text", text: built.message }, ...images] : built.message,
			display: true,
			details: built.details,
			attribution: "user",
		},
		{
			streamingBehavior,
			queueChipText: invocation.queueChipText,
			onPromptAdmitted,
		},
	);
}

/**
 * Skill branch of the `prompt` command: resolves the invocation cheaply, then
 * registers the slow dispatch with watchAndReportPromptResult and awaits
 * admission (or completion, for a message that settles without ever being
 * admitted) before answering. The caller still does not wait for the full
 * dispatch pipeline — building the skill prompt and running it (usage
 * preflight, compaction, provider calls) can outlast any client's prompt
 * timeout under provider stress; only queue admission gates the response.
 *
 * @returns `null` for a non-skill message, `"cancelled"` when `isCurrent`
 *   reports the submission was invalidated while the skill file was read.
 */
export async function dispatchRpcSkillPrompt(input: {
	ticket: RpcPromptTicket;
	session: RpcSkillCommandSession;
	message: string;
	streamingBehavior: "steer" | "followUp" | undefined;
	results: RpcPromptResults;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
	images?: ImageContent[];
	isCurrent?: () => boolean;
}): Promise<RpcSkillCommandResult | "cancelled" | null> {
	const invocation = resolveRpcSkillInvocation(input.session, input.message);
	if (!invocation) return null;
	// Read the skill before acknowledging the command so a missing SKILL.md
	// still fails immediately (a stale one is read from its rediscovered
	// replacement first). Rendering (and authorizing model tags) happens
	// only after the in-flight submission survives the currentness check.
	const loaded = await loadSkillPrompt(invocation.skill, input.session);
	if (input.isCurrent && !input.isCurrent()) return "cancelled";
	const built = input.session.renderUserSkillPrompt(loaded.skill, invocation, loaded.body);
	// A failure before admission still resolves this wait (without rejecting this
	// call) — reportPromptResult already routed it to onError and a failed prompt_result.
	await watchAndReportPromptResult({
		ticket: input.ticket,
		startPrompt: onPromptAdmitted =>
			runRpcSkillCommand(
				input.session,
				invocation,
				input.streamingBehavior ?? "steer",
				built,
				onPromptAdmitted,
				input.images,
			),
		results: input.results,
		onError: input.onError,
		extensionUserMessageTracker: input.extensionUserMessageTracker,
	});
	return { agentInvoked: true };
}

export async function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp" = "steer",
	images?: ImageContent[],
): Promise<RpcSkillCommandResult | false> {
	const invocation = resolveRpcSkillInvocation(session, text);
	if (!invocation) return false;
	await runRpcSkillCommand(session, invocation, streamingBehavior, undefined, undefined, images);
	return { agentInvoked: true };
}

/**
 * Dependencies for {@link dispatchRpcInputFrame}. Provided by the RPC mode
 * entrypoint; broken out so tests can drive the input loop with stubs.
 */
export interface RpcInputFrameDeps {
	handleCommand: (command: RpcCommand) => Promise<RpcResponse>;
	output: RpcOutput;
	errorResponse: (id: string | undefined, command: string, message: string) => RpcResponse;
	trackBackgroundTask?: (task: Promise<void>) => void;
	pendingExtensionRequests: Map<string, PendingExtensionRequest>;
	onHostToolResult: (frame: RpcHostToolResult) => void;
	onHostToolUpdate: (frame: RpcHostToolUpdate) => void;
	onHostUriResult: (frame: RpcHostUriResult) => void;
}

/**
 * Structural guard for a well-formed extension UI response frame. Mirrors the
 * shape declared in {@link RpcExtensionUIResponse} — a truthy record with
 * `type === "extension_ui_response"` and a string `id`. Payload variants (value,
 * confirmed, cancelled) are validated at the read site.
 */
function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_response" && typeof value.id === "string";
}

/** Dispatch side-channel frames that must overtake the serialized command queue. */
export function dispatchRpcControlFrame(parsed: unknown, deps: RpcInputFrameDeps): boolean {
	if (isRpcExtensionUIResponse(parsed)) {
		const pending = deps.pendingExtensionRequests.get(parsed.id);
		if (pending) pending.resolve(parsed);
		return true;
	}

	if (isRpcHostToolResult(parsed)) {
		deps.onHostToolResult(parsed);
		return true;
	}

	if (isRpcHostToolUpdate(parsed)) {
		deps.onHostToolUpdate(parsed);
		return true;
	}

	if (isRpcHostUriResult(parsed)) {
		deps.onHostUriResult(parsed);
		return true;
	}

	return false;
}

/**
 * Commands that skip the serial queue entirely; see {@link dispatchRpcInputFrame}.
 * Execution, discovery/import, OAuth, and local speech inference can all be slow;
 * their control frames or an unrelated prompt must remain readable while they
 * run. (`prompt` and `steer_subagent` are also backgrounded there, but start
 * through the serial tail.) `btw_cancel` is synchronous and must overtake a
 * `btw` still starting or a long serial command; `abort_branch_summary`
 * likewise overtakes the `navigate_tree` whose summary it stops.
 * A Set, not a Record: `type` is untrusted input and must not hit prototype keys.
 */
/** omp subcommands `terminal_run_cli` launches; a Set so untrusted input never reaches prototype keys. */
const TERMINAL_CLI_SUBCOMMANDS: ReadonlySet<string> = new Set<RpcTerminalCliSubcommand>(["git", "cleanse"]);

const BACKGROUND_COMMANDS: ReadonlySet<string> = new Set<RpcCommand["type"]>([
	"bash",
	"collab_join",
	"collab_start",
	"debug",
	// Host dictation: start waits on the model and stop on the transcript, while audio keeps arriving;
	// every handler is synchronous up to the controller call, so audio keeps its arrival order.
	"host_dictation_audio",
	"host_dictation_cancel",
	"host_dictation_start",
	"host_dictation_stop",
	"eval",
	"get_git_changes",
	"get_git_diff",
	"get_omp_update",
	"get_security_dashboard",
	"import_foreign_session",
	"list_foreign_sessions",
	"live_start",
	"mcp_reauth",
	"mcp_test",
	"pr_checkout",
	"pr_create",
	"pr_diff",
	"pr_draft",
	"pr_get",
	"pr_list",
	"pr_repo",
	"predict_word",
	// Both reach the provider's reset-credit API.
	"list_reset_credits",
	"redeem_reset_credit",
	"security_start",
	"ssh_test",
	"synthesize_speech",
	"transcribe_audio",
	"worktree_create",
	"worktree_remove",
	"btw_cancel",
	// Network or user waits that never touch the conversation: an OAuth login
	// waits on the browser, MCP and marketplace changes on connects and git,
	// usage and share on provider and upload round-trips. Plugin and MCP
	// reloads serialize among themselves.
	"get_usage",
	"login",
	"marketplace_action",
	"mcp_action",
	"mcp_add",
	"reload_plugins",
	"share_session",
	// Terminal handlers are synchronous up to the PTY call, so backgrounded
	// keystrokes keep their arrival order and never wait behind a slow command.
	"browser_host_start",
	"browser_host_stop",
	"terminal_close",
	"terminal_configure",
	"terminal_input",
	"terminal_list",
	"terminal_open",
	"terminal_resize",
	"terminal_run_cli",
	"tui_open",
	"terminal_snapshot",
	"abort_branch_summary",
]);

/**
 * Commands that start in order behind earlier ordinary commands but never hold
 * later ones. A manual `compact` or `handoff` is one model call over the whole
 * context — minutes on a large session — and on the serial tail it stalled
 * every `get_state`, transcript read and `abort` behind it. The session already
 * tolerates input during either, as the TUI relies on: prompts park until the
 * pass commits, steers/follow-ups wait in the preserved queues, `abort` cancels
 * it, and a second pass is refused. `omfg` runs an ephemeral side turn that
 * never writes the conversation. Plan approval is detached only when it
 * compacts: its fresh-session options must still hold later prompts.
 * `switch_leaf` stays serial: a branch summary has no prompt barrier.
 */
function isDetachedSerialCommand(command: RpcCommand): boolean {
	switch (command.type) {
		case "compact":
		case "handoff":
		case "omfg":
			return true;
		case "plan_approval":
			return command.approved && command.option === "compact";
		default:
			return false;
	}
}

/**
 * Dispatch a single parsed frame from the RPC input stream.
 *
 * Long-running and long-lived commands are dispatched in the background so
 * the caller can keep reading subsequent control frames. On top of
 * {@link BACKGROUND_COMMANDS} (long executions, source scans/imports, MCP
 * probes/OAuth, speech inference, `bash`, `predict_word`), a `prompt`
 * command's response is held until the message is admitted, which can span
 * real wall-clock time (image normalization, a vision-model description call).
 * `steer_subagent` likewise holds its response until the subagent accepts the
 * message, which for a subagent between turns includes its whole
 * pre-`agent_start` setup. Backgrounding them lets a client send `abort_bash`
 * while a shell command runs, or `abort` (and `steer`/`follow_up`/`get_state`)
 * while a `prompt` or `steer_subagent` is still admitting. `predict_word` is
 * backgrounded too, so a cold prediction engine never stalls the command queue
 * behind a keystroke. `live_start` and `dictation_start` respond only when
 * recording, so they are backgrounded and their stop commands can cancel them.
 * Response correlation is preserved via each command's `id`; ordering across
 * concurrent commands is not guaranteed and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or dispatched in the
 *   background (`bash`, `predict_word`, `live_start`, `dictation_start`, `prompt`, `steer`, `follow_up`, `steer_subagent`). Otherwise a promise that
 *   resolves once the response for the command has been emitted via `output`.
 *   Errors from `handleCommand` on a command dispatched inline propagate; the
 *   caller is expected to wrap them.
 */
export function dispatchRpcInputFrame(parsed: unknown, deps: RpcInputFrameDeps): Promise<void> | undefined {
	if (dispatchRpcControlFrame(parsed, deps)) return undefined;
	// Regular RPC command. The transport contract states each remaining frame
	// is an {@link RpcCommand}; `handleCommand`'s `default` arm surfaces
	// unknown discriminants as an error response, so we do not shape-check
	// the union here.
	const command = parsed as RpcCommand;

	// `bash` can run for a long time, and `prompt`'s response is held until
	// admission (see PromptOptions.onPromptAdmitted), which can likewise span
	// real wall-clock time; `steer_subagent` waits for the subagent to accept.
	// Dispatch them in the background so a subsequent frame — `abort_bash` for
	// a running `bash`, or `abort`/`steer`/`follow_up`/`get_state` for an
	// admitting `prompt` — can be read and handled without waiting for the
	// earlier command to finish on its own. `predict_word` is backgrounded so a
	// cold prediction engine never stalls the command queue behind a keystroke.
	// The response is emitted when `handleCommand` resolves; clients correlate
	// via `command.id`.
	if (
		BACKGROUND_COMMANDS.has(command.type) ||
		command.type === "prompt" ||
		command.type === "steer" ||
		command.type === "dictation_start" ||
		command.type === "follow_up" ||
		command.type === "steer_subagent"
	) {
		const task = (async () => {
			try {
				deps.output(await deps.handleCommand(command));
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				deps.output(deps.errorResponse(command.id, command.type, message));
			}
		})();
		deps.trackBackgroundTask?.(task);
		return undefined;
	}

	return (async () => {
		deps.output(await deps.handleCommand(command));
	})();
}

const USER_INPUT_TYPES: Record<string, true> = {
	prompt: true,
	steer: true,
	follow_up: true,
	abort_and_prompt: true,
};

const SESSION_CHANGE_TYPES: Record<string, true> = {
	new_session: true,
	switch_session: true,
	branch: true,
	fork: true,
	open_session: true,
};

/**
 * Orders user input and decides whether an accepted frame is still wanted.
 *
 * Every user-input, abort and session-change frame gets a sequence number when it
 * is accepted (read from stdin), not when its handler runs. An abort invalidates
 * input accepted before it immediately. A session change invalidates input accepted
 * before the change frame, and only once the change succeeds: a vetoed change keeps
 * that input, and input pipelined after the change still runs in the new session.
 */
export class RpcUserInputGate {
	#tail: Promise<void> = Promise.resolve();
	#sequence = 0;
	#validFrom = 0;
	#acceptedAt = new WeakMap<object, number>();

	/** Call from {@link RpcInputDispatcher.dispatch} before the handler is queued. */
	accept(command: RpcCommand): void {
		const isAbort =
			command.type === "abort" || command.type === "abort_and_prompt" || command.type === "abort_and_restore_queue";
		if (
			!isAbort &&
			!Object.hasOwn(USER_INPUT_TYPES, command.type) &&
			!Object.hasOwn(SESSION_CHANGE_TYPES, command.type)
		) {
			return;
		}
		const sequence = ++this.#sequence;
		this.#acceptedAt.set(command, sequence);
		if (isAbort) this.#validFrom = sequence;
	}

	/** A session change succeeded: invalidate input accepted before its frame. */
	commitSessionChange(command: RpcCommand): void {
		const sequence = this.#acceptedAt.get(command);
		if (sequence !== undefined && sequence > this.#validFrom) this.#validFrom = sequence;
	}

	/** False when an abort, or a successful session change, accepted after this frame invalidated it. */
	isCurrent(command: RpcCommand): boolean {
		const sequence = this.#acceptedAt.get(command);
		return sequence !== undefined && sequence >= this.#validFrom;
	}

	/** Run user-input work in accept order. The tail releases when `work` settles, not when a model turn ends. */
	enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(work, work);
		this.#tail = run.then(
			() => {},
			() => {},
		);
		return run;
	}
}

/** Starts prompts, steers, follow-ups and `steer_subagent` after earlier ordinary commands, without
 * awaiting admission. Control frames, `bash` and `predict_word` dispatch immediately (see
 * dispatchRpcInputFrame). `acceptInput` runs synchronously in {@link dispatch}, before the
 * handler is queued, so an abort can invalidate a frame that has not started yet. */
export class RpcInputDispatcher {
	#tail: Promise<void> = Promise.resolve();
	#tasks = new Set<Promise<void>>();
	readonly #deps: RpcInputFrameDeps;
	readonly #afterSerialCommand: (() => Promise<void>) | undefined;
	readonly #acceptInput: ((command: RpcCommand) => void) | undefined;

	constructor(options: {
		deps: RpcInputFrameDeps;
		afterSerialCommand?: () => Promise<void>;
		acceptInput?: (command: RpcCommand) => void;
	}) {
		this.#deps = options.deps;
		this.#afterSerialCommand = options.afterSerialCommand;
		this.#acceptInput = options.acceptInput;
	}

	/** Accept a parsed input frame without blocking the stdin reader. */
	dispatch(parsed: unknown): void {
		try {
			if (dispatchRpcControlFrame(parsed, this.#deps)) return;
			const command = parsed as RpcCommand;
			this.#acceptInput?.(command);
			// Bash and predict_word retain their immediate side channel. Prompts,
			// steers, follow-ups and steer_subagent start through the serial tail, but
			// dispatchRpcInputFrame backgrounds their admission.
			if (BACKGROUND_COMMANDS.has(command.type)) {
				dispatchRpcInputFrame(command, this.#deps);
				return;
			}

			const task = this.#tail.then(
				() => this.#dispatchSerialCommand(command),
				() => this.#dispatchSerialCommand(command),
			);
			// A detached command leaves the tail where it was: later commands
			// queue behind what preceded it, not behind its whole run.
			if (!isDetachedSerialCommand(command)) this.#tail = task.catch(() => {});
			this.#tasks.add(task);
			void task.finally(() => {
				this.#tasks.delete(task);
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(undefined, "parse", `Failed to parse command: ${message}`));
		}
	}

	/** Await every accepted serial command, including commands queued before EOF. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	async #dispatchSerialCommand(command: RpcCommand): Promise<void> {
		try {
			const awaited = dispatchRpcInputFrame(command, this.#deps);
			if (awaited) await awaited;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(command.id, command.type, message));
		} finally {
			await this.#afterSerialCommand?.();
		}
	}
}

/**
 * Coordinates deferred shutdown with in-flight background input tasks.
 *
 * `pi.shutdown()` from an extension only *requests* shutdown; the process must
 * not exit while a background-dispatched command (`bash`, `predict_word`,
 * `prompt` or `steer_subagent`, see
 * {@link dispatchRpcInputFrame}) still owes the client a response frame. The
 * coordinator tracks those tasks, re-checks the shutdown request whenever one
 * settles (covering a shutdown requested mid-command with no follow-up client
 * frame), and drains every tracked task before invoking `performShutdown`.
 * The shutdown sequence is latched so concurrent triggers (input loop and
 * settling tasks) run it exactly once.
 */
export class RpcShutdownCoordinator {
	#tasks = new Set<Promise<void>>();
	#shutdown: Promise<void> | undefined;
	readonly #isShutdownRequested: () => boolean;
	readonly #performShutdown: () => Promise<void>;

	constructor(options: { isShutdownRequested: () => boolean; performShutdown: () => Promise<void> }) {
		this.#isShutdownRequested = options.isShutdownRequested;
		this.#performShutdown = options.performShutdown;
	}

	/**
	 * Track a background input task. When it settles it is untracked and the
	 * shutdown request is re-checked, so a deferred shutdown fires even when
	 * no further client frames arrive.
	 */
	track(task: Promise<void>): void {
		this.#tasks.add(task);
		void task.finally(() => {
			this.#tasks.delete(task);
			// Fire-and-forget: performShutdown ends the process. Rejections are
			// not expected — hook errors are caught inside extensionRunner.emit,
			// and background tasks catch their own dispatch errors.
			void this.checkShutdownRequested();
		});
	}

	/** Await every tracked task, including tasks tracked while draining. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	/**
	 * If shutdown was requested, drain background tasks (so every owed
	 * response frame is written) before running the shutdown sequence.
	 */
	checkShutdownRequested(): Promise<void> {
		if (!this.#shutdown) {
			if (!this.#isShutdownRequested()) return Promise.resolve();
			this.#shutdown = this.drain().then(() => this.#performShutdown());
		}
		return this.#shutdown;
	}
}

/** UTF-8 JSON size of `value`, as compared against `RpcFrameEncoder.maxResponseBytes`. */
function encodedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Build the `remove_queued_message` response within `maxBytes`. The message is already removed,
 * so an oversized response must not become a transport-limit error that loses it: its images are
 * omitted instead (`imagesDropped`).
 */
export function fitRemoveQueuedMessageResponse(
	id: string | undefined,
	removed: RestoredQueuedMessage | undefined,
	maxBytes: number,
): RpcResponse {
	const response = (data: RpcRemoveQueuedMessageResult): RpcResponse => ({
		id,
		type: "response",
		command: "remove_queued_message",
		success: true,
		data,
	});
	if (!removed?.images) return response({ removed: removed !== undefined });
	const full = response({ removed: true, images: removed.images });
	return encodedBytes(full) <= maxBytes ? full : response({ removed: true, imagesDropped: true });
}

/**
 * Build the `abort_and_restore_queue` response within `maxBytes`. The queue is already withdrawn,
 * so an oversized response must not become a transport-limit error that loses it: images go first
 * (`imagesDropped`, keeping every text), then the newest entries (`truncated`, keeping an
 * oldest-first prefix of steering then follow-ups).
 */
export function fitAbortAndRestoreQueueResponse(
	id: string | undefined,
	restored: RpcAbortAndRestoreQueueResult,
	maxBytes: number,
): RpcResponse {
	const response = (data: RpcAbortAndRestoreQueueResult): RpcResponse => ({
		id,
		type: "response",
		command: "abort_and_restore_queue",
		success: true,
		data,
	});
	const full = response(restored);
	if (encodedBytes(full) <= maxBytes) return full;
	const imagesDropped = [...restored.steering, ...restored.followUp].some(entry => entry.images?.length);
	const flags = imagesDropped ? { imagesDropped: true as const } : {};
	const textOnly = {
		steering: restored.steering.map(({ text }) => ({ text })),
		followUp: restored.followUp.map(({ text }) => ({ text })),
	};
	if (imagesDropped) {
		const withoutImages = response({ ...textOnly, ...flags });
		if (encodedBytes(withoutImages) <= maxBytes) return withoutImages;
	}
	const fitted: RpcAbortAndRestoreQueueResult = {
		steering: [],
		followUp: [],
		...flags,
		truncated: true,
	};
	// Exact: each entry adds its own JSON plus a comma after the first in its array.
	let remaining = maxBytes - encodedBytes(response(fitted));
	for (const queue of ["steering", "followUp"] as const) {
		for (const entry of textOnly[queue]) {
			const cost = encodedBytes(entry) + (fitted[queue].length > 0 ? 1 : 0);
			if (cost > remaining) return response(fitted);
			fitted[queue].push(entry);
			remaining -= cost;
		}
	}
	return response(fitted);
}

export type RpcSubagentResetRegistry = Pick<RpcSubagentRegistry, "clear">;

/**
 * Handle RPC `cancel_subagent`: hard-kill one of this session's running
 * subagents through the same path as the Agent Hub / collab `kill` command.
 * Aborting the live turn and releasing the registry ref as an `aborted`
 * tombstone settles the owning `task` call (foreground or background) with an
 * aborted result, and disposing the session cancels its nested children.
 *
 * Only ids this session reported as running are reachable (see
 * {@link resolveOwnedLiveSubagent}). Returns `false` (a no-op) for unknown,
 * finished, or already-cancelled subagents so hosts can treat cancelling a
 * vanished subagent as success. Rejects when the tombstone cannot be persisted
 * or the abort fails; the subagent is still detached and disposed.
 */
export async function handleRpcCancelSubagent(
	subagentRegistry: Pick<RpcSubagentRegistry, "getReportedSubagent">,
	subagentId: string,
): Promise<boolean> {
	const owned = resolveOwnedLiveSubagent(subagentRegistry, subagentId);
	if (!owned) return false;
	// Start the release first: it publishes the `aborted` tombstone synchronously,
	// so the executor cannot accept the run's result (flipping the ref to idle)
	// while the abort below is still settling. Settle both together so a failed
	// tombstone write is reported here instead of escaping as an unhandled
	// rejection while the abort is pending.
	const [released, aborted] = await Promise.allSettled([
		AgentLifecycleManager.global().release(subagentId, owned.ref, {
			tombstone: true,
		}),
		owned.session.abort({ reason: USER_INTERRUPT_LABEL }),
	]);
	if (released.status === "rejected") throw released.reason;
	if (aborted.status === "rejected") throw aborted.reason;
	return released.value;
}

/**
 * Handle RPC `steer_subagent`: send the host's message to a running subagent
 * as its user, the same way Agent Hub chat does: `AgentLifecycleManager.ensureLive`,
 * then `prompt(message, { streamingBehavior: "steer" })` on the subagent's own
 * session. A mid-turn subagent is steered at its next step boundary; one
 * between turns starts its next turn. Because this is `prompt()`, extension,
 * custom and file slash commands run and prompt templates expand as in Agent
 * Hub chat (unlike RPC `steer`, which rejects extension commands). The message
 * is recorded in the subagent's transcript, never attributed to the parent.
 *
 * Only running subagents this session lists in `get_subagents` are reachable
 * (see {@link resolveOwnedLiveSubagent}); one whose result the parent already
 * accepted is refused. A running ref always holds a live session, so
 * `ensureLive` never revives here; it only cancels an in-flight idle park.
 *
 * Resolves once the message is accepted: queued into a running turn, or the
 * subagent's new turn started (`agent_start`). A refusal before that —
 * including a prompt dropped by an abort, disposal or usage preflight — is
 * returned as the error; the rest of the turn is not awaited and later
 * failures are logged. Returns an error message, or `undefined` once accepted.
 */
export async function handleRpcSteerSubagent(
	subagentRegistry: Pick<RpcSubagentRegistry, "getReportedSubagent">,
	subagentId: string,
	message: string,
): Promise<string | undefined> {
	const notRunning = `Subagent not running: ${subagentId}`;
	const owned = resolveOwnedLiveSubagent(subagentRegistry, subagentId);
	if (!owned) return notRunning;
	let session: AgentSession;
	try {
		session = await AgentLifecycleManager.global().ensureLive(subagentId);
	} catch {
		return notRunning;
	}
	// ensureLive awaits; the id may now belong to a different (same-name) agent,
	// or the subagent may have finished in the meantime.
	const current = resolveOwnedLiveSubagent(subagentRegistry, subagentId);
	if (current?.ref !== owned.ref || current.session !== session) return notRunning;

	const accepted = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe(event => {
		if (event.type === "agent_start") accepted.resolve();
	});
	session.prompt(message, { streamingBehavior: "steer", throwOnDrop: true }).then(
		() => accepted.resolve(),
		err => {
			accepted.reject(err);
			logger.warn("steer_subagent message failed", {
				subagentId,
				error: String(err),
			});
		},
	);
	try {
		await accepted.promise;
		return undefined;
	} catch (err) {
		return `Subagent refused the message: ${err instanceof Error ? err.message : String(err)}`;
	} finally {
		unsubscribe();
	}
}

export async function handleRpcSessionChange(
	session: RpcSessionChangeSession,
	command: RpcSessionChangeCommand,
	subagentRegistry?: RpcSubagentResetRegistry,
	requestedModel?: Model,
): Promise<RpcSessionChangeResult> {
	switch (command.type) {
		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const cancelled = !(await session.newSession(options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "new_session", data: { cancelled } };
		}

		case "drop_session": {
			if (session.isStreaming || session.isCompacting) {
				throw new Error("Cannot delete a session while it is running");
			}
			const cancelled = !(await session.newSession({ drop: true }));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "drop_session", data: { cancelled } };
		}

		case "switch_session": {
			const options = requestedModel ? { model: requestedModel } : undefined;
			const cancelled = !(await session.switchSession(command.sessionPath, options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "switch_session", data: { cancelled } };
		}

		case "branch": {
			const result = await session.branch(command.entryId);
			if (!result.cancelled) subagentRegistry?.clear();
			return {
				type: "branch",
				data: { text: result.selectedText, cancelled: result.cancelled },
			};
		}

		case "fork": {
			// RPC forks are snapshots: refuse while work could still write into the transcript.
			// fork() rechecks after its awaits; interactive /fork keeps carrying running bash across.
			const cancelled = !(await session.fork(command.entryId, {
				requireIdle: true,
			}));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "fork", data: { cancelled } };
		}
	}
	throw new Error("Unsupported RPC session change command");
}

export type RpcOpenSessionSession = Pick<
	AgentSession,
	"newSession" | "switchSession" | "sessionFile" | "sessionId" | "messages" | "model" | "setModel"
>;

/**
 * Continue the newest non-empty session in `sessionDir`, or start a fresh one
 * there — the runtime equivalent of `--session-dir <dir> --continue`, so a host
 * can bind a pre-spawned process to a conversation it keys by directory. Like
 * `--continue`, it opens the copy the conversation went on in when that session
 * moved off its file (see {@link findRecentSessionContinuation}).
 * Reopening the session that is already active is a no-op and does not abort a run.
 *
 * With `model`, the session uses that model instead of its saved one, like an
 * explicit `--model`; otherwise a saved model that cannot be restored fails the
 * switch (see {@link AgentSession.switchSession}).
 *
 * @throws Error when the process runs without session persistence (`--no-session`).
 */
export async function openRpcSession(
	session: RpcOpenSessionSession,
	sessionDir: string,
	subagentRegistry?: RpcSubagentResetRegistry,
	model?: Model,
): Promise<RpcOpenSessionResult> {
	if (!session.sessionFile) throw new Error("open_session requires session persistence (omit --no-session)");
	const dir = path.resolve(sessionDir);
	const recent = await findMostRecentNonEmptySession(dir);
	const latest = recent ? ((await findRecentSessionContinuation(recent))?.session.path ?? recent) : null;
	const current = path.resolve(session.sessionFile);
	const alreadyOpen = latest
		? current === path.resolve(latest)
		: path.dirname(current) === dir && session.messages.length === 0;
	let cancelled = false;
	if (!alreadyOpen) {
		cancelled = latest
			? !(await session.switchSession(latest, model ? { model } : undefined))
			: !(await session.newSession({ sessionDir: dir }));
		if (!cancelled) subagentRegistry?.clear();
	}
	// A resumed session is bound to the model by the switch; an already-open or
	// fresh one selects it as `set_model` would.
	if (!cancelled && model && !modelsAreEqual(session.model, model)) await session.setModel(model);
	return {
		cancelled,
		resumed: !cancelled && latest !== null,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
	};
}

type RpcModelLookupSession = Pick<AgentSession, "getAvailableModels" | "modelRegistry">;

/**
 * The available model with exactly this provider and id. Models missing from
 * the current catalog wait for in-flight background discovery first: on cold
 * start, discovery-backed providers (proxy / ollama / etc.) populate seconds
 * after session ready. Catalog hits skip the wait, so the RPC queue is not
 * stalled behind unrelated discovery.
 */
async function findRpcModel(session: RpcModelLookupSession, provider: string, modelId: string) {
	const find = () => session.getAvailableModels().find(m => m.provider === provider && m.id === modelId);
	const model = find();
	if (model) return model;
	await session.modelRegistry.awaitBackgroundRefresh();
	return find();
}

/** The optional `provider`/`modelId` pair of `open_session` or `switch_session`, validated like `set_model`. */
async function resolveRequestedRpcModel(
	session: RpcModelLookupSession,
	command: { provider?: string; modelId?: string },
): Promise<Model | undefined> {
	const { provider, modelId } = command;
	if (provider === undefined && modelId === undefined) return undefined;
	if (provider === undefined || modelId === undefined) throw new Error("provider and modelId must be given together");
	const model = await findRpcModel(session, provider, modelId);
	if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
	return model;
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
			loadMode: defaultLoadModeForToolName(name, tool.loadMode),
			readsSkillUris: tool.readsSkillUris,
		};
	});
}

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isSubagentSubscriptionLevel(value: unknown): value is RpcSubagentSubscriptionLevel {
	return value === "off" || value === "progress" || value === "events";
}

/** Sends an RPC select request while retaining aligned option descriptions. */
export function requestRpcSelect(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	options: ExtensionUISelectItem[],
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const labels = new Array<string>(options.length);
	let optionDetails: RpcExtensionUISelectOptionDetail[] | undefined;
	for (let index = 0; index < options.length; index++) {
		const option = options[index]!;
		labels[index] = getExtensionUISelectOptionLabel(option);
		if (typeof option === "string") continue;
		const description = option.description?.trim();
		if (!description) continue;
		optionDetails ??= Array.from({ length: options.length }, () => ({}));
		optionDetails[index] = { description };
	}

	return requestRpcDialog(
		pendingRequests,
		output,
		dialogOptions,
		undefined,
		{
			method: "select",
			title,
			options: labels,
			...(optionDetails ? { optionDetails } : {}),
			timeout: dialogOptions?.timeout,
		},
		response => parseValueDialogResponse(response, dialogOptions),
	);
}

/** Sends an RPC input request, passing optional secret masking and timeout metadata. */
export function requestRpcInput(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	placeholder?: string,
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	return requestRpcDialog(
		pendingRequests,
		output,
		dialogOptions,
		undefined,
		{
			method: "input",
			title,
			placeholder,
			timeout: dialogOptions?.timeout,
			...(dialogOptions?.secret !== undefined ? { secret: dialogOptions.secret } : {}),
		},
		response => parseValueDialogResponse(response, dialogOptions),
	);
}

/** Validates `ask` answers against the questions; any mismatch throws instead of guessing. */
function parseAskDialogResponse(
	response: RpcExtensionUIResponse,
	questions: ExtensionAskDialogQuestion[],
	dialogOptions: ExtensionUIDialogOptions,
): ExtensionAskDialogSubmitResult | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions.onTimeout?.();
		return undefined;
	}
	const answers: unknown = "answers" in response ? response.answers : undefined;
	if (!Array.isArray(answers) || answers.length !== questions.length) {
		throw new Error(`Ask dialog response must carry ${questions.length} answers in question order`);
	}
	return {
		kind: "submit",
		results: questions.map((question, index) => {
			const answer: unknown = answers[index];
			if (!isRecord(answer) || answer.id !== question.id) {
				throw new Error(`Ask dialog answer ${index} must have id ${JSON.stringify(question.id)}`);
			}
			const labels = question.options.map(option => option.label);
			const multi = question.multi ?? false;
			const { selectedOptions, customInput } = answer;
			if (!Array.isArray(selectedOptions)) {
				throw new Error(`Ask dialog answer ${JSON.stringify(question.id)} must carry a selectedOptions array`);
			}
			const selected: string[] = [];
			for (const label of selectedOptions) {
				if (typeof label !== "string" || !labels.includes(label)) {
					throw new Error(
						`Ask dialog answer ${JSON.stringify(question.id)} selected unknown option ${JSON.stringify(label)}`,
					);
				}
				if (selected.includes(label)) {
					throw new Error(
						`Ask dialog answer ${JSON.stringify(question.id)} selected ${JSON.stringify(label)} twice`,
					);
				}
				selected.push(label);
			}
			if (customInput !== undefined && typeof customInput !== "string") {
				throw new Error(`Ask dialog answer ${JSON.stringify(question.id)} customInput must be a string`);
			}
			const custom = customInput?.trim() || undefined;
			if (!multi && (selected.length > 1 || (selected.length > 0 && custom !== undefined))) {
				throw new Error(
					`Ask dialog answer ${JSON.stringify(question.id)} is single-select but carries more than one answer`,
				);
			}
			return {
				id: question.id,
				question: question.question,
				options: labels,
				multi,
				selectedOptions: selected,
				customInput: custom,
			};
		}),
	};
}

/** Sends all ask questions as one RPC `ask` dialog; a timeout answers every question with its recommended option. */
export async function requestRpcAskDialog(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	questions: ExtensionAskDialogQuestion[],
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<ExtensionAskDialogResult | undefined> {
	let timedOut = false;
	const opts: ExtensionUIDialogOptions = {
		...dialogOptions,
		onTimeout: () => {
			timedOut = true;
			dialogOptions?.onTimeout?.();
		},
	};
	const result = await requestRpcDialog(
		pendingRequests,
		output,
		opts,
		undefined,
		{ method: "ask", questions, timeout: dialogOptions?.timeout },
		response => parseAskDialogResponse(response, questions, opts),
	);
	return timedOut ? timedOutAskDialogResult(questions) : result;
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	let settled = false;

	const cleanup = () => {
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: string | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		finish(undefined);
	};

	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
	pendingRequests.set(id, {
		resolve: response => {
			if ("cancelled" in response && response.cancelled) {
				finish(undefined);
			} else if ("value" in response) {
				finish(response.value);
			} else {
				finish(undefined);
			}
		},
		reject: fail,
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
	} as RpcExtensionUIRequest);
	return promise;
}

/** Sends an RPC extension dialog and cancels the remote presentation when its signal aborts. */
export function requestRpcDialog<T>(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	opts: ExtensionUIDialogOptions | undefined,
	defaultValue: T,
	request: Record<string, unknown>,
	parseResponse: (response: RpcExtensionUIResponse) => T,
): Promise<T> {
	if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let timeoutId: NodeJS.Timeout | undefined;

	const cleanup = () => {
		clearTimeout(timeoutId);
		opts?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	// Tells the host to close a dialog omp has already settled, so a late answer
	// cannot look actionable after abort or timeout.
	const cancelHostDialog = () =>
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
	const onAbort = () => {
		cancelHostDialog();
		cleanup();
		resolve(defaultValue);
	};
	opts?.signal?.addEventListener("abort", onAbort, { once: true });

	if (opts?.timeout !== undefined) {
		timeoutId = setTimeout(() => {
			opts.onTimeout?.();
			cancelHostDialog();
			cleanup();
			resolve(defaultValue);
		}, opts.timeout);
	}

	pendingRequests.set(id, {
		resolve: response => {
			cleanup();
			try {
				resolve(parseResponse(response));
			} catch (err) {
				reject(err);
			}
		},
		reject,
	});
	output({
		type: "extension_ui_request",
		id,
		...request,
	} as RpcExtensionUIRequest);
	return promise;
}
/**
 * Shows an OAuth authorization URL. A host that answers `cancelled: true`, or
 * a channel that closes, calls `onDismiss`; aborting `signal` closes a dialog
 * the host has not answered once the flow that opened it ends. Returns the
 * request id, which pasted-code prompts carry as `authCodeFor`.
 */
export function requestRpcOpenUrl(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	info: { url: string; launchUrl?: string; instructions?: string },
	options: { signal: AbortSignal; onDismiss: (reason?: Error) => void },
): string {
	const id = Snowflake.next() as string;
	const close = () => {
		pendingRequests.delete(id);
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
	};
	const settle = () => {
		options.signal.removeEventListener("abort", close);
		pendingRequests.delete(id);
	};
	pendingRequests.set(id, {
		resolve: response => {
			settle();
			if ("cancelled" in response && response.cancelled) options.onDismiss();
		},
		reject: reason => {
			settle();
			options.onDismiss(reason);
		},
	});
	options.signal.addEventListener("abort", close, { once: true });
	output({
		type: "extension_ui_request",
		id,
		method: "open_url",
		url: info.url,
		launchUrl: info.launchUrl,
		instructions: info.instructions,
	} as RpcExtensionUIRequest);
	return id;
}

/**
 * Applies a queue-mode RPC command to the calling session only. Owns the
 * `persist: false` contract (#11555) in one place so no dispatcher arm can
 * silently restore machine-global writes.
 */
export function applyRpcQueueModeCommand(session: AgentSession, command: RpcQueueModeCommand): void {
	switch (command.type) {
		case "set_steering_mode":
			session.setSteeringMode(command.mode, false);
			break;
		case "set_follow_up_mode":
			session.setFollowUpMode(command.mode, false);
			break;
		case "set_interrupt_mode":
			session.setInterruptMode(command.mode, false);
			break;
	}
}

/**
 * Report a store failure as an error `notice` frame and a session move as a
 * warning one (each with a stderr mirror) — issue #11493. Frames go straight
 * through the mode's `output` rather than `session.emitNotice`: dispose clears
 * the session's event listeners before it closes the store (agent-session.ts
 * `#doDispose`), so a failure latched during `close()` would have no subscriber
 * left to forward it and the client would see a nonzero exit with no notice at
 * all. `onFailure` records the failure for the mode's own teardown
 * attribution: a failure still latched at dispose is what makes
 * `session.dispose()` reject.
 */
export function registerRpcPersistenceSurface(
	session: Pick<AgentSession, "sessionManager">,
	output: (frame: object) => void,
	onFailure?: (error: Error) => void,
): () => void {
	const unsubscribeFailures = session.sessionManager.onPersistenceError(error => {
		onFailure?.(error);
		const message = formatPersistenceFailure(error.message);
		output({
			type: "notice",
			level: "error",
			message,
			source: "session-persistence",
		});
		process.stderr.write(`${message}\n`);
	});
	const unsubscribeNotices = session.sessionManager.onPersistenceNotice(notice => {
		const message = formatPersistenceNotice(notice);
		output({
			type: "notice",
			level: "warning",
			message,
			source: "session-persistence",
		});
		process.stderr.write(`${message}\n`);
	});
	return () => {
		unsubscribeFailures();
		unsubscribeNotices();
	};
}

/** Re-scope a moved RPC session before acknowledging the move to its host. */
export async function rebindRpcSessionCwd(
	session: AgentSession,
	newCwd: string,
	reloadPluginState: () => Promise<unknown>,
): Promise<void> {
	setProjectDir(newCwd);
	await session.settings.reloadForCwd(newCwd);
	await rebindMemoryBackendForCwd(session);
	await reloadPluginState();
}

/** Startup options for {@link runRpcMode}. */
export interface RpcModeOptions {
	/** `--mode rpc-ui`: route tool UI (e.g. ask) over the protocol, independently of headless extensions. */
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** `--no-ui`: extensions run with `hasUI=false` and no UI frames; tool UI and host-issued login are unaffected. */
	headless?: boolean;
	subagentEventBus?: EventBus;
	input?: ReadableStream<Uint8Array>;
	/** Builds `live_start` sessions; defaults to the real {@link LiveSessionController}. */
	createLiveSession?: RpcLiveSessionFactory;
	/** Builds the native speech controller; tests may substitute the capture boundary. */
	createDictationController?: RpcDictationControllerFactory;
	/** The session's MCP manager, so `/mcp` builtins resolve and reconnect live servers. */
	mcpManager?: MCPManager;
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(session: AgentSession, options: RpcModeOptions = {}): Promise<never> {
	const {
		setToolUIContext,
		headless = false,
		subagentEventBus,
		input = claimRpcInput(),
		createLiveSession,
		createDictationController,
	} = options;
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.PI_NOTIFICATIONS = "off";

	const frameEncoder = new RpcFrameEncoder();
	// Bun on Windows writes a piped process.stdout with a blocking WriteFile on the
	// JS thread and never reports backpressure, so a client that stops reading
	// stdout froze the whole worker, stdin reader included. An fd write stream
	// writes from the threadpool and reports backpressure, letting the writer spool.
	const stdout = process.platform === "win32" ? fs.createWriteStream("", { fd: 1, autoClose: false }) : process.stdout;
	// The writer can fail before the bridge is constructed.
	let dictationBridge: RpcDictationBridge | undefined = undefined;
	const outputWriter = new RpcOutputWriter(stdout, failure => {
		logger.error("RPC output delivery failed", { error: String(failure) });
		dictationBridge?.dispose();
		void session.dispose().finally(() => process.exit(1));
	});
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		outputWriter.write(frameEncoder.encodeFrames(obj));
		if (isRecord(obj) && obj.type === "response" && obj.command === "negotiate_protocol" && obj.success === true)
			frameEncoder.setProtocolVersion(2);
	};
	const emitRpcTitles = shouldEmitRpcTitles();

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return {
			id,
			type: "response",
			command,
			success: true,
			data,
		} as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string, code?: string): RpcResponse => {
		return {
			id,
			type: "response",
			command,
			success: false,
			error: message,
			...(code ? { code } : {}),
		};
	};

	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();
	const wordPredictor = new RpcWordPredictor();
	const btw = new RpcBtwController(session, output);
	// A continuation abandoned while waiting leaves nothing to end the activity stretch: re-check settlement.
	const goalController = new RpcGoalController(session, () => void settleWatcher.check());
	// A scheduled or held goal turn will start a turn: every settle report treats it as busy,
	// and any report of "not settled" for that reason is later closed by `session_settled`.
	const goalTurnScheduled = watchedScheduledTurnProbe(
		() => goalController.continuationPending,
		() => settleWatcher,
	);
	const settleWatcher = new RpcSessionSettleWatcher(session, output, goalTurnScheduled);
	const promptResults = new RpcPromptResults(session, output, goalTurnScheduled, {
		costCapRefusal: () => session.costCapRefusal,
		settledWithoutRun: () => void settleWatcher.check(),
	});
	const sessionEvents = new RpcSessionEventForwarder(output);

	const pendingExtensionRequests = new RpcPendingExtensionRequests();
	// OAuth UI bridge for mcp_reauth (C1): the browser URL rides the EXISTING
	// open_url frame (same emission as the login command), progress rides
	// notify, and the manual code paste-back rides the EXISTING input dialog
	// plumbing (requestRpcDialog over pendingExtensionRequests).
	const rpcMcpOAuthUi: RpcMcpOAuthUi = {
		openUrl: (info, options) => requestRpcOpenUrl(pendingExtensionRequests, output, info, options),
		notify: message =>
			output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: "info",
			} as RpcExtensionUIRequest),
		input: (title, placeholder, signal, authCodeFor) =>
			requestRpcDialog<string | undefined>(
				pendingExtensionRequests,
				output,
				// The reauth cancel channel: aborting dismisses the remote input
				// dialog (method:"cancel" frame) and resolves the pending extension
				// request instead of leaking it.
				signal ? { signal } : undefined,
				undefined,
				{ method: "input", title, placeholder, ...(authCodeFor ? { authCodeFor } : {}) },
				response => parseValueDialogResponse(response, undefined),
			),
	};
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	// Live frames go straight to `output`, so `set_event_filter` (session events only) never drops them.
	const liveBridge = new RpcLiveBridge(session, output, createLiveSession);
	let lastDictationError: { message: string } | undefined;
	const sessionDictationBridge = new RpcDictationBridge(
		session,
		frame => {
			output(frame);
			if (frame.type === "dictation_end" && frame.error) lastDictationError = { message: frame.error };
		},
		createDictationController,
	);
	dictationBridge = sessionDictationBridge;
	const stopDictationForSessionChange = async (): Promise<void> => {
		const previousError = lastDictationError;
		try {
			await sessionDictationBridge.stop();
		} catch (cause) {
			// Only a reported transcription failure after cleanup may leave the change proceeding.
			if (
				sessionDictationBridge.active ||
				!lastDictationError ||
				lastDictationError === previousError ||
				!(cause instanceof Error) ||
				cause.message !== lastDictationError.message
			)
				throw cause;
			logger.warn("Dictation failed while changing sessions", { error: String(cause) });
		}
	};
	let sessionChangesInProgress = 0;
	const withSessionChange = async <T>(change: () => Promise<T>): Promise<T> => {
		sessionChangesInProgress++;
		try {
			return await change();
		} finally {
			sessionChangesInProgress--;
		}
	};
	// Two dictation paths share the speech model: the host's own microphone (`host_dictation_*`)
	// and omp's native capture (`dictation_*`). Only one may run, and neither during live voice.
	const hostDictation = new RpcHostDictationBridge(session, output, {
		isBlocked: () =>
			liveBridge.active
				? "End live mode before dictating."
				: dictationBridge?.active
					? "End dictation before starting another."
					: undefined,
	});
	const browserHost = new RpcBrowserHost();
	const terminalHost = new RpcTerminalHost({
		output,
		environment: async () => {
			const { shell: configuredShell, env } = session.settings.getShellConfig();
			return {
				...resolveTerminalShell(process.env.SHELL, configuredShell),
				cwd: session.sessionManager.getCwd(),
				env: interactivePtyEnv(env, { COLORTERM: "truecolor" }),
			};
		},
	});
	/** Tools the host registered with `set_host_tools` (executed by the host). */
	let hostTools: AgentTool[] = [];
	/** The agent's `terminal` tool while the host opts in with `terminal_configure`. */
	let terminalTool: TerminalTool | undefined;
	const refreshRpcTools = () =>
		session.refreshRpcHostTools(terminalTool ? [...hostTools, terminalTool as AgentTool] : hostTools);
	const subagentRegistry = subagentEventBus
		? new RpcSubagentRegistry(subagentEventBus, output, () => session.sessionFile)
		: undefined;
	const planApprovalController = new RpcPlanApprovalController({
		session,
		output,
		onError: err => output(error(undefined, "plan_approval", err.message)),
	});
	const vibeModeController = new RpcVibeModeController(session);
	const goalModeController = new RpcGoalModeController({
		session,
		onError: err => output(error(undefined, "goal", err.message)),
	});
	const loopModeController = new RpcLoopModeController({
		session,
		output,
		onError: err => output(error(undefined, "loop", err.message)),
	});

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		readonly supportsEditor = true;
		/** Set by `set_ask_dialog`; hosts that never opt in keep the select/editor ask fallback. */
		askDialogEnabled = false;
		/** Set by `terminal_configure`; `pty: true` bash runs here instead of without a terminal. */
		interactiveTerminal: InteractiveTerminalHost | undefined;

		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
		) {}

		get askDialog(): ExtensionUIContext["askDialog"] {
			if (!this.askDialogEnabled) return undefined;
			return (questions, dialogOptions) =>
				requestRpcAskDialog(this.pendingRequests, this.output, questions, dialogOptions);
		}

		select(
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcSelect(this.pendingRequests, this.output, title, options, dialogOptions);
		}

		confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				false,
				{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
				response => {
					if ("cancelled" in response && response.cancelled) {
						if (response.timedOut) dialogOptions?.onTimeout?.();
						return false;
					}
					if ("confirmed" in response) return response.confirmed;
					return false;
				},
			);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcInput(this.pendingRequests, this.output, title, placeholder, dialogOptions);
		}

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		}

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		}

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		}

		setWorkingMessage(_message?: string): void {
			// Not supported in RPC mode
		}

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				this.output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		}

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		}

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		}

		setTitle(title: string): void {
			// Title updates are low-value noise for most RPC hosts; opt in via PI_RPC_EMIT_TITLE=1.
			if (!emitRpcTitles) return;
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		}

		custom<T>(factory: HostedComponentFactory<T>, options?: ExtensionCustomOptions): Promise<T> {
			// A host that renders terminals (the GUI) shows the component in one;
			// any other host still resolves without running the factory.
			if (!this.interactiveTerminal) return Promise.resolve(undefined as T);
			return showHostedComponent(terminalHost, "Extension", factory, options);
		}

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		}

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		}

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		}

		async editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
			editorOptions?: { promptStyle?: boolean },
		): Promise<string | undefined> {
			return requestRpcEditor(this.pendingRequests, this.output, title, prefill, dialogOptions, editorOptions);
		}

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		}

		get theme(): Theme {
			return theme;
		}

		getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return Promise.resolve([]);
		}

		getTheme(_name: string): Promise<Theme | undefined> {
			return Promise.resolve(undefined);
		}

		setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
			// Theme switching not supported in RPC mode
			return Promise.resolve({
				success: false,
				error: "Theme switching not supported in RPC mode",
			});
		}

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		}

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		}

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		}

		getEditorComponent() {
			return undefined;
		}
	}

	// Wire up UI context for tool execution (ask tool, etc.) and extensions.
	// A single shared instance routes all responses received on stdin to the
	// correct waiting promise regardless of which code path created the request.
	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output);
	setToolUIContext?.(rpcUiContext, true);
	session.setPromptDropped(prompt => reportDroppedPrompt(output, prompt));
	const collabController = new RpcCollabController({
		session,
		eventBus: subagentEventBus,
		output,
		notify: (message, type) => rpcUiContext.notify(message, type),
		select: (title, options, dialogOptions) => rpcUiContext.select(title, options, dialogOptions),
		edit: (title, prefill, dialogOptions) => rpcUiContext.editor(title, prefill, dialogOptions),
	});
	const setAskDialog = (command: RpcCommand & { type: "set_ask_dialog" }): RpcResponse => {
		rpcUiContext.askDialogEnabled = command.enabled === true;
		return success(command.id, "set_ask_dialog", { enabled: rpcUiContext.askDialogEnabled });
	};
	const onPromptError = (id: string | undefined, command: string) => (promptError: Error) =>
		output(error(id, command, promptError.message));
	let askReanswerAwaitingResumeLeafId: string | undefined;

	// Discriminates a store failure from any other dispose rejection below.
	let persistenceFailure: Error | undefined;
	registerRpcPersistenceSurface(
		session,
		frame => output(frame),
		error => {
			persistenceFailure = error;
		},
	);

	/** Dispose the session, drain protocol output, then end the process. */
	const disposeAndExit = async (exitCode = 0): Promise<never> => {
		try {
			// The process ends regardless; report an unsaved side answer instead of skipping dispose.
			await btw.close().catch(btwError => {
				const message = toError(btwError).message;
				logger.error(message);
				output({
					type: "notice",
					level: "error",
					message,
					source: "btw-history",
				});
			});
			// Close the realtime call (microphone, socket) before the session it delegates into.
			hostDictation.cancel();
			dictationBridge.dispose();
			await liveBridge.stop();
			terminalHost.dispose();
			await session.dispose();
			browserHost.stop();
		} catch (error) {
			if (!persistenceFailure || error !== persistenceFailure) throw error;
			await outputWriter.close();
			try {
				if (!process.stderr.write(`${formatPersistenceDurabilityFailure(persistenceFailure.message)}\n`)) {
					const { promise, resolve } = Promise.withResolvers<void>();
					const settle = (): void => {
						process.stderr.off("drain", settle);
						process.stderr.off("error", settle);
						process.stderr.off("close", settle);
						resolve();
					};
					process.stderr.on("drain", settle);
					process.stderr.on("error", settle);
					process.stderr.on("close", settle);
					await promise;
				}
			} catch {
				// A mirror that cannot be written must not strand process teardown.
			}
			process.exit(1);
		}
		await outputWriter.close();
		process.exit(exitCode);
	};

	const initialize = async (): Promise<void> => {
		// session_start handlers may await UI replies from the already-running reader.
		await initializeExtensions(session, {
			mode: "rpc",
			// Extension-initiated session changes get the same goal quiesce/reattach as the commands below.
			wrapSessionChange: <T extends { cancelled: boolean }>(
				change: () => Promise<T>,
				{ detachesRun }: { detachesRun: boolean },
			): Promise<T> =>
				withSessionChange(async () => {
					await stopDictationForSessionChange();
					await btw.close();
					await goalController.beginSessionChange();
					let result: T | undefined;
					try {
						result = await change();
						return result;
					} finally {
						// Reattaches only if the session actually changed, then re-checks settlement.
						// A change that throws may already have detached the run: count it as detached.
						await goalController.endSessionChange({
							detachedRun: detachesRun && result?.cancelled !== true,
						});
						if (result && !result.cancelled) {
							// As for the host's new/switch commands: a detached run never yields, so
							// close the prompts it was answering. Branch and navigation leave a live
							// run streaming to its normal yield.
							if (detachesRun) promptResults.abortOpen();
							void settleWatcher.check();
						}
					}
				}),
			reportSendError: (action, err) => {
				output(error(undefined, action, err.message));
			},
			reportRuntimeError: err => {
				output({
					type: "extension_error",
					extensionPath: err.extensionPath,
					event: err.event,
					error: err.error,
				});
			},
			onShutdown: () => {
				shutdownState.requested = true;
				dictationBridge.dispose();
			},
			trackAgentInvokingMessage: task => {
				extensionUserMessageTracker.trackAgentMessageTask(task);
			},
			// Headless hosts get the extension runner's no-op UI: hasUI=false, dialogs resolve to defaults.
			uiContext: headless ? undefined : rpcUiContext,
		});

		// Output all agent events as JSON; prompt results follow the frame that settled them.
		session.subscribe(event => {
			// Forward through the single filter/stamping path (agent_end messages get
			// their persisted entry ids), then observe for prompt completion and settling.
			sessionEvents.forward(
				event.type === "agent_end"
					? {
							...event,
							messages: attachRpcMessageEntryIds(event.messages, session.sessionManager.getBranch(), message =>
								session.getPersistedMessageEntryId(message),
							),
						}
					: event,
			);
			// Before the prompt-result and settle reports: a goal continuation decided at this
			// agent_end is scheduled (and reported as pending) before either reads settlement.
			goalController.observe(event);
			promptResults.observe(event);
			settleWatcher.observe(event);
		});

		// Fork-specific event observers (plan/goal/loop controllers).
		session.subscribe(event => {
			void planApprovalController.handleSessionEvent(event).catch(err => {
				output(error(undefined, "plan_approval", err instanceof Error ? err.message : String(err)));
			});
			void goalModeController.handleSessionEvent(event).catch(err => {
				output(error(undefined, "goal", err instanceof Error ? err.message : String(err)));
			});
			if (event.type === "agent_end") loopModeController.onAgentEnd();
		});
		// A resumed session may already carry plan mode from the journal.
		planApprovalController.syncArmed();

		// Mirror print-mode's startup arming, minus the abort-after-proposal hook.
		if (
			cfgPlanDefaultOnStartup.get(session.settings) &&
			cfgPlanEnabled.get(session.settings) &&
			!session.sessionManager.getEntries().some(entry => entry.type === "mode_change") &&
			!session.getPlanModeState()?.enabled
		) {
			const planFilePath = session.getPlanReferencePath() || "local://PLAN.md";
			const previousTools = session.getEnabledToolNames();
			const planTools = session.hasBuiltInTool("write") ? [...new Set([...previousTools, "write"])] : previousTools;
			await session.setActiveToolsByName(planTools);
			session.setPlanModeState({
				enabled: true,
				planFilePath,
				workflow: "parallel",
			});
			session.sessionManager.appendModeChange("plan", { planFilePath });
		}
		session.subscribeCommandMetadataChanged(() => {
			void emitAvailableCommandsUpdate();
		});
		await emitAvailableCommandsUpdate();
		await goalController.reconcile();
		await goalController.settled();
	};

	const getAvailableCommands = async () =>
		buildAvailableSlashCommands(session, undefined, {
			includeTuiOnlyBuiltins: true,
		});
	// Plugin mutations and `reload_plugins` run off the serial tail; one reload at
	// a time, in arrival order, so an older reload never lands after a newer one.
	let pluginReloadChain: Promise<unknown> = Promise.resolve();
	const reloadPluginState = (): Promise<RpcReloadPluginsResult> => {
		const reload = () =>
			applyRpcReloadPlugins(session, commands => {
				output({ type: "available_commands_update", commands });
			});
		const result = pluginReloadChain.then(reload, reload);
		pluginReloadChain = result.catch(() => {});
		return result;
	};
	const emitAvailableCommandsUpdate = async () => {
		output({
			type: "available_commands_update",
			commands: await getAvailableCommands(),
		});
	};
	const emitSessionInfoUpdate = () => {
		output({
			type: "session_info_update",
			// JSON.stringify drops undefined properties. Null is the protocol's
			// explicit "clear the previous session title" value.
			title: session.sessionName ?? null,
			sessionId: session.sessionId,
			kind: session.sessionManager.getHeader()?.kind,
		});
	};

	// Bound the background-discovery await used by model-listing commands.
	// The RPC command queue is serial, so an unbounded
	// `awaitBackgroundRefresh()` that stalls (headless provider/MCP discovery
	// hanging) wedges every later command — including unrelated session
	// switches and health probes — until the sidecar restarts. Racing it
	// against a short timeout lets the command return current (possibly
	// partial) models and unblock the queue; the refresh keeps running in the
	// background and the next listing will reflect it once it completes.
	const DISCOVERY_WAIT_MS = 4_000;
	const awaitDiscoveryBounded = async (refresh: Promise<void>): Promise<boolean> => {
		const timeout = Promise.withResolvers<false>();
		const timer = setTimeout(() => timeout.resolve(false), DISCOVERY_WAIT_MS);
		try {
			return await Promise.race([refresh.then(() => true as const), timeout.promise]);
		} finally {
			clearTimeout(timer);
		}
	};
	const modelCatalogSnapshot = (refreshPending: boolean): RpcAvailableModelsResult => ({
		models: session.getAvailableModels(),
		discoveryStates: session.modelRegistry.getProviderDiscoveryStates(),
		refreshPending,
		generation: session.modelRegistry.getCatalogGeneration(),
	});
	const modelCatalogUpdateFrame = (): RpcModelCatalogUpdateFrame => ({
		type: "model_catalog_update",
		...modelCatalogSnapshot(false),
		...buildRpcProvidersResult(session),
	});
	let lastCatalogEventGeneration = -1;
	const emitModelCatalogUpdate = (): void => {
		const frame = modelCatalogUpdateFrame();
		if (frame.generation <= lastCatalogEventGeneration) return;
		lastCatalogEventGeneration = frame.generation;
		output(frame);
	};
	let watchedCatalogRefresh: Promise<void> | undefined;
	const watchCatalogRefresh = (refresh: Promise<void>): void => {
		if (watchedCatalogRefresh === refresh) return;
		watchedCatalogRefresh = refresh;
		void refresh.finally(() => {
			if (watchedCatalogRefresh === refresh) watchedCatalogRefresh = undefined;
			emitModelCatalogUpdate();
		});
	};
	const refreshModelCatalog = async (forceRefresh: boolean): Promise<RpcAvailableModelsResult> => {
		const authGeneration = session.modelRegistry.authStorage.credentials.generation;
		await session.modelRegistry.authStorage.credentials.reload();
		const authChanged = session.modelRegistry.authStorage.credentials.generation !== authGeneration;
		session.modelRegistry.refreshInBackground(forceRefresh || authChanged ? "online" : "online-if-uncached");
		const refresh = session.modelRegistry.awaitBackgroundRefresh();
		const completed = await awaitDiscoveryBounded(refresh);
		if (!completed) watchCatalogRefresh(refresh);
		return modelCatalogSnapshot(!completed);
	};

	// Workspace-directory mutations surface streaming refusals with the
	// machine-readable "busy" code (TUI "Cannot … while streaming." parity);
	// domain refusals (missing path, primary removal) ride the plain message.
	const workspaceError = (id: string | undefined, command: string, err: unknown): RpcResponse => {
		if (err instanceof RpcWorkspaceRestoreError) {
			shutdownState.requested = true;
			return error(id, command, err.message, err.code);
		}
		if (err instanceof RpcWorkspaceBusyError) return error(id, command, err.message, err.code);
		return error(id, command, err instanceof Error ? err.message : String(err));
	};
	// Worktree refusals carry a machine-readable code (the GUI's close dialog
	// branches on "worktree_dirty"); everything else is a plain message.
	const worktreeError = (id: string | undefined, command: string, err: unknown): RpcResponse => {
		if (err instanceof RpcWorktreeError) return error(id, command, err.message, err.code);
		return error(id, command, err instanceof Error ? err.message : String(err));
	};
	// PR failures carry the typed reason (gh_missing / no_github_remote / …) so
	// the PR Center renders the matching empty state instead of a raw message.
	const prError = (id: string | undefined, command: string, err: unknown): RpcResponse => {
		if (err instanceof RpcPrError) return error(id, command, err.message, err.code);
		return error(id, command, err instanceof Error ? err.message : String(err));
	};

	const inputGate = new RpcUserInputGate();
	type OrderedUserInput = Extract<RpcCommand, { type: "prompt" | "steer" | "follow_up" | "abort_and_prompt" }>;
	type OrderedInputOutcome = "local" | "cancelled" | "admitted" | "builtin-agent";
	const dispatchOrderedUserInput = (
		command: OrderedUserInput,
		ticket: RpcPromptTicket | undefined,
	): Promise<OrderedInputOutcome> =>
		inputGate.enqueue(async () => {
			const sessionId = session.sessionId;
			const isCurrent = () =>
				inputGate.isCurrent(command) && !shutdownState.requested && session.sessionId === sessionId;
			if (!isCurrent()) return "cancelled";
			let text = command.message;
			let images = command.images;
			const runner = session.extensionRunner;
			if (runner?.hasHandlers("input")) {
				const result = await runner.emitInput(text, images, "rpc");
				if (!isCurrent()) return "cancelled";
				if (result.handled) return "local";
				if (result.text !== undefined) text = result.text;
				if (result.images !== undefined) images = result.images;
			}
			if (!isCurrent()) return "cancelled";
			if (!text.trim() && !images?.length) return "local";
			if (command.type === "steer") {
				await session.steer(text, images);
				return "admitted";
			}
			if (command.type === "follow_up") {
				await session.followUp(text, images);
				return "admitted";
			}
			if (command.type === "prompt") {
				if (!ticket) return "cancelled";
				const skillResult = await dispatchRpcSkillPrompt({
					ticket,
					session,
					message: text,
					streamingBehavior: command.streamingBehavior,
					results: promptResults,
					onError: onPromptError(command.id, "prompt"),
					extensionUserMessageTracker,
					images,
					isCurrent,
				});
				if (skillResult === "cancelled") return "cancelled";
				if (skillResult) return "admitted";
				const builtinAbort = new AbortController();
				builtinCommandAborts.add(builtinAbort);
				let backgroundedBuiltin = false;
				const builtinResult = await executeAcpBuiltinSlashCommand(text, {
					session,
					sessionManager: session.sessionManager,
					settings: session.settings,
					cwd: session.sessionManager.getCwd(),
					output: commandOutput => output({ type: "command_output", text: commandOutput }),
					refreshCommands: emitAvailableCommandsUpdate,
					reloadPlugins: async () => {
						await reloadPluginState();
					},
					mcpManager: options.mcpManager,
					reconnectMcpServer: options.mcpManager
						? async (mcpName, selected) => {
								const manager = options.mcpManager!;
								const state = await reconnectMcpManagerServer(manager, mcpName, selected);
								if (state) {
									// RPC mode wires no tools-changed callback; refresh the
									// session binding so later prompts see the recovered tools.
									await session.refreshMCPTools(manager.getTools());
								}
								return state;
							}
						: undefined,
					signal: builtinAbort.signal,
					runCommandInBackground: task => {
						backgroundedBuiltin = true;
						shutdownCoordinator.track(task().finally(() => builtinCommandAborts.delete(builtinAbort)));
					},
					notifyTitleChanged: async () => {
						output({
							type: "session_info_update",
							title: session.sessionName,
							sessionId: session.sessionId,
						});
					},
					notifyConfigChanged: async () => {
						output({
							type: "config_update",
							model: session.model,
							thinkingLevel: session.thinkingLevel,
						});
					},
				});
				if (!backgroundedBuiltin) builtinCommandAborts.delete(builtinAbort);
				if (!isCurrent()) return "cancelled";
				if (builtinResult !== false) {
					if (!("prompt" in builtinResult)) {
						if (builtinResult.agentInvoked === true && ticket) {
							void session.waitForIdle().then(
								() => promptResults.settle(ticket),
								(idleError: unknown) =>
									promptResults.fail(
										ticket,
										idleError instanceof Error ? idleError.message : String(idleError),
									),
							);
							return "builtin-agent";
						}
						return "local";
					}
					text = builtinResult.prompt;
				}
			}
			if (!isCurrent() || !ticket) return "cancelled";
			await watchAndReportPromptResult({
				ticket,
				startPrompt: onPromptAdmitted =>
					session.prompt(text, {
						images,
						...(command.type === "prompt" ? { streamingBehavior: command.streamingBehavior } : {}),
						onPromptAdmitted,
					}),
				results: promptResults,
				onError: onPromptError(command.id, command.type),
				extensionUserMessageTracker,
			});
			return "admitted";
		});
	// Abort controllers for builtin commands whose work outlives the prompt
	// response (e.g. the `/mcp reauth` browser wait, dispatched through
	// `runCommandInBackground`). Host abort and disconnect must tear those
	// down, or a tracked task parks the shutdown drain for up to five minutes
	// and can persist credentials after the client asked to abort.
	const builtinCommandAborts = new Set<AbortController>();
	const abortBuiltinCommands = (reason: string): void => {
		for (const controller of builtinCommandAborts) controller.abort(reason);
		builtinCommandAborts.clear();
	};

	// Handle a single command
	const handleCommandImpl = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;
		if (collabController.state.readOnly && !isReadOnlyCollabCommand(command.type))
			return error(
				id,
				command.type,
				"This collaboration session is read-only. Leave it before changing the session.",
				"collab_read_only",
			);

		switch (command.type) {
			case "negotiate_protocol": {
				if (command.protocolVersion !== 2)
					return error(id, "negotiate_protocol", `Unsupported RPC protocol version: ${command.protocolVersion}`);
				return success(id, "negotiate_protocol", { protocolVersion: 2 });
			}

			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Guest prompts are relayed to the collaboration host and do not create a
				// local prompt ticket.
				if (collabController.isGuest && !command.message.trimStart().startsWith("/")) {
					collabController.sendPrompt(command.message, command.images);
					return success(id, "prompt");
				}
				// Allocate before dispatch so a builtin that schedules a turn (e.g.
				// `/retry`) cannot start its run ahead of the prompt's event position.
				const ticket = promptResults.begin(id);
				try {
					// Ack after admission, including hooks and skill image preparation, so a
					// queue edit sent after this response finds the message.
					const outcome = await dispatchOrderedUserInput(command, ticket);
					if (outcome === "local") {
						promptResults.discard(ticket);
						return success(id, "prompt", { agentInvoked: false });
					}
					if (outcome === "builtin-agent") return success(id, "prompt", { agentInvoked: true });
					if (outcome === "cancelled") {
						promptResults.settle(ticket);
						return success(id, "prompt");
					}
					return success(id, "prompt");
				} catch (promptSetupError) {
					promptResults.discard(ticket);
					throw promptSetupError;
				}
			}

			case "steer":
			case "follow_up": {
				if (collabController.sendPrompt(command.message, command.images)) return success(id, command.type);
				await dispatchOrderedUserInput(command, undefined);
				return success(id, command.type);
			}

			case "remove_queued_message": {
				if (typeof command.message !== "string") {
					return error(id, "remove_queued_message", "message must be a string");
				}
				if (command.queue !== "steering" && command.queue !== "followUp") {
					return error(id, "remove_queued_message", 'queue must be "steering" or "followUp"');
				}
				return fitRemoveQueuedMessageResponse(
					id,
					session.takeQueuedMessage(command.message, command.queue),
					frameEncoder.maxResponseBytes,
				);
			}

			case "promote_queued_message": {
				if (typeof command.message !== "string") {
					return error(id, "promote_queued_message", "message must be a string");
				}
				return success(id, "promote_queued_message", {
					promoted: session.promoteQueuedMessage(command.message),
				});
			}

			case "abort": {
				// TUI Esc pauses the loop before aborting the current iteration.
				loopModeController.pause();
				goalController.stopForHostAbort();
				abortBuiltinCommands("RPC command aborted by host");
				if (!collabController.sendAbort()) await session.abort({ reason: USER_INTERRUPT_LABEL });
				return success(id, "abort");
			}

			case "abort_and_restore_queue": {
				// Mirrors the TUI Esc restore: withdraw queued user input (including input the run
				// dequeued but never recorded) before aborting, so neither the aborted turn nor
				// abort()'s stranded-queue drain can run it.
				const restored = session.clearQueue({ forInterrupt: true });
				goalController.stopForHostAbort();
				abortBuiltinCommands("RPC command aborted by host");
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return fitAbortAndRestoreQueueResponse(id, restored, frameEncoder.maxResponseBytes);
			}

			case "abort_and_prompt": {
				loopModeController.pause();
				if (collabController.sendAbort()) {
					collabController.sendPrompt(command.message, command.images);
					return success(id, "abort_and_prompt");
				}
				goalController.stopForHostAbort();
				abortBuiltinCommands("RPC command aborted by host");
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				// After the abort so the aborted run's terminal agent_end cannot settle this prompt.
				loopModeController.onHostPrompt(command.message);
				const ticket = promptResults.begin(id);
				void dispatchOrderedUserInput(command, ticket).then(
					outcome => {
						if (outcome === "cancelled") promptResults.settle(ticket);
						else if (outcome === "local") promptResults.completeLocal(ticket);
					},
					(cause: unknown) => {
						// Already acknowledged: owe the late same-id error and a failed prompt_result.
						const promptError = cause instanceof Error ? cause : new Error(String(cause));
						onPromptError(id, "abort_and_prompt")(promptError);
						promptResults.fail(ticket, promptError.message);
					},
				);
				return success(id, "abort_and_prompt");
			}

			case "new_session":
			case "drop_session":
			case "switch_session":
			case "branch":
			case "fork": {
				// Guard: refuse cross-kind switches (I3 — reject rather than degrade)
				if (command.type === "switch_session") {
					const targetKind = (await SessionManager.peekSessionKind(command.sessionPath)) ?? "agent";
					const ownKind = session.sessionManager.getHeader()?.kind ?? "agent";
					if (targetKind !== ownKind) {
						return error(
							id,
							"switch_session",
							`Cannot switch from ${ownKind} session to ${targetKind} session. Open the target session in a new tab instead.`,
							"session_kind_mismatch",
						);
					}
				}
				// Fast refusal before the goal controller voids a waiting continuation;
				// fork() repeats the check after each of its own awaits.
				if (command.type === "fork" && session.isBusyForSnapshot) {
					return error(id, "fork", new SessionBusyError("fork the session").message, "session_busy");
				}
				// A manual compaction or handoff no longer holds the queue; branching under it would
				// land its write in the new session file.
				if (command.type === "branch" && (session.isCompacting || session.isGeneratingHandoff)) {
					return error(id, "branch", new SessionBusyError("branch the session").message, "session_busy");
				}
				const requestedModel =
					command.type === "switch_session" ? await resolveRequestedRpcModel(session, command) : undefined;
				// Validation first: a refused change must not cancel the running side question.
				await stopDictationForSessionChange();
				await btw.close();
				await goalController.beginSessionChange();
				let result: RpcSessionChangeResult | undefined;
				try {
					result = await handleRpcSessionChange(session, command, subagentRegistry, requestedModel);
				} catch (err) {
					// fork() refuses when work started while its transition awaited.
					if (err instanceof SessionBusyError) return error(id, command.type, err.message, "session_busy");
					throw err;
				} finally {
					// Branch and fork switch files in-process without detaching a run (fork requires idle).
					await goalController.endSessionChange({
						detachedRun: command.type !== "branch" && command.type !== "fork" && result?.data.cancelled !== true,
					});
					// Respond only once this change's reattach (and any queued ahead of it) has run.
					await goalController.settled();
				}
				if (!result.data.cancelled) {
					inputGate.commitSessionChange(command);
					// `branch` leaves a live run streaming to its normal yield; new/switch detach it.
					if (command.type !== "branch" && command.type !== "fork") promptResults.abortOpen();
					// The detached run publishes no terminal agent_end to settle on.
					void settleWatcher.check();
					await emitAvailableCommandsUpdate();
					emitSessionInfoUpdate();
				}
				planApprovalController.syncArmed();
				return success(id, result.type, result.data);
			}

			case "navigate_tree": {
				if (typeof command.entryId !== "string") return error(id, "navigate_tree", "entryId must be a string");
				// Validation first: a refused navigation must not cancel the running side question or touch the goal.
				if (!session.sessionManager.getEntry(command.entryId)) {
					return error(id, "navigate_tree", `Entry ${command.entryId} not found`, "entry_not_found");
				}
				// As `fork`: a run would keep writing into the branch the leaf just left.
				if (session.isBusyForSnapshot) {
					const busy = new SessionBusyError("navigate the session tree");
					return error(id, "navigate_tree", busy.message, "session_busy");
				}
				await btw.close();
				// A goal continuation waiting to start is held until the navigation ends, then resumes (same session).
				await goalController.beginSessionChange();
				let result: NavigateTreeResult;
				try {
					result = await session.navigateTree(command.entryId, {
						summarize: command.summarize === true,
						customInstructions:
							typeof command.customInstructions === "string" ? command.customInstructions : undefined,
						// Only to detect a re-answer, which moves nothing yet: refused below, since it needs a picker here.
						allowAskReopen: true,
						// Rechecked after the summary: work may have started while it ran.
						requireIdle: true,
					});
				} catch (err) {
					if (err instanceof SessionBusyError) return error(id, "navigate_tree", err.message, "session_busy");
					throw err;
				} finally {
					await goalController.endSessionChange();
					// Respond only once a resumed continuation is scheduled.
					await goalController.settled();
				}
				if (result.reopenAsk) {
					return error(
						id,
						"navigate_tree",
						"Re-answering an ask is not available over RPC; select another entry",
						"ask_reanswer_unsupported",
					);
				}
				return success(id, "navigate_tree", {
					cancelled: result.cancelled,
					aborted: result.aborted,
					editorText: result.editorText,
				});
			}

			case "abort_branch_summary": {
				session.abortBranchSummary();
				return success(id, "abort_branch_summary");
			}

			case "set_label": {
				if (typeof command.entryId !== "string") return error(id, "set_label", "entryId must be a string");
				if (command.label !== undefined && typeof command.label !== "string") {
					return error(id, "set_label", "label must be a string");
				}
				session.sessionManager.appendLabelChange(command.entryId, command.label);
				return success(id, "set_label");
			}

			case "open_session": {
				const requestedModel = await resolveRequestedRpcModel(session, command);
				await stopDictationForSessionChange();
				const fileBeforeOpen = session.sessionFile;
				await btw.close();
				await goalController.beginSessionChange();
				let result: RpcOpenSessionResult | undefined;
				try {
					result = await openRpcSession(session, command.sessionDir, subagentRegistry, requestedModel);
				} finally {
					// Opening the session that is already open leaves a live run going (see below).
					await goalController.endSessionChange({
						detachedRun: session.sessionFile !== fileBeforeOpen,
					});
					// Respond only once this change's reattach (and any queued ahead of it) has run.
					await goalController.settled();
				}
				if (!result.cancelled) {
					inputGate.commitSessionChange(command);
					// Opening the session that is already open switches nothing and leaves a live run
					// going. Any real open (switch or new) changes the file, even when an aliased path
					// reopens a transcript with the same id.
					if (session.sessionFile !== fileBeforeOpen) promptResults.abortOpen();
					void settleWatcher.check();
					await emitAvailableCommandsUpdate();
					emitSessionInfoUpdate();
				}
				planApprovalController.syncArmed();
				return success(id, "open_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				// A goal exit triggered by the last turn restores tools asynchronously; report after it.
				await goalController.settled();
				const queuedMessages = session.getQueuedMessages();
				const state: RpcSessionState = {
					collab: collabController.state,
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					thinkingConfigured: session.configuredThinkingLevel(),
					availableThinkingLevels: [...session.getAvailableThinkingLevels()],
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					sessionFile: session.sessionFile,
					cwd: session.sessionManager.getCwd(),
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					autoRetryEnabled: session.autoRetryEnabled,
					queuedMessageCount: session.queuedMessageCount,
					hasPendingAsyncWork: session.hasPendingAsyncWork(),
					// A scheduled goal continuation will start a turn: not settled.
					isSettled: isSessionSettled(session, goalTurnScheduled),
					queuedMessages: {
						steering: [...queuedMessages.steering],
						followUp: [...queuedMessages.followUp],
						liveSteered: queuedMessages.liveSteered,
					},
					todoPhases: session.getVisibleTodoPhases(),
					fastModeEnabled: session.isFastModeEnabled(),
					tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
					fastModeActive: session.isFastModeActive(),
					slowModeSupported: session.isSlowModeSupported(),
					slowModeEnabled: session.isSlowModeEnabled(),
					slowModeScope: session.getSlowModeScope(),
					usageLimit: session.getUsageLimitState(),
					messageCount: session.messages.length,
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: toolWireSchema(tool),
						examples: tool.examples,
					})),
					contextUsage: session.getContextUsage(),
					planModeEnabled: session.getPlanModeState()?.enabled ?? false,
					prewalkArmed: session.getPrewalkState() !== undefined,
					agentsPaused: agentPauseGate.paused,
					agentsPausedAt: agentPauseGate.pausedAt,
					kind: session.sessionManager.getHeader()?.kind,
					goal: session.getGoalModeState() ?? null,
				};
				return success(id, "get_state", state);
			}

			case "set_fast_mode": {
				const supported = session.setFastMode(command.enabled);
				if (command.enabled && !supported) {
					return error(id, "set_fast_mode", "Fast mode is unavailable for the current model.");
				}
				return success(id, "set_fast_mode", {
					enabled: session.isFastModeEnabled(),
					active: session.isFastModeActive(),
				});
			}

			case "set_slow_mode": {
				// A truthy non-boolean must not flip a persisted global setting.
				if (typeof command.enabled !== "boolean") {
					return error(id, "set_slow_mode", "set_slow_mode requires boolean enabled");
				}
				const supported = session.setSlowMode(command.enabled);
				if (command.enabled && !supported) {
					return error(id, "set_slow_mode", "Slow mode is unavailable for the current model.");
				}
				return success(id, "set_slow_mode", {
					enabled: session.isSlowModeEnabled(),
				});
			}

			case "goal": {
				try {
					return success(id, "goal", await goalController.handle(command));
				} catch (goalError) {
					return error(id, "goal", goalError instanceof Error ? goalError.message : String(goalError));
				}
			}

			case "set_ask_dialog":
				return setAskDialog(command);

			case "get_available_commands": {
				return success(id, "get_available_commands", {
					commands: await getAvailableCommands(),
				});
			}

			// Dynamic slash-command argument candidates (MCP server names, /move
			// directories). Static subcommand data rides get_available_commands.
			case "get_command_arg_completions": {
				try {
					const items = await buildRpcCommandArgCompletions(
						session.sessionManager.getCwd(),
						command.command,
						command.prefix,
					);
					return success(id, "get_command_arg_completions", {
						items: items ?? [],
					});
				} catch (err) {
					return error(id, "get_command_arg_completions", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_entries": {
				try {
					return success(
						id,
						"get_entries",
						selectRpcEntries(
							session.sessionManager.getEntries(),
							session.sessionManager.getLeafId(),
							command.since,
						),
					);
				} catch (err) {
					return error(id, "get_entries", err instanceof Error ? err.message : String(err), "unknown_since");
				}
			}

			case "get_tree": {
				return success(id, "get_tree", {
					tree: session.sessionManager.getTree(),
					leafId: session.sessionManager.getLeafId(),
				});
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				const phases = session.getTodoPhases();
				session.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
				return success(id, "set_todos", { todoPhases: phases });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				hostTools = hostToolBridge.setTools(tools);
				await refreshRpcTools();
				return success(id, "set_host_tools", {
					toolNames: tools.map(tool => tool.name),
				});
			}

			case "live_start": {
				if (dictationBridge.active) return error(id, "live_start", "End dictation before starting live voice");
				if (sessionChangesInProgress > 0 || shutdownState.requested)
					return error(id, "live_start", "Session is changing or shutting down");
				// The realtime call takes the microphone; a host dictation in progress ends without its words.
				hostDictation.cancel();
				try {
					return success(
						id,
						"live_start",
						await liveBridge.start({
							voice: command.voice,
							instructions: command.instructions,
						}),
					);
				} catch (err) {
					return error(id, "live_start", err instanceof Error ? err.message : String(err));
				}
			}

			case "live_stop": {
				await liveBridge.stop();
				return success(id, "live_stop");
			}

			// =================================================================
			// Host dictation (the host's microphone; see rpc-host-dictation.ts)
			// =================================================================

			case "host_dictation_start": {
				try {
					return success(id, "host_dictation_start", await hostDictation.start());
				} catch (err) {
					return error(id, "host_dictation_start", err instanceof Error ? err.message : String(err));
				}
			}

			case "host_dictation_audio":
				hostDictation.pushAudio(command.pcm16Base64);
				return success(id, "host_dictation_audio");

			case "host_dictation_stop":
				await hostDictation.stop();
				return success(id, "host_dictation_stop");

			case "host_dictation_cancel":
				hostDictation.cancel();
				return success(id, "host_dictation_cancel");

			// =================================================================
			// Interactive terminals
			// =================================================================

			case "terminal_open":
				return success(
					id,
					"terminal_open",
					await terminalHost.open({ cols: command.cols, rows: command.rows, cwd: command.cwd }),
				);

			case "terminal_input":
				terminalHost.input(command.terminalId, command.data);
				return success(id, "terminal_input");

			case "terminal_resize":
				terminalHost.resize(command.terminalId, command.cols, command.rows);
				return success(id, "terminal_resize");

			case "terminal_close":
				terminalHost.close(command.terminalId);
				return success(id, "terminal_close");

			case "terminal_run_cli": {
				if (!TERMINAL_CLI_SUBCOMMANDS.has(command.subcommand)) {
					return error(id, "terminal_run_cli", `Unsupported subcommand: ${String(command.subcommand)}`);
				}
				const args = Array.isArray(command.args) ? command.args.filter(arg => typeof arg === "string") : [];
				const [application, ...entryArgs] = resolveCliEntryCmd();
				return success(
					id,
					"terminal_run_cli",
					await terminalHost.runArgv({
						title: ["omp", command.subcommand, ...args].join(" "),
						application: application as string,
						args: [...entryArgs, command.subcommand, ...args],
					}),
				);
			}

			case "tui_open": {
				if (command.surface !== "advisor_config") {
					return error(id, "tui_open", `Unknown surface: ${String(command.surface)}`);
				}
				const shown = Promise.withResolvers<void>();
				const notify = (level: "info" | "warning") => (message: string) =>
					session.emitNotice(level, message, "advisor");
				void showHostedComponent<void>(
					terminalHost,
					"Advisor configuration",
					async (ui, _theme, _keybindings, done) => {
						try {
							return await createAdvisorConfigOverlay(
								ui,
								{
									session,
									settings: session.settings,
									cwd: session.sessionManager.getCwd(),
									status: notify("info"),
									warn: notify("warning"),
									advisorsChanged: () => {},
									requestRender: () => ui.requestRender(),
								},
								() => done(undefined),
							);
						} finally {
							shown.resolve();
						}
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "bottom-center",
							width: "100%",
							maxHeight: "100%",
							margin: 0,
							fullscreen: true,
						},
					},
				).catch((cause: unknown) => {
					shown.resolve();
					session.emitNotice("error", cause instanceof Error ? cause.message : String(cause), "advisor");
				});
				await shown.promise;
				return success(id, "tui_open");
			}

			case "terminal_list":
				return success(id, "terminal_list", { terminals: terminalHost.list() });

			case "terminal_snapshot":
				return success(id, "terminal_snapshot", terminalHost.snapshot(command.terminalId));

			case "browser_host_start":
				return success(id, "browser_host_start", browserHost.start());

			case "browser_host_stop":
				browserHost.stop();
				return success(id, "browser_host_stop");

			case "terminal_configure": {
				rpcUiContext.interactiveTerminal = command.interactiveCommands
					? terminalHost.asInteractiveTerminal()
					: undefined;
				const wantsTool = command.agentTools === true;
				if (wantsTool !== (terminalTool !== undefined)) {
					terminalTool = wantsTool
						? new TerminalTool(terminalHost, {
								commandEnvironment: async () => {
									const { shell, env } = session.settings.getShellConfig();
									return {
										shell,
										cwd: session.sessionManager.getCwd(),
										env: interactivePtyEnv(env, { COLORTERM: "truecolor" }),
									};
								},
								bashApproval: () => session.getToolByName("bash")?.approval,
							})
						: undefined;
					await refreshRpcTools();
				}
				return success(id, "terminal_configure", {
					interactiveCommands: rpcUiContext.interactiveTerminal !== undefined,
					agentTools: terminalTool !== undefined,
				});
			}

			case "live_mute": {
				try {
					return success(id, "live_mute", liveBridge.setMuted(command.muted));
				} catch (err) {
					return error(id, "live_mute", err instanceof Error ? err.message : String(err));
				}
			}

			case "dictation_start": {
				if (liveBridge.active) return error(id, "dictation_start", "End live voice before starting dictation");
				if (hostDictation.state !== "idle")
					return error(id, "dictation_start", "End dictation before starting another");
				if (sessionChangesInProgress > 0 || shutdownState.requested)
					return error(id, "dictation_start", "Session is changing or shutting down");
				if (!cfgSttEnabled.get(session.settings))
					return error(id, "dictation_start", "Speech-to-text is disabled. Enable it in settings: stt.enabled");
				await dictationBridge.start(command.captureId);
				return success(id, "dictation_start");
			}

			case "dictation_stop": {
				return success(id, "dictation_stop", await dictationBridge.stop());
			}

			case "set_host_uri_schemes": {
				try {
					const schemes = hostUriBridge.setSchemes(command.schemes);
					return success(id, "set_host_uri_schemes", { schemes });
				} catch (err) {
					return error(id, "set_host_uri_schemes", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_subagent_subscription": {
				if (!subagentRegistry) {
					return error(id, "set_subagent_subscription", "Subagent event bus is unavailable");
				}
				if (!isSubagentSubscriptionLevel(command.level)) {
					return error(
						id,
						"set_subagent_subscription",
						`Invalid subagent subscription level: ${String(command.level)}`,
					);
				}
				subagentRegistry.setSubscriptionLevel(command.level);
				return success(id, "set_subagent_subscription", {
					level: subagentRegistry.getSubscriptionLevel(),
				});
			}

			case "set_event_filter": {
				const events = command.events;
				if (
					events !== null &&
					(!Array.isArray(events) || !events.every(event => typeof event === "string" && event.length > 0))
				) {
					return error(id, "set_event_filter", "events must be null or an array of non-empty event type strings");
				}
				const messageUpdates = command.messageUpdates === undefined ? "full" : command.messageUpdates;
				if (messageUpdates !== "full" && messageUpdates !== "delta") {
					return error(id, "set_event_filter", 'messageUpdates must be "full" or "delta"');
				}
				return success(id, "set_event_filter", {
					events: sessionEvents.setFilter(events, messageUpdates),
					messageUpdates,
				});
			}

			case "get_subagents": {
				if (!subagentRegistry) {
					return error(id, "get_subagents", "Subagent event bus is unavailable");
				}
				await subagentRegistry.restorePersisted();
				return success(id, "get_subagents", {
					subagents: subagentRegistry.getSubagents(),
				});
			}

			case "get_subagent_messages": {
				if (!subagentRegistry) {
					return error(id, "get_subagent_messages", "Subagent event bus is unavailable");
				}
				try {
					if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
						return error(id, "get_subagent_messages", "fromByte must be a finite number");
					}
					await subagentRegistry.restorePersisted();
					const sessionFile = subagentRegistry.resolveSessionFile(command);
					const transcript = await readRpcSubagentTranscript(sessionFile, command.fromByte);
					return success(id, "get_subagent_messages", transcript);
				} catch (err) {
					return error(id, "get_subagent_messages", err instanceof Error ? err.message : String(err));
				}
			}

			// Per-subagent lifecycle (TUI Agent Hub `x`/`r` parity): abort one
			// subagent without touching the main turn, or revive a parked one.
			case "abort_subagent": {
				if (collabController.abortRemoteAgent(command.agentId)) {
					return success(id, "abort_subagent", { ok: true });
				}
				return success(id, "abort_subagent", await applyRpcAbortSubagent(command.agentId));
			}

			case "revive_subagent": {
				if (collabController.reviveRemoteAgent(command.agentId)) {
					return success(id, "revive_subagent", { ok: true });
				}
				return success(id, "revive_subagent", await applyRpcReviveSubagent(command.agentId));
			}

			case "cancel_subagent": {
				if (!subagentRegistry) {
					return error(id, "cancel_subagent", "Subagent event bus is unavailable");
				}
				if (typeof command.subagentId !== "string" || command.subagentId.length === 0) {
					return error(id, "cancel_subagent", "`subagentId` must be a non-empty string.");
				}
				try {
					const cancelled = await handleRpcCancelSubagent(subagentRegistry, command.subagentId);
					return success(id, "cancel_subagent", { cancelled });
				} catch (err) {
					return error(id, "cancel_subagent", err instanceof Error ? err.message : String(err));
				}
			}

			case "steer_subagent": {
				if (!subagentRegistry) {
					return error(id, "steer_subagent", "Subagent event bus is unavailable");
				}
				if (typeof command.subagentId !== "string" || command.subagentId.length === 0) {
					return error(id, "steer_subagent", "`subagentId` must be a non-empty string.");
				}
				if (typeof command.message !== "string" || !command.message.trim()) {
					return error(id, "steer_subagent", "`message` is required for steer_subagent.");
				}
				const failure = await handleRpcSteerSubagent(subagentRegistry, command.subagentId, command.message);
				return failure ? error(id, "steer_subagent", failure) : success(id, "steer_subagent");
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const model = await findRpcModel(session, command.provider, command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				// Wire frames are cast, not shape-validated — reject a direction
				// outside the declared union before forwarding to the session.
				if (
					command.direction !== undefined &&
					command.direction !== "forward" &&
					command.direction !== "backward"
				) {
					return error(
						id,
						"cycle_model",
						`Invalid direction: ${command.direction}. Expected "forward" or "backward".`,
					);
				}
				const result = await session.cycleModel(command.direction);
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const result = await refreshModelCatalog(command.forceRefresh === true);
				return success(id, "get_available_models", result);
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level", {
					thinkingLevel: session.thinkingLevel,
					thinkingConfigured: session.configuredThinkingLevel(),
				});
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				// Pi-compatible discovery: the selectable levels for the live model,
				// including `off` (which `set_thinking_level` accepts but the
				// effort-only helper excludes). OMP-only `auto`/`inherit` are
				// intentionally omitted — that selector stays an OMP dialect.
				return success(id, "get_available_thinking_levels", {
					levels: [ThinkingLevel.Off, ...session.getAvailableThinkingLevels()],
				});
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				applyRpcQueueModeCommand(session, command);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				applyRpcQueueModeCommand(session, command);
				return success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				applyRpcQueueModeCommand(session, command);
				return success(id, "set_interrupt_mode");
			}

			case "dequeue": {
				// Preserve delivery lanes and cross-lane enqueue order so a remote
				// editor can pull back the newest message and re-queue the rest
				// without demoting steers to follow-ups.
				const messages = session.clearQueueWithDelivery();
				return success(id, "dequeue", { messages });
			}

			case "get_queue": {
				return success(id, "get_queue", applyRpcGetQueue(session));
			}

			case "queue_edit": {
				try {
					return success(id, "queue_edit", applyRpcQueueEdit(session, command.queueId, command.text));
				} catch (err) {
					return error(id, "queue_edit", err instanceof Error ? err.message : String(err));
				}
			}

			case "queue_remove": {
				try {
					return success(id, "queue_remove", applyRpcQueueRemove(session, command.queueId));
				} catch (err) {
					return error(id, "queue_remove", err instanceof Error ? err.message : String(err));
				}
			}

			case "queue_move": {
				try {
					return success(
						id,
						"queue_move",
						applyRpcQueueMove(session, command.queueId, command.toIndex, command.toLane),
					);
				} catch (err) {
					return error(id, "queue_move", err instanceof Error ? err.message : String(err));
				}
			}

			case "queue_clear": {
				return success(id, "queue_clear", applyRpcQueueClear(session, command.lane));
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Cache warming
			// =================================================================

			case "set_cache_warming": {
				if (!CACHE_WARMING_MODES.includes(command.mode)) {
					return error(id, "set_cache_warming", `Invalid cache warming mode: ${String(command.mode)}`);
				}
				const mode = session.setCacheWarmingMode(command.mode);
				return success(id, "set_cache_warming", { mode });
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// TUI /retry parity: retry the last failed assistant turn. Distinct
			// from abort_retry (cancels a scheduled auto-retry) and from the GUI's
			// client-side re-send (this knows what "failed turn" means).
			case "retry": {
				const didRetry = await session.retry();
				return success(id, "retry", { retried: didRetry });
			}

			// TUI /clear parity: drop the conversation context in place, keeping
			// the session. Refused while streaming / foreground bash/eval so a
			// late result cannot land after the reset boundary.
			case "clear_context": {
				const result = await session.resetSessionContext();
				if (!result) {
					return error(
						id,
						"clear_context",
						"Session is busy (streaming or foreground execution in flight)",
						"busy",
					);
				}
				return success(id, "clear_context", {
					cleared: true,
					droppedCount: result.droppedCount,
				});
			}

			// =================================================================
			// One-shot session actions (TUI /prewalk /fresh /shake
			// /reload-plugins /force parity)
			// =================================================================

			// /prewalk: arm/disarm the next-action model switch. Resolution and
			// auth failures land as ordinary errors (the TUI's usage() path).
			case "set_prewalk": {
				try {
					return success(id, "set_prewalk", applyRpcSetPrewalk(session, command.enabled));
				} catch (err) {
					return error(id, "set_prewalk", err instanceof Error ? err.message : String(err));
				}
			}

			// /fresh: reset provider stream state. Same busy boundary as
			// clear_context — the TUI refuses mid-stream too.
			case "fresh": {
				const result = applyRpcFresh(session);
				if (!result) {
					return error(id, "fresh", "Session is busy (streaming or foreground execution in flight)", "busy");
				}
				return success(id, "fresh", result);
			}

			// /shake elide|images: `removed` carries the TUI's one-line summary.
			case "shake_context": {
				try {
					return success(id, "shake_context", await applyRpcShakeContext(session, command.mode));
				} catch (err) {
					return error(id, "shake_context", err instanceof Error ? err.message : String(err));
				}
			}

			// /reload-plugins: full reload incl. MCP reconnect (#7189 parity);
			// data carries the post-reload counts for the GUI toast.
			case "reload_plugins": {
				return success(id, "reload_plugins", await reloadPluginState());
			}

			// /force + GUI clear: unknown/inactive tool names land as errors
			// (the TUI's usage() path); the response reports the post-state.
			case "set_force_tool": {
				try {
					return success(id, "set_force_tool", applyRpcSetForceTool(session, command));
				} catch (err) {
					return error(id, "set_force_tool", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_force_tool": {
				return success(id, "get_force_tool", applyRpcGetForceTool(session));
			}

			// Write a large paste to the session's local:// store; the name
			// counter is allocated here so concurrent GUI windows never collide.
			case "write_local_paste": {
				try {
					return success(id, "write_local_paste", await applyRpcWriteLocalPaste(session, command.content));
				} catch (err) {
					return error(id, "write_local_paste", err instanceof Error ? err.message : String(err));
				}
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excluded === true,
				});
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Eval
			// =================================================================

			case "eval": {
				// Same user-eval path as the TUI `$`/`$$` composer modes
				// (AgentSession.executePython → EvalRunner): records the execution
				// message in session history, so the pythonExecution event flows to
				// the host like any other session event. Background-dispatched (see
				// dispatchRpcInputFrame) so a long cell never wedges the command queue.
				const language = command.language ?? "python";
				if (language !== "python") {
					return error(
						id,
						"eval",
						`Interactive eval supports only "python" today (got "${language}"); other backends are agent-tool-only`,
					);
				}
				const result = await session.executePython(command.code, undefined, {
					excludeFromContext: command.excluded === true,
				});
				return success(id, "eval", {
					language,
					code: command.code,
					output: result.output,
					exitCode: result.exitCode,
					cancelled: result.cancelled,
					truncated: result.truncated,
					excluded: command.excluded === true,
				});
			}

			case "abort_eval": {
				// TUI Esc parity (input-controller's isEvalRunning branch).
				session.abortEval();
				return success(id, "abort_eval");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "set_session_pinned": {
				const sessionId = command.sessionId.trim();
				if (!sessionId) return error(id, "set_session_pinned", "Session id cannot be empty");
				const pinned = await setSessionPinned(sessionId, command.pinned);
				return success(id, "set_session_pinned", { pinned });
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return success(id, "get_branch_messages", { messages });
			}

			case "get_config_warnings": {
				return success(id, "get_config_warnings", { warnings: [...session.configWarnings] });
			}

			case "get_advisor_status": {
				const overview = session.getAdvisorStatusOverview();
				return success(id, "get_advisor_status", {
					configured: overview.configured,
					advisors: overview.advisors.map(({ name, status, yielded }) => ({ name, status, yielded })),
					cost: session.getAdvisorCost(),
					usingSubscription: session.isAdvisorUsingSubscription(),
				});
			}

			case "list_reset_credits": {
				const accounts = toResetUsageAccounts(await session.listResetCredits()).map(account => ({
					label: account.label,
					provider: account.provider,
					providerLabel: account.providerLabel,
					availableCount: account.availableCount,
					redeemableCount: account.redeemableCount,
					target: account.target,
					active: account.active,
					error: account.error,
					unavailableReason: account.unavailableReason,
					expiresAt: account.expiresAt,
				}));
				return success(id, "list_reset_credits", { accounts });
			}

			case "redeem_reset_credit": {
				const outcome = await session.redeemResetCredit(command.target);
				return success(id, "redeem_reset_credit", {
					ok: outcome.ok,
					code: outcome.code,
					message: describeRedeemOutcome(outcome, command.label),
				});
			}

			case "get_session_tree": {
				return success(id, "get_session_tree", buildRpcSessionTree(session));
			}

			// Independent new session from a history node (Codex-style "open in
			// new window from here"); does NOT switch the attached session.
			case "fork_from": {
				try {
					return success(id, "fork_from", await applyRpcForkFrom(session, command.entryId));
				} catch (err) {
					return error(id, "fork_from", err instanceof Error ? err.message : String(err));
				}
			}

			// Move the active leaf in place (TUI tree-selector Enter parity).
			case "switch_leaf": {
				if (session.isStreaming) {
					return error(id, "switch_leaf", "Session is busy (streaming)", "busy");
				}
				try {
					const result = await applyRpcSwitchLeaf(session, command, rpcUiContext);
					askReanswerAwaitingResumeLeafId = result.askReanswerCommitted ? result.activeLeafId : undefined;
					return success(id, "switch_leaf", result);
				} catch (err) {
					askReanswerAwaitingResumeLeafId = undefined;
					if (err instanceof SessionBusyError) return error(id, "switch_leaf", err.message, "busy");
					return error(id, "switch_leaf", err instanceof Error ? err.message : String(err));
				}
			}

			case "resume_after_ask_reanswer": {
				const activeLeafId = session.sessionManager.getLeafId() ?? undefined;
				if (!askReanswerAwaitingResumeLeafId || activeLeafId !== askReanswerAwaitingResumeLeafId) {
					return error(
						id,
						"resume_after_ask_reanswer",
						"No committed ask re-answer is awaiting resume",
						"invalid_state",
					);
				}
				askReanswerAwaitingResumeLeafId = undefined;
				session.resumeAfterAskReanswer();
				return success(id, "resume_after_ask_reanswer");
			}

			case "get_themes": {
				const themes = await getAvailableThemesWithPaths();
				return success(id, "get_themes", { themes });
			}

			case "get_theme_colors": {
				try {
					const colors = await getResolvedThemeColors(command.name);
					return success(id, "get_theme_colors", {
						name: command.name,
						colors,
					});
				} catch (err) {
					return error(id, "get_theme_colors", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_transcript": {
				// Full display history (all messages on the active branch), NOT the
				// LLM context window that get_messages returns.
				const transcript = session.buildTranscriptSessionContext();
				return success(id, "get_transcript", {
					messages: attachRpcTranscriptEntryIds(transcript.messages, transcript.messageEntryIds ?? []),
				});
			}

			// =================================================================
			// Workspace directories (TUI /dirs /add-dir /remove-dir /move parity)
			// =================================================================

			case "get_directories": {
				return success(id, "get_directories", buildRpcWorkspaceDirectories(session));
			}

			case "add_directory": {
				try {
					return success(id, "add_directory", await applyRpcAddDirectory(session, command.path));
				} catch (err) {
					return workspaceError(id, "add_directory", err);
				}
			}

			case "remove_directory": {
				try {
					return success(id, "remove_directory", await applyRpcRemoveDirectory(session, command.path));
				} catch (err) {
					return workspaceError(id, "remove_directory", err);
				}
			}

			case "move_session": {
				try {
					const result = await applyRpcMoveSession(session, command.path, {
						applyCwdChange: newCwd => rebindRpcSessionCwd(session, newCwd, reloadPluginState),
					});
					return success(id, "move_session", result);
				} catch (err) {
					return workspaceError(id, "move_session", err);
				}
			}

			// =================================================================
			// Git worktrees (GUI tab × worktree binding; plan/20 in the GUI repo)
			// =================================================================

			case "get_git_changes":
				return success(id, "get_git_changes", await getRpcGitChanges(session.sessionManager.getCwd()));
			case "get_git_diff":
				return success(id, "get_git_diff", await getRpcGitDiff(session.sessionManager.getCwd(), command.path));
			case "get_git_status": {
				return success(id, "get_git_status", await buildRpcGitStatus(session));
			}

			case "worktree_create": {
				try {
					return success(
						id,
						"worktree_create",
						await createRpcWorktree(session, {
							name: command.name,
							baseCwd: command.baseCwd,
							baseRef: command.baseRef,
						}),
					);
				} catch (err) {
					return worktreeError(id, "worktree_create", err);
				}
			}

			case "worktree_remove": {
				try {
					return success(
						id,
						"worktree_remove",
						await removeRpcWorktree(session, {
							path: command.path,
							force: command.force,
						}),
					);
				} catch (err) {
					return worktreeError(id, "worktree_remove", err);
				}
			}

			// =================================================================
			// Pull requests (GUI PR Center; plan/21 in the GUI repo)
			// =================================================================

			case "pr_repo": {
				return success(id, "pr_repo", await buildRpcPrRepo(session));
			}

			case "pr_list": {
				try {
					return success(
						id,
						"pr_list",
						await buildRpcPrList(session, {
							state: command.state,
							limit: command.limit,
						}),
					);
				} catch (err) {
					return prError(id, "pr_list", err);
				}
			}

			case "pr_get": {
				try {
					return success(id, "pr_get", await buildRpcPrDetail(session, { number: command.number }));
				} catch (err) {
					return prError(id, "pr_get", err);
				}
			}

			case "pr_diff": {
				try {
					return success(
						id,
						"pr_diff",
						await buildRpcPrFileDiff(session, {
							number: command.number,
							path: command.path,
						}),
					);
				} catch (err) {
					return prError(id, "pr_diff", err);
				}
			}

			case "pr_draft": {
				try {
					return success(
						id,
						"pr_draft",
						await buildRpcPrDraft(session, {
							base: command.base,
							head: command.head,
						}),
					);
				} catch (err) {
					return prError(id, "pr_draft", err);
				}
			}

			case "pr_create": {
				try {
					return success(
						id,
						"pr_create",
						await createRpcPr(session, {
							title: command.title,
							body: command.body,
							base: command.base,
							head: command.head,
							draft: command.draft,
						}),
					);
				} catch (err) {
					return prError(id, "pr_create", err);
				}
			}

			case "pr_checkout": {
				try {
					return success(id, "pr_checkout", await checkoutRpcPr(session, { number: command.number }));
				} catch (err) {
					return prError(id, "pr_checkout", err);
				}
			}

			// Foreign session import (Claude/Codex → OMP copy). Both run in the
			// background (dispatchRpcInputFrame) — listing scans the source,
			// importing converts a whole transcript.
			case "list_foreign_sessions": {
				try {
					return success(id, "list_foreign_sessions", {
						sessions: await buildRpcForeignSessionList(command.source),
					});
				} catch (err) {
					return error(
						id,
						"list_foreign_sessions",
						err instanceof Error ? err.message : String(err),
						"source_unavailable",
					);
				}
			}

			case "import_foreign_session": {
				try {
					return success(
						id,
						"import_foreign_session",
						await applyRpcImportForeignSession(session, command.source, command.foreignId),
					);
				} catch (err) {
					// Same source-outage failure class as list_foreign_sessions.
					return error(
						id,
						"import_foreign_session",
						err instanceof Error ? err.message : String(err),
						"source_unavailable",
					);
				}
			}

			case "transcribe_audio": {
				// GUI mic dictation: the host ships a canonical 16 kHz mono PCM16
				// WAV buffer (the STT pipeline's native rate — see the wire type).
				try {
					const { samples, sampleRate } = decodeWav(Buffer.from(command.audioBase64, "base64"));
					if (sampleRate !== 16_000) {
						return error(
							id,
							"transcribe_audio",
							`Unsupported sample rate ${sampleRate} Hz — transcribe_audio expects 16 kHz mono PCM16 WAV`,
						);
					}
					if (samples.length === 0) return success(id, "transcribe_audio", { text: "" });
					// Same resolution as the TUI stt-controller: stale/legacy keys
					// fall back to the SoTA default rather than failing.
					const pool = roleCandidatePool("dictation", session.settings, session.modelRegistry);
					const selectedId = resolveRoleChain("dictation", session.settings, pool)[0]?.model.id;
					const modelKey = resolveSttModelSpec(selectedId).key;
					const language = cfgSttLanguage.get(session.settings);
					const text = await sttClient.transcribe(modelKey, samples, {
						language: language || undefined,
					});
					return success(id, "transcribe_audio", { text });
				} catch (err: unknown) {
					return error(id, "transcribe_audio", err instanceof Error ? err.message : String(err));
				}
			}

			case "synthesize_speech": {
				// GUI speech output: synthesize to an in-memory WAV buffer instead
				// of device playback. Model/voice resolution mirrors the TUI
				// vocalizer (local model + `speech.voice` override).
				try {
					const text = command.text.trim();
					if (!text)
						return success(id, "synthesize_speech", {
							audioBase64: "",
							mimeType: "audio/wav",
						});
					const voice = cfgSpeechVoice.get(session.settings) || DEFAULT_TTS_VOICE;
					const modelKey = resolveLocalSpeechModelId({
						settings: session.settings,
						registry: session.modelRegistry,
					});
					const audio = await ttsClient.synthesize(modelKey, text, { voice });
					if (!audio) {
						return error(
							id,
							"synthesize_speech",
							"Local TTS model is unavailable — download it from the TUI speech settings first",
							"tts_unavailable",
						);
					}
					const wav = encodeWav(audio.pcm, audio.sampleRate);
					return success(id, "synthesize_speech", {
						audioBase64: Buffer.from(wav).toString("base64"),
						mimeType: "audio/wav",
					});
				} catch (err: unknown) {
					return error(id, "synthesize_speech", err instanceof Error ? err.message : String(err));
				}
			}

			case "debug": {
				try {
					const debugSession = {
						cwd: session.sessionManager.getCwd(),
						hasUI: true,
						settings: session.settings,
					} as ToolSession;
					const result = await new DebugTool(debugSession).execute(Snowflake.next() as string, command.params);
					return success(id, "debug", {
						content: result.content,
						details: result.details,
					});
				} catch (err: unknown) {
					return error(id, "debug", err instanceof Error ? err.message : String(err));
				}
			}

			case "collab_start": {
				try {
					return success(id, "collab_start", await collabController.start(command.relayUrl));
				} catch (err: unknown) {
					return error(id, "collab_start", err instanceof Error ? err.message : String(err));
				}
			}

			case "collab_join": {
				try {
					return success(id, "collab_join", await collabController.join(command.link));
				} catch (err: unknown) {
					return error(id, "collab_join", err instanceof Error ? err.message : String(err));
				}
			}

			case "collab_leave": {
				try {
					return success(id, "collab_leave", await collabController.leave());
				} catch (err: unknown) {
					return error(id, "collab_leave", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_collab_state": {
				return success(id, "get_collab_state", collabController.state);
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "get_copy_targets": {
				return success(id, "get_copy_targets", {
					targets: buildCopyTargets(session),
				});
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				const currentPath = session.sessionFile ? path.resolve(session.sessionFile) : undefined;
				const targetPath = command.sessionPath ? path.resolve(command.sessionPath) : undefined;
				const renamingCurrent = targetPath === undefined || targetPath === currentPath;
				if (renamingCurrent && (session.isStreaming || session.isCompacting)) {
					return error(id, "set_session_name", "Cannot rename a session while it is running");
				}
				const applied = renamingCurrent
					? await session.setSessionName(name, "user")
					: await SessionManager.renameStoredSession(targetPath, name);
				if (!applied) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				if (renamingCurrent) emitSessionInfoUpdate();
				return success(id, "set_session_name");
			}

			case "set_entry_label": {
				// TUI tree-selector Shift+L parity: set/clear a label on any entry.
				const entryId = command.entryId.trim();
				if (!entryId) {
					return error(id, "set_entry_label", "Entry id cannot be empty");
				}
				const label = typeof command.label === "string" && command.label.trim() ? command.label.trim() : undefined;
				try {
					session.sessionManager.appendLabelChange(entryId, label);
				} catch (cause) {
					return error(id, "set_entry_label", cause instanceof Error ? cause.message : String(cause));
				}
				return success(id, "set_entry_label");
			}

			case "handoff": {
				// Resetting the agent mid-stream lets the live turn keep emitting into a
				// session that handoff has already torn down. Refuse while a prompt is in
				// flight (mirrors the TUI /handoff guard).
				if (session.isStreaming) {
					return error(id, "handoff", "Cannot hand off while a response is in progress");
				}
				const result = await session.handoff(command.customInstructions);
				return success(id, "handoff", result ? { savedPath: result.savedPath } : null);
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", {
					messages: attachRpcMessageEntryIds(session.messages, session.sessionManager.getBranch()),
				});
			}

			case "get_messages_page": {
				if (session.isStreaming || session.isCompacting)
					return error(id, "get_messages_page", RPC_MESSAGES_PAGE_BUSY_ERROR, "session_busy");
				const messages = attachRpcMessageEntryIds(session.messages, session.sessionManager.getBranch());
				try {
					return success(
						id,
						"get_messages_page",
						pageRpcMessages(
							messages,
							{
								sessionId: session.sessionId,
								leafId: session.sessionManager.getLeafId(),
								messageCount: messages.length,
							},
							{ cursor: command.cursor, limit: command.limit },
						),
					);
				} catch (pageError) {
					return error(
						id,
						"get_messages_page",
						pageError instanceof Error ? pageError.message : String(pageError),
						pageError instanceof RpcMessagesPageError ? pageError.code : undefined,
					);
				}
			}

			case "get_transcript_page": {
				if (session.isStreaming || session.isCompacting)
					return error(id, "get_transcript_page", RPC_MESSAGES_PAGE_BUSY_ERROR, "session_busy");
				const transcript = session.buildTranscriptSessionContext();
				const messages = attachRpcTranscriptEntryIds(transcript.messages, transcript.messageEntryIds ?? []);
				try {
					return success(
						id,
						"get_transcript_page",
						pageRpcMessages(
							messages,
							{
								sessionId: session.sessionId,
								leafId: session.sessionManager.getLeafId(),
								messageCount: messages.length,
							},
							{ cursor: command.cursor, limit: command.limit },
						),
					);
				} catch (pageError) {
					return error(
						id,
						"get_transcript_page",
						pageError instanceof Error ? pageError.message : String(pageError),
						pageError instanceof RpcMessagesPageError ? pageError.code : undefined,
					);
				}
			}

			// =================================================================
			// Login
			// =================================================================

			case "get_login_providers": {
				// Every GUI tab owns a separate sidecar/AuthStorage snapshot. Reload
				// before projecting auth state so a login/logout in another tab is
				// visible without restarting this sidecar.
				await session.modelRegistry.authStorage.credentials.reload();
				const providers = getOAuthProviders().map(provider => ({
					id: provider.id,
					name: provider.name,
					available: provider.available,
					authenticated:
						session.modelRegistry.authStorage.keys.source(provider.storeCredentialsAs ?? provider.id) !==
						undefined,
				}));
				return success(id, "get_login_providers", { providers });
			}

			case "login": {
				const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
				if (!knownProvider) {
					return error(id, "login", `Unknown login provider: ${command.providerId}`);
				}
				const uiCtx = new RpcExtensionUIContext(pendingExtensionRequests, output);
				// A host that dismisses the authorization URL or a login prompt cancels
				// the login: the provider stops waiting on its callback and open prompts close.
				const cancel = new AbortController();
				let promptTimedOut = false;
				const dialogOptions = {
					timeout: 600_000,
					signal: cancel.signal,
					onTimeout: () => {
						promptTimedOut = true;
					},
				};
				const promptClosed = (): LoginCancelledError => {
					if (promptTimedOut) return new LoginCancelledError("Login prompt timed out");
					cancel.abort(new LoginCancelledError());
					return new LoginCancelledError();
				};
				// Closes the authorization-URL dialogs the host has not answered once the login ends.
				const loginDone = new AbortController();
				let authUrlId: string | undefined;
				try {
					await session.modelRegistry.authStorage.oauth.login(command.providerId, {
						signal: cancel.signal,
						onAuth: info => {
							authUrlId = requestRpcOpenUrl(pendingExtensionRequests, output, info, {
								signal: loginDone.signal,
								onDismiss: reason => cancel.abort(reason ?? new LoginCancelledError()),
							});
						},
						// Paste-code providers also accept the code by hand while the browser
						// step is pending. The prompt names its URL dialog so hosts can show
						// both together, and it closes when the browser callback wins.
						...(PASTE_CODE_LOGIN_PROVIDERS.has(command.providerId)
							? {
									onManualCodeInput: async (signal?: AbortSignal) => {
										const value = await requestRpcDialog<string | undefined>(
											pendingExtensionRequests,
											output,
											{
												...dialogOptions,
												signal: signal ? AbortSignal.any([cancel.signal, signal]) : cancel.signal,
											},
											undefined,
											{
												method: "input",
												title: "Paste the authorization code (or full redirect URL):",
												...(authUrlId ? { authCodeFor: authUrlId } : {}),
											},
											response => parseValueDialogResponse(response, dialogOptions),
										);
										if (value !== undefined) return value;
										// The callback race already settled (the browser signed in first); this answer is moot.
										if (signal?.aborted && !cancel.signal.aborted) throw new LoginCancelledError();
										throw promptClosed();
									},
								}
							: {}),
						onProgress: message => {
							uiCtx.notify(message, "info");
						},
						// GUI consumers render input/select dialogs, so every prompt
						// in a login flow — including pre-auth ones like region
						// selection or a custom base URL — is satisfiable. Prompts
						// carrying `options` render as a picker and return the
						// 1-based index the provider's parsing expects. A dismissed
						// dialog is a cancel, not an empty answer — an empty string
						// would silently take the prompt's default branch.
						onPrompt: async prompt => {
							if (prompt.options?.length) {
								const picked = await uiCtx.select(prompt.message, prompt.options, dialogOptions);
								if (picked === undefined) throw promptClosed();
								return String(prompt.options.indexOf(picked) + 1);
							}
							if (prompt.secret) {
								throw new Error(
									`Provider '${command.providerId}' requires secret input, ` +
										"which is not supported in RPC mode. Use the terminal UI to log in.",
								);
							}
							const value = await uiCtx.input(prompt.message, prompt.placeholder, dialogOptions);
							if (value === undefined) throw promptClosed();
							return value;
						},
					});
					// Provider-scoped online refresh so the just-persisted credential
					// re-runs discovery instead of reusing a fresh authoritative cache
					// row (#5780).
					await session.modelRegistry.refreshProvider(
						knownProvider.storeCredentialsAs ?? knownProvider.id,
						"online",
					);
					emitModelCatalogUpdate();
					return success(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					// After a host cancel, whichever rejection reaches here first is the cancel.
					if (cancel.signal.aborted) {
						return error(id, "login", new LoginCancelledError().message, "login_cancelled");
					}
					return error(id, "login", err instanceof Error ? err.message : String(err));
				} finally {
					loginDone.abort();
				}
			}

			case "get_logout_accounts": {
				// An absent provider would list every provider's credentials.
				if (typeof command.providerId !== "string") {
					return error(id, "get_logout_accounts", "providerId must be a string");
				}
				const accounts = await listLogoutAccounts(
					session.modelRegistry.authStorage,
					command.providerId,
					session.sessionId,
				);
				return success(id, "get_logout_accounts", { accounts });
			}

			case "logout": {
				if (typeof command.providerId !== "string" || !Number.isInteger(command.credentialId)) {
					return error(id, "logout", "providerId must be a string and credentialId an integer");
				}
				const { removed, remainingSource } = await logoutCredential(
					session.modelRegistry,
					command.providerId,
					command.credentialId,
					session.sessionId,
				);
				if (!removed) {
					return error(id, "logout", `Credential ${command.credentialId} is not stored for ${command.providerId}`);
				}
				emitModelCatalogUpdate();
				return success(id, "logout", { remainingSource });
			}

			// =================================================================
			// Side questions (/btw)
			// =================================================================

			case "btw": {
				const record = await btw.ask(command.question, command.recordId);
				return success(id, "btw", { record });
			}

			case "btw_cancel":
				return success(id, "btw_cancel", {
					cancelled: btw.cancel(command.recordId),
				});

			case "get_btw_history":
				return success(id, "get_btw_history", { records: await btw.history() });

			// =================================================================
			// Extension Features (usage / settings / providers)
			// =================================================================

			case "get_usage": {
				try {
					const result = await buildRpcUsageResult(session);
					return success(id, "get_usage", result);
				} catch (err: unknown) {
					return error(id, "get_usage", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_settings_schema": {
				const result = buildRpcSettingsSchema(session.settings);
				return success(id, "get_settings_schema", result);
			}

			case "get_settings": {
				const paths = command.paths ?? orderedSettings().map(setting => setting.id);
				const values: Record<string, unknown> = {};
				const provenance: Record<string, RpcSettingProvenance> = {};
				for (const path of paths) {
					const setting = lookupSetting(path);
					if (!setting) continue;
					values[path] = setting.get(session.settings);
					provenance[path] = session.settings.getProvenanceDetails(setting);
				}
				return success(id, "get_settings", {
					values,
					provenance,
					advisorEnabled: session.isAdvisorEnabled(),
					advisorActive: session.isAdvisorActive(),
				});
			}

			case "set_setting": {
				const setting = lookupSetting(command.path);
				if (!setting) return error(id, "set_setting", `Unknown setting path: ${command.path}`);
				try {
					validateRpcSettingValue(command.path, command.value);
					setting.set(session.settings, command.value as never);
					await session.settings.flush();
					const effectiveValue = setting.get(session.settings);
					const advisorEnabled = command.path === "advisor.enabled" ? session.isAdvisorEnabled() : undefined;
					const advisorActive = command.path === "advisor.enabled" ? session.isAdvisorActive() : undefined;
					output({
						type: "config_update",
						model: session.model,
						thinkingLevel: session.thinkingLevel,
					});
					return success(id, "set_setting", {
						path: command.path,
						value: effectiveValue,
						savedValue: command.value,
						provenance: session.settings.getProvenanceDetails(setting),
						...(advisorEnabled === undefined ? {} : { advisorEnabled, advisorActive }),
					});
				} catch (err: unknown) {
					return error(id, "set_setting", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_providers": {
				try {
					const catalog = await refreshModelCatalog(command.forceRefresh === true);
					const result = { ...buildRpcProvidersResult(session), ...catalog };
					return success(id, "get_providers", result);
				} catch (err: unknown) {
					return error(id, "get_providers", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_plan_mode": {
				// Mode arming needs tools the restricted (chat) session does not
				// have — refuse rather than create a contradictory "plan rules +
				// no tools" context (I3). Disarming stays allowed.
				if (command.enabled && session.restrictToolNames) {
					return error(
						id,
						"set_plan_mode",
						"Plan mode is unavailable in a tool-free (chat) session.",
						"mode_unavailable_in_chat",
					);
				}
				if (command.enabled) {
					session.setPlanModeState({
						enabled: true,
						planFilePath: "local://PLAN.md",
					});
				} else {
					session.setPlanModeState(undefined);
				}
				planApprovalController.syncArmed();
				const state = session.getPlanModeState();
				return success(id, "set_plan_mode", {
					enabled: state?.enabled ?? false,
					planFilePath: state?.planFilePath,
				});
			}

			case "plan_approval": {
				try {
					const result = await planApprovalController.resolve(command);
					return success(id, "plan_approval", result);
				} catch (err: unknown) {
					return error(id, "plan_approval", err instanceof Error ? err.message : String(err));
				}
			}

			// =================================================================
			// Session Modes (vibe / goal / loop)
			// =================================================================

			case "get_vibe_mode": {
				return success(id, "get_vibe_mode", {
					enabled: vibeModeController.enabled,
				});
			}

			case "set_vibe_mode": {
				if (command.enabled && session.restrictToolNames) {
					return error(
						id,
						"set_vibe_mode",
						"Vibe mode is unavailable in a tool-free (chat) session.",
						"mode_unavailable_in_chat",
					);
				}
				try {
					return success(id, "set_vibe_mode", await vibeModeController.setEnabled(command.enabled));
				} catch (err: unknown) {
					return error(id, "set_vibe_mode", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_goal": {
				return success(id, "get_goal", goalModeController.state);
			}

			case "guided_goal": {
				if (session.restrictToolNames) {
					return error(
						id,
						"guided_goal",
						"Goal mode is unavailable in a tool-free (chat) session.",
						"mode_unavailable_in_chat",
					);
				}
				try {
					return success(id, "guided_goal", await goalModeController.startGuidedInterview(command.initial));
				} catch (err: unknown) {
					return error(id, "guided_goal", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_agents_paused": {
				if (command.enabled) {
					agentPauseGate.pause();
					return success(id, "set_agents_paused", {
						paused: true,
						pausedAt: agentPauseGate.pausedAt,
					});
				}
				const heldMs = agentPauseGate.resume();
				return success(id, "set_agents_paused", { paused: false, heldMs });
			}

			case "btw_branch": {
				try {
					const result = await btw.branch();
					if (!result.cancelled) {
						subagentRegistry?.clear();
						await emitAvailableCommandsUpdate();
						planApprovalController.syncArmed();
					}
					return success(id, "btw_branch", result);
				} catch (err: unknown) {
					return error(id, "btw_branch", err instanceof Error ? err.message : String(err));
				}
			}

			case "tan": {
				try {
					return success(id, "tan", await startRpcTan(session, command.work));
				} catch (err: unknown) {
					return error(id, "tan", err instanceof Error ? err.message : String(err));
				}
			}

			case "omfg": {
				try {
					return success(id, "omfg", await runRpcOmfg(session, rpcUiContext, command.complaint));
				} catch (err: unknown) {
					return error(id, "omfg", err instanceof Error ? err.message : String(err));
				}
			}
			case "set_goal": {
				if (session.restrictToolNames) {
					return error(
						id,
						"set_goal",
						"Goal mode is unavailable in a tool-free (chat) session.",
						"mode_unavailable_in_chat",
					);
				}
				try {
					return success(id, "set_goal", await goalModeController.setGoal(command));
				} catch (err: unknown) {
					return error(id, "set_goal", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_loop_mode": {
				return success(id, "get_loop_mode", loopModeController.state);
			}

			case "set_loop_mode": {
				if (command.enabled && session.restrictToolNames) {
					return error(
						id,
						"set_loop_mode",
						"Loop mode is unavailable in a tool-free (chat) session.",
						"mode_unavailable_in_chat",
					);
				}
				try {
					return success(id, "set_loop_mode", loopModeController.setEnabled(command.enabled, command.args));
				} catch (err: unknown) {
					return error(id, "set_loop_mode", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_plan_mode": {
				const state = session.getPlanModeState();
				return success(id, "get_plan_mode", {
					enabled: state?.enabled ?? false,
					planFilePath: state?.planFilePath,
				});
			}

			case "get_model_roles": {
				return success(id, "get_model_roles", buildRpcModelRoles(session.settings, session.modelRegistry));
			}

			case "set_model_role": {
				try {
					session.settings.setModelRole(command.role, command.modelId ?? undefined);
					await session.settings.flush();
					output({
						type: "config_update",
						model: session.model,
						thinkingLevel: session.thinkingLevel,
					});
					return success(id, "set_model_role", {
						role: command.role,
						modelId: command.modelId,
					});
				} catch (err: unknown) {
					return error(id, "set_model_role", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_model_role_metadata": {
				return success(id, "get_model_role_metadata", buildRpcModelRoleMetadata(session.settings));
			}

			// =================================================================
			// Domain Inspection (skills / hooks / mcp / plugins / templates / memory)
			// =================================================================

			case "get_agent_definitions": {
				try {
					const result = await buildRpcAgentDefinitions(session);
					return success(id, "get_agent_definitions", result);
				} catch (err: unknown) {
					return error(id, "get_agent_definitions", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_skills": {
				try {
					const result = await buildRpcSkillsResult(session);
					return success(id, "get_skills", result);
				} catch (err: unknown) {
					return error(id, "get_skills", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_skill_detail": {
				try {
					return success(id, "get_skill_detail", await buildRpcSkillDetail(session, command.name));
				} catch (err: unknown) {
					return error(id, "get_skill_detail", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_hooks": {
				try {
					const result = await buildRpcHooksResult(session);
					return success(id, "get_hooks", result);
				} catch (err: unknown) {
					return error(id, "get_hooks", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_mcp_servers": {
				try {
					const result = await buildRpcMcpServersResult(session);
					return success(id, "get_mcp_servers", result);
				} catch (err: unknown) {
					return error(id, "get_mcp_servers", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_plugins": {
				try {
					const result = await buildRpcPluginsResult(session);
					return success(id, "get_plugins", result);
				} catch (err: unknown) {
					return error(id, "get_plugins", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_marketplaces": {
				try {
					const result = await buildRpcMarketplacesResult(session);
					return success(id, "get_marketplaces", result);
				} catch (err: unknown) {
					return error(id, "get_marketplaces", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_prompt_templates": {
				try {
					const result = buildRpcPromptTemplatesResult(session);
					return success(id, "get_prompt_templates", result);
				} catch (err: unknown) {
					return error(id, "get_prompt_templates", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_memory_overview": {
				try {
					return success(id, "get_memory_overview", await buildRpcMemoryOverview(session, command.cwd));
				} catch (err: unknown) {
					return error(id, "get_memory_overview", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_memory_activity": {
				try {
					return success(id, "get_memory_activity", buildRpcMemoryActivity(session, command.cwd));
				} catch (err: unknown) {
					return error(id, "get_memory_activity", err instanceof Error ? err.message : String(err));
				}
			}

			case "edit_memory": {
				try {
					return success(id, "edit_memory", await applyRpcMemoryEdit(session, command.edit, command.cwd));
				} catch (err: unknown) {
					return error(id, "edit_memory", err instanceof Error ? err.message : String(err));
				}
			}

			case "update_memory": {
				try {
					const result = await applyRpcMemoryUpdate(session, command.cwd, command.minIdleMinutes);
					return success(id, "update_memory", result);
				} catch (err: unknown) {
					return error(id, "update_memory", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_memory_report": {
				try {
					const result = await buildRpcMemoryReport(session);
					return success(id, "get_memory_report", result);
				} catch (err: unknown) {
					return error(id, "get_memory_report", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_security_dashboard": {
				try {
					return success(id, "get_security_dashboard", await buildRpcSecurityDashboard(session));
				} catch (err: unknown) {
					return error(id, "get_security_dashboard", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_security_scan": {
				try {
					return success(id, "get_security_scan", await buildRpcSecurityScan(session, command.scanId));
				} catch (err: unknown) {
					return error(id, "get_security_scan", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_ssh_hosts": {
				try {
					return success(id, "get_ssh_hosts", await buildRpcSshHosts(session));
				} catch (err: unknown) {
					return error(id, "get_ssh_hosts", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_omp_update": {
				try {
					return success(id, "get_omp_update", await buildRpcOmpUpdate());
				} catch (err: unknown) {
					return error(id, "get_omp_update", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_context_report": {
				return success(id, "get_context_report", buildRpcContextReport(session));
			}

			case "get_active_tools": {
				return success(id, "get_active_tools", buildRpcActiveTools(session));
			}

			case "preview_share_session": {
				try {
					return success(id, "preview_share_session", previewRpcShareSession(session));
				} catch (err: unknown) {
					return error(id, "preview_share_session", err instanceof Error ? err.message : String(err));
				}
			}

			case "share_session": {
				try {
					return success(id, "share_session", await shareRpcSession(session, command.snapshotId));
				} catch (err: unknown) {
					return error(id, "share_session", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_jobs": {
				return success(id, "get_jobs", buildRpcJobs(session));
			}

			// =================================================================
			// Domain Actions (mutating)
			// =================================================================

			case "set_skill_enabled": {
				try {
					const result = await applyRpcSkillEnabled(session, command.name, command.enabled);
					await session.refreshSkills();
					return success(id, "set_skill_enabled", result);
				} catch (err: unknown) {
					return error(id, "set_skill_enabled", err instanceof Error ? err.message : String(err));
				}
			}

			case "manage_skill": {
				try {
					const result = await applyRpcManageSkill(
						session,
						command.action,
						command.name,
						command.description,
						command.body,
					);
					await session.refreshSkills();
					return success(id, "manage_skill", result);
				} catch (err: unknown) {
					return error(id, "manage_skill", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_hook_enabled": {
				try {
					const result = await applyRpcHookEnabled(session, command.hookId, command.enabled);
					return success(id, "set_hook_enabled", result);
				} catch (err: unknown) {
					return error(id, "set_hook_enabled", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_plugin_enabled": {
				try {
					const result = await applyRpcPluginEnabled(session, command.pluginId, command.enabled, command.scope);
					await reloadPluginState();
					return success(id, "set_plugin_enabled", result);
				} catch (err: unknown) {
					return error(id, "set_plugin_enabled", err instanceof Error ? err.message : String(err));
				}
			}

			case "mcp_action": {
				try {
					const result = await applyRpcMcpAction(session, command.name, command.action, command.scope);
					return success(id, "mcp_action", result);
				} catch (err: unknown) {
					return error(id, "mcp_action", err instanceof Error ? err.message : String(err));
				}
			}

			case "security_start": {
				try {
					return success(id, "security_start", await startRpcSecurityScan(session, command.target));
				} catch (err: unknown) {
					return error(id, "security_start", err instanceof Error ? err.message : String(err));
				}
			}

			case "security_cancel": {
				try {
					return success(id, "security_cancel", await cancelRpcSecurityScan(session, command.operationId));
				} catch (err: unknown) {
					return error(id, "security_cancel", err instanceof Error ? err.message : String(err));
				}
			}

			case "security_validate": {
				try {
					const prompt = await buildRpcSecurityValidationPrompt(session, command.scanId, command.findingId);
					const trackedPrompt = extensionUserMessageTracker.watchPrompt(() =>
						session.prompt(prompt, { streamingBehavior: "followUp" }),
					);
					void trackedPrompt.prompt.catch(cause => {
						const promptError = cause instanceof Error ? cause : new Error(String(cause));
						output(error(id, "security_validate", promptError.message));
					});
					return success(id, "security_validate", { accepted: true });
				} catch (err: unknown) {
					return error(id, "security_validate", err instanceof Error ? err.message : String(err));
				}
			}

			case "security_set_disposition": {
				try {
					return success(
						id,
						"security_set_disposition",
						await setRpcSecurityDisposition(
							session,
							command.scanId,
							command.findingId,
							command.status,
							command.rationale,
						),
					);
				} catch (err: unknown) {
					return error(id, "security_set_disposition", err instanceof Error ? err.message : String(err));
				}
			}

			case "ssh_manage": {
				try {
					return success(
						id,
						"ssh_manage",
						await manageRpcSshHost(
							session,
							command.action,
							command.scope,
							command.name,
							command.previousName,
							command.previousScope,
							command.host,
						),
					);
				} catch (err: unknown) {
					return error(id, "ssh_manage", err instanceof Error ? err.message : String(err));
				}
			}

			case "ssh_test": {
				return success(id, "ssh_test", await testRpcSshHost(command.host.name, command.host));
			}

			// =================================================================
			// C1 management surfaces (MCP add/test/reauth, marketplace, plugins)
			// =================================================================

			case "mcp_add": {
				try {
					const result = await applyRpcMcpAdd(session, command.name, command.config, command.scope);
					return success(id, "mcp_add", result);
				} catch (err: unknown) {
					return error(id, "mcp_add", err instanceof Error ? err.message : String(err));
				}
			}

			case "mcp_test": {
				// Background-dispatched (dispatchRpcInputFrame). Every outcome —
				// including argument and probe failures — rides the result shape.
				const result = await applyRpcMcpTest(session, command.name, command.config);
				return success(id, "mcp_test", result);
			}

			case "mcp_reauth": {
				// Background-dispatched (dispatchRpcInputFrame) so
				// mcp_reauth_cancel can overtake the browser login wait.
				try {
					const result = await applyRpcMcpReauth(session, command.name, rpcMcpOAuthUi);
					return success(id, "mcp_reauth", result);
				} catch (err: unknown) {
					if (err instanceof RpcMcpReauthBusyError) {
						return error(id, "mcp_reauth", err.message, err.code);
					}
					return error(id, "mcp_reauth", err instanceof Error ? err.message : String(err));
				}
			}

			case "mcp_reauth_cancel": {
				return success(id, "mcp_reauth_cancel", applyRpcMcpReauthCancel(command.name));
			}

			case "marketplace_action": {
				try {
					const result = await applyRpcMarketplaceAction(session, command);
					// Every successful mutation ends in the plugin-state reload so the
					// GUI receives a fresh available_commands_update.
					if (result.ok && command.action !== "list_available") await reloadPluginState();
					return success(id, "marketplace_action", result);
				} catch (err: unknown) {
					return error(id, "marketplace_action", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_gui_themes": {
				try {
					const result = await buildRpcGuiThemes(session);
					return success(id, "get_gui_themes", result);
				} catch (err: unknown) {
					return error(id, "get_gui_themes", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_plugin_detail": {
				try {
					const detail = await buildRpcPluginDetail(session, command.pluginId);
					return success(id, "get_plugin_detail", detail);
				} catch (err: unknown) {
					return error(id, "get_plugin_detail", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_plugin_features": {
				const result = await applyRpcSetPluginFeatures(session, command.pluginId, command.features);
				if (result.ok) await reloadPluginState();
				return success(id, "set_plugin_features", result);
			}

			case "set_plugin_setting": {
				const result = await applyRpcSetPluginSetting(session, command.pluginId, command.key, command.value);
				if (result.ok) await reloadPluginState();
				return success(id, "set_plugin_setting", result);
			}

			case "delete_plugin_setting": {
				const result = await applyRpcDeletePluginSetting(session, command.pluginId, command.key);
				if (result.ok) await reloadPluginState();
				return success(id, "delete_plugin_setting", result);
			}

			// =================================================================
			// Word prediction
			// =================================================================

			case "predict_word": {
				if (!isTextCursor(command.text, command.cursor)) {
					return error(id, "predict_word", INVALID_TEXT_CURSOR_ERROR);
				}
				try {
					const method = cfgSpellingAutocomplete.get(session.settings);
					const suffix = await wordPredictor.predict(method, command.text, command.cursor);
					return success(id, "predict_word", { suffix });
				} catch (err: unknown) {
					return error(id, "predict_word", err instanceof Error ? err.message : String(err));
				}
			}

			case "predict_word_feedback": {
				if (!isTextCursor(command.text, command.cursor)) {
					return error(id, "predict_word_feedback", INVALID_TEXT_CURSOR_ERROR);
				}
				if (typeof command.suggestion !== "string" || typeof command.accepted !== "boolean") {
					return error(id, "predict_word_feedback", "suggestion must be a string and accepted a boolean");
				}
				const method = cfgSpellingAutocomplete.get(session.settings);
				if (method !== "off") {
					const query = wordQueryAt(command.text, command.cursor);
					if (query) {
						textPredictionBackend(method).feedback(
							query.before,
							query.prefix,
							command.suggestion,
							command.accepted,
						);
					}
				}
				return success(id, "predict_word_feedback");
			}

			default: {
				const exhaustive: never = command;
				const unknownCommand = exhaustive as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		if (!Object.hasOwn(SESSION_CHANGE_TYPES, command.type)) return handleCommandImpl(command);
		return withSessionChange(() => handleCommandImpl(command));
	};

	// Deferred shutdown (pi.shutdown() from an extension) must not kill the
	// process while a background-dispatched bash/eval still owes the client its
	// response frame. The coordinator drains tracked tasks before exiting and
	// re-checks the request as each task settles.
	const shutdownCoordinator = new RpcShutdownCoordinator({
		isShutdownRequested: () => startupSucceeded && shutdownState.requested,
		performShutdown: async () => {
			// Route through the idempotent session.dispose() so the browser
			// reaper (releaseTabsForOwner) and other bounded teardown run before
			// the process exits. dispose() also emits `session_shutdown`, so we
			// must NOT emit it separately here or the event fires twice. Skipping
			// dispose left OMP-owned Chromium alive after RPC shutdown (#5643).
			await Promise.all([liveBridge.stop(), collabController.dispose()]);
			await disposeAndExit();
		},
	});

	// Use a resolving gate (including failure) so startup without any queued
	// commands cannot leave an unobserved rejected promise. Background commands
	// still bypass the serial tail, but cannot enter their handlers before init.
	const startup = Promise.withResolvers<Error | undefined>();
	let startupSucceeded = false;
	const dispatchFrameDeps: RpcInputFrameDeps = {
		handleCommand: async command => {
			const failure = await startup.promise;
			if (failure) throw failure;
			return handleCommand(command);
		},
		output,
		errorResponse: error,
		trackBackgroundTask: task => shutdownCoordinator.track(task),
		pendingExtensionRequests,
		onHostToolResult: frame => hostToolBridge.handleResult(frame),
		onHostToolUpdate: frame => hostToolBridge.handleUpdate(frame),
		onHostUriResult: frame => hostUriBridge.handleResult(frame),
	};

	const inputDispatcher = new RpcInputDispatcher({
		deps: dispatchFrameDeps,
		afterSerialCommand: () => shutdownCoordinator.checkShutdownRequested(),
		acceptInput: command => inputGate.accept(command),
	});

	// Start the sole reader BEFORE session_start. UI/host side channels must
	// remain live even while startup awaits a dialog. Malformed lines remain
	// recoverable; EOF immediately closes bridges, including future UI requests.
	const inputAbort = new AbortController();
	let inputFailure: Error | undefined;
	let startupPending = true;
	const inputTask = readRpcInputFrames(
		input,
		parsed => {
			// Commands wait for startup, but the ask-dialog opt-in is served at once, like a dialog answer:
			// a client may wait for it before answering the dialog session_start awaits.
			if (startupPending && isRecord(parsed) && parsed.type === "set_ask_dialog")
				output(setAskDialog(parsed as RpcCommand & { type: "set_ask_dialog" }));
			else inputDispatcher.dispatch(parsed);
		},
		message => output(error(undefined, "parse", message)),
		inputAbort.signal,
	)
		.catch(err => {
			inputFailure = err instanceof Error ? err : new Error(String(err));
			output(error(undefined, "input", inputFailure.message));
		})
		.finally(() => {
			pendingExtensionRequests.rejectAll("RPC client disconnected before extension UI response completed");
			hostToolBridge.close("RPC client disconnected before host tool execution completed");
			hostUriBridge.clear("RPC client disconnected before host URI request completed");
		});

	let startupFailure: Error | undefined;
	try {
		await initialize();
		if (inputFailure) throw inputFailure;
		// Exactly one truthful ready, in v1, before queued negotiation/commands.
		output({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
		});
		startupSucceeded = true;
	} catch (err) {
		startupFailure = err instanceof Error ? err : new Error(String(err));
		output(error(undefined, "startup", startupFailure.message));
		inputAbort.abort();
	} finally {
		startupPending = false;
		// Failed startup rejects accepted work through normal correlated responses,
		// not through a rejected reader task or a permanently closed command gate.
		startup.resolve(startupFailure);
	}

	await inputTask;
	hostDictation.cancel();
	dictationBridge.dispose();
	await liveBridge.stop();
	await inputDispatcher.drain();
	// A backgrounded builtin (e.g. a /mcp reauth browser wait) must not park
	// the drain: tear it down now that the client is gone.
	abortBuiltinCommands("RPC client disconnected");
	await shutdownCoordinator.drain();
	subagentRegistry?.dispose();
	await Promise.all([liveBridge.stop(), collabController.dispose()]);
	// Dispose the main session before exiting so the browser reaper and other
	// bounded teardown run on the stdin-EOF path too (#5643). Idempotent: a
	// prior pi.shutdown() through the coordinator makes this await settle
	// immediately. Returned rather than awaited: `runRpcMode` is typed
	// `Promise<never>`, and only returning the `Promise<never>` keeps this end
	// point unreachable for the compiler.
	return disposeAndExit(startupFailure || inputFailure ? 1 : 0);
}
