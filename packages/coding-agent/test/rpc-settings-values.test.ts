import { expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import type { SettingPath } from "../src/config/settings-schema";
import { validateRpcSettingValue } from "../src/modes/rpc/rpc-extensions";

test("global saves preserve explicit runtime false and report both configured layers", () => {
	const settings = Settings.isolated({ "display.showTokenUsage": false });
	settings.set("display.showTokenUsage", true);
	expect(settings.get("display.showTokenUsage")).toBe(false);
	expect(settings.getProvenance("display.showTokenUsage")).toMatchObject({
		layers: ["global", "runtime"],
		globalValue: true,
	});
	settings.clearOverride("display.showTokenUsage");
	expect(settings.get("display.showTokenUsage")).toBe(true);
	expect(settings.getProvenance("display.showTokenUsage").layers).toEqual(["global"]);
});

test("RPC rejects malformed booleans, unsupported enums, non-finite numbers and inherited paths before saving", () => {
	expect(() => validateRpcSettingValue("display.showTokenUsage", "false")).toThrow("expected boolean");
	expect(() => validateRpcSettingValue("tools.approvalMode", "unknown")).toThrow("expected enum");
	expect(() => validateRpcSettingValue("setupVersion", Number.NaN)).toThrow("expected number");
	expect(() => validateRpcSettingValue("__proto__" as SettingPath, {})).toThrow("Unknown setting");
	const settings = Settings.isolated();
	validateRpcSettingValue("display.showTokenUsage", true);
	settings.set("display.showTokenUsage", true);
	expect(settings.get("display.showTokenUsage")).toBe(true);
});
