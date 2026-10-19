/**
 * Renders TUI components for an RPC host in its own terminal view. A host that
 * opted into interactive terminals (`terminal_configure`) gets a virtual
 * terminal per component: a {@link TUI} paints into it, and the host's
 * keystrokes and size flow back. This is what lets `ui.custom()` extension UIs
 * and fullscreen TUI overlays work in the GUI instead of resolving empty.
 */
import { type Component, type OverlayHandle, type Terminal, TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { TerminalAppearance, TerminalAppearanceRequestToken } from "@oh-my-pi/pi-tui/terminal";
import { type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import type { ExtensionCustomOptions } from "../../extensibility/extensions/types";
import type { RpcTerminalHost, VirtualTerminalHandle } from "./rpc-terminal";

/** {@link Terminal} over a host terminal view: writes become terminal output, host input drives the TUI. */
class HostedTerminal implements Terminal {
	#handle: VirtualTerminalHandle | undefined;
	#onInput: ((data: string) => void) | undefined;
	#onResize: (() => void) | undefined;

	attach(handle: VirtualTerminalHandle): void {
		this.#handle = handle;
	}

	input(data: string): void {
		this.#onInput?.(data);
	}

	resized(): void {
		this.#onResize?.();
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#onInput = onInput;
		this.#onResize = onResize;
	}
	stop(): void {
		this.#onInput = undefined;
		this.#onResize = undefined;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.#handle?.write(data);
	}
	get columns(): number {
		return this.#handle?.cols ?? 100;
	}
	get rows(): number {
		return this.#handle?.rows ?? 30;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): string | null {
		return null;
	}
	moveBy(lines: number): void {
		if (lines > 0) this.write(`\x1b[${lines}B`);
		else if (lines < 0) this.write(`\x1b[${-lines}A`);
	}
	hideCursor(): void {
		this.write("\x1b[?25l");
	}
	showCursor(): void {
		this.write("\x1b[?25h");
	}
	clearLine(): void {
		this.write("\x1b[K");
	}
	clearFromCursor(): void {
		this.write("\x1b[J");
	}
	clearScreen(): void {
		this.write("\x1b[H\x1b[0J");
	}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
	refreshAppearance(_requestToken?: TerminalAppearanceRequestToken): void {}
	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}
}

export type HostedComponentFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;

/**
 * Show `factory`'s component in a new host terminal until it calls `done`.
 * Closing the terminal resolves `undefined`, the cancel every TUI picker reports.
 */
export function showHostedComponent<T>(
	host: RpcTerminalHost,
	title: string,
	factory: HostedComponentFactory<T>,
	options?: ExtensionCustomOptions,
): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	if (options?.signal?.aborted) {
		reject(options.signal.reason ?? new DOMException("Dialog aborted", "AbortError"));
		return promise;
	}
	const terminal = new HostedTerminal();
	const ui = new TUI(terminal);
	let component: (Component & { dispose?(): void }) | undefined;
	let overlayHandle: OverlayHandle | undefined;
	let closed = false;
	const finish = (settle: () => void) => {
		if (closed) return;
		closed = true;
		options?.signal?.removeEventListener("abort", onAbort);
		try {
			component?.dispose?.();
			overlayHandle?.hide();
			ui.stop();
		} finally {
			handle.finish();
			settle();
		}
	};
	const onAbort = () =>
		finish(() => reject(options?.signal?.reason ?? new DOMException("Dialog aborted", "AbortError")));
	const handle = host.openVirtual(title, {
		onInput: data => terminal.input(data),
		onResize: () => terminal.resized(),
		onClose: () => finish(() => resolve(undefined as T)),
	});
	terminal.attach(handle);
	options?.signal?.addEventListener("abort", onAbort, { once: true });
	ui.start();
	Promise.try(() => factory(ui, theme, KeybindingsManager.inMemory(), result => finish(() => resolve(result))))
		.then(created => {
			if (closed) {
				created.dispose?.();
				return;
			}
			component = created;
			if (options?.overlay) {
				const overlayOptions =
					typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
				overlayHandle = ui.showOverlay(
					created,
					overlayOptions ?? { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0 },
				);
				options.onHandle?.(overlayHandle);
			} else {
				ui.addChild(created);
				ui.setFocus(created);
			}
			ui.requestRender();
		})
		.catch((error: unknown) => finish(() => reject(error)));
	return promise;
}
