/**
 * Live dictation for RPC mode: drives the same {@link STTController} the TUI uses, with the
 * host supplying the microphone (`dictation_audio`) and the text box (`dictation_text` frames).
 * Streaming local models show words while the user speaks; cloud models transcribe on stop.
 */
import type { AgentSession } from "../../session/agent-session";
import { sttClient } from "../../stt/asr-client";
import type { SttProgressEvent } from "../../stt/asr-protocol";
import { getSttModelSpec } from "../../stt/models";
import { cfgSttEnabled } from "../../stt/settings";
import {
	type SttCallbacks,
	STTController,
	type STTControllerDependencies,
	type SttTarget,
} from "../../stt/stt-controller";
import type { RpcDictationFrame, RpcDictationState } from "./rpc-types";

/** Microphone sink the controller opens once recording begins. */
type AudioSink = (error: Error | null, samples: Float32Array) => void;

/** The controller surface the RPC bridge drives. */
export type RpcDictationController = Pick<STTController, "start" | "stop" | "dispose" | "state">;

/** Builds the controller over a host-fed capture; tests substitute a fake. */
export type RpcDictationControllerFactory = (
	createCapture: (onAudio: AudioSink) => { stop(): void },
	dependencies: STTControllerDependencies,
) => RpcDictationController;

/** Subscribes to speech-model download progress; returns the unsubscribe. */
export type RpcDictationProgressSource = (listener: (event: SttProgressEvent) => void) => () => void;

/** Decodes a `dictation_audio` payload: base64 little-endian PCM16 mono at 16 kHz. */
export function decodeDictationAudio(pcm16Base64: string): Float32Array {
	const bytes = Buffer.from(pcm16Base64, "base64");
	const count = bytes.length >> 1;
	const samples = new Float32Array(count);
	for (let i = 0; i < count; i++) samples[i] = bytes.readInt16LE(i * 2) / 0x8000;
	return samples;
}

/** Owns at most one dictation capture for an RPC server. */
export class RpcDictationBridge {
	readonly #session: AgentSession;
	readonly #output: (frame: RpcDictationFrame) => void;
	readonly #createController: RpcDictationControllerFactory;
	readonly #onProgress: RpcDictationProgressSource;
	readonly #isBlocked: () => string | undefined;

	#controller: RpcDictationController | undefined;
	/** Bumped by {@link cancel}, so a discarded controller's late callbacks reach no one. */
	#generation = 0;
	#state: RpcDictationState = "idle";
	#sink: AudioSink | undefined;

	constructor(
		session: AgentSession,
		output: (frame: RpcDictationFrame) => void,
		options: {
			/** A reason dictation cannot start right now (e.g. a live voice session owns the mic). */
			isBlocked?: () => string | undefined;
			createController?: RpcDictationControllerFactory;
			onProgress?: RpcDictationProgressSource;
		} = {},
	) {
		this.#session = session;
		this.#output = output;
		this.#isBlocked = options.isBlocked ?? (() => undefined);
		this.#createController =
			options.createController ?? ((capture, dependencies) => new STTController(capture, dependencies));
		this.#onProgress = options.onProgress ?? (listener => sttClient.onProgress(listener));
	}

	get state(): RpcDictationState {
		return this.#state;
	}

	/**
	 * Prepare the dictation model, then record from `dictation_audio`. Resolves with the state the
	 * start settled in: `recording`, or `idle` when it was cancelled or failed (a notice says why).
	 */
	async start(): Promise<{ state: RpcDictationState }> {
		if (this.#state !== "idle") return { state: this.#state };
		if (!cfgSttEnabled.get(this.#session.settings)) {
			throw new Error("Speech-to-text is disabled. Enable it in settings: stt.enabled");
		}
		const blocked = this.#isBlocked();
		if (blocked) throw new Error(blocked);

		const generation = this.#generation;
		const controller = this.#ensureController();
		this.#setState("preparing", generation);
		const unsubscribe = this.#watchDownload(generation);
		try {
			await controller.start(this.#target(generation), this.#callbacks(generation));
		} finally {
			unsubscribe();
		}
		// A start that never reached the microphone settles back to idle.
		if (generation === this.#generation && this.state === "preparing") this.#setState("idle", generation);
		return { state: this.#state };
	}

	/** Feed microphone audio; dropped unless recording. */
	pushAudio(pcm16Base64: string): void {
		const sink = this.#sink;
		if (!sink || this.#state !== "recording") return;
		const samples = decodeDictationAudio(pcm16Base64);
		if (samples.length > 0) sink(null, samples);
	}

	/** Stop recording and transcribe what was heard; a start still preparing is cancelled instead. */
	async stop(): Promise<void> {
		await this.#controller?.stop();
	}

	/** End the capture now, discarding anything not yet committed. */
	cancel(): void {
		const controller = this.#controller;
		if (!controller) return;
		const wasActive = this.#state !== "idle";
		this.#generation += 1;
		this.#controller = undefined;
		this.#sink = undefined;
		controller.dispose();
		if (wasActive) {
			this.#output({ type: "dictation_text", op: "clear" });
			this.#state = "idle";
			this.#output({ type: "dictation_state", state: "idle" });
		}
	}

	#ensureController(): RpcDictationController {
		if (this.#controller) return this.#controller;
		const generation = this.#generation;
		const controller = this.#createController(
			onAudio => {
				if (generation === this.#generation) this.#sink = onAudio;
				return {
					stop: () => {
						if (this.#sink === onAudio) this.#sink = undefined;
					},
				};
			},
			{
				settings: this.#session.settings,
				registry: this.#session.modelRegistry,
				getSessionId: () => this.#session.sessionId,
			},
		);
		this.#controller = controller;
		return controller;
	}

	#setState(state: RpcDictationState, generation: number): void {
		if (generation !== this.#generation || state === this.#state) return;
		this.#state = state;
		this.#output({ type: "dictation_state", state });
	}

	#target(generation: number): SttTarget {
		const emit = (frame: RpcDictationFrame) => {
			if (generation === this.#generation) this.#output(frame);
		};
		return {
			setVolatileText: text => emit({ type: "dictation_text", op: "volatile", text }),
			clearVolatileText: () => emit({ type: "dictation_text", op: "clear" }),
			commitVolatileText: text => emit({ type: "dictation_text", op: "commit", text }),
			deleteBeforeCursor: count => emit({ type: "dictation_text", op: "trim", count }),
			submit: () => emit({ type: "dictation_text", op: "submit" }),
		};
	}

	#callbacks(generation: number): SttCallbacks {
		const notice = (level: "warning" | "status", message: string) => {
			if (generation === this.#generation && message) this.#output({ type: "dictation_notice", level, message });
		};
		return {
			showWarning: message => notice("warning", message),
			showStatus: message => notice("status", message),
			onStateChange: state => this.#setState(state, generation),
		};
	}

	/** Report real download progress while the model is being fetched before recording. */
	#watchDownload(generation: number): () => void {
		const files = new Map<string, { loaded: number; total: number }>();
		let lastPercent = -1;
		return this.#onProgress(event => {
			if (generation !== this.#generation || this.#state !== "preparing") return;
			if (event.status !== "progress" && event.status !== "progress_total") return;
			if (!event.file || typeof event.loaded !== "number" || typeof event.total !== "number" || event.total <= 0)
				return;
			files.set(event.file, { loaded: event.loaded, total: event.total });
			let loaded = 0;
			let total = 0;
			for (const file of files.values()) {
				loaded += file.loaded;
				total += file.total;
			}
			// Files report as they start, so the aggregate can dip; the host's bar only moves forward.
			const percent = Math.min(100, Math.floor((loaded / total) * 100));
			if (percent <= lastPercent) return;
			lastPercent = percent;
			const label = getSttModelSpec(event.modelKey)?.label ?? event.modelKey;
			this.#output({ type: "dictation_download", label, percent });
		});
	}
}
