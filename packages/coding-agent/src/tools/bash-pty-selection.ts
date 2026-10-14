import { $env } from "@oh-my-pi/pi-utils/env";

/** Minimal UI-capability fields needed to decide whether bash can run on an interactive PTY. */
export interface BashPtyContext {
	hasUI?: boolean;
	ui?: { supportsCustom?: boolean; interactiveTerminal?: unknown };
}

/** Return whether a bash tool call should run on an interactive PTY (TUI overlay or host terminal). */
export function canUseInteractiveBashPty(pty: boolean, ctx: BashPtyContext | undefined): boolean {
	if (!pty || ctx?.hasUI !== true) return false;
	// RPC and ACP hosts report a UI but cannot render the overlay (their
	// custom() resolves without running the command). An RPC host with its own
	// terminal (the GUI) opted in explicitly, so it holds even under the
	// PI_NO_PTY that rpc-ui mode sets for the overlay and executor PTYs.
	if (ctx.ui?.supportsCustom !== true) return ctx.ui?.interactiveTerminal !== undefined;
	return $env.PI_NO_PTY !== "1";
}
