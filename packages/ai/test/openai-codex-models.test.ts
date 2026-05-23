import type { Api, Model } from "../src/types.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { hydrateOpenAICodexModels } from "../src/utils/oauth/openai-codex.js";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
	delete process.env.PI_OFFLINE;
});

describe("hydrateOpenAICodexModels", () => {
	test("replaces the static catalog with visible account models and preserves other providers", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					models: [
						{
							slug: "gpt-5.5",
							display_name: "GPT-5.5",
							context_window: 272000,
							input_modalities: ["text", "image"],
							supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }],
							visibility: "list",
						},
						{
							slug: "gpt-5.4-mini",
							display_name: "GPT-5.4 Mini",
							context_window: 272000,
							input_modalities: ["text", "image"],
							supported_reasoning_levels: [{ effort: "low" }],
							visibility: "list",
						},
						{
							slug: "gpt-5.4",
							display_name: "GPT-5.4",
							context_window: 272000,
							input_modalities: ["text", "image"],
							supported_reasoning_levels: [{ effort: "low" }],
							visibility: "list",
						},
						{
							slug: "codex-auto-review",
							display_name: "Codex Auto Review",
							visibility: "hide",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		global.fetch = fetchMock as typeof fetch;

		const models: Model<Api>[] = [
			{
				id: "gpt-5.1",
				name: "GPT-5.1",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 272000,
				maxTokens: 128000,
			},
			{
				id: "gpt-5.4",
				name: "GPT-5.4",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
				contextWindow: 272000,
				maxTokens: 128000,
			},
			{
				id: "claude-sonnet-4",
				name: "Claude Sonnet 4",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200000,
				maxTokens: 8192,
			},
		];

		const hydrated = await hydrateOpenAICodexModels(models, {
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			accountId: "acct_123",
		});

		expect(hydrated.filter((model) => model.provider === "openai-codex").map((model) => model.id)).toEqual([
			"gpt-5.5",
			"gpt-5.4-mini",
			"gpt-5.4",
		]);
		expect(hydrated.find((model) => model.provider === "openai-codex" && model.id === "gpt-5.5")?.maxTokens).toBe(
			128000,
		);
		expect(hydrated.some((model) => model.provider === "anthropic" && model.id === "claude-sonnet-4")).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
