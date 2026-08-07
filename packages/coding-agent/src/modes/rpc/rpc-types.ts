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
import type {
	ContextUsage,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
} from "../../extensibility/extensions/types";
import type { GoalStatus } from "../../goals/state";
import type { LiveTranscript } from "../../live/controller";
import type { LivePhase } from "../../live/visualizer";
import type { MemoryBackendId } from "../../memory-backend/types";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import type {
	AsyncJobSnapshotItem,
	ContextUsageBreakdown,
	RestoredQueuedMessageWithDelivery,
} from "../../session/agent-session-types";
import type { FileEntry } from "../../session/session-entries";
import type { AvailableSlashCommandSource } from "../../slash-commands/available-commands";
import type {
	AgentProgress,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "../../task";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { DebugParams } from "../../tools/debug";
import type { TodoPhase } from "../../tools/todo";
import type { LoopLimitRuntime } from "../loop-limit";
import type { CopyTarget } from "../utils/copy-targets";
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
	| { id?: string; type: "drop_session" }

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
	| { id?: string; type: "cycle_model"; direction?: "forward" | "backward" }
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

	// Queue management (stable per-entry ids — never array indices, which
	// drift under concurrent enqueue). `queueId` names the entry id surfaced
	// by get_queue; it cannot ride the frame envelope's `id` slot, which is
	// the request-correlation id. queue_move is a same-lane reorder with a
	// clamped target; queue_clear drops user-restorable entries only (hidden
	// companions ride out with them; advisor cards and internal steers
	// survive), lane-scoped when `lane` is given.
	| { id?: string; type: "get_queue" }
	| { id?: string; type: "queue_remove"; queueId: string }
	| { id?: string; type: "queue_move"; queueId: string; toIndex: number }
	| { id?: string; type: "queue_clear"; lane?: "steering" | "followUp" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string; excluded?: boolean }
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
	| { id?: string; type: "get_copy_targets" }
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
	| { id?: string; type: "guided_goal"; initial?: string }
	| { id?: string; type: "set_agents_paused"; enabled: boolean }
	| { id?: string; type: "btw"; question: string }
	| { id?: string; type: "btw_branch" }
	| { id?: string; type: "tan"; work: string }
	| { id?: string; type: "omfg"; complaint: string }
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

	// Session reports (structured TUI /context /tools /share /jobs parity)
	| { id?: string; type: "get_context_report" }
	| { id?: string; type: "get_active_tools" }
	| { id?: string; type: "share_session" }
	| { id?: string; type: "get_jobs" }

	// One-shot session actions (TUI /prewalk /fresh /shake /reload-plugins
	// /force parity). set_force_tool takes exactly one of `tool` (force the
	// next turn onto that active tool) or `clear: true` (drop a pending
	// force); fresh is refused with code "busy" while streaming.
	| { id?: string; type: "set_prewalk"; enabled: boolean }
	| { id?: string; type: "fresh" }
	| { id?: string; type: "shake_context"; mode: "elide" | "images" }
	| { id?: string; type: "reload_plugins" }
	| { id?: string; type: "set_force_tool"; tool?: string; clear?: boolean }
	| { id?: string; type: "get_force_tool" }

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
	| { id?: string; type: "synthesize_speech"; text: string }

	// Turn recovery (TUI /retry parity): retry the last failed assistant turn.
	// Separate from abort_retry (which cancels a scheduled auto-retry).
	| { id?: string; type: "retry" }

	// In-place context reset (TUI /clear parity): drops the conversation
	// context, keeps the session id + transcript file. Refused with code "busy"
	// while streaming or a foreground bash/eval execution is in flight.
	| { id?: string; type: "clear_context" }

	// Per-subagent lifecycle (TUI Agent Hub `x`/`r` parity). `agentId` names
	// the registry row; the main agent and read-only advisor transcripts are
	// refused via the result's `reason`.
	| { id?: string; type: "abort_subagent"; agentId: string }
	| { id?: string; type: "revive_subagent"; agentId: string }

	// Agent control-center inventory. Returns every definition discoverable for
	// the attached workspace, including unused project/user/bundled agents.
	| { id?: string; type: "get_agent_definitions" }

	// Write a large paste into the session's local:// store. The name counter
	// is allocated agent-side so multiple GUI windows on one session can never
	// collide (the TUI counter is per-input-controller and can).
	| { id?: string; type: "write_local_paste"; content: string }

	// Foreign session import (Claude/Codex → a fresh OMP session copy; the
	// source data is never modified). `foreignId` is the `id` from
	// list_foreign_sessions; import re-lists to resolve it.
	| { id?: string; type: "list_foreign_sessions"; source: "claude" | "codex" }
	| { id?: string; type: "import_foreign_session"; source: "claude" | "codex"; foreignId: string }

	// Session tree navigation. fork_from writes an INDEPENDENT new session
	// file containing only the path from root to `entryId` and does not switch
	// (Codex-style "new session from here"); switch_leaf moves the active leaf
	// in place (TUI tree-selector Enter parity, navigateTree underneath).
	| { id?: string; type: "fork_from"; entryId: string }
	| { id?: string; type: "switch_leaf"; entryId: string; summarize?: boolean; customInstructions?: string }
	| { id?: string; type: "resume_after_ask_reanswer" }

	// Slash-command argument completions for a remote composer. Static
	// subcommand data already rides RpcAvailableSlashCommand; this covers the
	// dynamic candidates (MCP server names, /move directories).
	| { id?: string; type: "get_command_arg_completions"; command: string; prefix: string }

	// MCP server management (C1). mcp_test/mcp_reauth are background-dispatched
	// (see dispatchRpcInputFrame) so a slow probe or a browser OAuth login never
	// wedges the serial command queue — that is what lets mcp_reauth_cancel
	// overtake an in-flight mcp_reauth. mcp_test takes exactly one of
	// `name` (probe a configured server) or `config` (probe an inline definition).
	| { id?: string; type: "mcp_add"; name: string; config: RpcMcpServerInput; scope?: "user" | "project" }
	| { id?: string; type: "mcp_test"; name?: string; config?: RpcMcpServerInput }
	| { id?: string; type: "mcp_reauth"; name: string }
	| { id?: string; type: "mcp_reauth_cancel"; name: string }

	// Marketplace management (C1). `add` takes `source`; remove/update take
	// `marketplace`; install takes `plugin` + `marketplace`; uninstall/upgrade
	// take `plugin` ("name@marketplace" id, or a bare name with `marketplace`);
	// list_available optionally filters by `marketplace`.
	| {
			id?: string;
			type: "marketplace_action";
			action: "add" | "remove" | "update" | "install" | "uninstall" | "upgrade" | "list_available";
			marketplace?: string;
			plugin?: string;
			source?: string;
	  }

	// Interactive surfaces that remain long-lived in the sidecar process.
	| { id?: string; type: "live_start"; voice?: string }
	| { id?: string; type: "live_toggle_mute" }
	| { id?: string; type: "live_stop" }
	| { id?: string; type: "get_live_state" }
	| { id?: string; type: "debug"; params: DebugParams }
	| { id?: string; type: "collab_start"; relayUrl?: string; view?: boolean }
	| { id?: string; type: "collab_join"; link: string }
	| { id?: string; type: "collab_leave" }
	| { id?: string; type: "get_collab_state" }

	// Plugin detail and settings (C1). `pluginId` is the npm package name (the
	// npm install channel backs settings/features; see rpc-plugins.ts).
	| { id?: string; type: "get_plugin_detail"; pluginId: string }
	| { id?: string; type: "set_plugin_features"; pluginId: string; features: string[] }
	| { id?: string; type: "set_plugin_setting"; pluginId: string; key: string; value: unknown }
	| { id?: string; type: "delete_plugin_setting"; pluginId: string; key: string }

	// Workspace directories (TUI /dirs /add-dir /remove-dir /move parity).
	// Paths may be absolute or cwd-relative and follow TUI `~` expansion.
	// add_directory/remove_directory return the post-mutation directory list;
	// remove_directory refuses the primary (cwd) directory with a clear error;
	// move_session relocates the session file's cwd association on disk.
	| { id?: string; type: "get_directories" }
	| { id?: string; type: "add_directory"; path: string }
	| { id?: string; type: "remove_directory"; path: string }
	| { id?: string; type: "move_session"; path: string }

	// Git worktrees (GUI tab × worktree binding). get_git_status is the live
	// source for the footer git segment (branch + porcelain counts; isRepo
	// false outside a repository). worktree_create materializes a new branch
	// omp/gui/<name> at ~/.omp/wt/gui-<name>-<hash7>; baseRef "HEAD" (current
	// checkout) or "default" (repository default branch). worktree_remove
	// refuses a dirty worktree unless force, the refusal carrying the counts.
	| { id?: string; type: "get_git_status" }
	| { id?: string; type: "worktree_create"; name: string; baseCwd?: string; baseRef?: "HEAD" | "default" }
	| { id?: string; type: "worktree_remove"; path: string; force?: boolean }

	// Pull requests (GUI PR Center, plan/21). All resolve the GitHub repo from
	// the session cwd via the gh CLI; pr_diff is per-file (lazy) so frames stay
	// small, pr_draft is the one model call, pr_checkout lands the PR in a
	// ~/.omp/wt worktree (plan/20 scheme).
	| { id?: string; type: "pr_repo" }
	| { id?: string; type: "pr_list"; state?: "open" | "closed" | "merged" | "all"; limit?: number }
	| { id?: string; type: "pr_get"; number: number }
	| { id?: string; type: "pr_diff"; number: number; path: string }
	| { id?: string; type: "pr_draft"; base?: string; head?: string }
	| { id?: string; type: "pr_create"; title: string; body: string; base?: string; head?: string; draft?: boolean }
	| { id?: string; type: "pr_checkout"; number: number };

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
	/** Whether a prewalk model switch is armed and waiting for the first edit/write. */
	prewalkArmed?: boolean;
	/** Process-global agent pause state. */
	agentsPaused: boolean;
	agentsPausedAt?: number;
	/** Session kind. Absent = "agent" (tools enabled); "chat" = tool-free conversation. Immutable per session. */
	kind?: "chat";
}

export interface RpcAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
	/** Whether the command consumes text after its name (drives post-space completion). */
	allowArgs?: boolean;
	/** Whether dynamic candidates exist (get_command_arg_completions); static-only commands never need the round trip. */
	hasDynamicArgCompletion?: boolean;
}

/** Result of switch_leaf (session.navigateTree passthrough + the leaf after the move). */
export interface RpcSwitchLeafResult {
	cancelled: boolean;
	aborted?: boolean;
	/** Set when the target is an `ask` toolResult and the caller must re-open the ask picker first (issue #5642). */
	reopenAsk?: { toolCallId: string; questions: unknown };
	/** Draft text/images of the target user message — restore into the composer. */
	editorText?: string;
	editorImages?: ImageContent[];
	/** The active leaf after navigation (undefined when cancelled/aborted). */
	activeLeafId?: string;
	/** The caller must rebuild its transcript, then send resume_after_ask_reanswer. */
	askReanswerCommitted?: boolean;
}

/** Realtime voice state mirrored into the GUI while the sidecar owns audio I/O. */
export interface RpcLiveState {
	active: boolean;
	phase: LivePhase;
	muted: boolean;
	inputLevel: number;
	outputLevel: number;
	transcript?: LiveTranscript;
	error?: string;
}

export interface RpcLiveUpdateFrame {
	type: "live_update";
	state: RpcLiveState;
}

export interface RpcCollabParticipant {
	name: string;
	role: "host" | "guest";
	readOnly?: boolean;
}

/** Current live-collaboration attachment. Secret write links never enter logs. */
export interface RpcCollabState {
	role: "host" | "guest" | null;
	readOnly: boolean;
	link?: string;
	viewLink?: string;
	webLink?: string;
	webViewLink?: string;
	participants: RpcCollabParticipant[];
}

/** Lightweight metadata of one Claude/Codex session offered for import. */
export interface RpcForeignSessionInfo {
	id: string;
	path: string;
	cwd: string;
	title?: string;
	created: string;
	modified: string;
	messageCount?: number;
	firstMessage?: string;
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
 * Result of a `dequeue` command. Messages retain their original delivery lane
 * and are ordered by enqueue time across both queues (oldest first).
 */
export interface RpcDequeueResult {
	messages: RestoredQueuedMessageWithDelivery[];
}

/**
 * One user-restorable queued message surfaced by `get_queue`. `id` is the
 * stable per-entry queue id assigned at enqueue time (lane-prefixed counter
 * like `s1`/`f1`), valid for queue_remove/queue_move until the entry is
 * consumed or removed. Only user-authored, displayable entries appear here —
 * advisor cards, hidden companions, and internal steers are excluded.
 */
export interface RpcQueuedMessage {
	id: string;
	text: string;
	images?: ImageContent[];
	timestamp: number;
}

/** Result of a `get_queue` command: both lanes in insertion order. */
export interface RpcGetQueueResult {
	steering: RpcQueuedMessage[];
	followUp: RpcQueuedMessage[];
}

/** Result of a `queue_remove` command. Unknown ids produce an error response instead. */
export interface RpcQueueRemoveResult {
	removed: true;
}

/** Result of a `queue_move` command: the entry's lane and its final (clamped) index. */
export interface RpcQueueMoveResult {
	lane: "steering" | "followUp";
	index: number;
}

/** Result of a `queue_clear` command: count of user-restorable messages removed. */
export interface RpcQueueClearResult {
	removed: number;
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
	 * True when the setting only affects TUI chrome. Non-TUI clients should
	 * hide it or clearly identify that it has no effect there
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
	/** Which writable config file declared the server; omitted for discovered-only entries. */
	scope?: "user" | "project";
	/** Configured stdio command (stdio transports only). */
	command?: string;
	/** Configured URL (http/sse transports only). */
	url?: string;
	/**
	 * Last connection error for this server. Currently always omitted: the MCP
	 * manager surfaces connection failures through transient status events, not
	 * a queryable per-server error store.
	 */
	lastError?: string;
	/**
	 * OAuth credential state derived from the config and stored credentials:
	 * "none" (no OAuth configured), "authorized" (usable credential or static
	 * Authorization header), "expired" (stored credential past its expiry),
	 * "required" (OAuth configured but no usable credential stored).
	 */
	authState?: "none" | "authorized" | "expired" | "required";
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

// ============================================================================
// C1 Management Wire Types (mcp add/test/reauth, marketplace, plugin settings)
// ============================================================================

/**
 * Wire form of one MCP server definition (`mcp_add.config`, `mcp_test.config`).
 * Maps onto {@link MCPServerConfig}: stdio takes command/args/env, http/sse
 * take url/headers, `timeoutMs` maps to the config's `timeout`.
 */
export interface RpcMcpServerInput {
	transport: "stdio" | "http" | "sse";
	/** stdio: executable to spawn. */
	command?: string;
	/** stdio: argv. */
	args?: string[];
	/** stdio: environment overrides. */
	env?: Record<string, string>;
	/** http/sse: server URL. */
	url?: string;
	/** http/sse: extra headers. */
	headers?: Record<string, string>;
	/** MCP request timeout in milliseconds (maps to the config's `timeout`). */
	timeoutMs?: number;
}

/** Result of `mcp_add`: the refreshed live view of the just-added server. */
export interface RpcMcpAddResult {
	added: true;
	server: RpcMcpServerInfo;
}

/**
 * Result of `mcp_test`. Probe failures (connect/handshake/tool-list, unknown
 * server name, invalid arguments) ride `error` with `ok:false`.
 */
export interface RpcMcpTestResult {
	ok: boolean;
	toolNames?: string[];
	toolCount?: number;
	error?: string;
}

/**
 * Result of `mcp_reauth`. User cancellation resolves `{ ok:false, error:"cancelled" }`;
 * a second reauth claimed while one is in flight is refused at the envelope
 * (`success:false, code:"oauth_busy"`), not here.
 */
export interface RpcMcpReauthResult {
	ok: boolean;
	error?: string;
}

/** Result of `mcp_reauth_cancel`: false when no reauth for that name was in flight. */
export interface RpcMcpReauthCancelResult {
	cancelled: boolean;
}

/** One catalog entry from a marketplace, with its local install state. */
export interface RpcMarketplacePluginInfo {
	name: string;
	description?: string;
	version?: string;
	installed: boolean;
}

/**
 * Result of `marketplace_action`. Domain failures (unknown marketplace/plugin,
 * invalid source, install errors) ride `error` with `ok:false`. `plugins` is
 * populated only for `action:"list_available"`; catalogs are cache-backed
 * (populated by `add`/`update`), so the listing reflects the last fetch.
 */
export interface RpcMarketplaceActionResult {
	ok: boolean;
	error?: string;
	plugins?: RpcMarketplacePluginInfo[];
}

/**
 * Full detail for one plugin: manifest-declared features with live enable
 * state, the declared settings schema (omitted when the manifest declares
 * none), non-secret effective setting values (project overrides merged over
 * user), and the keys with persisted values. Secret values never cross the
 * RPC boundary; `configuredKeys` lets clients render their write-only state.
 */
export interface RpcPluginDetail {
	id: string;
	enabled: boolean;
	features: Array<{ id: string; description?: string; enabled: boolean }>;
	settingsSchema?: unknown;
	values: Record<string, unknown>;
	configuredKeys: string[];
}

/**
 * Result of the plugin feature/setting mutations. Validation feedback (unknown
 * feature, schema violation) rides `error` with `ok:false`.
 */
export interface RpcPluginMutationResult {
	ok: boolean;
	error?: string;
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
	agentSource?: AgentProgress["agentSource"];
	description?: string;
	status: string;
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: AgentProgress;
	parentToolCallId?: string;
	/** Registry id of the spawning subagent for nested spawns; absent at the root. */
	parentSubagentId?: string;
	kind?: "sub" | "advisor";
}

export interface RpcAgentDefinitionInfo {
	name: string;
	description: string;
	filePath?: string;
	model?: string[];
	thinkingLevel?: string;
	tools?: string[];
	spawns?: string[] | "*";
	autoloadSkills?: string[];
	output?: unknown;
	blocking?: boolean;
	readSummarize?: boolean;
	prewalk?: boolean | string;
	defaultPatterns: string[];
	defaultResolved?: string;
	effectivePatterns: string[];
	effectiveResolved?: string;
	effectiveThinkingLevel?: string;
	prewalkPattern?: string;
	prewalkResolved?: string;
	source: "bundled" | "user" | "project";
}

export interface RpcAgentDefinitionsResult {
	agents: RpcAgentDefinitionInfo[];
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
// Workspace Directory Wire Types (/dirs /add-dir /remove-dir /move parity)
// ============================================================================

/** One session workspace root. Exactly one entry — the session cwd — is primary. */
export interface RpcWorkspaceDirectory {
	path: string;
	primary: boolean;
}

/**
 * Result of get_directories / add_directory / remove_directory: the session's
 * workspace roots, primary (cwd) first, additional directories in their
 * stored order.
 */
export interface RpcWorkspaceDirectoriesResult {
	directories: RpcWorkspaceDirectory[];
}

/**
 * Result of get_git_status: the footer git segment's live state for the
 * session cwd (TUI gitSegment parity). `isRepo` false outside a repository
 * (counts zeroed, branch null); `branch` null when detached.
 */
export interface RpcGitStatus {
	isRepo: boolean;
	branch: string | null;
	staged: number;
	unstaged: number;
	untracked: number;
}

/**
 * Result of worktree_create: the materialized worktree. `path` is the
 * checkout root (~/.omp/wt/gui-<name>-<hash7>), `branch` the new
 * omp/gui/<name> ref, `baseCwd` the repo's primary checkout it forked from.
 */
export interface RpcWorktreeCreateResult {
	path: string;
	branch: string;
	baseCwd: string;
}

/** pr_repo: gh availability + the session cwd's GitHub repo, or the typed reason it's unusable. */
export type RpcPrRepo =
	| { available: true; repo: string; defaultBranch: string | null }
	| { available: false; reason: "gh_missing" | "not_a_repo" | "no_github_remote" };

/** pr_list row: one PR with rollup CI counts (success/failure/pending). */
export interface RpcPrListItem {
	number: number;
	title: string;
	url: string;
	isDraft: boolean;
	authorLogin: string;
	headRefName: string;
	baseRefName: string;
	additions: number;
	deletions: number;
	updatedAt: string;
	reviewDecision: string | null;
	checks: { success: number; failure: number; pending: number };
}

/** pr_get detail: everything the PR Center renders except per-file diff text. */
export interface RpcPrDetail {
	number: number;
	title: string;
	url: string;
	isDraft: boolean;
	authorLogin: string;
	body: string;
	baseRefName: string;
	headRefName: string;
	mergeStateStatus: string;
	additions: number;
	deletions: number;
	reviewDecision: string | null;
	files: Array<{ path: string; changeType: string; additions: number; deletions: number }>;
	checks: Array<{ name: string; status: string; conclusion: string | null }>;
}

/** pr_draft result (AI-drafted, user-editable before pr_create). */
export interface RpcPrDraftResult {
	title: string;
	body: string;
}

/** pr_create result. */
export interface RpcPrCreateResult {
	url: string;
	number: number;
}

// ============================================================================
// Session Report Wire Types (/context /tools /share /jobs parity)
// ============================================================================

/**
 * Result of get_context_report: the provider-anchored token breakdown from
 * `session.getContextBreakdown()` verbatim, plus the header fields the TUI
 * renders above it. `contextWindow` is 0 (and `model` empty) when no model
 * is selected — the TUI's "unavailable" state.
 */
export interface RpcContextReportResult {
	breakdown: ContextUsageBreakdown | undefined;
	contextWindow: number;
	/** Active model id; empty when no model is selected. */
	model: string;
}

/** Tool provenance bucket. `plugin` is reserved: plugin-shipped tools load
 * through the extension/custom-tool path and surface as `extension`. */
export type RpcToolSource = "builtin" | "mcp" | "extension" | "plugin";

export interface RpcActiveTool {
	name: string;
	description?: string;
	source: RpcToolSource;
}

/**
 * Result of get_active_tools: active top-level tools (TUI /tools rows),
 * followed by xd:// mounted entries (the `~ xd://name` rows).
 */
export interface RpcActiveToolsResult {
	tools: RpcActiveTool[];
}

/** Result of share_session. `truncated` rides only when content was trimmed. */
export interface RpcShareSessionResult {
	url: string;
	truncated?: boolean;
}

/**
 * Result of get_jobs: running jobs first, then recent (TUI /jobs ordering),
 * items as-is from the session's async-job snapshot. Empty when the session
 * has no job registry.
 */
export interface RpcJobsResult {
	jobs: AsyncJobSnapshotItem[];
}

// ============================================================================
// One-Shot Session Action Wire Types (prewalk / fresh / shake / reload / force)
// ============================================================================

/** Result of set_prewalk: the armed state after the toggle. */
export interface RpcPrewalkState {
	enabled: boolean;
}

/** Result of fresh (provider stream state reset); deliberately empty. */
export type RpcFreshResult = Record<string, never>;

/** Result of shake_context. `removed` is the one-line operator summary (TUI formatShakeSummary). */
export interface RpcShakeContextResult {
	removed: string;
}

/** Result of reload_plugins: post-reload inventory counts. */
export interface RpcReloadPluginsResult {
	plugins: number;
	skills: number;
	commands: number;
}

/** Result of set_force_tool / get_force_tool: the pending forced tool, or null. */
export interface RpcForceToolState {
	tool: string | null;
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
	| { id?: string; type: "response"; command: "drop_session"; success: true; data: { cancelled: boolean } }

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
	| { id?: string; type: "response"; command: "retry"; success: true; data: { retried: boolean } }

	// Context reset
	| {
			id?: string;
			type: "response";
			command: "clear_context";
			success: true;
			data: { cleared: boolean; droppedCount?: number };
	  }

	// Per-subagent lifecycle
	| {
			id?: string;
			type: "response";
			command: "abort_subagent";
			success: true;
			data: { ok: boolean; reason?: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "revive_subagent";
			success: true;
			data: { ok: boolean; reason?: string };
	  }

	// Session local:// paste write
	| { id?: string; type: "response"; command: "write_local_paste"; success: true; data: { name: string; url: string } }

	// Foreign sessions
	| {
			id?: string;
			type: "response";
			command: "list_foreign_sessions";
			success: true;
			data: { sessions: RpcForeignSessionInfo[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "import_foreign_session";
			success: true;
			data: { sessionPath: string; sessionId: string };
	  }

	// Slash-command argument completions
	| {
			id?: string;
			type: "response";
			command: "get_command_arg_completions";
			success: true;
			data: { items: Array<{ value: string; label?: string; description?: string; hint?: string }> };
	  }

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
	| { id?: string; type: "response"; command: "fork"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "fork_from";
			success: true;
			data: { sessionPath: string; sessionId: string };
	  }
	| { id?: string; type: "response"; command: "switch_leaf"; success: true; data: RpcSwitchLeafResult }
	| { id?: string; type: "response"; command: "resume_after_ask_reanswer"; success: true }
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
	| { id?: string; type: "response"; command: "get_copy_targets"; success: true; data: { targets: CopyTarget[] } }
	| { id?: string; type: "response"; command: "guided_goal"; success: true; data: { started: true } }
	| {
			id?: string;
			type: "response";
			command: "btw";
			success: true;
			data: { question: string; replyText: string; canBranch: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "btw_branch";
			success: true;
			data: { cancelled: boolean; sessionFile?: string };
	  }
	| { id?: string; type: "response"; command: "tan"; success: true; data: { jobId: string } }
	| {
			id?: string;
			type: "response";
			command: "omfg";
			success: true;
			data: { state: "saved" | "rejected" | "aborted"; savedPath?: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_agents_paused";
			success: true;
			data: { paused: boolean; pausedAt?: number; heldMs?: number };
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
	| {
			id?: string;
			type: "response";
			command: "get_settings";
			success: true;
			data: { values: Record<string, unknown>; advisorEnabled: boolean; advisorActive: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_setting";
			success: true;
			data: {
				path: string;
				value: unknown;
				advisorEnabled?: boolean;
				advisorActive?: boolean;
			};
	  }

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
	| {
			id?: string;
			type: "response";
			command: "set_model_role";
			success: true;
			data: { role: string; modelId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_model_role_metadata";
			success: true;
			data: RpcModelRoleMetadataResult;
	  }

	// Domain inspection (read-only)
	| { id?: string; type: "response"; command: "get_skills"; success: true; data: RpcSkillsResult }
	| { id?: string; type: "response"; command: "get_agent_definitions"; success: true; data: RpcAgentDefinitionsResult }
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

	// Session reports (read-only)
	| { id?: string; type: "response"; command: "get_context_report"; success: true; data: RpcContextReportResult }
	| { id?: string; type: "response"; command: "get_active_tools"; success: true; data: RpcActiveToolsResult }
	| { id?: string; type: "response"; command: "share_session"; success: true; data: RpcShareSessionResult }
	| { id?: string; type: "response"; command: "get_jobs"; success: true; data: RpcJobsResult }

	// One-shot session actions
	| { id?: string; type: "response"; command: "set_prewalk"; success: true; data: RpcPrewalkState }
	| { id?: string; type: "response"; command: "fresh"; success: true; data: RpcFreshResult }
	| { id?: string; type: "response"; command: "shake_context"; success: true; data: RpcShakeContextResult }
	| { id?: string; type: "response"; command: "reload_plugins"; success: true; data: RpcReloadPluginsResult }
	| { id?: string; type: "response"; command: "set_force_tool"; success: true; data: RpcForceToolState }
	| { id?: string; type: "response"; command: "get_force_tool"; success: true; data: RpcForceToolState }

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
	| {
			id?: string;
			type: "response";
			command: "synthesize_speech";
			success: true;
			data: { audioBase64: string; mimeType: string };
	  }

	// MCP server management (C1)
	| { id?: string; type: "response"; command: "mcp_add"; success: true; data: RpcMcpAddResult }
	| { id?: string; type: "response"; command: "mcp_test"; success: true; data: RpcMcpTestResult }
	| { id?: string; type: "response"; command: "mcp_reauth"; success: true; data: RpcMcpReauthResult }
	| { id?: string; type: "response"; command: "mcp_reauth_cancel"; success: true; data: RpcMcpReauthCancelResult }

	// Marketplace management (C1)
	| {
			id?: string;
			type: "response";
			command: "marketplace_action";
			success: true;
			data: RpcMarketplaceActionResult;
	  }

	// Plugin detail and settings (C1)
	| { id?: string; type: "response"; command: "get_plugin_detail"; success: true; data: RpcPluginDetail }
	| { id?: string; type: "response"; command: "set_plugin_features"; success: true; data: RpcPluginMutationResult }
	| { id?: string; type: "response"; command: "set_plugin_setting"; success: true; data: RpcPluginMutationResult }
	| {
			id?: string;
			type: "response";
			command: "delete_plugin_setting";
			success: true;
			data: RpcPluginMutationResult;
	  }

	// Long-lived interactive surfaces.
	| { id?: string; type: "response"; command: "live_start"; success: true; data: RpcLiveState }
	| { id?: string; type: "response"; command: "live_toggle_mute"; success: true; data: RpcLiveState }
	| { id?: string; type: "response"; command: "live_stop"; success: true; data: RpcLiveState }
	| { id?: string; type: "response"; command: "get_live_state"; success: true; data: RpcLiveState }
	| {
			id?: string;
			type: "response";
			command: "debug";
			success: true;
			data: { content: unknown; details?: unknown };
	  }
	| { id?: string; type: "response"; command: "collab_start"; success: true; data: RpcCollabState }
	| { id?: string; type: "response"; command: "collab_join"; success: true; data: RpcCollabState }
	| { id?: string; type: "response"; command: "collab_leave"; success: true; data: RpcCollabState }
	| { id?: string; type: "response"; command: "get_collab_state"; success: true; data: RpcCollabState }

	// Workspace directories
	| { id?: string; type: "response"; command: "get_directories"; success: true; data: RpcWorkspaceDirectoriesResult }
	| { id?: string; type: "response"; command: "add_directory"; success: true; data: RpcWorkspaceDirectoriesResult }
	| { id?: string; type: "response"; command: "remove_directory"; success: true; data: RpcWorkspaceDirectoriesResult }
	| { id?: string; type: "response"; command: "move_session"; success: true; data: { cwd: string } }

	// Git worktrees
	| { id?: string; type: "response"; command: "get_git_status"; success: true; data: RpcGitStatus }
	| { id?: string; type: "response"; command: "worktree_create"; success: true; data: RpcWorktreeCreateResult }
	| { id?: string; type: "response"; command: "worktree_remove"; success: true; data: { removed: true } }

	// Pull requests
	| { id?: string; type: "response"; command: "pr_repo"; success: true; data: RpcPrRepo }
	| { id?: string; type: "response"; command: "pr_list"; success: true; data: RpcPrListItem[] }
	| { id?: string; type: "response"; command: "pr_get"; success: true; data: RpcPrDetail }
	| { id?: string; type: "response"; command: "pr_diff"; success: true; data: { diff: string } }
	| { id?: string; type: "response"; command: "pr_draft"; success: true; data: RpcPrDraftResult }
	| { id?: string; type: "response"; command: "pr_create"; success: true; data: RpcPrCreateResult }
	| { id?: string; type: "response"; command: "pr_checkout"; success: true; data: { path: string; branch: string } }

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
