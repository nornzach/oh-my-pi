/**
 * TypeSafe System One client: the native {@link Judge} backend.
 *
 * Forwards a {@link JudgmentRequest} verbatim to the judgment route of its
 * API ({@link JUDGMENT_ROUTES}) and maps the typed answers back. TypeSafe's
 * own `POST /v1/systemone` and OpenRouter's `POST /api/alpha/decisions` share
 * the request and answer wire shape, so one client serves both. Credentials
 * flow through {@link withAuth}, so a stored key rotates on 401/403 exactly
 * like chat providers; transient 429/5xx responses retry with bounded,
 * `retry-after`-aware backoff. Endpoints that cap the `questions` map (the
 * catalog's `judgment-questions-max`, e.g. OpenJEV at 16) get oversized
 * requests split into chunks under `maxQuestions`, at most
 * {@link CHUNK_PARALLEL} in flight at once.
 *
 * Environment (mirrors the official SDK): `TYPESAFE_API_KEY` is resolved by
 * the auth registry (`rules/auth/typesafe.kdl`), `TYPESAFE_BASE_URL`
 * overrides the API root, `TYPESAFE_DEFAULT_MODEL` the model.
 */
import { TYPESAFE_DEFAULT_BASE_URL } from "@oh-my-pi/pi-catalog/discovery";
import type { Api, FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { $env } from "@oh-my-pi/pi-utils";
import { type ApiKey, withAuth } from "../auth-retry";
import * as AIError from "../error";
import type { Usage } from "../types";
import { getRetryAfterMsFromHeaders } from "../utils/retry-after";
import {
	type Answer,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Questions,
	tokenUsage,
} from "./types";

export const TYPESAFE_PROVIDER = "typesafe";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

/** Judgment `POST` path under a model's base URL, per System One–compatible API. */
export const JUDGMENT_ROUTES = {
	typesafe: "/v1/systemone",
	"openrouter-decisions": "/decisions",
} as const satisfies Partial<Record<Api, string>>;

/** APIs {@link TypeSafeJudge} can serve. */
export type JudgmentApi = keyof typeof JUDGMENT_ROUTES;

/** Whether a catalog API answers System One judgments natively. */
export function isJudgmentApi(api: Api): api is JudgmentApi {
	return Object.hasOwn(JUDGMENT_ROUTES, api);
}

/** `TYPESAFE_BASE_URL` when set, else the public API root; trailing slashes stripped. */
export function typesafeBaseUrl(): string {
	return ($env.TYPESAFE_BASE_URL?.trim() || TYPESAFE_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** `TYPESAFE_DEFAULT_MODEL` when set, else {@link TYPESAFE_DEFAULT_MODEL}. */
export function typesafeModel(): string {
	return $env.TYPESAFE_DEFAULT_MODEL?.trim() || TYPESAFE_DEFAULT_MODEL;
}

export interface TypeSafeJudgeOptions {
	apiKey: ApiKey;
	/** Wire route; defaults to TypeSafe's own API. */
	api?: JudgmentApi;
	/** Catalog provider reported on results; defaults to {@link TYPESAFE_PROVIDER}. */
	provider?: string;
	/** Defaults to {@link typesafeBaseUrl}. */
	baseUrl?: string;
	/** Defaults to {@link typesafeModel}. */
	model?: string;
	/** Static headers attached to judgment requests (e.g. proxy routing, gateway auth). */
	headers?: Record<string, string>;
	fetch?: FetchImpl;
	/** Per-attempt timeout; defaults to {@link DEFAULT_TIMEOUT_MS}. */
	timeoutMs?: number;
	/**
	 * Most questions per request the endpoint accepts, a positive integer; larger
	 * requests are split. Unset: no cap.
	 */
	maxQuestions?: number;
}

/** Per-call options for {@link TypeSafeJudge.judge}. */
export interface TypeSafeJudgeCallOptions extends JudgeOptions {
	/**
	 * Called before a split judgment rejects, with the summed usage of the chunks that had already
	 * succeeded: billed upstream, but their answers are discarded with the failure. Not called when
	 * no chunk succeeded or the request was not split.
	 */
	onPartialUsage?: (usage: Usage) => void;
}

/** Non-2xx response from the TypeSafe API. */
export class TypeSafeApiError extends AIError.ProviderHttpError {
	override readonly name = "TypeSafeApiError";
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5_000;
/** Chunks of one split judgment in flight at once, so a split never bursts the endpoint unboundedly. */
const CHUNK_PARALLEL = 4;

interface SystemOneResponse {
	model: string;
	answers: Record<string, Answer>;
	/** OpenRouter adds the billed `cost` in USD; some routes omit token counts. */
	usage: { input_tokens?: number; output_tokens?: number; cost?: number };
}

/** Server hint wins (capped); otherwise exponential backoff from {@link BACKOFF_BASE_MS}. */
function backoffMs(attempt: number, headers: Headers | undefined): number {
	const hinted = headers === undefined ? undefined : getRetryAfterMsFromHeaders(headers);
	if (hinted !== undefined) return Math.min(hinted, BACKOFF_MAX_MS);
	return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

export class TypeSafeJudge implements Judge {
	readonly label: string;
	readonly api: JudgmentApi;
	readonly provider: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly #apiKey: ApiKey;
	readonly #headers: Record<string, string> | undefined;
	readonly #fetch: FetchImpl;
	readonly #timeoutMs: number;
	readonly #maxQuestions: number | undefined;

	constructor(options: TypeSafeJudgeOptions) {
		this.#apiKey = options.apiKey;
		this.api = options.api ?? TYPESAFE_PROVIDER;
		this.provider = options.provider ?? TYPESAFE_PROVIDER;
		this.baseUrl = (options.baseUrl ?? typesafeBaseUrl()).replace(/\/+$/, "");
		this.model = options.model ?? typesafeModel();
		this.#headers = options.headers;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (options.maxQuestions !== undefined && !(Number.isInteger(options.maxQuestions) && options.maxQuestions > 0)) {
			throw new RangeError(`TypeSafeJudge maxQuestions must be a positive integer, got ${options.maxQuestions}`);
		}
		this.#maxQuestions = options.maxQuestions;
		this.label = `${this.provider}/${this.model}`;
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options?: TypeSafeJudgeCallOptions,
	): Promise<JudgmentResult<Q>> {
		const ids = Object.keys(request.questions);
		const cap = this.#maxQuestions;
		if (cap !== undefined && ids.length > cap) return this.#judgeChunked(request, ids, cap, options);
		return this.#judgeOnce(request, options);
	}

	/**
	 * Answer `request` in requests of at most `cap` questions each, {@link CHUNK_PARALLEL} at a time;
	 * answers merge and usage sums. The first failing chunk aborts its in-flight siblings and stops
	 * dispatch, so a doomed judgment stops spending; once every chunk settles, the usage of those that
	 * succeeded goes to `onPartialUsage` before the judgment rejects.
	 */
	async #judgeChunked<Q extends Questions>(
		request: JudgmentRequest<Q>,
		ids: string[],
		cap: number,
		options: TypeSafeJudgeCallOptions | undefined,
	): Promise<JudgmentResult<Q>> {
		const chunks: Questions[] = [];
		for (let start = 0; start < ids.length; start += cap) {
			const questions: Questions = {};
			for (const id of ids.slice(start, start + cap)) questions[id] = request.questions[id];
			chunks.push(questions);
		}
		const failed = new AbortController();
		const signal = options?.signal ? AbortSignal.any([options.signal, failed.signal]) : failed.signal;
		const chunkOptions = { signal };
		const results: JudgmentResult[] = [];
		let next = 0;
		const drain = async (): Promise<void> => {
			while (next < chunks.length && !signal.aborted) {
				const index = next++;
				try {
					results[index] = await this.#judgeOnce({ state: request.state, questions: chunks[index] }, chunkOptions);
				} catch (error) {
					failed.abort(error);
					throw error;
				}
			}
		};
		// Settle every worker, not just the first failure, so no sibling's billed result goes uncounted.
		await Promise.allSettled(Array.from({ length: Math.min(CHUNK_PARALLEL, chunks.length) }, drain));
		const answers: Record<string, Answer> = {};
		let settled = 0;
		let input = 0;
		let output = 0;
		let cost = 0;
		for (const result of results) {
			if (result === undefined) continue;
			settled++;
			Object.assign(answers, result.answers);
			input += result.usage.input;
			output += result.usage.output;
			cost += result.usage.cost.total;
		}
		// Every chunk failure aborts `failed`, so `signal` carries the first failure or the caller's abort.
		if (signal.aborted) {
			if (settled > 0) options?.onPartialUsage?.(tokenUsage(input, output, cost));
			throw signal.reason;
		}
		return {
			api: this.api,
			provider: this.provider,
			model: results[0].model,
			answers: answers as JudgmentResult<Q>["answers"],
			usage: tokenUsage(input, output, cost),
		};
	}

	async #judgeOnce<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: JudgeOptions | undefined,
	): Promise<JudgmentResult<Q>> {
		const body = JSON.stringify({ state: request.state, model: this.model, questions: request.questions });
		const signal = options?.signal;
		const response = await withAuth(
			this.#apiKey,
			key => this.#attempt<SystemOneResponse>(JUDGMENT_ROUTES[this.api], body, key, signal),
			{ signal },
		);
		for (const id in request.questions) {
			const answer = response.answers[id];
			if (answer === undefined || answer.type !== request.questions[id].type) {
				throw new AIError.ProviderResponseError(
					`${this.label} response is missing a "${request.questions[id].type}" answer for question "${id}"`,
					{ provider: this.provider, kind: "envelope" },
				);
			}
		}
		return {
			api: this.api,
			provider: this.provider,
			model: response.model,
			answers: response.answers as JudgmentResult<Q>["answers"],
			usage: tokenUsage(response.usage.input_tokens, response.usage.output_tokens, response.usage.cost),
		};
	}

	async #attempt<T>(path: string, body: string, key: string, signal: AbortSignal | undefined): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const headers: Record<string, string> = {
			...this.#headers,
			Authorization: `Bearer ${key}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		};
		for (let attempt = 0; ; attempt++) {
			signal?.throwIfAborted();
			const timeout = AbortSignal.timeout(this.#timeoutMs);
			let response: Response;
			try {
				response = await this.#fetch(url, {
					method: "POST",
					headers,
					body,
					signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				});
			} catch (error) {
				if (signal?.aborted || attempt + 1 >= MAX_ATTEMPTS) throw error;
				await Bun.sleep(backoffMs(attempt, undefined));
				continue;
			}
			if (response.ok) return (await response.json()) as T;
			const text = await response.text();
			const error = new TypeSafeApiError(`${this.label} API error (${response.status}): ${text}`, response.status, {
				headers: response.headers,
			});
			const transient = response.status === 408 || response.status === 429 || response.status >= 500;
			if (!transient || attempt + 1 >= MAX_ATTEMPTS) throw error;
			await Bun.sleep(backoffMs(attempt, response.headers));
		}
	}
}
