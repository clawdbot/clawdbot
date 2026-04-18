import { describe, expect, it } from "vitest";
import { CONTEXT_WINDOW_HARD_MIN_TOKENS } from "../agents/context-window-guard.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyCustomApiConfig,
  buildAnthropicVerificationProbeRequest,
  buildOpenAiVerificationProbeRequest,
  parseNonInteractiveCustomApiFlags,
} from "./onboard-custom-config.js";

function buildCustomProviderConfig(contextWindow?: number) {
  if (contextWindow === undefined) {
    return {} as OpenClawConfig;
  }
  return {
    models: {
      providers: {
        custom: {
          api: "openai-completions" as const,
          baseUrl: "https://llm.example.com/v1",
          models: [
            {
              id: "foo-large",
              name: "foo-large",
              contextWindow,
              maxTokens: contextWindow > CONTEXT_WINDOW_HARD_MIN_TOKENS ? 4096 : 1024,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              reasoning: false,
            },
          ],
        },
      },
    },
  } as OpenClawConfig;
}

function applyCustomModelConfigWithContextWindow(contextWindow?: number) {
  return applyCustomApiConfig({
    config: buildCustomProviderConfig(contextWindow),
    baseUrl: "https://llm.example.com/v1",
    modelId: "foo-large",
    compatibility: "openai",
    providerId: "custom",
  });
}

it("uses expanded max_tokens for openai verification probes", async () => {
  const request = buildOpenAiVerificationProbeRequest({
    baseUrl: "https://example.com/v1",
    apiKey: "test-key",
    modelId: "detected-model",
  });

  expect(request.body).toMatchObject({ max_tokens: 16 });
});
it("uses azure responses-specific headers and body for openai verification probes", () => {
  const request = buildOpenAiVerificationProbeRequest({
    baseUrl: "https://my-resource.openai.azure.com",
    apiKey: "azure-test-key",
    modelId: "gpt-4.1",
  });

  expect(request.endpoint).toBe("https://my-resource.openai.azure.com/openai/v1/responses");
  expect(request.headers["api-key"]).toBe("azure-test-key");
  expect(request.headers.Authorization).toBeUndefined();
  expect(request.body).toEqual({
    model: "gpt-4.1",
    input: "Hi",
    max_output_tokens: 16,
    stream: false,
  });
});
it("uses Azure Foundry chat-completions probes for services.ai URLs", () => {
  const request = buildOpenAiVerificationProbeRequest({
    baseUrl: "https://my-resource.services.ai.azure.com",
    apiKey: "azure-test-key",
    modelId: "deepseek-v3-0324",
  });

  expect(request.endpoint).toBe(
    "https://my-resource.services.ai.azure.com/openai/deployments/deepseek-v3-0324/chat/completions?api-version=2024-10-21",
  );
  expect(request.headers["api-key"]).toBe("azure-test-key");
  expect(request.headers.Authorization).toBeUndefined();
  expect(request.body).toEqual({
    model: "deepseek-v3-0324",
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 16,
    stream: false,
  });
});
it("uses expanded max_tokens for anthropic verification probes", () => {
  const request = buildAnthropicVerificationProbeRequest({
    baseUrl: "https://example.com",
    apiKey: "test-key",
    modelId: "detected-model",
  });

  expect(request.endpoint).toBe("https://example.com/v1/messages");
  expect(request.body).toMatchObject({ max_tokens: 1 });
});

describe("applyCustomApiConfig", () => {
  it.each([
    {
      name: "uses hard-min context window for newly added custom models",
      existingContextWindow: undefined,
      expectedContextWindow: CONTEXT_WINDOW_HARD_MIN_TOKENS,
    },
    {
      name: "upgrades existing custom model context window when below hard minimum",
      existingContextWindow: 4096,
      expectedContextWindow: CONTEXT_WINDOW_HARD_MIN_TOKENS,
    },
    {
      name: "preserves existing custom model context window when already above minimum",
      existingContextWindow: 131072,
      expectedContextWindow: 131072,
    },
  ])("$name", ({ existingContextWindow, expectedContextWindow }) => {
    const result = applyCustomModelConfigWithContextWindow(existingContextWindow);
    const model = result.config.models?.providers?.custom?.models?.find(
      (entry) => entry.id === "foo-large",
    );
    expect(model?.contextWindow).toBe(expectedContextWindow);
  });

  it.each([
    {
      name: "invalid compatibility values at runtime",
      params: {
        config: {},
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        compatibility: "invalid" as unknown as "openai",
      },
      expectedMessage: 'Custom provider compatibility must be "openai" or "anthropic".',
    },
    {
      name: "explicit provider ids that normalize to empty",
      params: {
        config: {},
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        compatibility: "openai" as const,
        providerId: "!!!",
      },
      expectedMessage: "Custom provider ID must include letters, numbers, or hyphens.",
    },
  ])("rejects $name", ({ params, expectedMessage }) => {
    expect(() => applyCustomApiConfig(params)).toThrow(expectedMessage);
  });

  it("produces azure-specific config for Azure OpenAI URLs with reasoning model", () => {
    const result = applyCustomApiConfig({
      config: {},
      baseUrl: "https://user123-resource.openai.azure.com",
      modelId: "o4-mini",
      compatibility: "openai",
      apiKey: "abcd1234",
    });
    const providerId = result.providerId!;
    const provider = result.config.models?.providers?.[providerId];

    expect(provider?.baseUrl).toBe("https://user123-resource.openai.azure.com/openai/v1");
    expect(provider?.api).toBe("azure-openai-responses");
    expect(provider?.authHeader).toBe(false);
    expect(provider?.headers).toEqual({ "api-key": "abcd1234" });

    const model = provider?.models?.find((m) => m.id === "o4-mini");
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.reasoning).toBe(true);
    expect(model?.compat).toEqual({ supportsStore: false });

    const modelRef = `${providerId}/${result.modelId}`;
    expect(result.config.agents?.defaults?.models?.[modelRef]?.params?.thinking).toBe("medium");
  });

  it("keeps selected compatibility for Azure AI Foundry URLs", () => {
    const result = applyCustomApiConfig({
      config: {},
      baseUrl: "https://my-resource.services.ai.azure.com",
      modelId: "gpt-4.1",
      compatibility: "openai",
      apiKey: "key123",
    });
    const providerId = result.providerId!;
    const provider = result.config.models?.providers?.[providerId];

    expect(provider?.baseUrl).toBe("https://my-resource.services.ai.azure.com/openai/v1");
    expect(provider?.api).toBe("openai-completions");
    expect(provider?.authHeader).toBe(false);
    expect(provider?.headers).toEqual({ "api-key": "key123" });

    const model = provider?.models?.find((m) => m.id === "gpt-4.1");
    expect(model?.reasoning).toBe(false);
    expect(model?.input).toEqual(["text"]);
    expect(model?.compat).toEqual({ supportsStore: false });

    const modelRef = `${providerId}/gpt-4.1`;
    expect(result.config.agents?.defaults?.models?.[modelRef]?.params?.thinking).toBeUndefined();
  });

  it("strips pre-existing deployment path from Azure URL in stored config", () => {
    const result = applyCustomApiConfig({
      config: {},
      baseUrl: "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
      modelId: "gpt-4",
      compatibility: "openai",
      apiKey: "key456",
    });
    const providerId = result.providerId!;
    const provider = result.config.models?.providers?.[providerId];

    expect(provider?.baseUrl).toBe("https://my-resource.openai.azure.com/openai/v1");
  });

  it("re-onboard updates existing Azure provider instead of creating a duplicate", () => {
    const oldProviderId = "custom-my-resource-openai-azure-com";
    const result = applyCustomApiConfig({
      config: {
        models: {
          providers: {
            [oldProviderId]: {
              baseUrl: "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
              api: "openai-completions",
              models: [
                {
                  id: "gpt-4",
                  name: "gpt-4",
                  contextWindow: 1,
                  maxTokens: 1,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  reasoning: false,
                },
              ],
            },
          },
        },
      },
      baseUrl: "https://my-resource.openai.azure.com",
      modelId: "gpt-4",
      compatibility: "openai",
      apiKey: "key789",
    });

    expect(result.providerId).toBe(oldProviderId);
    expect(result.providerIdRenamedFrom).toBeUndefined();
    const provider = result.config.models?.providers?.[oldProviderId];
    expect(provider?.baseUrl).toBe("https://my-resource.openai.azure.com/openai/v1");
    expect(provider?.api).toBe("azure-openai-responses");
    expect(provider?.authHeader).toBe(false);
    expect(provider?.headers).toEqual({ "api-key": "key789" });
  });

  it("renames provider id when a non-azure baseUrl differs", () => {
    const result = applyCustomApiConfig({
      config: {
        models: {
          providers: {
            custom: {
              baseUrl: "http://old.example.com/v1",
              api: "openai-completions",
              models: [
                {
                  id: "old-model",
                  name: "Old",
                  contextWindow: 1,
                  maxTokens: 1,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  reasoning: false,
                },
              ],
            },
          },
        },
      },
      baseUrl: "http://localhost:11434/v1",
      modelId: "llama3",
      compatibility: "openai",
      providerId: "custom",
    });

    expect(result.providerId).toBe("custom-2");
    expect(result.config.models?.providers?.custom).toBeDefined();
    expect(result.config.models?.providers?.["custom-2"]).toBeDefined();
  });

  it("does not add azure fields for non-azure URLs", () => {
    const result = applyCustomApiConfig({
      config: {},
      baseUrl: "https://llm.example.com/v1",
      modelId: "foo-large",
      compatibility: "openai",
      apiKey: "key123",
      providerId: "custom",
    });
    const provider = result.config.models?.providers?.custom;

    expect(provider?.api).toBe("openai-completions");
    expect(provider?.authHeader).toBeUndefined();
    expect(provider?.headers).toBeUndefined();
    expect(provider?.models?.[0]?.reasoning).toBe(false);
    expect(provider?.models?.[0]?.input).toEqual(["text"]);
    expect(provider?.models?.[0]?.compat).toBeUndefined();
    expect(
      result.config.agents?.defaults?.models?.["custom/foo-large"]?.params?.thinking,
    ).toBeUndefined();
  });

  it("re-onboard preserves user-customized fields for non-azure models", () => {
    const result = applyCustomApiConfig({
      config: {
        models: {
          providers: {
            custom: {
              baseUrl: "https://llm.example.com/v1",
              api: "openai-completions",
              models: [
                {
                  id: "foo-large",
                  name: "My Custom Model",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 131072,
                  maxTokens: 16384,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
      baseUrl: "https://llm.example.com/v1",
      modelId: "foo-large",
      compatibility: "openai",
      apiKey: "key",
      providerId: "custom",
    });
    const model = result.config.models?.providers?.custom?.models?.find(
      (m) => m.id === "foo-large",
    );
    expect(model?.name).toBe("My Custom Model");
    expect(model?.reasoning).toBe(true);
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    expect(model?.maxTokens).toBe(16384);
    expect(model?.contextWindow).toBe(131072);
  });

  it("preserves existing per-model thinking when already set for azure reasoning model", () => {
    const providerId = "custom-my-resource-openai-azure-com";
    const modelRef = `${providerId}/o3-mini`;
    const result = applyCustomApiConfig({
      config: {
        agents: {
          defaults: {
            models: {
              [modelRef]: { params: { thinking: "high" } },
            },
          },
        },
      } as OpenClawConfig,
      baseUrl: "https://my-resource.openai.azure.com",
      modelId: "o3-mini",
      compatibility: "openai",
      apiKey: "key",
    });
    expect(result.config.agents?.defaults?.models?.[modelRef]?.params?.thinking).toBe("high");
  });
});

describe("parseNonInteractiveCustomApiFlags", () => {
  it("parses required flags and defaults compatibility to openai", () => {
    const result = parseNonInteractiveCustomApiFlags({
      baseUrl: " https://llm.example.com/v1 ",
      modelId: " foo-large ",
      apiKey: " custom-test-key ",
      providerId: " my-custom ",
    });

    expect(result).toEqual({
      baseUrl: "https://llm.example.com/v1",
      modelId: "foo-large",
      compatibility: "openai",
      apiKey: "custom-test-key", // pragma: allowlist secret
      providerId: "my-custom",
    });
  });

  it.each([
    {
      name: "missing required flags",
      flags: { baseUrl: "https://llm.example.com/v1" },
      expectedMessage: 'Auth choice "custom-api-key" requires a base URL and model ID.',
    },
    {
      name: "invalid compatibility values",
      flags: {
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        compatibility: "xmlrpc",
      },
      expectedMessage: 'Invalid --custom-compatibility (use "openai" or "anthropic").',
    },
    {
      name: "invalid explicit provider ids",
      flags: {
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        providerId: "!!!",
      },
      expectedMessage: "Custom provider ID must include letters, numbers, or hyphens.",
    },
  ])("rejects $name", ({ flags, expectedMessage }) => {
    expect(() => parseNonInteractiveCustomApiFlags(flags)).toThrow(expectedMessage);
  });
});
