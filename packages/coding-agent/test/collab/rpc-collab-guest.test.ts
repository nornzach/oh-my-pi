/**
 * Contract: an RPC host can join a collab room and mirror it to its client.
 *
 * `RpcCollabController` builds its own stand-in for the TUI context, cast past
 * the compiler, so what `CollabGuestLink` calls on it is only checked by running
 * it. A member the guest starts using that the stand-in lacks fails the join.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsp from "node:fs/promises";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { COLLAB_PROTO, type CollabFrame, formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcCollabController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-collab";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

function makeSession(): AgentSession {
	return {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
		},
		messages: [],
		switchSession: () => Promise.resolve(),
		newSession: () => Promise.resolve(),
		getContextBreakdown: () => undefined,
		agent: {
			state: { model: undefined },
			setModel: () => {},
			setThinkingLevel: () => {},
			setDisableReasoning: () => {},
		},
	} as unknown as AgentSession;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

describe("RpcCollabController as a guest", () => {
	it("joins a room, forwards the host's events to its client, and leaves", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const roomId = "rpc-guest-room-1";
		const roomKey = generateRoomKey();
		const hostSocket = new CollabSocket({
			wsUrl: `ws://localhost:8788/r/${roomId}`,
			role: "host",
			key: await importRoomKey(roomKey),
		});
		const hostOpen = Promise.withResolvers<void>();
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t !== "hello") return;
			hostSocket.send({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-11-06T00:00:00Z", cwd: "/tmp" },
				state: {
					isStreaming: false,
					queuedMessageCount: 0,
					sessionName: "host session",
					cwd: "/tmp",
					participants: [{ name: "Host", role: "host" }],
				},
				agents: [],
				entryCount: 0,
			} as CollabFrame);
		};
		hostSocket.connect();
		await hostOpen.promise;

		const sent: { type?: string }[] = [];
		const forwarded = Promise.withResolvers<void>();
		const controller = new RpcCollabController({
			session: makeSession(),
			output: event => {
				sent.push(event as { type?: string });
				if ((event as { type?: string }).type === "agent_start") forwarded.resolve();
			},
			notify: () => {},
			select: () => Promise.resolve(undefined),
			edit: () => Promise.resolve(undefined),
		});

		try {
			const joined = await controller.join(formatCollabLink("ws://localhost:8788", roomId, roomKey));
			expect(joined.role).toBe("guest");
			expect(controller.isGuest).toBe(true);

			hostSocket.send({ t: "event", event: { type: "agent_start" } } as CollabFrame);
			await forwarded.promise;
			expect(sent.map(event => event.type)).toContain("agent_start");

			const left = await controller.leave();
			expect(left.role).toBeNull();
			expect(controller.isGuest).toBe(false);
		} finally {
			hostSocket.close();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
		}
	});
});
