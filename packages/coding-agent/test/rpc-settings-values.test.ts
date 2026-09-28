import { expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { lookup as lookupSetting } from "../src/config/registry";
import { validateRpcSettingValue } from "../src/modes/rpc/rpc-extensions";

test("global saves preserve explicit runtime false and report both configured layers", () => {
	const settings = Settings.isolated({ "display.showTokenUsage": false });
	const showTokenUsage = lookupSetting("display.showTokenUsage");
	if (!showTokenUsage) throw new Error("display.showTokenUsage is not registered");
	showTokenUsage.set(settings, true);
	expect(showTokenUsage.get(settings)).toBe(false);
	expect(showTokenUsage.provenance(settings)).toBe("runtime");
	expect(settings.getProvenanceDetails(showTokenUsage)).toMatchObject({
		layers: ["global", "runtime"],
		globalValue: true,
	});
	showTokenUsage.clearOverride(settings);
	expect(showTokenUsage.get(settings)).toBe(true);
	expect(showTokenUsage.provenance(settings)).toBe("global");
	expect(settings.getProvenanceDetails(showTokenUsage)).toMatchObject({ layers: ["global"], globalValue: true });
});

test("RPC rejects malformed booleans, unsupported enums, non-finite numbers and inherited paths before saving", () => {
	expect(() => validateRpcSettingValue("display.showTokenUsage", "false")).toThrow("expected boolean");
	expect(() => validateRpcSettingValue("tools.approvalMode", "unknown")).toThrow("expected enum");
	expect(() => validateRpcSettingValue("setupVersion", Number.NaN)).toThrow("expected number");
	expect(() => validateRpcSettingValue("__proto__", {})).toThrow("Unknown setting");
	const settings = Settings.isolated();
	const showTokenUsage = lookupSetting("display.showTokenUsage");
	if (!showTokenUsage) throw new Error("display.showTokenUsage is not registered");
	validateRpcSettingValue("display.showTokenUsage", true);
	showTokenUsage.set(settings, true);
	expect(showTokenUsage.get(settings)).toBe(true);
});
