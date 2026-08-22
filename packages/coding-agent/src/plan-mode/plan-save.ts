const PLAN_SAVE_STEM_MAX_LENGTH = 32;

/** Suggested save filename for an approved plan: `<TOPIC>_PLAN.md`. */
export function planSaveFileName(title: string): string {
	let stem = title
		.normalize("NFC")
		.replace(/[^\p{L}\p{N}]+/gu, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
	if (stem.length > PLAN_SAVE_STEM_MAX_LENGTH) {
		const cut = stem.lastIndexOf("_", PLAN_SAVE_STEM_MAX_LENGTH);
		stem = cut > 0 ? stem.slice(0, cut) : stem.slice(0, PLAN_SAVE_STEM_MAX_LENGTH);
	}
	if (!stem || stem === "PLAN") return "PLAN.md";
	return `${stem.endsWith("_PLAN") ? stem : `${stem}_PLAN`}.md`;
}
