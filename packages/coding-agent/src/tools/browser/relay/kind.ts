/**
 * Browser relay mode: drive the user's own Chrome tabs through the local CDP
 * relay served by `omp browser-relay` (sibling `server.ts`/`bridge.ts`) plus
 * its companion extension (`packages/browser-relay`, installed via
 * `omp browser-relay install`). The relay impersonates Chrome's CDP discovery
 * endpoint, so beyond kind resolution the entire connected-browser machinery
 * (registry, tab supervisor, tab workers) applies unchanged.
 */
import { parseFlag } from "@oh-my-pi/pi-utils";

/** Browser kind selecting the omp browser relay. */
export interface RelayKind {
	kind: "relay";
	cdpUrl: string;
	/**
	 * Served by this process for its RPC host's browser panel (the GUI), which
	 * dials in as the relay's extension: never daemon-managed, and opens get
	 * their own panel page instead of adopting one.
	 */
	hosted?: true;
}

/** The relay this process serves for its RPC host (see `modes/rpc/rpc-browser-host.ts`). */
let hostedRelayUrl: string | null = null;

/** Route opens without an explicit browser choice to the host's panel; `null` stops. */
export function setHostedRelay(cdpUrl: string | null): void {
	hostedRelayUrl = cdpUrl;
}

/** The host panel's relay kind, or null when no RPC host serves one. */
export function resolveHostedRelayKind(): RelayKind | null {
	return hostedRelayUrl === null ? null : { kind: "relay", cdpUrl: hostedRelayUrl, hosted: true };
}

/** Default endpoint of the `omp-browser-relay` CLI. */
export const DEFAULT_RELAY_URL = "http://127.0.0.1:9224";

export interface ResolveRelayKindOptions {
	/** `browser.relay` setting; `PI_BROWSER_RELAY=0|1` overrides it. */
	settingEnabled?: boolean;
	/** `browser.relayUrl` setting; falls back to {@link DEFAULT_RELAY_URL}. */
	url?: string;
}

/**
 * Resolve the relay browser kind, or null when relay mode is disabled.
 * Mirrors `resolveCmuxKind`: the setting opts in, the env var is the final
 * override in both directions.
 */
export function resolveRelayKind(
	options?: ResolveRelayKindOptions | null,
	env: Record<string, string | undefined> = process.env,
): RelayKind | null {
	if (!parseFlag(env.PI_BROWSER_RELAY, options?.settingEnabled ?? false)) {
		return null;
	}
	const url = options?.url?.trim() || DEFAULT_RELAY_URL;
	return { kind: "relay", cdpUrl: url.replace(/\/+$/, "") };
}
