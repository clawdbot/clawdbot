import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const DEFAULT_LIVE_MODEL_IDS = ["gpt-5.4-mini", "gpt-5.4-nano"] as const;
const liveEnabled = OPENAI_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

type LiveModelCase = {
  modelId: string;
  templateId: string;
  templateName: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

function resolveLiveModelCase(modelId: string): LiveModelCase {
  switch (modelId) {
    case "gpt-5.4":
      return {
        modelId,
        templateId: "gpt-5.2",
        templateName: "GPT-5.2",
        cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
      };
    case "gpt-5.4-pro":
      return {
        modelId,
        templateId: "gpt-5.2-pro",
        templateName: "GPT-5.2 Pro",
        cost: { input: 21, output: 168, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
      };
    case "gpt-5.4-mini":
      return {
        modelId,
        templateId: "gpt-5-mini",
        templateName: "GPT-5 mini",
        cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
      };
    case "gpt-5.4-nano":
      return {
        modelId,
        templateId: "gpt-5-nano",
        templateName: "GPT-5 nano",
        cost: { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
      };
    default:
      throw new Error(`Unsupported live OpenAI model: ${modelId}`);
  }
}

function resolveLiveModelCases(raw?: string): LiveModelCase[] {
  const requested = raw
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const modelIds = requested?.length ? requested : [...DEFAULT_LIVE_MODEL_IDS];
  return [...new Set(modelIds)].map((modelId) => resolveLiveModelCase(modelId));
}

describeLive("buildOpenAIProvider live", () => {
  it.each(resolveLiveModelCases(process.env.OPENCLAW_LIVE_OPENAI_MODELS))(
    "resolves %s and completes through the OpenAI responses API",
    async (liveCase) => {
      const provider = buildOpenAIProvider();
      const registry = {
        find(providerId: string, id: string) {
          if (providerId !== "openai") {
            return null;
          }
          if (id === liveCase.templateId) {
            return {
              id: liveCase.templateId,
              name: liveCase.templateName,
              provider: "openai",
              api: "openai-completions",
              baseUrl: "https://api.openai.com/v1",
              reasoning: true,
              input: ["text", "image"],
              cost: liveCase.cost,
              contextWindow: liveCase.contextWindow,
              maxTokens: liveCase.maxTokens,
            };
          }
          return null;
        },
      };

      const resolved = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId: liveCase.modelId,
        modelRegistry: registry as never,
      });
      if (!resolved) {
        throw new Error(`openai provider did not resolve ${liveCase.modelId}`);
      }

      const normalized = provider.normalizeResolvedModel?.({
        provider: "openai",
        modelId: resolved.id,
        model: resolved,
      });

      expect(normalized).toMatchObject({
        provider: "openai",
        id: liveCase.modelId,
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      });

      const client = new OpenAI({
        apiKey: OPENAI_API_KEY,
        baseURL: normalized?.baseUrl,
      });

      const response = await client.responses.create({
        model: normalized?.id ?? liveCase.modelId,
        input: "Reply with exactly OK.",
        max_output_tokens: 16,
      });

      expect(response.output_text.trim()).toMatch(/^OK[.!]?$/);
    },
    30_000,
  );
});
