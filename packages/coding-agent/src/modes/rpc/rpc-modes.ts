/**
 * Session-mode controllers for RPC mode (vibe / goal / loop).
 *
 * The TUI owns these modes as fields on `InteractiveMode` and drives them
 * through `handleVibeModeCommand` / `handleGoalModeCommand` /
 * `handleLoopCommand`. None of them have a UI dependency in their session-level
 * mechanics, so each controller here mirrors the TUI path method-for-method
 * against the same `AgentSession` APIs. Deltas vs the TUI are documented per
 * controller.
 */
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { formatModelString } from "../../config/model-resolver";
import type { GoalModeState } from "../../goals/state";
import guidedGoalInterviewPrompt from "../../prompts/goals/guided-goal-interview.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { type VibeOwnerScope, type VibeParentSession, VibeSessionRegistry } from "../../vibe/runtime";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	isLoopDurationExpired,
	type LoopLimitRuntime,
	parseLoopLimitArgs,
} from "../loop-limit";
import type { RpcGoalState, RpcLoopModeState, RpcLoopModeUpdateFrame, RpcVibeModeState } from "./rpc-types";

// ============================================================================
// Vibe mode
// ============================================================================

/**
 * Mirror of `InteractiveMode.#enterVibeMode` / `#exitVibeMode`. All mechanics
 * are session-level (tool activation, worker registry, mode journal); the only
 * TUI-only pieces dropped here are status-line widgets.
 */
export class RpcVibeModeController {
	readonly #session: AgentSession;
	#previousTools: string[] | undefined;
	#ownerScope: VibeOwnerScope | undefined;

	constructor(session: AgentSession) {
		this.#session = session;
	}

	get enabled(): boolean {
		return this.#session.getVibeModeState()?.enabled === true;
	}

	#getState(): RpcVibeModeState {
		return { enabled: this.enabled };
	}

	/** Structured VibeParentSession for the worker registry (TUI `#vibeParentSession`). */
	#parentSession(): VibeParentSession {
		const session = this.#session;
		return {
			getAgentId: () => session.getAgentId() ?? null,
			getSessionId: () => session.sessionManager.getSessionId(),
			getSessionFile: () => session.sessionManager.getSessionFile() ?? null,
			sessionManager: session.sessionManager,
			asyncJobManager: session.asyncJobManager,
			settings: session.settings,
			getActiveModelString: () => (session.model ? formatModelString(session.model) : undefined),
		};
	}

	async setEnabled(enabled: boolean): Promise<RpcVibeModeState> {
		if (enabled === this.enabled) return this.#getState();
		if (enabled) {
			const session = this.#session;
			if (session.getPlanModeState()?.enabled) {
				throw new Error("Exit plan mode first.");
			}
			const goalState = session.getGoalModeState();
			if (goalState?.enabled || (goalState && !goalState.enabled && goalState.goal.status === "paused")) {
				throw new Error("Exit goal mode first.");
			}
			const vibeRegistry = VibeSessionRegistry.global();
			const ownerScope = vibeRegistry.ownerScope(this.#parentSession());
			vibeRegistry.activateScope(ownerScope);
			const previousTools = session.getEnabledToolNames();
			const vibeBaseTools = ["read"];
			if (session.hasBuiltInTool("todo")) vibeBaseTools.push("todo");
			await session.activateVibeTools(vibeBaseTools);
			this.#previousTools = previousTools;
			this.#ownerScope = ownerScope;
			session.setVibeModeState({ enabled: true });
			if (session.isStreaming) {
				await session.sendVibeModeContext({ deliverAs: "steer" });
			}
			session.sessionManager.appendModeChange("vibe");
			return this.#getState();
		}
		const killed = await VibeSessionRegistry.global().killAll(this.#parentSession(), this.#ownerScope);
		await this.#session.deactivateVibeTools(this.#previousTools ?? []);
		this.#session.setVibeModeState(undefined);
		this.#previousTools = undefined;
		this.#ownerScope = undefined;
		return { enabled: false, killedWorkers: killed };
	}
}

// ============================================================================
// Goal mode
// ============================================================================

interface RpcGoalModeControllerDeps {
	session: AgentSession;
	/** Fire-and-forget error reporting for dispatched turns. */
	onError: (error: Error) => void;
}

export interface RpcSetGoalCommand {
	objective?: string;
	tokenBudget?: number | null;
	action?: "pause" | "resume" | "drop";
}

/**
 * Mirror of the TUI goal paths: `#enterGoalMode` / `#exitGoalMode`,
 * `#replaceGoalFromObjective`, `#handleGoalBudgetCommand`, and the
 * `#handleGoalSessionEvent` subscription (tool restoration on drop/complete,
 * continuation scheduling).
 *
 * Deltas vs the TUI:
 * - Auto-continuation after a yield is gated on `"rpc"` appearing in the
 *   `goal.continuationModes` setting (default `["interactive"]`). The TUI gates
 *   on `"interactive"`; honoring that here would make every headless sidecar
 *   auto-continue goals by default.
 * - Drop skips the TUI's confirm dialog — an explicit RPC command is the
 *   confirmation.
 * - The TUI's goal menu/status-line widgets have no RPC counterpart.
 */
export class RpcGoalModeController {
	readonly #deps: RpcGoalModeControllerDeps;
	#previousTools: string[] | undefined;
	#continuationTimer: NodeJS.Timeout | undefined;
	#continuationTurnInFlight = false;
	#suppressNextContinuation = false;
	#turnHadToolCalls = false;

	constructor(deps: RpcGoalModeControllerDeps) {
		this.#deps = deps;
		// A resumed session may restore an active goal from the journal; the
		// pre-goal tool set is unknowable then, so restoration falls back to
		// dropping only the goal tool (mirrors #enterGoalMode's filter).
		if (this.enabled) {
			this.#previousTools = this.#deps.session.getEnabledToolNames().filter(name => name !== "goal");
		}
	}

	get enabled(): boolean {
		return this.#deps.session.getGoalModeState()?.enabled === true;
	}

	static projectState(state: GoalModeState | undefined): RpcGoalState {
		if (!state?.goal) return { enabled: false };
		return {
			enabled: state.enabled,
			status: state.goal.status,
			objective: state.goal.objective,
			tokenBudget: state.goal.tokenBudget,
			tokensUsed: state.goal.tokensUsed,
			timeUsedSeconds: state.goal.timeUsedSeconds,
			mode: state.mode,
		};
	}

	get state(): RpcGoalState {
		return RpcGoalModeController.projectState(this.#deps.session.getGoalModeState());
	}

	#assertEnterAllowed(): void {
		const session = this.#deps.session;
		if (session.getPlanModeState()?.enabled) {
			throw new Error("Exit plan mode first.");
		}
		if (session.getVibeModeState()?.enabled) {
			throw new Error("Exit vibe mode first.");
		}
		if (!session.settings.get("goal.enabled")) {
			throw new Error("Goal mode is disabled. Enable it in settings (goal.enabled).");
		}
	}

	/** TUI `#enterGoalMode`: create/resume the goal, expose the goal tool, journal. */
	async #enter(options: { objective?: string; resume?: boolean; tokenBudget?: number }): Promise<void> {
		const session = this.#deps.session;
		const previousTools = session.getEnabledToolNames().filter(name => name !== "goal");
		const goalTools = [...new Set([...previousTools, "goal"])];
		const state = options.resume
			? await session.goalRuntime.resumeGoal()
			: await session.goalRuntime.createGoal({
					objective: options.objective ?? "",
					tokenBudget: options.tokenBudget,
				});
		this.#previousTools = previousTools;
		await session.setActiveToolsByName(goalTools);
		session.setGoalModeState(state);
		this.#suppressNextContinuation = false;
		if (session.isStreaming) {
			await session.sendGoalModeContext({ deliverAs: "steer" });
		}
	}

	/** TUI `#exitGoalMode`: restore the pre-goal tool set. The runtime persists state. */
	async #exit(options: { reason: "paused" | "dropped" | "completed" }): Promise<void> {
		const session = this.#deps.session;
		if (this.enabled && this.#previousTools) {
			await session.setActiveToolsByName(this.#previousTools);
		}
		if (options.reason === "completed") {
			const currentState = session.getGoalModeState();
			session.sessionManager.appendModeChange("none");
			session.sessionManager.appendCustomEntry("goal-completed", {
				objective: currentState?.goal?.objective,
				tokensUsed: currentState?.goal?.tokensUsed,
				tokenBudget: currentState?.goal?.tokenBudget,
				timeUsedSeconds: currentState?.goal?.timeUsedSeconds,
			});
		}
		this.#previousTools = undefined;
		this.#continuationTurnInFlight = false;
		this.#cancelContinuation();
	}

	async startGuidedInterview(initial?: string): Promise<{ started: true }> {
		const session = this.#deps.session;
		this.#assertEnterAllowed();
		const state = session.getGoalModeState();
		if (state?.enabled) throw new Error("Goal mode is already active.");
		if (state?.goal?.status === "paused") {
			throw new Error("Resume the current goal first, or drop it before starting a guided goal.");
		}
		const enabledTools = session.getEnabledToolNames();
		const previousTools = enabledTools.filter(name => name !== "goal");
		this.#previousTools = previousTools;
		if (!enabledTools.includes("goal")) {
			await session.setActiveToolsByName([...previousTools, "goal"]);
		}
		const kickoff = prompt.render(guidedGoalInterviewPrompt, { initial: initial?.trim() || undefined });
		try {
			if (session.isStreaming) {
				await session.followUp(kickoff, undefined, { synthetic: true });
			} else {
				try {
					await session.prompt(kickoff, { synthetic: true });
				} catch (error) {
					if (!(error instanceof AgentBusyError)) throw error;
					await session.followUp(kickoff, undefined, { synthetic: true });
				}
			}
			return { started: true };
		} catch (error) {
			await session.setActiveToolsByName(previousTools);
			this.#previousTools = undefined;
			throw error;
		}
	}

	async setGoal(command: RpcSetGoalCommand): Promise<RpcGoalState> {
		const session = this.#deps.session;
		const objective = command.objective?.trim();

		if (command.action === "pause") {
			if (!this.enabled) throw new Error("No active goal to pause.");
			await session.goalRuntime.pauseGoal();
			await this.#exit({ reason: "paused" });
			return this.state;
		}
		if (command.action === "resume") {
			const state = session.getGoalModeState();
			if (!state?.goal || state.enabled || state.goal.status !== "paused") {
				throw new Error("No paused goal to resume.");
			}
			this.#assertEnterAllowed();
			await this.#enter({ resume: true });
			this.#scheduleContinuation();
			return this.state;
		}
		if (command.action === "drop") {
			const state = session.getGoalModeState();
			if (!this.enabled && !state?.goal) throw new Error("No goal to drop.");
			await session.goalRuntime.dropGoal();
			await this.#exit({ reason: "dropped" });
			return this.state;
		}

		if (objective) {
			if (this.enabled) {
				// TUI `#replaceGoalFromObjective`.
				const state = await session.goalRuntime.replaceGoal({
					objective,
					tokenBudget: command.tokenBudget ?? undefined,
				});
				session.setGoalModeState(state);
				this.#suppressNextContinuation = false;
				if (session.isStreaming) {
					await session.sendGoalModeContext({ deliverAs: "steer" });
				} else {
					this.#dispatchTurn(objective);
				}
				return this.state;
			}
			const pausedState = session.getGoalModeState();
			if (pausedState?.goal && !pausedState.enabled && pausedState.goal.status === "paused") {
				throw new Error("Resume the current goal first, or drop it before setting a new objective.");
			}
			this.#assertEnterAllowed();
			await this.#enter({ objective, tokenBudget: command.tokenBudget ?? undefined });
			if (!session.isStreaming) {
				// TUI `#startGoalFromObjective` submits the objective as the first turn.
				this.#dispatchTurn(objective);
			}
			return this.state;
		}

		if (command.tokenBudget !== undefined) {
			// TUI `#handleGoalBudgetCommand`.
			const state = session.getGoalModeState();
			if (!this.enabled || !state?.enabled) throw new Error("No active goal.");
			if (state.goal.status === "complete") throw new Error("Goal is already complete.");
			const nextBudget = command.tokenBudget === null ? undefined : command.tokenBudget;
			if (nextBudget !== undefined && (!Number.isInteger(nextBudget) || nextBudget <= 0)) {
				throw new Error("Goal budget must be a positive integer or null.");
			}
			await session.goalRuntime.onBudgetMutated(nextBudget);
			this.#suppressNextContinuation = false;
			this.#scheduleContinuation();
			return this.state;
		}

		throw new Error("set_goal requires an objective, a tokenBudget, or an action.");
	}

	/** Fire-and-forget a user turn; events stream like the `prompt` command. */
	#dispatchTurn(text: string): void {
		const session = this.#deps.session;
		void session
			.prompt(text, { streamingBehavior: "followUp" })
			.catch(error => this.#deps.onError(error instanceof Error ? error : new Error(String(error))));
	}

	#cancelContinuation(): void {
		if (this.#continuationTimer) {
			clearTimeout(this.#continuationTimer);
			this.#continuationTimer = undefined;
		}
	}

	/**
	 * TUI `#scheduleGoalContinuation`, RPC-adapted: gated on `"rpc"` in
	 * `goal.continuationModes` (see class doc). The TUI's editor/pending-input
	 * guards have no RPC counterpart; the busy guards map to
	 * `isStreaming`/`isCompacting`/`hasPostPromptWork`.
	 */
	#scheduleContinuation(): void {
		this.#cancelContinuation();
		const session = this.#deps.session;
		if (!session.settings.get("goal.continuationModes").includes("rpc")) return;
		if (session.getPlanModeState()?.enabled) return;
		if (this.#suppressNextContinuation) return;
		const state = session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return;
		const text = session.goalRuntime.buildContinuationPrompt();
		if (!text) return;
		this.#continuationTimer = setTimeout(() => {
			this.#continuationTimer = undefined;
			// Drop the tick when a turn started in the gap; the next agent_end
			// reschedules (mirrors the TUI comment on its 800ms timer).
			if (session.isStreaming || session.isCompacting || session.hasPostPromptWork) return;
			const latest = session.getGoalModeState();
			if (!latest?.enabled || latest.goal.status !== "active") return;
			this.#continuationTurnInFlight = true;
			// main.ts dispatches customType submissions through promptCustomMessage
			// with followUp queueing; mirror it exactly.
			void session
				.promptCustomMessage(
					{ customType: "goal-continuation", content: text, display: false, attribution: "agent" },
					{ streamingBehavior: "followUp" },
				)
				.catch(error => this.#deps.onError(error instanceof Error ? error : new Error(String(error))));
		}, 800);
	}

	/** TUI `#handleGoalSessionEvent`: tool restore on drop/complete + continuation scheduling. */
	async handleSessionEvent(event: AgentSessionEvent): Promise<void> {
		const session = this.#deps.session;
		if (event.type === "agent_start") {
			this.#turnHadToolCalls = false;
			this.#cancelContinuation();
			return;
		}
		if (event.type === "tool_execution_start") {
			this.#turnHadToolCalls = true;
			if (!this.#continuationTurnInFlight) {
				this.#suppressNextContinuation = false;
			}
			return;
		}
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			this.#suppressNextContinuation = false;
			return;
		}
		if (event.type === "goal_updated") {
			if (event.state?.goal?.status === "dropped") {
				await this.#exit({ reason: "dropped" });
				return;
			}
			if (!event.state?.enabled) {
				this.#cancelContinuation();
			}
			return;
		}
		if (event.type !== "agent_end") return;
		if (this.#continuationTurnInFlight) {
			this.#suppressNextContinuation = !this.#turnHadToolCalls;
			this.#continuationTurnInFlight = false;
		}
		if (session.getGoalModeState()?.mode === "exiting") {
			await this.#exit({ reason: "completed" });
			return;
		}
		this.#scheduleContinuation();
	}
}

// ============================================================================
// Loop mode
// ============================================================================

interface RpcLoopModeControllerDeps {
	session: AgentSession;
	output: (frame: RpcLoopModeUpdateFrame) => void;
	onError: (error: Error) => void;
}

/**
 * RPC counterpart of the TUI loop (`handleLoopCommand` + `#runLoopIteration` +
 * `#submitLoopPromptWhenReady`). Loop state is mode-local in both worlds — the
 * TUI keeps it on `InteractiveMode` fields, never in session state — so holding
 * it here is parity, not a re-implementation gap. Iterations re-submit through
 * `session.prompt` exactly like the TUI's submit flow, honoring the same
 * `loop.mode` action and limit parser.
 *
 * Deltas vs the TUI:
 * - `"reset"` iterations start a fresh session via `session.newSession()`; the
 *   TUI's `handleClearCommand` additionally preps UI/vibe state (vibe+reset is
 *   already rejected in both).
 * - Auto-disable is surfaced as a `loop_mode_update` frame instead of a
 *   status-line toast.
 */
export class RpcLoopModeController {
	readonly #deps: RpcLoopModeControllerDeps;
	#enabled = false;
	#paused = false;
	#prompt: string | undefined;
	#limit: LoopLimitRuntime | undefined;
	#timer: NodeJS.Timeout | undefined;

	constructor(deps: RpcLoopModeControllerDeps) {
		this.#deps = deps;
	}

	get state(): RpcLoopModeState {
		return {
			enabled: this.#enabled,
			state: !this.#enabled ? "off" : this.#paused ? "paused" : this.#prompt ? "running" : "waiting",
			prompt: this.#prompt,
			limit: this.#limit,
		};
	}

	#emit(): void {
		this.#deps.output({ type: "loop_mode_update", state: this.state });
	}

	/** TUI `handleLoopCommand`: toggle, or parse args and (optionally) start the first iteration. */
	setEnabled(enabled: boolean, args?: string): RpcLoopModeState {
		if (!enabled) {
			this.#disable();
			return this.state;
		}
		if (this.#enabled) return this.state;
		const parsed = parseLoopLimitArgs(args ?? "");
		if (typeof parsed === "string") throw new Error(parsed);
		this.#enabled = true;
		this.#paused = false;
		this.#prompt = undefined;
		this.#limit = createLoopLimitRuntime(parsed.limit);
		this.#emit();
		if (parsed.prompt) {
			// The TUI hands the inline prompt back to the dispatcher, whose normal
			// submit flow records it as the loop prompt and runs the first iteration.
			this.onHostPrompt(parsed.prompt);
			this.#dispatchTurn(parsed.prompt);
		}
		return this.state;
	}

	/**
	 * Mirror of the input-controller's `if (loopModeEnabled) setLoopPrompt(text)`:
	 * every host prompt while enabled becomes the loop prompt and un-pauses.
	 */
	onHostPrompt(text: string): void {
		if (!this.#enabled) return;
		this.#prompt = text;
		this.#paused = false;
		this.#emit();
	}

	/** TUI `pauseLoop`: drop the captured prompt and any pending re-submit; mode stays enabled. */
	pause(): void {
		if (!this.#enabled) return;
		this.#prompt = undefined;
		this.#paused = true;
		this.#cancelTimer();
		this.#emit();
	}

	#disable(): void {
		const wasEnabled = this.#enabled;
		this.#enabled = false;
		this.#paused = false;
		this.#prompt = undefined;
		this.#limit = undefined;
		this.#cancelTimer();
		if (wasEnabled) this.#emit();
	}

	#cancelTimer(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	#dispatchTurn(text: string): void {
		const session = this.#deps.session;
		void session
			.prompt(text, { streamingBehavior: "followUp" })
			.catch(error => this.#deps.onError(error instanceof Error ? error : new Error(String(error))));
	}

	#isAutoSubmitBlocked(): boolean {
		const session = this.#deps.session;
		return session.isStreaming || session.isCompacting || session.hasPostPromptWork;
	}

	/** TUI `#deferLoopAutoSubmit` (800ms), then `#runLoopIteration`. */
	#defer(callback: () => void): void {
		this.#cancelTimer();
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			callback();
		}, 800);
	}

	/** Agent-end hook: TUI schedules `#runLoopIteration(settings.loop.mode, prompt)`. */
	onAgentEnd(): void {
		if (!this.#enabled || !this.#prompt) return;
		const text = this.#prompt;
		this.#defer(() => void this.#runIteration(text));
	}

	async #runIteration(text: string): Promise<void> {
		if (!this.#enabled || this.#prompt !== text) return;
		if (this.#isAutoSubmitBlocked()) {
			this.#defer(() => void this.#runIteration(text));
			return;
		}
		const action = this.#deps.session.settings.get("loop.mode");
		if (action === "reset" && this.#deps.session.getVibeModeState()?.enabled) {
			this.#disable();
			return;
		}
		if (!consumeLoopLimitIteration(this.#limit)) {
			this.#disable();
			return;
		}
		this.#emit();
		try {
			if (action === "compact") {
				await this.#deps.session.compact();
			} else if (action === "reset") {
				await this.#deps.session.newSession();
			}
		} catch (error) {
			this.#deps.onError(error instanceof Error ? error : new Error(String(error)));
			this.#disable();
			return;
		}
		this.#submitWhenReady(text);
	}

	/** TUI `#submitLoopPromptWhenReady`. */
	#submitWhenReady(text: string): void {
		if (!this.#enabled || this.#prompt !== text) return;
		if (isLoopDurationExpired(this.#limit)) {
			this.#disable();
			return;
		}
		if (this.#isAutoSubmitBlocked()) {
			this.#defer(() => this.#submitWhenReady(text));
			return;
		}
		this.#dispatchTurn(text);
	}
}
