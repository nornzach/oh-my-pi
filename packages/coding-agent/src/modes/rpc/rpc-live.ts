import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { LiveSessionController, type LiveTranscript } from "../../live/controller";
import type { AgentSession } from "../../session/agent-session";
import type { RpcLiveState, RpcLiveUpdateFrame } from "./rpc-types";

type RpcLiveOutput = (frame: RpcLiveUpdateFrame) => void;

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("");
}

/** Owns the one realtime voice call available to an RPC-attached session. */
export class RpcLiveController {
	readonly #session: AgentSession;
	readonly #output: RpcLiveOutput;
	#controller: LiveSessionController | undefined;
	#state: RpcLiveState = {
		active: false,
		phase: "connecting",
		muted: false,
		inputLevel: 0,
		outputLevel: 0,
	};

	constructor(session: AgentSession, output: RpcLiveOutput) {
		this.#session = session;
		this.#output = output;
	}

	get state(): RpcLiveState {
		return this.#state;
	}

	async start(voice?: string): Promise<RpcLiveState> {
		if (this.#controller) return this.#state;
		let controller: LiveSessionController;
		controller = new LiveSessionController({
			session: this.#session,
			extractAssistantText: assistantText,
			voice,
			callbacks: {
				onPhase: phase => this.#update({ active: true, phase }),
				onLevels: (inputLevel, outputLevel) => this.#update({ inputLevel, outputLevel }),
				onTranscript: transcript => this.#update({ transcript }),
				onTerminal: error => {
					if (this.#controller !== controller) return;
					this.#controller = undefined;
					this.#update({
						active: false,
						phase: error ? "error" : this.#state.phase,
						inputLevel: 0,
						outputLevel: 0,
						error: error?.message,
					});
				},
			},
		});
		this.#controller = controller;
		this.#update({ active: true, phase: "connecting", error: undefined, transcript: undefined });
		try {
			await controller.start();
		} catch (cause) {
			if (this.#controller === controller) this.#controller = undefined;
			const error = cause instanceof Error ? cause.message : String(cause);
			this.#update({ active: false, phase: "error", error, inputLevel: 0, outputLevel: 0 });
			throw cause;
		}
		return this.#state;
	}

	toggleMute(): RpcLiveState {
		const controller = this.#controller;
		if (!controller) throw new Error("No live voice session is active");
		controller.toggleMute();
		this.#update({ muted: controller.muted });
		return this.#state;
	}

	async stop(): Promise<RpcLiveState> {
		const controller = this.#controller;
		if (!controller) return this.#state;
		this.#controller = undefined;
		await controller.stop();
		this.#update({ active: false, muted: false, inputLevel: 0, outputLevel: 0, transcript: undefined });
		return this.#state;
	}

	async dispose(): Promise<void> {
		await this.stop();
	}

	#update(patch: Partial<RpcLiveState> & { transcript?: LiveTranscript | undefined }): void {
		this.#state = { ...this.#state, ...patch };
		this.#output({ type: "live_update", state: this.#state });
	}
}
