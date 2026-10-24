import { describe, expect, it, vi } from "bun:test";
import { applyRpcSwitchLeaf } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-extra";
import { type AgentSession, SessionBusyError } from "@oh-my-pi/pi-coding-agent/session/agent-session";

describe("RPC switch_leaf during manual maintenance", () => {
	// Compaction and handoff run beside the serial queue; the leaf must not move under them.
	for (const busy of [{ isCompacting: true }, { isGeneratingHandoff: true }]) {
		it(`refuses without moving the leaf while ${Object.keys(busy)[0]}`, async () => {
			const navigateTree = vi.fn(async () => ({ cancelled: false }));
			const session = {
				isCompacting: false,
				isGeneratingHandoff: false,
				...busy,
				navigateTree,
			} as unknown as AgentSession;

			await expect(applyRpcSwitchLeaf(session, { entryId: "entry-1" })).rejects.toBeInstanceOf(SessionBusyError);
			expect(navigateTree).not.toHaveBeenCalled();
		});
	}
});
