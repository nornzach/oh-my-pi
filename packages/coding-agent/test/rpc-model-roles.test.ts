import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildRpcModelRoles, rpcModelRoleValue } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-model-roles";
import type { ModelBrowserRegistry } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";

function chatModel(id: string, reasoning: boolean, thinking?: Model["thinking"]): Model {
	return { provider: "acme", id, name: id, reasoning, thinking } as unknown as Model;
}

const thinker = chatModel("thinker", true, { mode: "effort", efforts: [Effort.Low, Effort.High] });
const plain = chatModel("plain", false);
const draft = chatModel("draft", true, { mode: "effort", efforts: [Effort.Low], unverified: true });
// A literal id that ends in a thinking level: the suffix belongs to the id.
const literalMax = chatModel("router:max", true, { mode: "effort", efforts: [Effort.Low] });
const models = [thinker, plain, draft, literalMax];

const registry: ModelBrowserRegistry = {
	getError: () => undefined,
	getAvailable: () => models,
	getAll: () => models,
};

function role(settings: Settings, id: string) {
	const entry = buildRpcModelRoles(settings, registry).roles.find(candidate => candidate.id === id);
	if (!entry) throw new Error(`role ${id} missing`);
	return entry;
}

describe("get_model_roles", () => {
	test("offers each candidate the thinking levels a role assignment can apply", () => {
		const levels = Object.fromEntries(
			role(Settings.isolated(), "default").candidates.map(candidate => [candidate.id, candidate.thinkingLevels]),
		);

		expect(levels).toEqual({
			thinker: [ThinkingLevel.Inherit, ThinkingLevel.Off, AUTO_THINKING, Effort.Low, Effort.High],
			plain: [],
			draft: [ThinkingLevel.Inherit, ThinkingLevel.Off, Effort.Low],
			"router:max": [ThinkingLevel.Inherit, ThinkingLevel.Off, AUTO_THINKING, Effort.Low],
		});
	});

	test("selects the candidate a suffixed role value names and reports its level", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "acme/thinker:high", smol: "acme/router:max", slow: "acme/thinker,acme/plain" },
		});

		expect(role(settings, "default").selected).toEqual({
			provider: "acme",
			id: "thinker",
			thinkingLevel: Effort.High,
		});
		expect(role(settings, "smol").selected).toEqual({ provider: "acme", id: "router:max" });
		// A fallback chain names no single candidate.
		expect(role(settings, "slow").selected).toBeUndefined();
	});
});

describe("set_model_role", () => {
	test("stores a chosen level as the selector suffix and reads it back", () => {
		const settings = Settings.isolated();
		const value = rpcModelRoleValue("smol", "acme/thinker", Effort.High, settings, registry);
		settings.setModelRole("smol", value);

		expect(value).toBe("acme/thinker:high");
		expect(role(settings, "smol").selected).toEqual({ provider: "acme", id: "thinker", thinkingLevel: Effort.High });
		expect(rpcModelRoleValue("smol", "acme/thinker", ThinkingLevel.Inherit, settings, registry)).toBe("acme/thinker");
	});

	test("rejects a level the model cannot apply instead of storing it", () => {
		const settings = Settings.isolated();

		expect(() => rpcModelRoleValue("smol", "acme/thinker", Effort.XHigh, settings, registry)).toThrow(
			"acme/thinker does not support thinking level xhigh",
		);
		expect(() => rpcModelRoleValue("smol", "acme/plain", ThinkingLevel.Off, settings, registry)).toThrow(
			"acme/plain does not support thinking level off",
		);
		expect(() => rpcModelRoleValue("smol", "other/missing", Effort.Low, settings, registry)).toThrow(
			"other/missing is not a model the smol role accepts",
		);
	});
});
