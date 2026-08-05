const WAV_HEADER_BYTES = 44;
const PCM16_FORMAT = 1;
const BITS_PER_SAMPLE = 16;
const INT16_MAX = 32_767;
const INT16_MIN = -32_768;

/**
 * Assemble a mono PCM16 WAV byte buffer from Float32 PCM samples (the shape
 * transformers.js `RawAudio` emits: normalized [-1, 1] amplitudes plus a sample
 * rate). No external encoder is involved — we write a canonical 44-byte RIFF/
 * WAVE header followed by little-endian signed 16-bit samples. Samples are
 * clamped before quantization so out-of-range float values do not wrap.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
	const channels = 1;
	const byteRate = sampleRate * channels * (BITS_PER_SAMPLE / 8);
	const blockAlign = channels * (BITS_PER_SAMPLE / 8);
	const dataBytes = samples.length * (BITS_PER_SAMPLE / 8);
	const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
	const view = new DataView(buffer);

	// RIFF chunk descriptor
	writeAscii(view, 0, "RIFF");
	view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true); // file size minus the first 8 bytes
	writeAscii(view, 8, "WAVE");

	// fmt sub-chunk
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true); // PCM fmt chunk size
	view.setUint16(20, PCM16_FORMAT, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, BITS_PER_SAMPLE, true);

	// data sub-chunk
	writeAscii(view, 36, "data");
	view.setUint32(40, dataBytes, true);

	let offset = WAV_HEADER_BYTES;
	for (let i = 0; i < samples.length; i += 1) {
		const sample = samples[i]!;
		const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
		const quantized =
			clamped < 0
				? Math.max(INT16_MIN, Math.round(clamped * -INT16_MIN))
				: Math.min(INT16_MAX, Math.round(clamped * INT16_MAX));
		view.setInt16(offset, quantized, true);
		offset += 2;
	}

	return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
	for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Parse a canonical PCM WAV byte buffer back into Float32 samples (the inverse
 * of {@link encodeWav}, used by the RPC voice transport). Only the subset the
 * transport emits is accepted: RIFF/WAVE with a fixed 44-byte header, PCM
 * (format 1), mono, 16-bit samples. Throws on any deviation so callers can
 * surface a wire-format error instead of transcribing garbage.
 */
export function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
	if (bytes.length < WAV_HEADER_BYTES) throw new Error("WAV buffer too short for a 44-byte header");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") throw new Error("Not a RIFF/WAVE buffer");
	if (readAscii(view, 12, 4) !== "fmt " || readAscii(view, 36, 4) !== "data")
		throw new Error("WAV buffer is not in canonical fmt+data layout");
	const format = view.getUint16(20, true);
	const channels = view.getUint16(22, true);
	const sampleRate = view.getUint32(24, true);
	const bitsPerSample = view.getUint16(34, true);
	if (format !== PCM16_FORMAT) throw new Error(`Unsupported WAV encoding: format ${format} (only PCM is accepted)`);
	if (channels !== 1) throw new Error(`Unsupported WAV channel count: ${channels} (only mono is accepted)`);
	if (bitsPerSample !== BITS_PER_SAMPLE)
		throw new Error(`Unsupported WAV bit depth: ${bitsPerSample} (only 16-bit PCM is accepted)`);
	const dataBytes = Math.min(view.getUint32(40, true), bytes.length - WAV_HEADER_BYTES);
	const sampleCount = Math.floor(dataBytes / (BITS_PER_SAMPLE / 8));
	const samples = new Float32Array(sampleCount);
	let offset = WAV_HEADER_BYTES;
	for (let i = 0; i < sampleCount; i += 1) {
		samples[i] = view.getInt16(offset, true) / -INT16_MIN;
		offset += 2;
	}
	return { samples, sampleRate };
}

function readAscii(view: DataView, offset: number, length: number): string {
	let text = "";
	for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(offset + i));
	return text;
}
