import { vi } from "vitest";
import type { ModelDefinitionConfig } from "../../config/types.js";

type DiscoverModelsMock = typeof import("../pi-model-discovery.js").discoverModels;

export const makeModel = (id: string): ModelDefinitionConfig => ({
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
  provider: "openai-codex",
  api: "openai-codex-responses",
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
    "openai-codex",
    OPENAI_CODEX_TEMPLATE_MODEL.id,
    OPENAI_CODEX_TEMPLATE_MODEL,
  );
}

export function buildOpenAICodexForwardCompatExpectation(
  id: string = "gpt-5.3-codex",
): Partial<ModelDefinitionConfig> & {
  provider: string;
  id: string;
  api: string;
  baseUrl: string;
} {
  const isGpt54 = id === "gpt-5.4";
  const isGpt55 = id === "gpt-5.5";
  const isGpt54Mini = id === "gpt-5.4-mini";
  const isSpark = id === "gpt-5.3-codex-spark";
  return {
    provider: "openai-codex",
    id,
    api: "openai-codex-responses",
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

export const GOOGLE_GEMINI_CLI_PRO_TEMPLATE_MODEL = {
  id: "gemini-3-pro-preview",
  name: "Gemini 3 Pro Preview (Cloud Code Assist)",
  provider: "google-gemini-cli",
  api: "google-gemini-cli",
  baseUrl: "https://cloudcode-pa.googleapis.com",
  reasoning: true,
  input: ["text", "image"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 64000,
};

export const GOOGLE_GEMINI_CLI_FLASH_TEMPLATE_MODEL = {
  id: "gemini-3-flash-preview",
  name: "Gemini 3 Flash Preview (Cloud Code Assist)",
  provider: "google-gemini-cli",
  api: "google-gemini-cli",
  baseUrl: "https://cloudcode-pa.googleapis.com",
  reasoning: false,
  input: ["text", "image"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 64000,
};

export function mockGoogleGeminiCliProTemplateModel(discoverModelsMock: DiscoverModelsMock): void {
  mockTemplateModel(
    discoverModelsMock,
    "google-gemini-cli",
    "gemini-3-pro-preview",
    GOOGLE_GEMINI_CLI_PRO_TEMPLATE_MODEL,
  );
}

export function mockGoogleGeminiCliFlashTemplateModel(
  discoverModelsMock: DiscoverModelsMock,
): void {
  mockTemplateModel(
    discoverModelsMock,
    "google-gemini-cli",
    "gemini-3-flash-preview",
    GOOGLE_GEMINI_CLI_FLASH_TEMPLATE_MODEL,
  );
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
  vi.mocked(discoverModelsMock).mockReturnValue({
    find: vi.fn((provider: string, modelId: string) => {
      if (provider === params.provider && modelId === params.modelId) {
        return params.templateModel;
      }
      return null;
    }),
  } as unknown as ReturnType<DiscoverModelsMock>);
}
