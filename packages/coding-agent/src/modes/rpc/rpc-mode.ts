/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
import { once } from "node:events";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { $env, isRecord, readLines, Snowflake, setProjectDir } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import { getKnownRoleIds, getRoleInfo, MODEL_ROLES } from "../../config/model-roles";
import { applyProviderGlobalsFromSettings } from "../../config/provider-globals";
import { SETTINGS_SCHEMA, type SettingPath } from "../../config/settings-schema";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	type ExtensionAskDialogQuestion,
	type ExtensionAskDialogResult,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import { buildSkillPromptMessage, parseSkillInvocation } from "../../extensibility/skills";
import { getAvailableThemesWithPaths, getResolvedThemeColors, type Theme, theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import { applyRuntimeSetting } from "../../session/apply-runtime-setting";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import { SessionManager } from "../../session/session-manager";
import { executeAcpBuiltinSlashCommand, isTuiOnlyBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { sttClient } from "../../stt/asr-client";
import { resolveSttModelSpec } from "../../stt/models";
import type { ToolSession } from "../../tools";
import { DebugTool } from "../../tools/debug";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { DEFAULT_TTS_VOICE } from "../../tts/models";
import { ttsClient } from "../../tts/tts-client";
import { decodeWav, encodeWav } from "../../tts/wav";
import type { EventBus } from "../../utils/event-bus";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import { initializeExtensions } from "../runtime-init";
import { buildCopyTargets } from "../utils/copy-targets";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import { applyRpcHookEnabled, applyRpcMcpAction, applyRpcPluginEnabled, applyRpcSkillEnabled } from "./rpc-actions";
import { applyRpcAbortSubagent, applyRpcReviveSubagent, buildRpcAgentDefinitions } from "./rpc-agents";
import { RpcBtwController } from "./rpc-btw";
import { RpcCollabController } from "./rpc-collab";
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
import { buildRpcProvidersResult, buildRpcSettingsSchema, buildRpcUsageResult } from "./rpc-extensions";
import { applyRpcImportForeignSession, buildRpcForeignSessionList } from "./rpc-foreign";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "./rpc-frame";
import { claimRpcInput } from "./rpc-input";
import { RpcLiveController } from "./rpc-live";
import { applyRpcMarketplaceAction } from "./rpc-marketplace";
import {
	applyRpcMcpAdd,
	applyRpcMcpReauth,
	applyRpcMcpReauthCancel,
	applyRpcMcpTest,
	type RpcMcpOAuthUi,
	RpcMcpReauthBusyError,
} from "./rpc-mcp-extra";
import { pageRpcMessages, RPC_MESSAGES_PAGE_BUSY_ERROR, RpcMessagesPageError } from "./rpc-messages";
import { RpcGoalModeController, RpcLoopModeController, RpcVibeModeController } from "./rpc-modes";
import { runRpcOmfg } from "./rpc-omfg";
import { applyRpcWriteLocalPaste } from "./rpc-paste";
import { RpcPlanApprovalController } from "./rpc-plan";
import {
	applyRpcDeletePluginSetting,
	applyRpcSetPluginFeatures,
	applyRpcSetPluginSetting,
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
import { applyRpcGetQueue, applyRpcQueueClear, applyRpcQueueMove, applyRpcQueueRemove } from "./rpc-queue";
import { buildRpcActiveTools, buildRpcContextReport, buildRpcJobs, shareRpcSession } from "./rpc-reports";
import {
	applyRpcFresh,
	applyRpcGetForceTool,
	applyRpcReloadPlugins,
	applyRpcSetForceTool,
	applyRpcSetPrewalk,
	applyRpcShakeContext,
} from "./rpc-session-actions";
import { applyRpcForkFrom, applyRpcSwitchLeaf } from "./rpc-session-extra";
import { buildRpcSessionTree } from "./rpc-session-tree";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "./rpc-subagents";
import { startRpcTan } from "./rpc-tan";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcReloadPluginsResult,
	RpcResponse,
	RpcSessionState,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";
import {
	applyRpcAddDirectory,
	applyRpcMoveSession,
	applyRpcRemoveDirectory,
	buildRpcWorkspaceDirectories,
	RpcWorkspaceBusyError,
} from "./rpc-workspace";
import { buildRpcGitStatus, createRpcWorktree, RpcWorktreeError, removeRpcWorktree } from "./rpc-worktree";

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

export type RpcSessionChangeCommand = Extract<
	RpcCommand,
	| { type: "new_session" }
	| { type: "drop_session" }
	| { type: "switch_session" }
	| { type: "branch" }
	| { type: "fork" }
>;

export type RpcSessionChangeResult =
	| { type: "new_session"; data: { cancelled: boolean } }
	| { type: "drop_session"; data: { cancelled: boolean } }
	| { type: "switch_session"; data: { cancelled: boolean } }
	| { type: "branch"; data: { text: string; cancelled: boolean } }
	| { type: "fork"; data: { cancelled: boolean } };

export type RpcSessionChangeSession = Pick<AgentSession, "newSession" | "switchSession" | "branch" | "fork">;

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;
export type RpcSkillCommandResult = { agentInvoked: true };

export async function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp" = "steer",
): Promise<RpcSkillCommandResult | false> {
	if (!session.skillsSettings?.enableSkillCommands) return false;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return false;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return false;
	const built = await buildSkillPromptMessage(skill, parsed.args, "user");
	await session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: built.message,
			display: true,
			details: built.details,
			attribution: "user",
		},
		{ streamingBehavior },
	);
	return { agentInvoked: true };
}

export function reportLocalOnlyPromptResult(input: {
	id: string | undefined;
	prompt: Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	hasExtensionAgentMessageTask?: () => boolean;
	waitForExtensionAgentMessageTasks?: () => Promise<void>;
}): void {
	void input.prompt
		.then(async agentInvoked => {
			if (agentInvoked) return;
			await input.waitForExtensionAgentMessageTasks?.();
			if (!input.hasExtensionAgentMessageTask?.()) {
				input.output({ type: "prompt_result", id: input.id, agentInvoked: false });
			}
		})
		.catch(error => {
			input.onError(error instanceof Error ? error : new Error(String(error)));
		});
}

type RpcExtensionUserMessageScope = {
	hasAgentMessageTask: boolean;
	pendingAgentMessageTasks: Set<Promise<void>>;
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; that prompt must not report agentInvoked:false to the host.
 */
export class RpcExtensionUserMessageTracker {
	#activePromptScopes = new Set<RpcExtensionUserMessageScope>();

	markAgentMessageTask(): void {
		for (const scope of this.#activePromptScopes) {
			scope.hasAgentMessageTask = true;
		}
	}

	trackAgentMessageTask(task: Promise<unknown>): void {
		for (const scope of this.#activePromptScopes) {
			this.#trackAgentMessageTaskForScope(scope, task);
		}
	}

	#trackAgentMessageTaskForScope(scope: RpcExtensionUserMessageScope, task: Promise<unknown>): void {
		const scopedTask = task.then(
			() => {
				scope.hasAgentMessageTask = true;
			},
			() => {},
		);
		scope.pendingAgentMessageTasks.add(scopedTask);
		void scopedTask.finally(() => {
			scope.pendingAgentMessageTasks.delete(scopedTask);
		});
	}

	async #waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
		while (scope.pendingAgentMessageTasks.size > 0) {
			await Promise.allSettled(Array.from(scope.pendingAgentMessageTasks));
		}
	}

	watchPrompt<T>(startPrompt: () => Promise<T>): {
		prompt: Promise<T>;
		hasAgentMessageTask: () => boolean;
		waitForAgentMessageTasks: () => Promise<void>;
	} {
		const scope: RpcExtensionUserMessageScope = {
			hasAgentMessageTask: false,
			pendingAgentMessageTasks: new Set(),
		};
		this.#activePromptScopes.add(scope);
		let prompt: Promise<T>;
		try {
			prompt = startPrompt();
		} catch (error) {
			this.#activePromptScopes.delete(scope);
			throw error;
		}
		return {
			prompt: prompt.finally(() => {
				this.#activePromptScopes.delete(scope);
			}),
			hasAgentMessageTask: () => scope.hasAgentMessageTask,
			waitForAgentMessageTasks: () => this.#waitForAgentMessageTasks(scope),
		};
	}
}

export function watchAndReportLocalOnlyPromptResult(input: {
	id: string | undefined;
	startPrompt: () => Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
}): void {
	const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(input.startPrompt);
	reportLocalOnlyPromptResult({
		id: input.id,
		prompt: trackedPrompt.prompt,
		output: input.output,
		onError: input.onError,
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
	});
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
 * Command types dispatched in the background instead of queueing behind the
 * serial command tail. Execution, discovery/import, OAuth, and local speech
 * inference can all be slow; their control frames or an unrelated prompt must
 * remain readable while they run. Shared by RpcInputDispatcher.dispatch's
 * immediate-spawn fast path and dispatchRpcInputFrame's background spawn so
 * the two never drift.
 */
function isBackgroundRpcCommand(type: RpcCommand["type"]): boolean {
	return (
		type === "bash" ||
		type === "eval" ||
		type === "list_foreign_sessions" ||
		type === "import_foreign_session" ||
		type === "worktree_create" ||
		type === "worktree_remove" ||
		type === "pr_repo" ||
		type === "pr_list" ||
		type === "pr_get" ||
		type === "pr_diff" ||
		type === "pr_draft" ||
		type === "pr_create" ||
		type === "pr_checkout" ||
		type === "mcp_test" ||
		type === "mcp_reauth" ||
		type === "transcribe_audio" ||
		type === "synthesize_speech" ||
		type === "debug" ||
		type === "live_start" ||
		type === "collab_start" ||
		type === "collab_join"
	);
}

/**
 * Dispatch a single parsed frame from the RPC input stream.
 *
 * Long-running and long-lived commands are dispatched in the background so
 * the caller can keep reading subsequent control frames. This lets a client
 * send `abort_bash`/`abort_eval`, stop live voice or collaboration, or issue
 * unrelated requests while the original command is still running. Response
 * correlation is preserved via each command's `id`; ordering across concurrent
 * commands is not guaranteed and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or dispatched in the
 *   background. Otherwise a promise that resolves once the
 *   response for the command has been emitted via `output`. Errors from
 *   `handleCommand` on non-background commands propagate; the caller is
 *   expected to wrap them.
 */
export function dispatchRpcInputFrame(parsed: unknown, deps: RpcInputFrameDeps): Promise<void> | undefined {
	if (dispatchRpcControlFrame(parsed, deps)) return undefined;
	// Regular RPC command. The transport contract states each remaining frame
	// is an {@link RpcCommand}; `handleCommand`'s `default` arm surfaces
	// unknown discriminants as an error response, so we do not shape-check
	// the union here.
	const command = parsed as RpcCommand;

	// Long-running executions, source scans/imports, MCP probes/OAuth, and local
	// speech inference run in the background. Abort/control frames and ordinary
	// prompts therefore remain responsive; responses correlate by command id.
	if (isBackgroundRpcCommand(command.type)) {
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

/** Serializes ordinary RPC commands while allowing control frames to dispatch immediately. */
export class RpcInputDispatcher {
	#tail: Promise<void> = Promise.resolve();
	#tasks = new Set<Promise<void>>();
	readonly #deps: RpcInputFrameDeps;
	readonly #afterSerialCommand: (() => Promise<void>) | undefined;

	constructor(options: { deps: RpcInputFrameDeps; afterSerialCommand?: () => Promise<void> }) {
		this.#deps = options.deps;
		this.#afterSerialCommand = options.afterSerialCommand;
	}

	/** Accept a parsed input frame without blocking the stdin reader. */
	dispatch(parsed: unknown): void {
		try {
			if (dispatchRpcControlFrame(parsed, this.#deps)) return;

			const command = parsed as RpcCommand;
			// Immediate-spawn fast path: background commands never wait behind
			// the serial tail (a slow mcp_reauth would otherwise hold every
			// later frame hostage — including the mcp_reauth_cancel meant to
			// overtake it).
			if (isBackgroundRpcCommand(command.type)) {
				dispatchRpcInputFrame(command, this.#deps);
				return;
			}

			const task = this.#tail.then(
				() => this.#dispatchSerialCommand(command),
				() => this.#dispatchSerialCommand(command),
			);
			this.#tail = task.catch(() => {});
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
 * not exit while a background-dispatched command (`bash`, see
 * {@link dispatchRpcInputFrame}) still owes the client a response frame. The
 * coordinator tracks those tasks, re-checks the shutdown request whenever one
 * settles (covering a shutdown requested mid-bash with no follow-up client
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

export type RpcSubagentResetRegistry = Pick<RpcSubagentRegistry, "clear">;

export async function handleRpcSessionChange(
	session: RpcSessionChangeSession,
	command: RpcSessionChangeCommand,
	subagentRegistry?: RpcSubagentResetRegistry,
): Promise<RpcSessionChangeResult> {
	switch (command.type) {
		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const cancelled = !(await session.newSession(options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "new_session", data: { cancelled } };
		}

		case "drop_session": {
			const cancelled = !(await session.newSession({ drop: true }));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "drop_session", data: { cancelled } };
		}

		case "switch_session": {
			const cancelled = !(await session.switchSession(command.sessionPath));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "switch_session", data: { cancelled } };
		}

		case "branch": {
			const result = await session.branch(command.entryId);
			if (!result.cancelled) subagentRegistry?.clear();
			return { type: "branch", data: { text: result.selectedText, cancelled: result.cancelled } };
		}

		case "fork": {
			const cancelled = !(await session.fork());
			if (!cancelled) subagentRegistry?.clear();
			return { type: "fork", data: { cancelled } };
		}
	}
	throw new Error("Unsupported RPC session change command");
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
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		cleanup();
		resolve(defaultValue);
	};
	opts?.signal?.addEventListener("abort", onAbort, { once: true });

	if (opts?.timeout !== undefined) {
		timeoutId = setTimeout(() => {
			opts.onTimeout?.();
			cleanup();
			resolve(defaultValue);
		}, opts.timeout);
	}

	pendingRequests.set(id, {
		resolve: response => {
			cleanup();
			resolve(parseResponse(response));
		},
		reject,
	});
	output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
	return promise;
}
/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	eventBus?: EventBus,
	input: ReadableStream<Uint8Array> = claimRpcInput(),
): Promise<never> {
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.PI_NOTIFICATIONS = "off";

	const frameEncoder = new RpcFrameEncoder();
	// Ordered stdout writer honoring backpressure: chunked v2 frames are produced
	// lazily by the encoder and written one physical line at a time, so a near-limit
	// logical frame never materializes its full base64 transport in memory.
	let stdoutQueue: Promise<void> = Promise.resolve();
	const writeFrames = (frames: Iterable<string>) => {
		stdoutQueue = stdoutQueue
			.then(async () => {
				for (const line of frames) {
					if (!process.stdout.write(line)) await once(process.stdout, "drain");
				}
			})
			// stdout gone (host exited) — nothing left to deliver; keep the queue alive.
			.catch(() => {});
	};
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeFrames(frameEncoder.encodeFrames(obj));
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
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string, code?: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) };
	};

	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();

	const pendingExtensionRequests = new RpcPendingExtensionRequests();
	// OAuth UI bridge for mcp_reauth (C1): the browser URL rides the EXISTING
	// open_url frame (same emission as the login command), progress rides
	// notify, and the manual code paste-back rides the EXISTING input dialog
	// plumbing (requestRpcDialog over pendingExtensionRequests).
	const rpcMcpOAuthUi: RpcMcpOAuthUi = {
		openUrl: info =>
			output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "open_url",
				url: info.url,
				launchUrl: info.launchUrl,
				instructions: info.instructions,
			} as RpcExtensionUIRequest),
		notify: message =>
			output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: "info",
			} as RpcExtensionUIRequest),
		input: (title, placeholder, signal) =>
			requestRpcDialog<string | undefined>(
				pendingExtensionRequests,
				output,
				// The reauth cancel channel: aborting dismisses the remote input
				// dialog (method:"cancel" frame) and resolves the pending extension
				// request instead of leaking it.
				signal ? { signal } : undefined,
				undefined,
				{ method: "input", title, placeholder },
				response => parseValueDialogResponse(response, undefined),
			),
	};
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	const subagentRegistry = eventBus ? new RpcSubagentRegistry(eventBus, output) : undefined;
	const planApprovalController = new RpcPlanApprovalController({
		session,
		output,
		onError: err => output(error(undefined, "plan_approval", err.message)),
	});
	const btwController = new RpcBtwController(session);
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
		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
		) {}

		select(
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				undefined,
				{
					method: "select",
					title,
					options: options.map(getExtensionUISelectOptionLabel),
					timeout: dialogOptions?.timeout,
				},
				response => parseValueDialogResponse(response, dialogOptions),
			);
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
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				undefined,
				{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		askDialog(
			questions: ExtensionAskDialogQuestion[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<ExtensionAskDialogResult | undefined> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				undefined,
				{ method: "askDialog", questions, timeout: dialogOptions?.timeout },
				response => {
					if ("cancelled" in response && response.cancelled) {
						if (response.timedOut) dialogOptions?.onTimeout?.();
						return undefined;
					}
					if ("askDialog" in response) return response.askDialog;
					return undefined;
				},
			);
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

		async custom(): Promise<never> {
			// Custom UI not supported in RPC mode
			return undefined as never;
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
			return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
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
	}

	// Wire up UI context for tool execution (ask tool, etc.) and extensions.
	// A single shared instance routes all responses received on stdin to the
	// correct waiting promise regardless of which code path created the request.
	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output);
	setToolUIContext?.(rpcUiContext, true);
	const liveController = new RpcLiveController(session, output);
	const collabController = new RpcCollabController({
		session,
		eventBus,
		output,
		notify: (message, type) => rpcUiContext.notify(message, type),
		select: (title, options, dialogOptions) => rpcUiContext.select(title, options, dialogOptions),
		edit: (title, prefill, dialogOptions) => rpcUiContext.editor(title, prefill, dialogOptions),
	});
	let askReanswerAwaitingResumeLeafId: string | undefined;

	// Set up extensions with RPC-based UI context
	await initializeExtensions(session, {
		reportSendError: (action, err) => {
			output(error(undefined, action, err.message));
		},
		reportRuntimeError: err => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
		onShutdown: () => {
			shutdownState.requested = true;
		},
		trackAgentInvokingMessage: task => {
			extensionUserMessageTracker.trackAgentMessageTask(task);
		},
		uiContext: rpcUiContext,
	});

	// Output all agent events as JSON
	session.subscribe(event => {
		output(event);
	});
	// Plan proposals and mode lifecycle ride a second subscription: plan
	// proposals emit `plan_proposal` and silently stop the proposal turn while
	// the host reviews; goal/loop drive their TUI-mirrored transitions.
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

	// plan.defaultOnStartup: the TUI and print mode arm plan mode on a fresh
	// boot session; the RPC boot path missed it, so GUI sessions never
	// inherited the default (audit finding — session behavior trapped in the
	// TUI). Mirrors print-mode's arming, minus the abort-after-proposal hook.
	if (
		session.settings.get("plan.defaultOnStartup") &&
		session.settings.get("plan.enabled") &&
		session.sessionManager.buildSessionContext().messages.length === 0 &&
		!session.sessionManager.getEntries().some(entry => entry.type === "mode_change") &&
		!session.getPlanModeState()?.enabled
	) {
		const planFilePath = session.getPlanReferencePath() || "local://PLAN.md";
		const previousTools = session.getEnabledToolNames();
		const planTools = session.hasBuiltInTool("write") ? [...new Set([...previousTools, "write"])] : previousTools;
		await session.setActiveToolsByName(planTools);
		session.setPlanModeState({ enabled: true, planFilePath, workflow: "parallel" });
		session.sessionManager.appendModeChange("plan", { planFilePath });
	}

	const getAvailableCommands = async () =>
		buildAvailableSlashCommands(session, undefined, { includeTuiOnlyBuiltins: true });
	const reloadPluginState = async (): Promise<RpcReloadPluginsResult> => {
		return applyRpcReloadPlugins(session, commands => {
			output({ type: "available_commands_update", commands });
		});
	};
	const emitAvailableCommandsUpdate = async () => {
		output({ type: "available_commands_update", commands: await getAvailableCommands() });
	};
	session.subscribeCommandMetadataChanged(() => {
		void emitAvailableCommandsUpdate();
	});
	await emitAvailableCommandsUpdate();

	// Send ready frame AFTER extension initialization so the GUI only sees
	// "ready" when the command loop is actually able to process commands.
	// Previously this was sent before initializeExtensions, which meant a
	// crash or hang during extension setup left the GUI thinking the sidecar
	// was responsive when it was not.
	writeFrames(
		frameEncoder.encodeFrames({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
		}),
	);

	// Bound the background-discovery await used by model-listing commands.
	// The RPC command queue is serial, so an unbounded
	// `awaitBackgroundRefresh()` that stalls (headless provider/MCP discovery
	// hanging) wedges every later command — including unrelated session
	// switches and health probes — until the sidecar restarts. Racing it
	// against a short timeout lets the command return current (possibly
	// partial) models and unblock the queue; the refresh keeps running in the
	// background and the next listing will reflect it once it completes.
	const DISCOVERY_WAIT_MS = 4_000;
	const awaitDiscoveryBounded = (): Promise<void> =>
		Promise.race([
			session.modelRegistry.awaitBackgroundRefresh(),
			new Promise<void>(resolve => setTimeout(resolve, DISCOVERY_WAIT_MS)),
		]);

	// Workspace-directory mutations surface streaming refusals with the
	// machine-readable "busy" code (TUI "Cannot … while streaming." parity);
	// domain refusals (missing path, primary removal) ride the plain message.
	const workspaceError = (id: string | undefined, command: string, err: unknown): RpcResponse => {
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

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

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
				if (collabController.isGuest && !command.message.trimStart().startsWith("/")) {
					collabController.sendPrompt(command.message, command.images);
					return success(id, "prompt");
				}
				// TUI captures every submitted prompt as the loop prompt while loop
				// mode is enabled (input-controller's setLoopPrompt).
				const skillResult = await tryRunRpcSkillCommand(session, command.message, command.streamingBehavior);
				if (skillResult) {
					return success(id, "prompt", skillResult);
				}
				const builtinResult = await executeAcpBuiltinSlashCommand(command.message, {
					session,
					sessionManager: session.sessionManager,
					settings: session.settings,
					cwd: session.sessionManager.getCwd(),
					output: text => output({ type: "command_output", text }),
					refreshCommands: emitAvailableCommandsUpdate,
					reloadPlugins: async () => {
						await reloadPluginState();
					},
					notifyTitleChanged: async () => {
						output({
							type: "session_info_update",
							title: session.sessionName,
							sessionId: session.sessionId,
							kind: session.sessionManager.getHeader()?.kind,
						});
					},
					notifyConfigChanged: async () => {
						output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
					},
				});
				if (builtinResult !== false) {
					if ("prompt" in builtinResult) {
						watchAndReportLocalOnlyPromptResult({
							id,
							startPrompt: () => session.prompt(builtinResult.prompt, { images: command.images }),
							output,
							onError: promptError => output(error(id, "prompt", promptError.message)),
							extensionUserMessageTracker,
						});
						return success(id, "prompt");
					}
					return success(id, "prompt", { agentInvoked: false });
				}
				if (isTuiOnlyBuiltinSlashCommand(command.message)) {
					return error(id, "prompt", "Command requires an interactive client UI");
				}

				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				watchAndReportLocalOnlyPromptResult({
					id,
					startPrompt: () =>
						session.prompt(command.message, {
							images: command.images,
							streamingBehavior: command.streamingBehavior,
						}),
					output,
					onError: promptError => output(error(id, "prompt", promptError.message)),
					extensionUserMessageTracker,
				});
				return success(id, "prompt");
			}

			case "steer": {
				if (collabController.sendPrompt(command.message, command.images)) return success(id, "steer");
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				if (collabController.sendPrompt(command.message, command.images)) return success(id, "follow_up");
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				// TUI Esc pauses the loop before aborting the current iteration.
				loopModeController.pause();
				if (!collabController.sendAbort()) await session.abort({ reason: USER_INTERRUPT_LABEL });
				return success(id, "abort");
			}

			case "abort_and_prompt": {
				loopModeController.pause();
				if (collabController.sendAbort()) {
					collabController.sendPrompt(command.message, command.images);
					return success(id, "abort_and_prompt");
				}
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				loopModeController.onHostPrompt(command.message);
				session
					.prompt(command.message, { images: command.images })
					.catch(e => output(error(id, "abort_and_prompt", e.message)));
				return success(id, "abort_and_prompt");
			}

			case "switch_session": {
				// Guard: refuse cross-kind switches (I3 — reject rather than degrade)
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
				const result = await handleRpcSessionChange(session, command, subagentRegistry);
				if (!result.data.cancelled) await emitAvailableCommandsUpdate();
				planApprovalController.syncArmed();
				return success(id, result.type, result.data);
			}

			case "new_session":
			case "drop_session":
			case "branch":
			case "fork": {
				const result = await handleRpcSessionChange(session, command, subagentRegistry);
				if (!result.data.cancelled) await emitAvailableCommandsUpdate();
				planApprovalController.syncArmed();
				return success(id, result.type, result.data);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
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
					todoPhases: session.getTodoPhases(),
					fastModeEnabled: session.isFastModeEnabled(),
					tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
					fastModeActive: session.isFastModeActive(),
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

			case "get_available_commands": {
				return success(id, "get_available_commands", { commands: await getAvailableCommands() });
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
					return success(id, "get_command_arg_completions", { items: items ?? [] });
				} catch (err) {
					return error(id, "get_command_arg_completions", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				return success(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = hostToolBridge.setTools(tools);
				await session.refreshRpcHostTools(rpcTools);
				return success(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
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
				return success(id, "set_subagent_subscription", { level: subagentRegistry.getSubscriptionLevel() });
			}

			case "get_subagents": {
				if (!subagentRegistry) {
					return error(id, "get_subagents", "Subagent event bus is unavailable");
				}
				return success(id, "get_subagents", { subagents: subagentRegistry.getSubagents() });
			}

			case "get_subagent_messages": {
				if (!subagentRegistry) {
					return error(id, "get_subagent_messages", "Subagent event bus is unavailable");
				}
				try {
					if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
						return error(id, "get_subagent_messages", "fromByte must be a finite number");
					}
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

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				let models = session.getAvailableModels();
				let model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					// Model not in the current catalog. Wait for in-flight
					// background discovery before declaring it missing: on cold
					// start, discovery-backed providers (proxy / ollama / etc.)
					// populate seconds after session ready. Models already in
					// the bundled catalog skip this await entirely so the RPC
					// queue is not stalled behind unrelated discovery.
					await awaitDiscoveryBounded();
					models = session.getAvailableModels();
					model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				}
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
				await awaitDiscoveryBounded();
				const models = session.getAvailableModels();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				session.setInterruptMode(command.mode);
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

			case "queue_remove": {
				try {
					return success(id, "queue_remove", applyRpcQueueRemove(session, command.queueId));
				} catch (err) {
					return error(id, "queue_remove", err instanceof Error ? err.message : String(err));
				}
			}

			case "queue_move": {
				try {
					return success(id, "queue_move", applyRpcQueueMove(session, command.queueId, command.toIndex));
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
				return success(id, "clear_context", { cleared: true, droppedCount: result.droppedCount });
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

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return success(id, "get_branch_messages", { messages });
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
					return success(id, "get_theme_colors", { name: command.name, colors });
				} catch (err) {
					return error(id, "get_theme_colors", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_transcript": {
				// Full display history (all messages on the active branch), NOT the
				// LLM context window that get_messages returns.
				const transcript = session.buildTranscriptSessionContext();
				return success(id, "get_transcript", { messages: transcript.messages });
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
						applyCwdChange: async newCwd => {
							// TUI applyCwdChange parity: re-point the process, project
							// settings, provider globals, and plugin/capability caches at
							// the destination so the next prompt sees the new project's
							// configuration and commands.
							setProjectDir(newCwd);
							await session.settings.reloadForCwd(newCwd);
							applyProviderGlobalsFromSettings(session.settings);
							await reloadPluginState();
						},
					});
					return success(id, "move_session", result);
				} catch (err) {
					return workspaceError(id, "move_session", err);
				}
			}

			// =================================================================
			// Git worktrees (GUI tab × worktree binding; plan/20 in the GUI repo)
			// =================================================================

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
						await removeRpcWorktree(session, { path: command.path, force: command.force }),
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
						await buildRpcPrList(session, { state: command.state, limit: command.limit }),
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
						await buildRpcPrFileDiff(session, { number: command.number, path: command.path }),
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
						await buildRpcPrDraft(session, { base: command.base, head: command.head }),
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
					const modelKey = resolveSttModelSpec(session.settings.get("stt.modelName") as string | undefined).key;
					const language = session.settings.get("stt.language") as string | undefined;
					const text = await sttClient.transcribe(modelKey, samples, { language: language || undefined });
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
					if (!text) return success(id, "synthesize_speech", { audioBase64: "", mimeType: "audio/wav" });
					const modelKey = session.settings.get("tts.localModel");
					const voice = session.settings.get("speech.voice") || DEFAULT_TTS_VOICE;
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

			case "live_start": {
				try {
					const state = await liveController.start(command.voice ?? session.settings.get("live.voice"));
					return success(id, "live_start", state);
				} catch (err: unknown) {
					return error(id, "live_start", err instanceof Error ? err.message : String(err));
				}
			}

			case "live_toggle_mute": {
				try {
					return success(id, "live_toggle_mute", liveController.toggleMute());
				} catch (err: unknown) {
					return error(id, "live_toggle_mute", err instanceof Error ? err.message : String(err));
				}
			}

			case "live_stop": {
				try {
					return success(id, "live_stop", await liveController.stop());
				} catch (err: unknown) {
					return error(id, "live_stop", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_live_state": {
				return success(id, "get_live_state", liveController.state);
			}

			case "debug": {
				try {
					const debugSession = {
						cwd: session.sessionManager.getCwd(),
						hasUI: true,
						settings: session.settings,
					} as ToolSession;
					const result = await new DebugTool(debugSession).execute(Snowflake.next() as string, command.params);
					return success(id, "debug", { content: result.content, details: result.details });
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
				return success(id, "get_copy_targets", { targets: buildCopyTargets(session) });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
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
				return success(id, "get_messages", { messages: session.messages });
			}

			case "get_messages_page": {
				if (session.isStreaming || session.isCompacting)
					return error(id, "get_messages_page", RPC_MESSAGES_PAGE_BUSY_ERROR, "session_busy");
				const messages = session.messages;
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

			// =================================================================
			// Login
			// =================================================================

			case "get_login_providers": {
				const providers = getOAuthProviders().map(provider => ({
					id: provider.id,
					name: provider.name,
					available: provider.available,
					authenticated: session.modelRegistry.authStorage.hasAuth(provider.id),
				}));
				return success(id, "get_login_providers", { providers });
			}

			case "login": {
				const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
				if (!knownProvider) {
					return error(id, "login", `Unknown OAuth provider: ${command.providerId}`);
				}
				const uiCtx = new RpcExtensionUIContext(pendingExtensionRequests, output);
				try {
					await session.modelRegistry.authStorage.login(command.providerId, {
						onAuth: info => {
							output({
								type: "extension_ui_request",
								id: Snowflake.next() as string,
								method: "open_url",
								url: info.url,
								launchUrl: info.launchUrl,
								instructions: info.instructions,
							} as RpcExtensionUIRequest);
						},
						onProgress: message => {
							uiCtx.notify(message, "info");
						},
						// GUI consumers render input dialogs, so every prompt in a
						// login flow — including pre-auth ones like region selection
						// or a custom base URL — is satisfiable; no headless rejection.
						onPrompt: async prompt => {
							return (await uiCtx.input(prompt.message, prompt.placeholder, { timeout: 600_000 })) ?? "";
						},
					});
					// Provider-scoped online refresh so the just-persisted credential
					// re-runs discovery instead of reusing a fresh authoritative cache
					// row (#5780).
					await session.modelRegistry.refreshProvider(command.providerId, "online");
					return success(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					return error(id, "login", err instanceof Error ? err.message : String(err));
				}
			}

			// =================================================================
			// Extension Features (usage / settings / providers)
			// =================================================================

			case "logout": {
				try {
					await session.modelRegistry.authStorage.logout(command.providerId);
					return success(id, "logout", { providerId: command.providerId });
				} catch (err: unknown) {
					return error(id, "logout", err instanceof Error ? err.message : String(err));
				}
			}

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
				const paths = command.paths ?? Object.keys(SETTINGS_SCHEMA);
				const values: Record<string, unknown> = {};
				for (const p of paths) {
					if (p in SETTINGS_SCHEMA) {
						values[p] = session.settings.get(p as SettingPath);
					}
				}
				return success(id, "get_settings", {
					values,
					advisorEnabled: session.isAdvisorEnabled(),
					advisorActive: session.isAdvisorActive(),
				});
			}

			case "set_setting": {
				if (!(command.path in SETTINGS_SCHEMA)) {
					return error(id, "set_setting", `Unknown setting path: ${command.path}`);
				}
				try {
					session.settings.set(command.path as SettingPath, command.value as never);
					await session.settings.flush();
					// Live-apply runtime keys to the running session — previously only
					// the TUI selector did this, so RPC edits looked broken until restart.
					await applyRuntimeSetting(session, command.path, command.value);
					const advisorEnabled = command.path === "advisor.enabled" ? session.isAdvisorEnabled() : undefined;
					const advisorActive = command.path === "advisor.enabled" ? session.isAdvisorActive() : undefined;
					output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
					return success(id, "set_setting", {
						path: command.path,
						value: command.value,
						...(advisorEnabled === undefined ? {} : { advisorEnabled, advisorActive }),
					});
				} catch (err: unknown) {
					return error(id, "set_setting", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_providers": {
				try {
					const result = buildRpcProvidersResult(session);
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
					session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
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
				return success(id, "get_vibe_mode", { enabled: vibeModeController.enabled });
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

			case "btw": {
				try {
					return success(id, "btw", await btwController.start(command.question));
				} catch (err: unknown) {
					return error(id, "btw", err instanceof Error ? err.message : String(err));
				}
			}

			case "btw_branch": {
				try {
					const result = await btwController.branch();
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
				const roleIds = getKnownRoleIds(session.settings);
				const roles = roleIds.map(roleId => {
					const info = getRoleInfo(roleId, session.settings);
					const model = session.settings.getModelRole(roleId);
					const source = session.settings.getModelRoleSource(roleId);
					return {
						id: roleId,
						name: info.name,
						tag: info.tag,
						color: info.color,
						model: model ?? undefined,
						source,
					};
				});
				return success(id, "get_model_roles", { roles });
			}

			case "set_model_role": {
				try {
					session.settings.setModelRole(command.role, command.modelId ?? undefined);
					await session.settings.flush();
					output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
					return success(id, "set_model_role", { role: command.role, modelId: command.modelId });
				} catch (err: unknown) {
					return error(id, "set_model_role", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_model_role_metadata": {
				const builtIn = Object.entries(MODEL_ROLES).map(([id, info]) => ({
					id,
					name: info.name,
					tag: info.tag,
					color: info.color,
					hidden: info.hidden || undefined,
				}));
				const customTags = session.settings.get("modelTags") as
					| Record<string, { name?: string; color?: string; hidden?: boolean }>
					| undefined;
				const custom = customTags
					? Object.entries(customTags)
							.filter(([id]) => !(id in MODEL_ROLES))
							.map(([id, tag]) => ({
								id,
								name: tag.name ?? id,
								tag: id.toUpperCase(),
								color: tag.color ?? "default",
								hidden: tag.hidden || undefined,
							}))
					: [];
				return success(id, "get_model_role_metadata", { roles: [...builtIn, ...custom] });
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

			case "get_memory_report": {
				try {
					const result = await buildRpcMemoryReport(session);
					return success(id, "get_memory_report", result);
				} catch (err: unknown) {
					return error(id, "get_memory_report", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_context_report": {
				return success(id, "get_context_report", buildRpcContextReport(session));
			}

			case "get_active_tools": {
				return success(id, "get_active_tools", buildRpcActiveTools(session));
			}

			case "share_session": {
				try {
					return success(id, "share_session", await shareRpcSession(session));
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
					await reloadPluginState();
					return success(id, "set_skill_enabled", result);
				} catch (err: unknown) {
					return error(id, "set_skill_enabled", err instanceof Error ? err.message : String(err));
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

			default: {
				const exhaustive: never = command;
				const unknownCommand = exhaustive as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	// Deferred shutdown (pi.shutdown() from an extension) must not kill the
	// process while a background-dispatched bash/eval still owes the client its
	// response frame. The coordinator drains tracked tasks before exiting and
	// re-checks the request as each task settles.
	const shutdownCoordinator = new RpcShutdownCoordinator({
		isShutdownRequested: () => shutdownState.requested,
		performShutdown: async () => {
			// Route through the idempotent session.dispose() so the browser
			// reaper (releaseTabsForOwner) and other bounded teardown run before
			// the process exits. dispose() also emits `session_shutdown`, so we
			// must NOT emit it separately here or the event fires twice. Skipping
			// dispose left OMP-owned Chromium alive after RPC shutdown (#5643).
			await Promise.all([liveController.dispose(), collabController.dispose()]);
			await session.dispose();
			process.exit(0);
		},
	});

	const dispatchFrameDeps: RpcInputFrameDeps = {
		handleCommand,
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
	});

	// Keep the stdin reader moving: side-channel frames dispatch immediately,
	// ordinary commands serialize through inputDispatcher, and bash/eval remain
	// background-dispatched so abort_bash/abort_eval can overtake them. Frames
	// are read line-by-line and parsed here (not via readJsonl) so a single
	// malformed line is reported as an error frame and the loop keeps running
	// instead of throwing out of the generator and killing the whole process
	// (issue #5194).
	const decoder = new TextDecoder();
	for await (const line of readLines(input ?? Bun.stdin.stream())) {
		const text = decoder.decode(line).trim();
		if (!text) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			output(error(undefined, "parse", `Failed to parse command: ${message}`));
			continue;
		}
		inputDispatcher.dispatch(parsed);
	}

	// stdin closed — RPC client is gone. Fail pending side-channel requests
	// first so active/queued commands can settle, then drain accepted work.
	pendingExtensionRequests.rejectAll("RPC client disconnected before extension UI response completed");
	hostToolBridge.close("RPC client disconnected before host tool execution completed");
	hostUriBridge.clear("RPC client disconnected before host URI request completed");
	await inputDispatcher.drain();
	await shutdownCoordinator.drain();
	subagentRegistry?.dispose();
	await Promise.all([liveController.dispose(), collabController.dispose()]);
	// Dispose the main session before exiting so the browser reaper and other
	// bounded teardown run on the stdin-EOF path too (#5643). Idempotent: a
	// prior pi.shutdown() through the coordinator makes this await settle
	// immediately.
	await session.dispose();
	process.exit(0);
}
