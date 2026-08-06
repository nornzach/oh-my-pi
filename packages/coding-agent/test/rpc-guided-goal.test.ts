import { describe, expect, it, vi } from "bun:test";
import { RpcGoalModeController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-modes";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function createSession(overrides: Record<string, unknown> = {}) {
	const prompt = vi.fn(async (_message: string, _options?: { synthetic?: boolean }) => true);
	const followUp = vi.fn(async (_message: string, _images?: unknown, _options?: { synthetic?: boolean }) => {});
	const setActiveToolsByName = vi.fn(async () => {});
	const session = {
		settings: { get: vi.fn(() => true) },
		getPlanModeState: vi.fn(() => undefined),
		getVibeModeState: vi.fn(() => undefined),
		getGoalModeState: vi.fn(() => undefined),
		getEnabledToolNames: vi.fn(() => ["read"]),
		setActiveToolsByName,
		isStreaming: false,
		prompt,
		followUp,
		...overrides,
	} as unknown as AgentSession;
	return { session, prompt, followUp, setActiveToolsByName };
}

describe("RpcGoalModeController guided interview", () => {
	it("exposes the goal tool and starts a synthetic interview with the rough objective", async () => {
		const fixture = createSession();
		const controller = new RpcGoalModeController({ session: fixture.session, onError: vi.fn() });

		expect(await controller.startGuidedInterview("ship reliable sync")).toEqual({ started: true });
		expect(fixture.setActiveToolsByName).toHaveBeenCalledWith(["read", "goal"]);
		expect(fixture.prompt).toHaveBeenCalledTimes(1);
		const [kickoff, options] = fixture.prompt.mock.calls[0] ?? [];
		expect(kickoff).toContain("ship reliable sync");
		expect(options).toMatchObject({ synthetic: true });
		expect(fixture.followUp).not.toHaveBeenCalled();
	});

	it("restores the prior tool set when the interview cannot be dispatched", async () => {
		const prompt = vi.fn(async () => {
			throw new Error("dispatch failed");
		});
		const fixture = createSession({ prompt });
		const controller = new RpcGoalModeController({ session: fixture.session, onError: vi.fn() });

		await expect(controller.startGuidedInterview()).rejects.toThrow("dispatch failed");
		expect(fixture.setActiveToolsByName).toHaveBeenNthCalledWith(1, ["read", "goal"]);
		expect(fixture.setActiveToolsByName).toHaveBeenNthCalledWith(2, ["read"]);
	});
});
