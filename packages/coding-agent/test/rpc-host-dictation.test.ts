import { afterEach, describe, expect, test, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcHostDictationBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-host-dictation";
import type { RpcHostDictationFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as asrClient from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import type { SttProgressEvent } from "@oh-my-pi/pi-coding-agent/stt/asr-protocol";
import * as downloader from "@oh-my-pi/pi-coding-agent/stt/downloader";
import type { STTControllerDependencies } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";

const STREAMING = getBundledModel("local", "nemotron-streaming-en-0.6b");
const registry: STTControllerDependencies["registry"] = {
	getError: () => undefined,
	getAvailable: () => [STREAMING],
	getAll: () => [STREAMING],
	resolver: () => () => "test-key",
};

/** PCM16 little-endian, base64 — the `host_dictation_audio` payload. */
function pcm16Base64(values: number[]): string {
	const bytes = Buffer.alloc(values.length * 2);
	values.forEach((value, i) => bytes.writeInt16LE(value, i * 2));
	return bytes.toString("base64");
}

/** A speech stream whose callbacks the test drives. */
function fakeStream() {
	const pushed: Float32Array[] = [];
	const finished = Promise.withResolvers<string>();
	let callbacks: asrClient.SttStreamOptions | undefined;
	const startStream = vi.spyOn(asrClient.sttClient, "startStream").mockImplementation((_key, options) => {
		callbacks = options;
		return {
			pushAudio: audio => pushed.push(audio),
			stop: () => finished.promise,
			cancel: () => finished.resolve(""),
		};
	});
	return {
		startStream,
		pushed,
		finish: (text: string) => finished.resolve(text),
		partial: (text: string) => callbacks?.onPartial?.(text),
		segment: (text: string) => callbacks?.onSegment?.(text, 0),
	};
}

function harness(values: Record<string, unknown> = {}, isBlocked?: () => string | undefined) {
	const settings = Settings.isolated({ "stt.enabled": true, ...values });
	settings.setModelRole("dictation", "local/nemotron-streaming-en-0.6b");
	const session = { settings, modelRegistry: registry, sessionId: "session-1" } as unknown as AgentSession;
	const frames: RpcHostDictationFrame[] = [];
	let progress: ((event: SttProgressEvent) => void) | undefined;
	const bridge = new RpcHostDictationBridge(session, frame => frames.push(frame), {
		isBlocked,
		onProgress: listener => {
			progress = listener;
			return () => {
				progress = undefined;
			};
		},
	});
	return { bridge, frames, progress: (event: SttProgressEvent) => progress?.(event) };
}

const states = (frames: RpcHostDictationFrame[]) =>
	frames.flatMap(frame => (frame.type === "host_dictation_state" ? [frame.state] : []));

describe("RpcHostDictationBridge", () => {
	let active: RpcHostDictationBridge | undefined;
	afterEach(() => {
		active?.cancel();
		active = undefined;
		vi.restoreAllMocks();
	});

	test("host audio is transcribed live into text edits, then finished on stop", async () => {
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue();
		const stream = fakeStream();
		const { bridge, frames } = harness();
		active = bridge;

		expect(await bridge.start()).toEqual({ state: "recording" });
		bridge.pushAudio(pcm16Base64([0, 16384, -32768]));
		expect(Array.from(stream.pushed[0]!)).toEqual([0, 0.5, -1]);

		stream.partial("hello wor");
		stream.segment("hello world");
		stream.partial("again");
		const stopping = bridge.stop();
		stream.finish("hello world again");
		await stopping;

		expect(states(frames)).toEqual(["preparing", "recording", "transcribing", "idle"]);
		expect(frames.filter(frame => frame.type === "host_dictation_text")).toEqual([
			{ type: "host_dictation_text", op: "volatile", text: "hello wor" },
			{ type: "host_dictation_text", op: "commit", text: "hello world" },
			{ type: "host_dictation_text", op: "volatile", text: " again" },
			// The stream already committed its words, so stop only drops the unfinished ones.
			{ type: "host_dictation_text", op: "clear" },
		]);
		// Audio after the capture ended reaches no stream.
		bridge.pushAudio(pcm16Base64([1, 2]));
		expect(stream.pushed).toHaveLength(1);
	});

	test("a spoken submit command trims itself and submits, per stt.submitTrigger", async () => {
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue();
		const stream = fakeStream();
		const { bridge, frames } = harness({ "stt.submitTrigger": "say-submit" });
		active = bridge;

		await bridge.start();
		stream.segment("ship it submit");
		const stopping = bridge.stop();
		stream.finish("ship it submit");
		await stopping;

		const edits = frames.filter(frame => frame.type === "host_dictation_text").map(frame => frame.op);
		expect(edits).toEqual(["commit", "clear", "trim", "submit"]);
		expect(frames).toContainEqual({ type: "host_dictation_text", op: "trim", count: " submit".length });
	});

	test("while preparing: reports download progress, ignores audio, and stop cancels without a warning", async () => {
		const loading = Promise.withResolvers<void>();
		vi.spyOn(downloader, "downloadSttModel").mockImplementation((_key, _progress, options) => {
			options?.signal?.addEventListener("abort", () => loading.reject(new Error("aborted")));
			return loading.promise;
		});
		const stream = fakeStream();
		const { bridge, frames, progress } = harness();
		active = bridge;

		const starting = bridge.start();
		await Bun.sleep(0);
		bridge.pushAudio(pcm16Base64([100]));
		const file = (name: string, loaded: number) =>
			progress({
				modelKey: "nemotron-streaming-en-0.6b",
				status: "progress",
				file: name,
				loaded,
				total: 100,
			});
		file("encoder.int8.onnx", 50);
		file("decoder.int8.onnx", 0); // A second file starting never moves the bar back.
		file("decoder.int8.onnx", 0.4);
		file("decoder.int8.onnx", 100);
		await bridge.stop();
		expect(await starting).toEqual({ state: "idle" });

		expect(states(frames)).toEqual(["preparing", "idle"]);
		expect(frames.flatMap(frame => (frame.type === "host_dictation_download" ? [frame.percent] : []))).toEqual([
			50, 75,
		]);
		expect(frames.some(frame => frame.type === "host_dictation_notice")).toBe(false);
		expect(stream.startStream).not.toHaveBeenCalled();
	});

	test("cancel discards the capture at once and a later start works", async () => {
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue();
		const stream = fakeStream();
		const { bridge, frames } = harness();
		active = bridge;

		await bridge.start();
		stream.partial("never mind");
		bridge.cancel();
		expect(states(frames)).toEqual(["preparing", "recording", "idle"]);
		expect(frames.at(-2)).toEqual({ type: "host_dictation_text", op: "clear" });

		// The discarded stream's late words go nowhere.
		const settled = frames.length;
		stream.segment("never mind");
		expect(frames).toHaveLength(settled);

		expect(await bridge.start()).toEqual({ state: "recording" });
	});

	test("refuses to start while speech input is off or the microphone is taken", async () => {
		await expect(harness({ "stt.enabled": false }).bridge.start()).rejects.toThrow("stt.enabled");
		const blocked = harness({}, () => "End live mode before dictating.");
		await expect(blocked.bridge.start()).rejects.toThrow("End live mode");
		expect(blocked.frames).toEqual([]);
	});
});
