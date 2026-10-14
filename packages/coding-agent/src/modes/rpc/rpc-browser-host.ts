/**
 * Browser panel for RPC hosts (the GUI).
 *
 * The process serves a private browser relay (`tools/browser/relay`) that the
 * host dials as the relay's extension, exposing its own web views as tabs. The
 * browser tool then opens pages there instead of launching Chromium (see
 * `resolveHostedRelayKind`), so the user watches the agent browse and can take
 * over. Loopback only, with a secret on each leg: the extension leg needs
 * `?token=`, and every CDP path carries a secret first segment, so other local
 * processes cannot drive pages the user may be signed in to.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { setHostedRelay } from "../../tools/browser/relay/kind";
import { type RelayServer, startRelayServer } from "../../tools/browser/relay/server";

/** `browser_host_start` result. */
export interface RpcBrowserHostInfo {
	/** Websocket URL the host dials as the relay extension (carries its token). */
	extensionUrl: string;
}

function secret(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

export class RpcBrowserHost {
	#server: RelayServer | undefined;
	#info: RpcBrowserHostInfo | undefined;

	/** Start the relay once and route browser opens to it; later calls return the same endpoint. */
	start(): RpcBrowserHostInfo {
		if (this.#server && this.#info) return this.#info;
		const token = secret();
		const cdpToken = secret();
		const server = startRelayServer({
			port: 0,
			token,
			cdpToken,
			// The host has no tab groups: it reads `group`/`ungroup` as "the agent
			// drives this page" (a page it created or adopted) and marks it so.
			group: true,
			log: (message, data) => logger.debug(`browser host: ${message}`, data),
		});
		this.#server = server;
		this.#info = { extensionUrl: `ws://127.0.0.1:${server.port}/ext?token=${token}` };
		setHostedRelay(`http://127.0.0.1:${server.port}/${cdpToken}`);
		return this.#info;
	}

	/** Stop serving; browser opens fall back to their usual browser. */
	stop(): void {
		if (!this.#server) return;
		setHostedRelay(null);
		this.#server.stop();
		this.#server = undefined;
		this.#info = undefined;
	}
}
