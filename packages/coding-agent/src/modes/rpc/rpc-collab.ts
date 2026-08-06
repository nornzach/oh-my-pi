import type { ImageContent } from "@oh-my-pi/pi-ai";
import { CollabGuestLink } from "../../collab/guest";
import { CollabHost } from "../../collab/host";
import type { ExtensionUIDialogOptions, ExtensionUISelectItem } from "../../extensibility/extensions";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { EventBus } from "../../utils/event-bus";
import type { InteractiveModeContext } from "../types";
import type { RpcCollabState } from "./rpc-types";

interface RpcCollabControllerOptions {
	session: AgentSession;
	eventBus?: EventBus;
	output(event: AgentSessionEvent | object): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	select(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined>;
	edit(title: string, prefill?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined>;
}

interface CollabStatusSegment {
	role: "host" | "guest";
	participantCount: number;
}

function normalizeRelayUrl(value: string): string {
	return value.includes("://") ? value : `wss://${value}`;
}

/** Adapts the collab transport's TUI context seam to RPC events and dialogs. */
export class RpcCollabController {
	readonly #options: RpcCollabControllerOptions;
	readonly #ctx: InteractiveModeContext;
	#host: CollabHost | undefined;
	#guest: CollabGuestLink | undefined;

	constructor(options: RpcCollabControllerOptions) {
		this.#options = options;
		this.#ctx = this.#buildContext();
	}

	get isGuest(): boolean {
		return this.#guest !== undefined;
	}

	get state(): RpcCollabState {
		const host = this.#host;
		if (host) {
			return {
				role: "host",
				readOnly: false,
				link: host.link,
				viewLink: host.viewLink,
				webLink: host.webLink,
				webViewLink: host.webViewLink,
				participants: host.participants,
			};
		}
		const guest = this.#guest;
		if (guest) {
			return {
				role: "guest",
				readOnly: guest.readOnly,
				participants: guest.state?.participants ?? [],
			};
		}
		return { role: null, readOnly: false, participants: [] };
	}

	async start(relayUrl?: string): Promise<RpcCollabState> {
		if (this.#guest) throw new Error("Leave the current collab session before hosting");
		if (this.#host) return this.state;
		const configured = relayUrl?.trim() || this.#options.session.settings.get("collab.relayUrl") || "";
		if (!configured) throw new Error("No relay configured. Set collab.relayUrl or provide a relay URL.");
		const host = new CollabHost(this.#ctx);
		await host.start(normalizeRelayUrl(configured), this.#options.session.settings.get("collab.webUrl") || "");
		this.#host = host;
		this.#ctx.collabHost = host;
		return this.state;
	}

	async join(link: string): Promise<RpcCollabState> {
		if (this.#host) throw new Error("Stop hosting before joining another collab session");
		if (this.#guest) return this.state;
		const trimmed = link.trim();
		if (!trimmed) throw new Error("A collab link is required");
		const guest = new CollabGuestLink(this.#ctx);
		await guest.join(trimmed);
		this.#guest = guest;
		return this.state;
	}

	async leave(): Promise<RpcCollabState> {
		const guest = this.#guest;
		if (guest) {
			this.#guest = undefined;
			await guest.leave("left");
		}
		const host = this.#host;
		if (host) {
			this.#host = undefined;
			await host.stop("host stopped");
		}
		this.#ctx.collabGuest = undefined;
		this.#ctx.collabHost = undefined;
		return this.state;
	}

	sendPrompt(text: string, images?: ImageContent[]): boolean {
		if (!this.#guest) return false;
		this.#guest.sendPrompt(text, images);
		return true;
	}

	sendAbort(): boolean {
		if (!this.#guest) return false;
		this.#guest.sendAbort();
		return true;
	}

	abortRemoteAgent(agentId: string): boolean {
		if (!this.#guest) return false;
		this.#guest.hubRemote.kill(agentId);
		return true;
	}

	reviveRemoteAgent(agentId: string): boolean {
		if (!this.#guest) return false;
		this.#guest.hubRemote.revive(agentId);
		return true;
	}

	async dispose(): Promise<void> {
		await this.leave();
	}

	#buildContext(): InteractiveModeContext {
		const { session, eventBus } = this.#options;
		const clearable = { clear: () => {}, disposeChildren: () => {} };
		const context = {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			eventBus,
			collabHost: undefined,
			collabGuest: undefined,
			statusLine: {
				setCollabStatus: (_status: CollabStatusSegment | null) => {},
				getCachedContextBreakdown: () => session.getContextBreakdown() ?? {},
				invalidate: () => {},
				resetActiveTime: () => {},
				markActivityStart: () => {},
				markActivityEnd: () => {},
			},
			ui: {
				requestRender: () => {},
				requestComponentRender: () => {},
				setFocus: () => {},
			},
			chatContainer: clearable,
			pendingMessagesContainer: clearable,
			statusContainer: clearable,
			pendingTools: new Map(),
			compactionQueuedMessages: [],
			streamingComponent: undefined,
			streamingMessage: undefined,
			loadingAnimation: undefined,
			autoCompactionLoader: undefined,
			retryLoader: undefined,
			eventController: {
				handleEvent: async (event: AgentSessionEvent) => {
					this.#options.output(event);
				},
			},
			showStatus: (message: string) => this.#options.notify(message, "info"),
			showError: (message: string) => this.#options.notify(message, "error"),
			showHookSelector: (
				title: string,
				options: ExtensionUISelectItem[],
				dialogOptions?: ExtensionUIDialogOptions,
			) => this.#options.select(title, options, dialogOptions),
			showHookEditor: (title: string, prefill?: string, dialogOptions?: ExtensionUIDialogOptions) =>
				this.#options.edit(title, prefill, dialogOptions),
			ensureLoadingAnimation: () => {},
			updatePendingMessagesDisplay: () => {},
			syncRunningSubagentBadge: () => {},
			resetObserverRegistry: () => {},
			updateEditorBorderColor: () => {},
			renderInitialMessages: () => {},
			reloadTodos: async () => {},
			handleResumeSession: async (sessionFile: string) => {
				await session.switchSession(sessionFile);
			},
		} as unknown as InteractiveModeContext;
		return context;
	}
}
