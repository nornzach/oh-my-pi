import { prompt } from "@oh-my-pi/pi-utils";
import type { EvalPreludeDefinition } from "../../eval/preludes";
import browserDescription from "../../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../../sdk";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import browserJavascript from "./prelude.js" with { type: "text" };
import browserPython from "./prelude.py" with { type: "text" };

import { resolveHostedRelayKind } from "./relay/kind";
import { cfgBrowserEnabled } from "./settings";

/** Build the browser eval facade after an eval runtime first requests preludes. */
export function createBrowserPreludeDefinition(
	session: ToolSession,
	host: Pick<EvalPreludeDefinition, "invoke" | "status">,
): EvalPreludeDefinition {
	return {
		name: "browser",
		// Rendered on each read: the omp app's browser panel starts after the
		// session does, and `xd://eval/browser` follows the live prelude set.
		// The first line (the advertised summary) never changes.
		get documentation() {
			return prompt.render(browserDescription, { panel: resolveHostedRelayKind() !== null });
		},
		javascript: browserJavascript,
		python: browserPython,
		exports: ["browser"],
		approval: "exec",
		enabled: () => cfgBrowserEnabled.get(session.settings),
		invoke: host.invoke,
		status: host.status,
	};
}
