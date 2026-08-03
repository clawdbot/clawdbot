// Shared model fixtures for embedded runner model resolution tests.
import { vi } from "vitest";
import type { ModelDefinitionConfig } from "../../config/types.js";

type DiscoverModelsMock = typeof import("../agent-model-discovery.js").discoverModels;

export const makeModel = (id: string): ModelDefinitionConfig => ({
  // Smallest valid model row used when tests only care about inheritance or
  // provider routing.
  id,
  name: id,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
});

export const OPENAI_CODEX_TEMPLATE_MODEL = {
  id: "gpt-5.3-codex",
  name: "GPT-5.3 Codex",
  provider: "openai",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"] as const,
  cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  contextWindow: 1_050_000,
  contextTokens: 272_000,
  maxTokens: 128000,
};

function mockTemplateModel(
  discoverModelsMock: DiscoverModelsMock,
  provider: string,
  modelId: string,
  templateModel: unknown,
): void {
  mockDiscoveredModel(discoverModelsMock, {
    provider,
    modelId,
    templateModel,
  });
}

export function mockOpenAICodexTemplateModel(discoverModelsMock: DiscoverModelsMock): void {
  mockTemplateModel(
    discoverModelsMock,
    "openai",
    OPENAI_CODEX_TEMPLATE_MODEL.id,
    OPENAI_CODEX_TEMPLATE_MODEL,
  );
}

export function buildOpenAICodexForwardCompatExpectation(
  id = "gpt-5.3-codex",
): Partial<ModelDefinitionConfig> & {
  provider: string;
  id: string;
  api: string;
  baseUrl: string;
} {
  // Expected metadata varies by requested future Codex id while preserving the
  // native ChatGPT Responses transport contract.
  const isGpt54 = id === "gpt-5.4";
  const isGpt55 = id === "gpt-5.5";
  const isGpt54Mini = id === "gpt-5.4-mini";
  const isSpark = id === "gpt-5.3-codex-spark";
  return {
    provider: "openai",
    id,
    api: "openai-chatgpt-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: isSpark ? ["text"] : ["text", "image"],
    cost: isSpark
      ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      : isGpt54
        ? { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }
        : isGpt54Mini
          ? { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 }
          : OPENAI_CODEX_TEMPLATE_MODEL.cost,
    contextWindow: isGpt54
      ? 1_050_000
      : isGpt55 || isGpt54Mini
        ? 400_000
        : isSpark
          ? 128_000
          : 272000,
    ...(isGpt54 || isGpt55 || isGpt54Mini ? { contextTokens: 272_000 } : {}),
    maxTokens: 128000,
  };
}

export function resetMockDiscoverModels(discoverModelsMock: DiscoverModelsMock): void {
  vi.mocked(discoverModelsMock).mockReturnValue({
    find: vi.fn(() => null),
  } as unknown as ReturnType<DiscoverModelsMock>);
}

export function mockDiscoveredModel(
  discoverModelsMock: DiscoverModelsMock,
  params: {
    provider: string;
    modelId: string;
    templateModel: unknown;
  },
): void {
  // Discovery mock returns exactly one template row so fallback tests cannot
  // accidentally pass by matching a sibling model.
  vi.mocked(discoverModelsMock).mockReturnValue({
    find: vi.fn((provider: string, modelId: string) => {
      if (provider === params.provider && modelId === params.modelId) {
        return params.templateModel;
      }
      return null;
    }),
  } as unknown as ReturnType<DiscoverModelsMock>);
}
