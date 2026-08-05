/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */
import type { AgentMessage, AgentToolResult, ThinkingLevel, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Effort, ImageContent, Model, ToolExample } from "@oh-my-pi/pi-ai";
import type { BashResult } from "../../exec/bash-executor";
import type { ContextUsage, ExtensionAskDialogQuestion, ExtensionAskDialogResult } from "../../extensibility/extensions/types";
import type { GoalStatus } from "../../goals/state";
import type { MemoryBackendId } from "../../memory-backend/types";
import type { LoopLimitRuntime } from "../loop-limit";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import type { RestoredQueuedMessage } from "../../session/agent-session-types";
import type { FileEntry } from "../../session/session-entries";
import type { AvailableSlashCommandSource } from "../../slash-commands/available-commands";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type {
	AgentProgress,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "../../task";
import type { TodoPhase } from "../../tools/todo";
import type { RpcMessagesPage } from "./rpc-messages";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Protocol
	| { id?: string; type: "negotiate_protocol"; protocolVersion: number }

	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_fast_mode"; enabled: boolean }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
	| { id?: string; type: "set_subagent_subscription"; level: RpcSubagentSubscriptionLevel }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel | "auto" }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }

	// Queue restore (TUI Alt+Up parity: pull queued steer/follow-up messages back out)
	| { id?: string; type: "dequeue" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Eval (user-initiated `$`/`$$` execution; `excluded` is the `$$` exclude-from-context form)
	| { id?: string; type: "eval"; language?: RpcEvalLanguage; code: string; excluded?: boolean }
	| { id?: string; type: "abort_eval" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "fork" }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "set_entry_label"; entryId: string; label?: string }
	| { id?: string; type: "handoff"; customInstructions?: string }

	// Messages
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_messages_page"; cursor?: string; limit?: number }

	// Login
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string }
	| { id?: string; type: "logout"; providerId: string }

	// Usage
	| { id?: string; type: "get_usage" }

	// Settings
	| { id?: string; type: "get_settings_schema" }
	| { id?: string; type: "get_settings"; paths?: string[] }
	| { id?: string; type: "set_setting"; path: string; value: unknown }

	// Providers
	| { id?: string; type: "get_providers" }

	// Plan mode
	| { id?: string; type: "set_plan_mode"; enabled: boolean }
	| { id?: string; type: "get_plan_mode" }
	| { id?: string; type: "plan_approval"; approved: boolean; option?: RpcPlanApprovalOption; feedback?: string }

	// Session modes (vibe / goal / loop)
	| { id?: string; type: "get_vibe_mode" }
	| { id?: string; type: "set_vibe_mode"; enabled: boolean }
	| { id?: string; type: "get_goal" }
	| {
			id?: string;
			type: "set_goal";
			objective?: string;
			/** Token budget for the goal; `null` clears it (the TUI's `off`). */
			tokenBudget?: number | null;
			/** Lifecycle action on an existing goal; omit to set/replace by objective. */
			action?: "pause" | "resume" | "drop";
		  }
	| { id?: string; type: "get_loop_mode" }
	| {
			id?: string;
			type: "set_loop_mode";
			enabled: boolean;
			/** Raw `/loop` argument string (`"10"`, `"5m keep going"`, …) parsed by the TUI's own parser. */
			args?: string;
		  }

	// Model roles
	| { id?: string; type: "get_model_roles" }
	| { id?: string; type: "set_model_role"; role: string; modelId: string | null }
	| { id?: string; type: "get_model_role_metadata" }

	// Domain inspection (read-only)
	| { id?: string; type: "get_skills" }
	| { id?: string; type: "get_hooks" }
	| { id?: string; type: "get_mcp_servers" }
	| { id?: string; type: "get_plugins" }
	| { id?: string; type: "get_marketplaces" }
	| { id?: string; type: "get_prompt_templates" }
	| { id?: string; type: "get_memory_report" }

	// Domain actions (mutating). Payload ids are `hookId`/`pluginId` — the
	// envelope `id` field is reserved for request correlation.
	| { id?: string; type: "set_skill_enabled"; name: string; enabled: boolean }
	| { id?: string; type: "set_hook_enabled"; hookId: string; enabled: boolean }
	| { id?: string; type: "set_plugin_enabled"; pluginId: string; enabled: boolean; scope?: "user" | "project" }
	| {
			id?: string;
			type: "mcp_action";
			name: string;
			action: "enable" | "disable" | "reconnect" | "remove";
			/** Config file for `remove` (defaults to project, mirroring `/mcp remove`). */
			scope?: "user" | "project";
		  }

	// Session tree (visual branch navigation)
	| { id?: string; type: "get_session_tree" }

	// Available UI themes (for theme dropdowns)
	| { id?: string; type: "get_themes" }

	// Resolved color tokens of one UI theme (for GUI theme overlays)
	| { id?: string; type: "get_theme_colors"; name: string }

	// Full display transcript (all messages, not the LLM context window)
	| { id?: string; type: "get_transcript" }

	// Voice (speech in/out). `transcribe_audio.audioBase64` carries a canonical
	// RIFF/WAVE buffer — PCM16, mono, 16 kHz (the STT pipeline's native rate);
	// `mimeType` is informational ("audio/wav").
	| { id?: string; type: "transcribe_audio"; audioBase64: string; mimeType: string }
	| { id?: string; type: "synthesize_speech"; text: string };

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel | undefined;
	/** Configured selector: `auto` while auto mode is active, else the effective level. Drives pickers (Codex-style) rather than cyclers. */
	thinkingConfigured?: ConfiguredThinkingLevel;
	/** Levels the active model actually supports (empty = model does not reason); pickers must not offer unsupported values. */
	availableThinkingLevels?: ThinkingLevel[];
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	cwd: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	autoRetryEnabled: boolean;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	tokensPerSecond: number | null;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: TodoPhase[];
	/** For session dump / export (plain-text parity with /dump). */
	systemPrompt?: string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	/** Current context window usage. */
	contextUsage?: ContextUsage;
	/** Whether plan mode is currently enabled. */
	planModeEnabled: boolean;
}

export interface RpcAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface RpcAvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: RpcAvailableSlashCommand[];
}

export interface RpcPromptResultFrame {
	type: "prompt_result";
	id?: string;
	agentInvoked: boolean;
}

export interface RpcReadyFrame {
	type: "ready";
	protocolVersion: 1;
	supportedProtocolVersions: [1, 2];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
}

export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

export interface RpcHandoffResult {
	savedPath?: string;
}

// ============================================================================
// Eval / Dequeue Wire Types
// ============================================================================

/**
 * Languages accepted by the `eval` command. Only `"python"` is wired to the
 * interactive user-eval path today (`AgentSession.executePython`, the same
 * machinery the TUI `$`/`$$` composer modes use); the other eval backends
 * remain agent-tool-only and the command rejects them with an error response.
 */
export type RpcEvalLanguage = "python" | "js" | "ruby" | "julia";

/**
 * Result of an `eval` command: the execution outcome plus a request echo so
 * the host can render an execution bubble without retaining the request.
 * Operational failures (kernel unavailable, disposal in progress) arrive as
 * `success: false` error responses instead — a non-zero `exitCode` here is a
 * user-code failure, not a transport/handler failure.
 */
export interface RpcEvalResult {
	language: RpcEvalLanguage;
	code: string;
	/** Combined stdout + stderr (sanitized, possibly truncated). */
	output: string;
	/** Kernel exit code (0 ok, 1 error); omitted when the run was cancelled. */
	exitCode?: number;
	/** Whether the execution was cancelled (abort_eval / session dispose). */
	cancelled: boolean;
	/** Whether the output was truncated. */
	truncated: boolean;
	/** Echo of the request's `excluded` flag (the `$$` exclude-from-context form). */
	excluded: boolean;
}

/**
 * Result of a `dequeue` command: the user-authored messages pulled out of the
 * steer/follow-up queues in editor-restore order (steering first, then
 * follow-ups — the TUI's Alt+Up restore order). Empty when nothing was queued.
 */
export interface RpcDequeueResult {
	messages: RestoredQueuedMessage[];
}

// ============================================================================
// Extension Feature Wire Types (usage / settings / providers)
// ============================================================================

/** A single normalized usage limit bucket for one provider window/quota. */
export interface RpcUsageLimit {
	id: string;
	label: string;
	/** Used fraction 0..1 (>1 = overage); undefined when the provider omits it. */
	usedFraction?: number;
	used?: number;
	limit?: number;
	unit?: string;
	remainingFraction?: number;
	windowLabel?: string;
	resetsAt?: number;
	status?: string;
	notes?: string[];
}

/** Aggregated usage report for one provider/account. */
export interface RpcUsageReport {
	provider: string;
	fetchedAt: number;
	limits: RpcUsageLimit[];
	notes?: string[];
	/** Account identity (email/org) when the provider reports it. */
	account?: string;
	/** Saved rate-limit resets available to redeem, when reported. */
	resetCreditsAvailable?: number;
}

/** Local session token/cost tallies (fallback when no provider usage API). */
export interface RpcUsageSessionStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	orchestrationTokens: number;
	premiumRequests: number;
	cost: number;
}

export interface RpcUsageResult {
	/** Provider-reported quota reports; empty when the provider has no usage API. */
	reports: RpcUsageReport[];
	/** Always-present local session tallies. */
	session: RpcUsageSessionStats;
}

/** One setting entry from the unified schema, projected for the GUI. */
export interface RpcSettingEntry {
	path: string;
	type: "boolean" | "string" | "number" | "enum" | "array" | "record";
	value: unknown;
	default: unknown;
	label?: string;
	description?: string;
	tab?: string;
	group?: string;
	/** Enum choices (for `enum` type) or submenu options. */
	options?: Array<{ value: string; label: string; description?: string }>;
	/** True when the value is a credential and must be masked in the UI. */
	secret?: boolean;
	/** True when the setting has no UI metadata (config-file only). */
	advanced?: boolean;
	/**
	 * Visibility gate name from the schema ui metadata (e.g. "advisorEnabled").
	 * Clients that can resolve the gate hide the entry while it evaluates false;
	 * unknown gates stay visible.
	 */
	condition?: string;
	/** True when array order is meaningful and editors should support reordering. */
	ordered?: boolean;
	/**
	 * True when the setting only affects TUI chrome — non-TUI clients should
	 * badge it so users don't expect an effect they can't deliver
	 * (TUI_ONLY_SETTING_PATHS).
	 */
	tuiOnly?: boolean;
	/**
	 * True when the value is cached at session/agent construction: edits take
	 * effect only after a sidecar/session restart, in every client
	 * (RESTART_REQUIRED_SETTING_PATHS).
	 */
	restartRequired?: boolean;
}

export interface RpcSettingsSchemaResult {
	entries: RpcSettingEntry[];
	tabs: Array<{ id: string; label: string; groups: string[] }>;
}

/** A configured model provider and its auth/config state. */
export interface RpcProviderInfo {
	id: string;
	name: string;
	/** True when a credential (OAuth or API key) is present. */
	authenticated: boolean;
	/** Auth kind when authenticated. */
	authKind?: "oauth" | "apikey" | "env";
	/** Account identity (email/org) for OAuth providers. */
	account?: string;
	/** True when the provider is an OAuth login target. */
	oauth: boolean;
	/** True when the provider is disabled in settings. */
	disabled: boolean;
	/** Base URL override, when configured. */
	baseUrl?: string;
	/** Number of models currently available from this provider. */
	modelCount: number;
}

export interface RpcProvidersResult {
	providers: RpcProviderInfo[];
}

export interface RpcPlanModeState {
	enabled: boolean;
	planFilePath?: string;
}

/**
 * Execution option for an approved plan. Mirrors the TUI plan-review choices:
 * `"execute"` starts a fresh session (context cleared), `"compact"` distills
 * the planning transcript first, `"keep_context"` executes on the intact
 * transcript. The TUI's fourth choice, "Refine plan", maps to
 * `plan_approval { approved: false, feedback }` instead of an option here.
 */
export type RpcPlanApprovalOption = "execute" | "compact" | "keep_context";

export interface RpcPlanApprovalResult {
	approved: boolean;
	/** True when the execution/refinement turn was dispatched to the agent. */
	dispatched: boolean;
	/** Present when nothing was dispatched (plain reject, compaction failure). */
	reason?: string;
}

/**
 * Emitted when the agent submits a plan for approval (a `write` to
 * `xd://propose` while plan mode is active). The host answers with a
 * `plan_approval` command. `options` lists the approval choices; `"refine"`
 * is answered with `approved: false` plus `feedback`, not `option`.
 */
export interface RpcPlanProposalFrame {
	type: "plan_proposal";
	planFilePath: string;
	title: string;
	planContent: string;
	options: string[];
}

// ============================================================================
// Session Mode Wire Types (vibe / goal / loop)
// ============================================================================

export interface RpcVibeModeState {
	enabled: boolean;
	/** Worker sessions killed by a disable transition (omit semantics: only set on set_vibe_mode). */
	killedWorkers?: number;
}

/** Current goal-mode state projected for the wire; absent fields mean "no goal". */
export interface RpcGoalState {
	enabled: boolean;
	status?: GoalStatus;
	objective?: string;
	tokenBudget?: number;
	tokensUsed?: number;
	timeUsedSeconds?: number;
	/** GoalModeState.mode: "active" while running, "exiting" on the completion transition. */
	mode?: "active" | "exiting";
}

export type RpcLoopModeRunState = "off" | "waiting" | "running" | "paused";

export interface RpcLoopModeState {
	enabled: boolean;
	/**
	 * "waiting": enabled, next host prompt becomes the loop prompt. "running": a
	 * loop prompt is captured and re-submits after each yield. "paused": an abort
	 * dropped the current prompt (TUI pauseLoop); the next host prompt re-arms.
	 */
	state: RpcLoopModeRunState;
	prompt?: string;
	limit?: LoopLimitRuntime;
}

/** Emitted on every loop-mode transition, including auto-disable on limit exhaustion. */
export interface RpcLoopModeUpdateFrame {
	type: "loop_mode_update";
	state: RpcLoopModeState;
}

export interface RpcModelRoleEntry {
	id: string;
	name: string;
	tag: string;
	color: string;
	model?: string;
	source: string;
}

export interface RpcModelRolesResult {
	roles: RpcModelRoleEntry[];
}

export interface RpcModelRoleMetadata {
	id: string;
	name: string;
	tag: string;
	color: string;
	hidden?: boolean;
}

export interface RpcModelRoleMetadataResult {
	roles: RpcModelRoleMetadata[];
}

// ============================================================================
// Domain Inspection Wire Types (skills / hooks / mcp / plugins / templates / memory)
// ============================================================================

/** A discoverable skill with its session enable state. */
export interface RpcSkillInfo {
	name: string;
	description: string;
	/** "<provider>:<level>", e.g. "native:project", "claude:user", "custom:user". */
	source: string;
	/** True when the live session actually loaded this skill. */
	enabled: boolean;
	/** Absolute path to the SKILL.md file. */
	location: string;
}

export interface RpcSkillsResult {
	skills: RpcSkillInfo[];
}

/** A discovered pre/post tool hook. */
export interface RpcHookInfo {
	/** Stable id used by the `disabledExtensions` setting: "hook:<type>:<tool>:<name>". */
	id: string;
	name: string;
	/** Hook event: "<pre|post>:<tool>", e.g. "pre:bash" or "post:*". */
	event: string;
	enabled: boolean;
	/** Id of the discovery provider that found this hook (e.g. "claude", "codex", "omp-plugins"). */
	source: string;
	/** Absolute path to the hook file. */
	path: string;
}

export interface RpcHooksResult {
	hooks: RpcHookInfo[];
}

/** A configured or discovered MCP server with live connection state. */
export interface RpcMcpServerInfo {
	name: string;
	/** Configured transport; "unknown" when no config exists anywhere (disabled-marker-only entries). */
	transport: "stdio" | "http" | "sse" | "unknown";
	/** Live connection state from the MCP manager ("disconnected" when no manager is running). */
	status: "connected" | "connecting" | "disconnected";
	/** Tools currently exposed by this server (0 when not connected). */
	toolCount: number;
	/** False when disabled in config (`enabled: false`) or via `/mcp disable`. */
	enabled: boolean;
	/** True when stored OAuth credentials or a static Authorization header exist. */
	authed: boolean;
}

export interface RpcMcpServersResult {
	servers: RpcMcpServerInfo[];
}

/** An installed plugin (npm package or marketplace install). */
export interface RpcPluginInfo {
	name: string;
	/** Marketplace name for marketplace installs; "npm" for npm package installs. */
	marketplace: string;
	enabled: boolean;
	version: string;
	/** Full "name@marketplace" id (marketplace installs only). */
	id?: string;
	/** Install scope (marketplace installs only). */
	scope?: "user" | "project";
	/** Set when a user-scope install is shadowed by an enabled project-scope install. */
	shadowedBy?: "project";
}

export interface RpcPluginsResult {
	plugins: RpcPluginInfo[];
}

/** A configured marketplace source. */
export interface RpcMarketplaceInfo {
	name: string;
	/** Source URI (github repo, git/url, or local path). */
	source: string;
	/** Plugins in the cached catalog; omitted until the catalog is fetched (`/marketplace update`). */
	pluginCount?: number;
}

export interface RpcMarketplacesResult {
	marketplaces: RpcMarketplaceInfo[];
}

/** Result of `set_plugin_enabled`: which install channel persisted the toggle. */
export interface RpcPluginSetEnabledResult {
	id: string;
	enabled: boolean;
	channel: "npm" | "marketplace";
}

/** Result of `mcp_action`; `status` reports the live connection state when a manager is running. */
export interface RpcMcpActionResult {
	name: string;
	action: "enable" | "disable" | "reconnect" | "remove";
	status?: "connected" | "connecting" | "disconnected";
}

/** A file-based prompt template. */
export interface RpcPromptTemplateInfo {
	name: string;
	description: string;
	/** "(user)", "(project)", or a scoped variant like "(project:frontend)". */
	source: string;
	/** "[arguments]" when the template body consumes args inline; omitted otherwise. */
	argumentHint?: string;
}

export interface RpcPromptTemplatesResult {
	templates: RpcPromptTemplateInfo[];
}

/** Structured memory backend status, projected for the wire (mirrors MemoryBackendStatus). */
export interface RpcMemoryStatus {
	active: boolean;
	writable: boolean;
	searchable: boolean;
	scope?: string;
	retainBank?: string;
	recallBanks?: string[];
	workingCount?: number;
	episodicCount?: number;
	tripleCount?: number;
	lastMemory?: string;
	lastRecall?: boolean;
	database?: string;
	message?: string;
	error?: string;
}

/** Read-only memory backend report. Optional fields are omitted when the backend lacks (or fails) that hook. */
export interface RpcMemoryReport {
	backend: MemoryBackendId;
	/** working + episodic entry counts, when the backend reports them. */
	entryCount?: number;
	status?: RpcMemoryStatus;
	/** `/memory stats` markdown payload. */
	stats?: string;
	/** `/memory diagnose` markdown payload. */
	diagnosis?: string;
}

/** A node in the session's branch tree (visual session navigation). */
export interface RpcSessionTreeNode {
	entryId: string;
	/** Nearest ancestor that is itself included in the tree array (null for roots). */
	parentId: string | null;
	role: "user" | "assistant" | "system";
	/** Whitespace-collapsed, pre-truncated preview (~200 chars). */
	textPreview: string;
	/** ms epoch. */
	timestamp: number;
	label?: string;
	/** True when this node lies on the path from root to the active leaf. */
	onActiveBranch: boolean;
	/** True when no other included node lists this as its parent. */
	isLeaf: boolean;
}

export interface RpcSessionTreeResult {
	tree: RpcSessionTreeNode[];
	/** The active leaf, resolved to the nearest included message entry (null when none). */
	activeLeafId: string | null;
}

/** An available UI theme (built-in or custom file). */
export interface RpcThemeInfo {
	name: string;
	path?: string;
}
export interface RpcThemesResult {
	themes: RpcThemeInfo[];
}

/** A UI theme's resolved colors as CSS hex strings, keyed by theme token (accent, statusLineBg, …). */
export interface RpcThemeColorsResult {
	name: string;
	colors: Record<string, string>;
}

export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface RpcSubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: AgentProgress["agentSource"];
	description?: string;
	status: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: AgentProgress;
	parentToolCallId?: string;
	/** Registry id of the spawning subagent for nested spawns; absent at the root. */
	parentSubagentId?: string;
}

export interface RpcSubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Protocol
	| {
			id?: string;
			type: "response";
			command: "negotiate_protocol";
			success: true;
			data: { protocolVersion: 2 };
	  }

	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true; data?: { agentInvoked: boolean } }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "abort_and_prompt"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| {
			id?: string;
			type: "response";
			command: "set_fast_mode";
			success: true;
			data: { enabled: boolean; active: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_commands";
			success: true;
			data: { commands: RpcAvailableSlashCommand[] };
	  }
	| { id?: string; type: "response"; command: "set_todos"; success: true; data: { todoPhases: TodoPhase[] } }
	| { id?: string; type: "response"; command: "set_host_tools"; success: true; data: { toolNames: string[] } }
	| { id?: string; type: "response"; command: "set_host_uri_schemes"; success: true; data: { schemes: string[] } }
	| {
			id?: string;
			type: "response";
			command: "set_subagent_subscription";
			success: true;
			data: { level: RpcSubagentSubscriptionLevel };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagents";
			success: true;
			data: { subagents: RpcSubagentSnapshot[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagent_messages";
			success: true;
			data: RpcSubagentMessagesResult;
	  }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: Effort } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }

	// Queue restore
	| { id?: string; type: "response"; command: "dequeue"; success: true; data: RpcDequeueResult }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Eval
	| { id?: string; type: "response"; command: "eval"; success: true; data: RpcEvalResult }
	| { id?: string; type: "response"; command: "abort_eval"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_branch_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "set_entry_label"; success: true }
	| { id?: string; type: "response"; command: "handoff"; success: true; data: RpcHandoffResult | null }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| { id?: string; type: "response"; command: "get_messages_page"; success: true; data: RpcMessagesPage }

	// Login
	| {
			id?: string;
			type: "response";
			command: "get_login_providers";
			success: true;
			data: { providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }> };
	  }
	| { id?: string; type: "response"; command: "login"; success: true; data: { providerId: string } }
	| { id?: string; type: "response"; command: "logout"; success: true; data: { providerId: string } }

	// Usage
	| { id?: string; type: "response"; command: "get_usage"; success: true; data: RpcUsageResult }

	// Settings
	| { id?: string; type: "response"; command: "get_settings_schema"; success: true; data: RpcSettingsSchemaResult }
	| { id?: string; type: "response"; command: "get_settings"; success: true; data: { values: Record<string, unknown> } }
	| { id?: string; type: "response"; command: "set_setting"; success: true; data: { path: string; value: unknown } }

	// Providers
	| { id?: string; type: "response"; command: "get_providers"; success: true; data: RpcProvidersResult }

	// Plan mode
	| { id?: string; type: "response"; command: "set_plan_mode"; success: true; data: RpcPlanModeState }
	| { id?: string; type: "response"; command: "get_plan_mode"; success: true; data: RpcPlanModeState }
	| { id?: string; type: "response"; command: "plan_approval"; success: true; data: RpcPlanApprovalResult }

	// Session modes (vibe / goal / loop)
	| { id?: string; type: "response"; command: "get_vibe_mode"; success: true; data: RpcVibeModeState }
	| { id?: string; type: "response"; command: "set_vibe_mode"; success: true; data: RpcVibeModeState }
	| { id?: string; type: "response"; command: "get_goal"; success: true; data: RpcGoalState }
	| { id?: string; type: "response"; command: "set_goal"; success: true; data: RpcGoalState }
	| { id?: string; type: "response"; command: "get_loop_mode"; success: true; data: RpcLoopModeState }
	| { id?: string; type: "response"; command: "set_loop_mode"; success: true; data: RpcLoopModeState }

	// Model roles
	| { id?: string; type: "response"; command: "get_model_roles"; success: true; data: RpcModelRolesResult }
	| { id?: string; type: "response"; command: "set_model_role"; success: true; data: { role: string; modelId: string | null } }
	| { id?: string; type: "response"; command: "get_model_role_metadata"; success: true; data: RpcModelRoleMetadataResult }

	// Domain inspection (read-only)
	| { id?: string; type: "response"; command: "get_skills"; success: true; data: RpcSkillsResult }
	| { id?: string; type: "response"; command: "get_hooks"; success: true; data: RpcHooksResult }
	| { id?: string; type: "response"; command: "get_mcp_servers"; success: true; data: RpcMcpServersResult }
	| { id?: string; type: "response"; command: "get_plugins"; success: true; data: RpcPluginsResult }
	| { id?: string; type: "response"; command: "get_marketplaces"; success: true; data: RpcMarketplacesResult }
	| {
			id?: string;
			type: "response";
			command: "get_prompt_templates";
			success: true;
			data: RpcPromptTemplatesResult;
	  }
	| { id?: string; type: "response"; command: "get_memory_report"; success: true; data: RpcMemoryReport }

	// Domain actions (mutating)
	| {
			id?: string;
			type: "response";
			command: "set_skill_enabled";
			success: true;
			data: { name: string; enabled: boolean };
		  }
	| {
			id?: string;
			type: "response";
			command: "set_hook_enabled";
			success: true;
			data: { id: string; enabled: boolean };
		  }
	| { id?: string; type: "response"; command: "set_plugin_enabled"; success: true; data: RpcPluginSetEnabledResult }
	| { id?: string; type: "response"; command: "mcp_action"; success: true; data: RpcMcpActionResult }
	| { id?: string; type: "response"; command: "get_session_tree"; success: true; data: RpcSessionTreeResult }
	| { id?: string; type: "response"; command: "get_themes"; success: true; data: RpcThemesResult }
	| { id?: string; type: "response"; command: "get_theme_colors"; success: true; data: RpcThemeColorsResult }
	| { id?: string; type: "response"; command: "get_transcript"; success: true; data: { messages: AgentMessage[] } }

	// Voice (speech in/out). `synthesize_speech` returns the local TTS model's
	// output as a base64 WAV (PCM16) buffer for host-side playback.
	| { id?: string; type: "response"; command: "transcribe_audio"; success: true; data: { text: string } }
	| { id?: string; type: "response"; command: "synthesize_speech"; success: true; data: { audioBase64: string; mimeType: string } }

	// Error response (any command can fail); `code` is an optional machine-readable reason.
	| { id?: string; type: "response"; command: string; success: false; error: string; code?: string };

// ============================================================================
// Subagent Events (stdout)
// ============================================================================

export interface RpcSubagentLifecycleFrame {
	type: "subagent_lifecycle";
	payload: SubagentLifecyclePayload;
}

export interface RpcSubagentProgressFrame {
	type: "subagent_progress";
	payload: SubagentProgressPayload;
}

export interface RpcSubagentEventFrame {
	type: "subagent_event";
	payload: SubagentEventPayload;
}

export type RpcSubagentFrame = RpcSubagentLifecycleFrame | RpcSubagentProgressFrame | RpcSubagentEventFrame;

export type RpcSessionEventFrame = AgentSessionEvent | RpcSubagentFrame;

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "askDialog";
			questions: ExtensionAskDialogQuestion[];
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			/**
			 * Short loopback URL that 302-redirects to {@link url}. When present,
			 * hosts SHOULD surface it as the copy target so terminal viewport
			 * truncation cannot corrupt OAuth query parameters on the full URL.
			 */
			launchUrl?: string;
			instructions?: string;
	  };

// ============================================================================
// Host Tool Frames (bidirectional)
// ============================================================================

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
	/** How this host tool is presented when enabled; omission normalizes to `"discoverable"` at the adapter boundary. */
	loadMode?: ToolLoadMode;
}

/** Emitted by the RPC server when it needs the host to execute a registered tool. */
export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Emitted by the RPC server when a pending host tool call should be aborted. */
export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to stream partial tool updates back to the RPC server. */
export interface RpcHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: AgentToolResult<unknown>;
}

/** Sent by the host to complete a pending tool call. */
export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

// ============================================================================
// Host URI Frames (bidirectional)
// ============================================================================

export interface RpcHostUriSchemeDefinition {
	/** URL scheme without trailing `://` (e.g. `db`, `notion`). */
	scheme: string;
	/** Optional human-readable description for logs/diagnostics. */
	description?: string;
	/** When true, the write tool is allowed to dispatch writes to this scheme. */
	writable?: boolean;
	/** When true, downstream callers suppress hashline anchors for resolved content. */
	immutable?: boolean;
}

export type RpcHostUriOperation = "read" | "write";

/** Emitted by the RPC server when it needs the host to satisfy a URI operation. */
export interface RpcHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: RpcHostUriOperation;
	url: string;
	/** Present for write operations. */
	content?: string;
}

/** Emitted by the RPC server when a pending URI request should be aborted. */
export interface RpcHostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to complete a pending URI request. */
export interface RpcHostUriResult {
	type: "host_uri_result";
	id: string;
	/**
	 * Required for successful `read` results. Ignored for `write` success.
	 * Set on errors when a textual explanation accompanies `isError`.
	 */
	content?: string;
	/** Defaults to `text/plain` when omitted. */
	contentType?: "text/markdown" | "application/json" | "text/plain";
	/** Optional resolution notes propagated to the read tool. */
	notes?: string[];
	/** Overrides the scheme-level `immutable` flag for this single resolution. */
	immutable?: boolean;
	/** When true, surface the result content as an error to the caller. */
	isError?: boolean;
	/** Optional error message; preferred over `content` for error surfacing. */
	error?: string;
}

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; askDialog: ExtensionAskDialogResult }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
