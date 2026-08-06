import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp";
import {
	applyRpcFresh,
	applyRpcGetForceTool,
	applyRpcReloadPlugins,
	applyRpcSetForceTool,
	applyRpcSetPrewalk,
	applyRpcShakeContext,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-actions";
import type { RpcAvailableSlashCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Contract tests for the one-shot session-action RPC commands (set_prewalk,
 * fresh, shake_context, reload_plugins, set_force_tool, get_force_tool): each
 * helper mirrors its TUI slash command's semantics and returns the pinned
 * wire shape. Force-tool tracking additionally pins the pending-force
 * lifecycle the GUI dialog renders: armed → spent on consumption → re-armed
 * on abort → dropped on explicit clear.
 */

let tempDir: TempDir;
let authStorage: AuthStorage | undefined;
let session: AgentSession;

beforeEach(async () => {
	tempDir = TempDir.createSync("@pi-rpc-session-actions-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({ "compaction.enabled": false });
	// Deterministic @smol resolution for set_prewalk: a catalog model with auth.
	settings.setModelRole("smol", "anthropic/claude-sonnet-4-5");

	const emptyObjectSchema = type("object");
	const bashTool: AgentTool = {
		name: "bash",
		label: "Bash",
		description: "Mock bash tool",
		parameters: emptyObjectSchema,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
	const writeTool: AgentTool = {
		name: "write",
		label: "Write",
		description: "Mock write tool",
		parameters: emptyObjectSchema,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};

	const mock = createMockModel({ handler: () => ({ content: ["done"] }) });
	const agent = new Agent({
		getToolChoice: () => session.nextToolChoiceDirective(),
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [bashTool, writeTool], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry: new Map([
			[bashTool.name, bashTool],
			[writeTool.name, writeTool],
		]),
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await session.dispose();
	authStorage?.close();
	authStorage = undefined;
	tempDir.removeSync();
});

describe("applyRpcSetPrewalk", () => {
	it("arms the resolved smol model and steers the plan nudge", () => {
		expect(applyRpcSetPrewalk(session, true)).toEqual({ enabled: true });
		expect(session.getPrewalkState()?.target.id).toBe("claude-sonnet-4-5");
		const nudges = session.agent
			.peekSteeringQueue()
			.filter(message => message.role === "custom" && message.customType === "prewalk-plan");
		expect(nudges).toHaveLength(1);
	});

	it("disarms a pending prewalk and pulls the queued nudge", () => {
		applyRpcSetPrewalk(session, true);
		expect(applyRpcSetPrewalk(session, false)).toEqual({ enabled: false });
		expect(session.getPrewalkState()).toBeUndefined();
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
	});

	it("disarm is idempotent when nothing is armed", () => {
		expect(applyRpcSetPrewalk(session, false)).toEqual({ enabled: false });
		expect(session.getPrewalkState()).toBeUndefined();
	});

	it("throws the TUI usage error when the role has no authenticated model", () => {
		session.settings.setModelRole("smol", "cerebras/zai-glm-4.7");
		expect(() => applyRpcSetPrewalk(session, true)).toThrow("No API key for cerebras/zai-glm-4.7");
		expect(session.getPrewalkState()).toBeUndefined();
	});
});

describe("applyRpcFresh", () => {
	it("rotates provider stream state and returns the empty data shape", () => {
		const previousSessionId = session.sessionId;
		expect(applyRpcFresh(session)).toEqual({});
		expect(session.sessionId).not.toBe(previousSessionId);
	});

	it("returns undefined while the session is busy (caller's busy refusal)", () => {
		vi.spyOn(session, "freshSession").mockReturnValue(undefined);
		expect(applyRpcFresh(session)).toBeUndefined();
	});
});

describe("applyRpcShakeContext", () => {
	it("reports the elide summary for an empty session", async () => {
		await expect(applyRpcShakeContext(session, "elide")).resolves.toEqual({ removed: "Nothing to shake." });
	});

	it("reports the images summary for an empty session", async () => {
		await expect(applyRpcShakeContext(session, "images")).resolves.toEqual({
			removed: "No images found in this session.",
		});
	});
});

describe("applyRpcReloadPlugins", () => {
	it("returns post-reload counts and hands the rebuilt command list to the frame callback", async () => {
		// The MCP branch mirrors applyRpcMcpAction's tested steps; pin it off so
		// the contract here is the reload pipeline, not the process-global manager.
		vi.spyOn(MCPManager, "instance").mockReturnValue(undefined);
		let refreshed: RpcAvailableSlashCommand[] | undefined;
		const result = await applyRpcReloadPlugins(session, commands => {
			refreshed = commands;
		});
		expect(typeof result.plugins).toBe("number");
		expect(typeof result.skills).toBe("number");
		expect(result.skills).toBe(session.skills.length);
		if (!refreshed) throw new Error("expected onCommandsRefreshed to fire");
		expect(result.commands).toBe(refreshed.length);
		// The palette list always carries the builtins, even in an empty cwd.
		expect(result.commands).toBeGreaterThan(0);
	});
});

describe("force-tool RPC commands", () => {
	it("arms and reports the pending forced tool", () => {
		expect(applyRpcSetForceTool(session, { tool: "write" })).toEqual({ tool: "write" });
		expect(applyRpcGetForceTool(session)).toEqual({ tool: "write" });
	});

	it("rejects unknown or inactive tools with the TUI validation error", () => {
		expect(() => applyRpcSetForceTool(session, { tool: "read" })).toThrow('Tool "read" is not currently active.');
		expect(applyRpcGetForceTool(session)).toEqual({ tool: null });
	});

	it("requires exactly one of tool or clear", () => {
		expect(() => applyRpcSetForceTool(session, {})).toThrow("exactly one of tool or clear");
		expect(() => applyRpcSetForceTool(session, { tool: "write", clear: true })).toThrow(
			"exactly one of tool or clear",
		);
	});

	it("clears a queued force so no directive survives", () => {
		applyRpcSetForceTool(session, { tool: "write" });
		expect(applyRpcSetForceTool(session, { clear: true })).toEqual({ tool: null });
		expect(applyRpcGetForceTool(session)).toEqual({ tool: null });
		expect(session.nextToolChoiceDirective()).toBeUndefined();
	});

	it("clears an in-flight force without re-arming it", () => {
		applyRpcSetForceTool(session, { tool: "write" });
		expect(session.nextToolChoiceDirective()).toEqual({ type: "tool", name: "write" });
		expect(session.toolChoiceQueue.hasInFlight).toBe(true);
		expect(applyRpcSetForceTool(session, { clear: true })).toEqual({ tool: null });
		expect(session.nextToolChoiceDirective()).toBeUndefined();
	});

	it("stays armed when the turn aborts (TUI requeue semantics)", () => {
		applyRpcSetForceTool(session, { tool: "write" });
		expect(session.nextToolChoiceDirective()).toEqual({ type: "tool", name: "write" });
		session.toolChoiceQueue.reject("aborted");
		expect(applyRpcGetForceTool(session)).toEqual({ tool: "write" });
		// The aborted force replays at the head so the next turn still honors it.
		expect(session.nextToolChoiceDirective()).toEqual({ type: "tool", name: "write" });
		// …and an explicit clear still drops the replayed copy.
		expect(applyRpcSetForceTool(session, { clear: true })).toEqual({ tool: null });
		expect(session.nextToolChoiceDirective()).toBeUndefined();
	});

	it("is spent once the forced call resolves", () => {
		applyRpcSetForceTool(session, { tool: "write" });
		expect(session.nextToolChoiceDirective()).toEqual({ type: "tool", name: "write" });
		session.toolChoiceQueue.resolve();
		expect(applyRpcGetForceTool(session)).toEqual({ tool: null });
		// The trailing "none" stop is bookkeeping: it still gates the next call.
		expect(session.nextToolChoiceDirective()).toBe("none");
		expect(session.nextToolChoiceDirective()).toBeUndefined();
	});
});
