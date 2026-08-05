/**
 * Contract tests for applyRuntimeSetting — the canonical live-apply shared by
 * the TUI selector and RPC set_setting. Every runtime key must hit the same
 * target the TUI used to apply directly; live-read/chrome keys must return
 * false so callers treat them as persistence-only.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
	applyRuntimeSetting,
	type RuntimeSettingTarget,
} from "@oh-my-pi/pi-coding-agent/session/apply-runtime-setting";
import * as imageGen from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import * as searchProvider from "@oh-my-pi/pi-coding-agent/web/search/provider";

function makeTarget() {
	const calls = new Map<string, unknown[][]>();
	const record =
		(name: string) =>
		(...args: unknown[]) => {
			const list = calls.get(name) ?? [];
			list.push(args);
			calls.set(name, list);
		};
	const target: RuntimeSettingTarget = {
		agent: {},
		setThinkingLevel: record("setThinkingLevel"),
		setAdvisorEnabled: record("setAdvisorEnabled"),
		setSteeringMode: record("setSteeringMode"),
		setFollowUpMode: record("setFollowUpMode"),
		setInterruptMode: record("setInterruptMode"),
		refreshBaseSystemPrompt: async () => record("refreshBaseSystemPrompt")(),
		applyMemoryBackend: async () => record("applyMemoryBackend")(),
		applyInspectImageModeChange: async () => record("applyInspectImageModeChange")(),
	};
	return { target, calls };
}

afterEach(() => {
	mock.restore();
});

describe("applyRuntimeSetting", () => {
	test("sampling keys map to agent fields, negative meaning provider default", async () => {
		const { target } = makeTarget();
		expect(await applyRuntimeSetting(target, "temperature", 0.7)).toBe(true);
		expect(target.agent.temperature).toBe(0.7);
		expect(await applyRuntimeSetting(target, "temperature", -1)).toBe(true);
		expect(target.agent.temperature).toBeUndefined();
		expect(await applyRuntimeSetting(target, "topP", 0.9)).toBe(true);
		expect(target.agent.topP).toBe(0.9);
		expect(await applyRuntimeSetting(target, "repetitionPenalty", 1.1)).toBe(true);
		expect(target.agent.repetitionPenalty).toBe(1.1);
	});

	test("defaultThinkingLevel applies the parsed selector with persist", async () => {
		const { target, calls } = makeTarget();
		expect(await applyRuntimeSetting(target, "defaultThinkingLevel", "high")).toBe(true);
		expect(calls.get("setThinkingLevel")).toEqual([["high", true]]);
		calls.clear();
		expect(await applyRuntimeSetting(target, "defaultThinkingLevel", "not-a-level")).toBe(true);
		expect(calls.get("setThinkingLevel")).toBeUndefined();
	});

	test("session toggles apply only valid values", async () => {
		const { target, calls } = makeTarget();
		await applyRuntimeSetting(target, "advisor.enabled", true);
		await applyRuntimeSetting(target, "steeringMode", "one-at-a-time");
		await applyRuntimeSetting(target, "followUpMode", "all");
		await applyRuntimeSetting(target, "interruptMode", "wait");
		expect(calls.get("setAdvisorEnabled")).toEqual([[true]]);
		expect(calls.get("setSteeringMode")).toEqual([["one-at-a-time"]]);
		expect(calls.get("setFollowUpMode")).toEqual([["all"]]);
		expect(calls.get("setInterruptMode")).toEqual([["wait"]]);
		calls.clear();
		await applyRuntimeSetting(target, "steeringMode", "garbage");
		expect(calls.get("setSteeringMode")).toBeUndefined();
	});

	test("omitThinking sets the agent hideThinkingSummary flag", async () => {
		const { target } = makeTarget();
		expect(await applyRuntimeSetting(target, "omitThinking", true)).toBe(true);
		expect(target.agent.hideThinkingSummary).toBe(true);
	});

	test("prompt-affecting keys refresh the base system prompt", async () => {
		const { target, calls } = makeTarget();
		await applyRuntimeSetting(target, "personality", "pragmatic");
		await applyRuntimeSetting(target, "tools.xdevDocs", true);
		await applyRuntimeSetting(target, "tui.renderMermaid", false);
		expect(calls.get("refreshBaseSystemPrompt")?.length).toBe(3);
	});

	test("memory backend and vision mode run their reconcilers", async () => {
		const { target, calls } = makeTarget();
		await applyRuntimeSetting(target, "memory.backend", "mnemopi");
		await applyRuntimeSetting(target, "inspect_image.mode", "file");
		expect(calls.get("applyMemoryBackend")?.length).toBe(1);
		expect(calls.get("applyInspectImageModeChange")?.length).toBe(1);
	});

	test("provider orders go to their module setters", async () => {
		const searchOrder = spyOn(searchProvider, "setSearchProviderOrder").mockImplementation(() => {});
		const searchExclude = spyOn(searchProvider, "setExcludedSearchProviders").mockImplementation(() => {});
		const imageOrder = spyOn(imageGen, "setImageProviderOrder").mockImplementation(() => {});
		const { target } = makeTarget();
		await applyRuntimeSetting(target, "providers.webSearchOrder", ["google"]);
		await applyRuntimeSetting(target, "providers.webSearchExclude", ["exa"]);
		await applyRuntimeSetting(target, "providers.imageOrder", ["openai", 42]);
		expect(searchOrder).toHaveBeenCalledTimes(1);
		expect(searchExclude).toHaveBeenCalledTimes(1);
		expect(imageOrder).toHaveBeenCalledWith(["openai"]);
	});

	test("mcp.notifications reaches the shared manager", async () => {
		const setNotificationsEnabled = mock((_enabled: boolean) => {});
		spyOn(MCPManager, "instance").mockReturnValue({ setNotificationsEnabled } as unknown as MCPManager);
		const { target } = makeTarget();
		expect(await applyRuntimeSetting(target, "mcp.notifications", false)).toBe(true);
		expect(setNotificationsEnabled).toHaveBeenCalledWith(false);
	});

	test("live-read and chrome keys are persistence-only", async () => {
		const { target, calls } = makeTarget();
		for (const path of ["retry.maxRetries", "model.loopGuard.enabled", "display.shimmer", "statusLine.preset"]) {
			expect(await applyRuntimeSetting(target, path, true)).toBe(false);
		}
		expect(calls.size).toBe(0);
	});
});
