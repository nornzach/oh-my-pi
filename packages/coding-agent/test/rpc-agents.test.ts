import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	applyRpcAbortSubagent,
	applyRpcReviveSubagent,
	buildRpcAgentDefinitions,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-agents";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";

/**
 * Contract tests for the per-subagent lifecycle RPC actions (TUI Agent Hub
 * `x`/`r` parity): refusal reasons for the main agent / advisor transcripts /
 * unknown ids, abort semantics for a running subagent, and revive idempotence.
 */

function stubSession(): AgentSession {
	return { abort: vi.fn(async () => {}) } as unknown as AgentSession;
}

afterEach(() => {
	// The lifecycle manager captures the registry at construction — reset both
	// or it keeps reading the pre-reset registry instance.
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("buildRpcAgentDefinitions", () => {
	it("exposes discoverable workspace definitions with their source metadata", async () => {
		const result = await buildRpcAgentDefinitions({
			sessionManager: { getCwd: () => process.cwd() },
			model: undefined,
			modelRegistry: { getAvailable: () => [] },
			settings: {
				get: () => undefined,
				getModelRole: () => undefined,
			},
		} as unknown as AgentSession);
		const task = result.agents.find(agent => agent.name === "task");
		expect(task).toMatchObject({
			name: "task",
			description: expect.any(String),
			source: expect.stringMatching(/^(bundled|user|project)$/),
		});
	});
});

describe("applyRpcAbortSubagent", () => {
	it("refuses the main agent", async () => {
		expect(await applyRpcAbortSubagent(MAIN_AGENT_ID)).toEqual({ ok: false, reason: "main_agent" });
	});

	it("refuses unknown ids", async () => {
		expect(await applyRpcAbortSubagent("ghost")).toEqual({ ok: false, reason: "not_found" });
	});

	it("refuses read-only advisor transcripts", async () => {
		AgentRegistry.global().register({ id: "adv", displayName: "advisor", kind: "advisor", session: null });
		expect(await applyRpcAbortSubagent("adv")).toEqual({ ok: false, reason: "advisor_readonly" });
	});

	it("aborts a running subagent with the user-interrupt reason and releases it", async () => {
		const session = stubSession();
		AgentRegistry.global().register({ id: "sub1", displayName: "worker", kind: "sub", session });
		const result = await applyRpcAbortSubagent("sub1");
		expect(result).toEqual({ ok: true });
		expect(session.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
	});

	it("releases an already-stopped subagent without calling abort", async () => {
		const session = stubSession();
		AgentRegistry.global().register({
			id: "sub2",
			displayName: "worker",
			kind: "sub",
			session: null,
			status: "aborted",
		});
		const result = await applyRpcAbortSubagent("sub2");
		expect(result).toEqual({ ok: true });
		expect(session.abort).not.toHaveBeenCalled();
	});
});

describe("applyRpcReviveSubagent", () => {
	it("refuses the main agent", async () => {
		expect(await applyRpcReviveSubagent(MAIN_AGENT_ID)).toEqual({ ok: false, reason: "main_agent" });
	});

	it("refuses unknown ids", async () => {
		expect(await applyRpcReviveSubagent("ghost")).toEqual({ ok: false, reason: "not_found" });
	});

	it("refuses read-only advisor transcripts", async () => {
		AgentRegistry.global().register({ id: "adv", displayName: "advisor", kind: "advisor", session: null });
		expect(await applyRpcReviveSubagent("adv")).toEqual({ ok: false, reason: "advisor_readonly" });
	});

	it("is idempotent for a live agent", async () => {
		AgentRegistry.global().register({ id: "sub1", displayName: "worker", kind: "sub", session: stubSession() });
		expect(await applyRpcReviveSubagent("sub1")).toEqual({ ok: true });
	});

	it("maps a parked agent with no reviver to not_parked", async () => {
		AgentRegistry.global().register({
			id: "sub2",
			displayName: "worker",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/nonexistent-session-file.jsonl",
			status: "parked",
		});
		expect(await applyRpcReviveSubagent("sub2")).toEqual({ ok: false, reason: "not_parked" });
	});
});
