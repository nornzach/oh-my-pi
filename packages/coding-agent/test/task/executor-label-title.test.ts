/**
 * A background agent's generated label lands after its spawn was saved, so the
 * executor also titles the agent's own session with it. Without that title a
 * host that rebuilds its roster from disk (an RPC session reopened in a new
 * process) shows the raw assignment instead of the label the user saw live.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as labelModule from "@oh-my-pi/pi-coding-agent/task/label";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

const yieldEvents = [
	{ type: "tool_execution_start", toolCallId: "final-yield", toolName: "yield", args: {} },
	{
		type: "tool_execution_end",
		toolCallId: "final-yield",
		toolName: "yield",
		result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success", data: "ok" } },
		isError: false,
	},
] as AgentSessionEvent[];

/** A session double that yields from `prompt()` and records the titles it is given. */
function titledSession(titles: string[]): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session = {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
			getSessionName: () => titles.at(-1),
			setSessionName: async (name: string) => {
				titles.push(name);
				return true;
			},
		},
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		getToolByName: () => undefined,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			for (const event of yieldEvents) for (const listener of listeners.slice()) listener(event);
			return true;
		},
		abort: async () => {},
		isAborted: () => false,
	};
	// Structural test double, as in executor-probe-stage.test.ts.
	return session as unknown as AgentSession;
}

describe("executor transcript title", () => {
	afterEach(() => vi.restoreAllMocks());

	it("titles the agent's session with its generated label", async () => {
		vi.spyOn(labelModule, "generateTaskLabel").mockResolvedValue("Map the auth surface");
		const titles: string[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: titledSession(titles),
		} as CreateAgentSessionResult);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "Map the auth surface",
			assignment: "# Target\nEvery route that checks a session cookie.",
			index: 0,
			id: `label-title-${Math.random().toString(36).slice(2)}`,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as ModelRegistry,
			enableLsp: false,
			eventBus: new EventBus(),
		});

		expect(result.description).toBe("Map the auth surface");
		expect(titles).toEqual(["Map the auth surface"]);
	});
});
