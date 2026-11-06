import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type DiscoveryProviderConfig, reportedModelLimits } from "@oh-my-pi/pi-coding-agent/config/model-discovery";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

const CONFIG: DiscoveryProviderConfig = {
	provider: "openai",
	api: "openai-completions",
	baseUrl: "https://new-endpoint.example.com/v1",
	discovery: { type: "openai-models-list" },
};

let authStorage: AuthStorage;
let sentAuthorization: (string | null)[];
let registry: ModelRegistry;

beforeEach(async () => {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("openai", "sk-saved-for-openai");
	sentAuthorization = [];
	registry = new ModelRegistry(authStorage, undefined, {
		fetch: (async (_url: string, init?: RequestInit) => {
			sentAuthorization.push(new Headers(init?.headers).get("authorization"));
			return Response.json({
				data: [{ id: "alpha" }, { id: "beta", context_length: 200_000, max_output_tokens: 8_000 }],
			});
		}) as typeof fetch,
	});
});

afterEach(() => {
	authStorage.close();
});

describe("ModelRegistry.listEndpointModels", () => {
	test("lists what the endpoint offers and adds nothing to the catalog", async () => {
		const models = await registry.listEndpointModels(CONFIG, { useSavedCredential: false });

		expect(models.map(model => model.id)).toEqual(["alpha", "beta"]);
		expect(registry.getAll().some(model => model.id === "alpha")).toBe(false);
	});

	test("reports only the limits a server gave, not discovery's fill-in defaults", async () => {
		const [silent, reporting] = await registry.listEndpointModels(CONFIG, { useSavedCredential: false });

		expect(reportedModelLimits(silent)).toEqual({ contextWindow: null, maxTokens: null });
		expect(reportedModelLimits(reporting)).toEqual({ contextWindow: 200_000, maxTokens: 8_000 });
	});

	test("does not send a saved key to a URL typed into a new provider's form", async () => {
		await registry.listEndpointModels(CONFIG, { useSavedCredential: false });

		expect(sentAuthorization).toEqual([null]);
	});

	test("uses the typed key over the saved one, and the saved one only when asked", async () => {
		await registry.listEndpointModels(CONFIG, { apiKey: "sk-typed", useSavedCredential: true });
		await registry.listEndpointModels(CONFIG, { useSavedCredential: true });

		expect(sentAuthorization).toEqual(["Bearer sk-typed", "Bearer sk-saved-for-openai"]);
	});
});
