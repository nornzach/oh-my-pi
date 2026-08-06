/**
 * `write_local_paste` RPC action: persist a large paste into the session's
 * local:// store, mirroring the TUI's #attachPasteAsFile
 * (input-controller.ts:1751-1776).
 *
 * The paste-N.md name is claimed with an exclusive create. Allocation is
 * therefore safe across separate GUI sidecar processes attached to one
 * session, not merely across sequential calls in one process.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEexist } from "@oh-my-pi/pi-utils";
import { resolveLocalRoot } from "../../internal-urls/local-protocol";
import type { AgentSession } from "../../session/agent-session";

export interface RpcWriteLocalPasteResult {
	/** File name inside the local store, e.g. "paste-3.md". */
	name: string;
	/** URI to hand to the composer / read tool, e.g. "local://paste-3.md". */
	url: string;
}

export async function applyRpcWriteLocalPaste(
	session: AgentSession,
	content: string,
): Promise<RpcWriteLocalPasteResult> {
	const sessionManager = session.sessionManager;
	// Mirror the exact mapping the read tool's local:// resolver uses.
	const localRoot = resolveLocalRoot({
		getArtifactsDir: () => sessionManager.getArtifactsDir(),
		getSessionId: () => sessionManager.getSessionId(),
	});
	await fs.mkdir(localRoot, { recursive: true });
	for (let counter = 1; ; counter++) {
		const name = `paste-${counter}.md`;
		const filePath = path.join(localRoot, name);
		try {
			await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
			return { name, url: `local://${name}` };
		} catch (error) {
			if (!isEexist(error)) throw error;
		}
	}
}
