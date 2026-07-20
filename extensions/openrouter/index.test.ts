// Openrouter tests cover index plugin behavior.
import { readFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import {
  registerProviderPlugin,
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  expectPassthroughReplayPolicy,
  expectUnifiedModelCatalogProviderRegistration,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it, vi } from "vitest";

const { getOpenRouterModelCapabilitiesMock, loadOpenRouterModelCapabilitiesMock } = vi.hoisted(
  () => ({
    getOpenRouterModelCapabilitiesMock: vi.fn(),
    loadOpenRouterModelCapabilitiesMock: vi.fn(async () => {}),
  }),
);

vi.mock("openclaw/plugin-sdk/provider-stream-family", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/provider-stream-family")>();
  return {
    ...actual,
    getOpenRouterModelCapabilities: getOpenRouterModelCapabilitiesMock,
    loadOpenRouterModelCapabilities: loadOpenRouterModelCapabilitiesMock,
  };
});

import openrouterPlugin from "./index.js";
import {
  buildOpenrouterProvider,
  isOpenRouterProxyReasoningUnsupportedModel,
} from "./provider-catalog.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";

function createOpenRouterDoneStreamWithoutGeneration() {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        api: "openai-completions",
        provider: "openrouter",
        model: "openrouter/auto",
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
        timestamp: Date.now(),
      } as never,
    });
  });
  return stream;
}

type OpenRouterManifest = {
  providerAuthChoices?: Array<{
    provider?: string;
    method?: string;
    choiceId?: string;
    choiceLabel?: string;
    choiceHint?: string;
    groupId?: string;
    groupLabel?: string;
    groupHint?: string;
    onboardingScopes?: string[];
    onboardingFeatured?: boolean;
  }>;
};

function readManifest(): OpenRouterManifest {
  return JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));
}

describe("openrouter provider hooks", () => {
  it("registers OpenRouter speech alongside model, media, and catalog providers", async () => {
    const {
      providers,
      speechProviders,
      mediaProviders,
      imageProviders,
      musicProviders,
      videoProviders,
    } = await registerProviderPlugin({
      plugin: openrouterPlugin,
      id: "openrouter",
      name: "OpenRouter Provider",
    });
    const modelCatalogProvider = expectUnifiedModelCatalogProviderRegistration({
      plugin: openrouterPlugin,
      pluginId: "openrouter",
      pluginName: "OpenRouter Provider",
      provider: "openrouter",
      kind: "video_generation",
    });

    expect(providers.map((provider) => provider.id)).toEqual(["openrouter"]);
    expect(providers[0]).toMatchObject({
      resolveUsageAuth: expect.any(Function),
      fetchUsageSnapshot: expect.any(Function),
    });
    expect(speechProviders.map((provider) => provider.id)).toEqual(["openrouter"]);
    expect(mediaProviders.map((provider) => provider.id)).toEqual(["openrouter"]);
    expect(imageProviders.map((provider) => provider.id)).toEqual(["openrouter"]);
    expect(musicProviders.map((provider) => provider.id)).toEqual(["openrouter"]);
    expect(videoProviders.map((provider) => provider.id)).toEqual(["openrouter"]);
    expect(modelCatalogProvider.liveCatalog).toBeTypeOf("function");
  });

  it("registers OAuth and API-key auth methods", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const manifestChoices = readManifest().providerAuthChoices?.map((choice) => ({
      provider: choice.provider,
      method: choice.method,
      choiceId: choice.choiceId,
      choiceLabel: choice.choiceLabel,
      choiceHint: choice.choiceHint,
      groupId: choice.groupId,
      groupLabel: choice.groupLabel,
      groupHint: choice.groupHint,
      onboardingScopes: choice.onboardingScopes,
      onboardingFeatured: choice.onboardingFeatured,
    }));

    expect(
      provider.auth.map((method) => ({
        id: method.id,
        kind: method.kind,
        choiceId: method.wizard?.choiceId,
      })),
    ).toEqual([
      { id: "api-key", kind: "api_key", choiceId: "openrouter-api-key" },
      { id: "oauth", kind: "oauth", choiceId: "openrouter-oauth" },
    ]);
    expect(
      provider.auth.map((method) => ({
        provider: provider.id,
        method: method.id,
        choiceId: method.wizard?.choiceId,
        choiceLabel: method.wizard?.choiceLabel,
        choiceHint: method.wizard?.choiceHint,
        groupId: method.wizard?.groupId,
        groupLabel: method.wizard?.groupLabel,
        groupHint: method.wizard?.groupHint,
        onboardingScopes: method.wizard?.onboardingScopes,
        onboardingFeatured: method.wizard?.onboardingFeatured,
      })),
    ).toEqual(manifestChoices);

    const bareProviderChoice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "openrouter",
    });
    const oauthChoice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "openrouter-oauth",
    });

    expect(bareProviderChoice?.method.id).toBe("api-key");
    expect(oauthChoice?.method.id).toBe("oauth");
  });

  it("features OpenRouter OAuth in the top-level onboarding picker", () => {
    const oauthChoice = readManifest().providerAuthChoices?.find(
      (choice) => choice.choiceId === "openrouter-oauth",
    );

    expect(oauthChoice).toMatchObject({
      provider: "openrouter",
      method: "oauth",
      groupId: "openrouter",
      groupLabel: "OpenRouter",
      onboardingFeatured: true,
    });
  });

  it("includes current Kimi models in the bundled catalog", () => {
    const modelIds = buildOpenrouterProvider().models?.map((model) => model.id) ?? [];
    expect(modelIds).toContain("moonshotai/kimi-k2.6");
    expect(modelIds).toContain("moonshotai/kimi-k2.5");
  });

  it("uses the canonical prefixed OpenRouter auto model id", () => {
    expect(buildOpenrouterProvider().models?.map((model) => model.id)).toContain("openrouter/auto");
    expect(buildOpenrouterProvider().models?.map((model) => model.id)).not.toContain("auto");
  });

  it("normalizes OpenRouter API ids before capability loading and lookup", async () => {
    getOpenRouterModelCapabilitiesMock.mockReset();
    loadOpenRouterModelCapabilitiesMock.mockClear();
    getOpenRouterModelCapabilitiesMock.mockReturnValue({
      name: "Claude Sonnet 4.6",
      reasoning: true,
      input: ["text", "image"],
      supportsTools: true,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const modelId = "openrouter/anthropic/claude-sonnet-4.6";
    const context = {
      provider: "openrouter",
      modelId,
      modelRegistry: { find: vi.fn(() => null) },
    } as never;

    await provider.prepareDynamicModel?.(context);
    const model = provider.resolveDynamicModel?.(context);

    expect(loadOpenRouterModelCapabilitiesMock).toHaveBeenCalledWith("anthropic/claude-sonnet-4.6");
    expect(getOpenRouterModelCapabilitiesMock).toHaveBeenCalledWith("anthropic/claude-sonnet-4.6");
    expect(model).toMatchObject({
      id: modelId,
      name: "Claude Sonnet 4.6",
      reasoning: true,
      input: ["text", "image"],
      compat: { supportsTools: true },
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
  });

  it("keeps native OpenRouter namespace ids for capability lookup", async () => {
    getOpenRouterModelCapabilitiesMock.mockReset();
    loadOpenRouterModelCapabilitiesMock.mockClear();
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const context = {
      provider: "openrouter",
      modelId: "openrouter/auto",
      modelRegistry: { find: vi.fn(() => null) },
    } as never;

    await provider.prepareDynamicModel?.(context);
    provider.resolveDynamicModel?.(context);

    expect(loadOpenRouterModelCapabilitiesMock).toHaveBeenCalledWith("openrouter/auto");
    expect(getOpenRouterModelCapabilitiesMock).toHaveBeenCalledWith("openrouter/auto");
  });

  it("describes configured Fusion analysis models in the system prompt", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      config: {
        agents: {
          defaults: {
            models: {
              "openrouter/openrouter/fusion": {
                params: {
                  extraBody: {
                    plugins: [
                      {
                        id: "fusion",
                        analysis_models: [
                          "google/gemini-3.5-flash",
                          "moonshotai/kimi-k2.6",
                          "deepseek/deepseek-v4-pro",
                        ],
                        model: "google/gemini-3.5-flash",
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    } as never);

    expect(contribution?.dynamicSuffix).toContain("OpenRouter Fusion Configuration");
    expect(contribution?.dynamicSuffix).toContain(
      "Analysis models: google/gemini-3.5-flash, moonshotai/kimi-k2.6, deepseek/deepseek-v4-pro.",
    );
    expect(contribution?.dynamicSuffix).toContain("Final Fusion model: google/gemini-3.5-flash.");
  });

  it("keeps bounded Fusion model IDs on valid UTF-16 boundaries", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const boundaryModelId = `${"a".repeat(255)}😀tail`;
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      config: {
        agents: {
          defaults: {
            models: {
              "openrouter/fusion": {
                params: {
                  extraBody: {
                    plugins: [
                      {
                        id: "fusion",
                        analysis_models: [boundaryModelId],
                        model: boundaryModelId,
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    } as never);

    expect(contribution?.dynamicSuffix).toContain(`Analysis models: ${"a".repeat(255)}.`);
    expect(contribution?.dynamicSuffix).toContain(`Final Fusion model: ${"a".repeat(255)}.`);
  });

  it("describes Fusion config from the canonical OpenRouter model key", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      config: {
        agents: {
          defaults: {
            models: {
              "openrouter/fusion": {
                params: {
                  extraBody: {
                    plugins: [
                      {
                        id: "fusion",
                        analysis_models: ["deepseek/deepseek-v4-pro"],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    } as never);

    expect(contribution?.dynamicSuffix).toContain("Analysis models: deepseek/deepseek-v4-pro.");
  });

  it("matches transport alias precedence for Fusion extra body", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      config: {
        agents: {
          defaults: {
            params: {
              extra_body: {
                plugins: [
                  {
                    id: "fusion",
                    analysis_models: ["google/gemini-3.5-flash"],
                  },
                ],
              },
            },
            models: {
              "openrouter/fusion": {
                params: {
                  extraBody: {
                    plugins: [
                      {
                        id: "fusion",
                        analysis_models: ["deepseek/deepseek-v4-pro"],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    } as never);

    expect(contribution?.dynamicSuffix).toContain("Analysis models: google/gemini-3.5-flash.");
    expect(contribution?.dynamicSuffix).not.toContain("deepseek/deepseek-v4-pro");
  });

  it("keeps arbitrary OpenRouter extraBody fields out of the system prompt", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      config: {
        agents: {
          defaults: {
            models: {
              "openrouter/openrouter/fusion": {
                params: {
                  extraBody: {
                    metadata: { private: "do-not-render" },
                    plugins: [{ id: "not-fusion", model: "private-model" }],
                  },
                },
              },
            },
          },
        },
      },
    } as never);

    expect(contribution).toBeUndefined();
  });

  it("does not describe disabled Fusion plugin config in the system prompt", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      config: {
        agents: {
          defaults: {
            models: {
              "openrouter/fusion": {
                params: {
                  extraBody: {
                    plugins: [
                      {
                        id: "fusion",
                        enabled: false,
                        analysis_models: ["deepseek/deepseek-v4-pro"],
                        model: "google/gemini-3.5-flash",
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    } as never);

    expect(contribution).toBeUndefined();
  });

  it("does not include retired stealth models in the bundled catalog", () => {
    const modelIds = buildOpenrouterProvider().models?.map((model) => model.id) ?? [];
    expect(modelIds).not.toContain("openrouter/hunter-alpha");
    expect(modelIds).not.toContain("openrouter/healer-alpha");
  });

  it("keeps stale Hunter Alpha configs out of OpenRouter proxy reasoning", () => {
    expect(isOpenRouterProxyReasoningUnsupportedModel("openrouter/hunter-alpha")).toBe(true);
    expect(isOpenRouterProxyReasoningUnsupportedModel("openrouter/hunter-alpha:free")).toBe(true);
    expect(isOpenRouterProxyReasoningUnsupportedModel("openrouter/healer-alpha")).toBe(false);
  });

  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin: openrouterPlugin,
      providerId: "openrouter",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
    await expectPassthroughReplayPolicy({
      plugin: openrouterPlugin,
      providerId: "openrouter",
      modelId: "openai/gpt-5.4",
    });
  });

  // Regression for #58012: OpenRouter proxies Mistral, which requires the
  // strict9 tool_call_id mode the direct `mistral` provider already applies.
  // Without strict9, replayed assistant turns fail with HTTP 400
  // `invalid_function_call` 3280. Other OpenRouter-routed models (Gemini,
  // OpenAI, Anthropic, etc.) must keep the existing passthrough policy.
  describe("OpenRouter Mistral tool_call_id strict9 (#58012)", () => {
    it.each([
      ["unprefixed Mistral", "mistral-large-latest"],
      ["unprefixed Codestral", "codestral-latest"],
      ["unprefixed Devstral", "devstral-small-latest"],
      ["bare mistralai prefix", "mistralai/mistral-large-latest"],
      ["nested openrouter/mistralai", "openrouter/mistralai/mistral-small"],
      ["bare mistral provider prefix", "mistral/mistral-medium"],
    ])("applies strict9 sanitisation for %s", async (_label, modelId) => {
      const provider = await registerSingleProviderPlugin(openrouterPlugin);
      const policy = provider.buildReplayPolicy?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId,
      } as never);

      expect(policy?.sanitizeToolCallIds).toBe(true);
      expect(policy?.toolCallIdMode).toBe("strict9");
    });

    it.each([
      ["Gemini", "gemini-2.5-pro"],
      ["OpenAI", "openai/gpt-5.4"],
      ["Anthropic", "anthropic/claude-sonnet-4-6"],
      ["DeepSeek", "deepseek/deepseek-v4-flash"],
    ])("keeps passthrough policy for %s (no strict9)", async (_label, modelId) => {
      const provider = await registerSingleProviderPlugin(openrouterPlugin);
      const policy = provider.buildReplayPolicy?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId,
      } as never);

      expect(policy?.sanitizeToolCallIds).toBeUndefined();
      expect(policy?.toolCallIdMode).toBeUndefined();
    });

    it("preserves Gemini thought-signature sanitisation alongside strict9 logic", async () => {
      const provider = await registerSingleProviderPlugin(openrouterPlugin);
      const geminiPolicy = provider.buildReplayPolicy?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId: "google/gemini-2.5-pro",
      } as never);

      expect(geminiPolicy).toHaveProperty("sanitizeThoughtSignatures");
    });
  });

  it("owns native reasoning output mode", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId: "openai/gpt-5.4",
      } as never),
    ).toBe("native");
  });

  it("advertises xhigh thinking for OpenRouter-routed DeepSeek V4 models", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const expectedV4Levels = ["off", "minimal", "low", "medium", "high", "xhigh"];

    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openrouter",
          modelId: "deepseek/deepseek-v4-pro",
        } as never)
        ?.levels.map((level) => level.id),
    ).toEqual(expectedV4Levels);
    expect(
      provider.resolveThinkingProfile?.({
        provider: "openrouter",
        modelId: "openrouter/deepseek/deepseek-v4-flash",
      } as never)?.defaultLevel,
    ).toBe("high");
    expect(
      provider.resolveThinkingProfile?.({
        provider: "openrouter",
        modelId: "openai/gpt-5.4",
      } as never),
    ).toBe(undefined);
  });

  it("exposes DeepSeek V4 thinking levels through the lightweight policy artifact", () => {
    expect(
      resolveThinkingProfile({
        provider: "openrouter",
        modelId: "openrouter/deepseek/deepseek-v4-pro",
      })?.levels.map((level) => level.id),
    ).toContain("xhigh");
    expect(
      resolveThinkingProfile({
        provider: "openrouter",
        modelId: "openai/gpt-5.4",
      }),
    ).toBe(undefined);
  });

  it("canonicalizes stale OpenRouter /v1 config and runtime metadata", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    const normalizedConfig = provider.normalizeConfig?.({
      provider: "openrouter",
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1/",
        models: [],
      },
    } as never);
    expect(normalizedConfig?.baseUrl).toBe("https://openrouter.ai/api/v1");

    const normalizedGptModel = provider.normalizeResolvedModel?.({
      provider: "openrouter",
      model: {
        provider: "openrouter",
        id: "openai/gpt-5.4",
        name: "openai/gpt-5.4",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    } as never);
    expect(normalizedGptModel?.baseUrl).toBe("https://openrouter.ai/api/v1");

    const normalizedHunterModel = provider.normalizeResolvedModel?.({
      provider: "openrouter",
      model: {
        provider: "openrouter",
        id: "openrouter/hunter-alpha",
        name: "Hunter Alpha",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      },
    } as never);
    expect(normalizedHunterModel?.reasoning).toBe(false);
    expect(normalizedHunterModel?.id).toBe("openrouter/hunter-alpha");

    const normalizedAnthropicModel = provider.normalizeResolvedModel?.({
      provider: "openrouter",
      model: {
        provider: "openrouter",
        id: "openrouter/anthropic/claude-sonnet-4.6",
        name: "anthropic/claude-sonnet-4.6",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    } as never);
    expect(normalizedAnthropicModel?.id).toBe("anthropic/claude-sonnet-4.6");

    expect(
      provider.normalizeResolvedModel?.({
        provider: "openrouter",
        modelId: "openrouter/auto",
        model: {
          provider: "openrouter",
          id: "openrouter/auto",
          name: "OpenRouter Auto",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      } as never),
    ).toBeUndefined();

    const normalizedDuplicatedAutoModel = provider.normalizeResolvedModel?.({
      provider: "openrouter",
      modelId: "openrouter/openrouter/auto",
      model: {
        provider: "openrouter",
        id: "openrouter/openrouter/auto",
        name: "OpenRouter Auto",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    } as never);
    expect(normalizedDuplicatedAutoModel?.id).toBe("openrouter/auto");

    expect(
      provider.normalizeTransport?.({
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1",
      } as never),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("injects provider routing into compat before applying stream wrappers", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("openclaw/plugin-sdk/agent-core").StreamFn>
      ): ReturnType<import("openclaw/plugin-sdk/agent-core").StreamFn> => {
        const payload: Record<string, unknown> = {};
        void args[2]?.onPayload?.(payload, args[0]);
        capturedPayload = payload;
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "openai/gpt-5.4",
      extraParams: {
        provider: {
          order: ["moonshot"],
        },
      },
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    void wrapped?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "openai/gpt-5.4",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    const firstCall = baseStreamFn.mock.calls[0];
    const firstModel = firstCall?.[0];
    const compat = (firstModel as { compat?: { openRouterRouting?: { order?: unknown } } }).compat;
    expect(compat?.openRouterRouting?.order).toEqual(["moonshot"]);
    expect(capturedPayload?.provider).toEqual({
      order: ["moonshot"],
    });
  });

  it("forwards resolved API keys as explicit OpenRouter auth headers", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const baseStreamFn = vi.fn((..._args: unknown[]) =>
      createOpenRouterDoneStreamWithoutGeneration(),
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "openrouter/auto",
      streamFn: baseStreamFn,
    } as never);
    if (!wrapped) {
      throw new Error("expected OpenRouter wrapper");
    }

    const stream = await wrapped(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "openrouter/auto",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      { apiKey: "or-test-key" } as never,
    );
    await stream.result();

    expect(baseStreamFn).toHaveBeenCalledOnce();
    const options = baseStreamFn.mock.calls[0]?.[2] as { headers?: HeadersInit } | undefined;
    const headers = new Headers(options?.headers);
    expect(headers.get("authorization")).toBe("Bearer or-test-key");
    expect(headers.get("http-referer")).toBe("https://openclaw.ai");
    expect(headers.get("x-openrouter-title")).toBe("OpenClaw");
  });

  it("merges resolved OpenRouter model params into transport params", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const patch = provider.extraParamsForTransport?.({
      config: {
        models: {
          providers: {
            openrouter: {
              params: {
                provider: {
                  sort: "price",
                  data_collection: "deny",
                },
              },
            },
          },
        },
      },
      provider: "openrouter",
      modelId: "openai/gpt-5.4",
      extraParams: {
        provider: {
          sort: "latency",
          require_parameters: true,
        },
        temperature: 0.2,
      },
      model: {
        provider: "openrouter",
        api: "openai-completions",
        id: "openai/gpt-5.4",
        params: {
          responseCache: true,
          provider: {
            order: ["openai"],
            constructor: "ignored",
          },
        },
      },
      transport: "sse",
    } as never)?.patch;

    expect(patch?.responseCache).toBe(true);
    expect(patch?.temperature).toBe(0.2);
    expect(patch?.provider).toEqual({
      sort: "latency",
      data_collection: "deny",
      order: ["openai"],
      require_parameters: true,
    });
  });

  it("does not inject OpenRouter reasoning for Hunter Alpha", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("openclaw/plugin-sdk/agent-core").StreamFn>
      ): ReturnType<import("openclaw/plugin-sdk/agent-core").StreamFn> => {
        void args[2]?.onPayload?.({}, args[0]);
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "openrouter/hunter-alpha",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    void wrapped?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "openrouter/hunter-alpha",
        compat: {},
      } as never,
      { messages: [] } as never,
      {
        onPayload: (payload: unknown) => {
          capturedPayload = payload as Record<string, unknown>;
          return payload;
        },
      } as never,
    );

    expect(capturedPayload).toStrictEqual({});
    expect(baseStreamFn).toHaveBeenCalledOnce();
  });

  it("uses OpenRouter reasoning for DeepSeek V4 replay turns", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("openclaw/plugin-sdk/agent-core").StreamFn>
      ): ReturnType<import("openclaw/plugin-sdk/agent-core").StreamFn> => {
        const payload = {
          messages: [
            { role: "user", content: "read file" },
            { role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] },
            { role: "tool", content: "ok" },
            { role: "assistant", content: "done" },
          ],
        };
        void args[2]?.onPayload?.(payload, args[0]);
        capturedPayload = payload;
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
      streamFn: baseStreamFn,
      thinkingLevel: "xhigh",
    } as never);

    void wrapped?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "deepseek/deepseek-v4-flash",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(capturedPayload?.reasoning).toEqual({ effort: "xhigh" });
    expect(capturedPayload).not.toHaveProperty("thinking");
    expect(capturedPayload).not.toHaveProperty("reasoning_effort");
    expect(capturedPayload?.messages).toEqual([
      { role: "user", content: "read file" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_1", type: "function" }],
      },
      { role: "tool", content: "ok" },
      { role: "assistant", content: "done", reasoning_content: "" },
    ]);
    expect(baseStreamFn).toHaveBeenCalledOnce();
  });

  it("clamps OpenRouter DeepSeek V4 reasoning.effort to supported OpenRouter values", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("openclaw/plugin-sdk/agent-core").StreamFn>
      ): ReturnType<import("openclaw/plugin-sdk/agent-core").StreamFn> => {
        const payload = { reasoning: { effort: "high" }, messages: [] };
        void args[2]?.onPayload?.(payload, args[0]);
        payloads.push(payload);
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    for (const thinkingLevel of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      const wrapped = provider.wrapStreamFn?.({
        provider: "openrouter",
        modelId: "openrouter/deepseek/deepseek-v4-pro",
        streamFn: baseStreamFn,
        thinkingLevel,
      } as never);
      void wrapped?.(
        {
          provider: "openrouter",
          api: "openai-completions",
          id: "openrouter/deepseek/deepseek-v4-pro",
          baseUrl: "https://openrouter.ai/api/v1",
          compat: {},
        } as never,
        { messages: [] } as never,
        {},
      );
    }

    expect(payloads.map((payload) => (payload.reasoning as { effort?: unknown }).effort)).toEqual([
      "high",
      "high",
      "high",
      "high",
      "xhigh",
      "xhigh",
    ]);
    for (const payload of payloads) {
      expect(payload).not.toHaveProperty("thinking");
      expect(payload).not.toHaveProperty("reasoning_effort");
    }
  });

  it("strips disabled OpenRouter DeepSeek V4 reasoning replay fields", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("openclaw/plugin-sdk/agent-core").StreamFn>
      ): ReturnType<import("openclaw/plugin-sdk/agent-core").StreamFn> => {
        const payload = {
          reasoning: { effort: "high" },
          messages: [{ role: "assistant", content: "done", reasoning_content: "" }],
        };
        void args[2]?.onPayload?.(payload, args[0]);
        capturedPayload = payload;
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "openrouter/deepseek/deepseek-v4-pro",
      streamFn: baseStreamFn,
      thinkingLevel: "off",
    } as never);
    void wrapped?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "openrouter/deepseek/deepseek-v4-pro",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(capturedPayload).not.toHaveProperty("reasoning");
    expect(capturedPayload).not.toHaveProperty("thinking");
    expect(capturedPayload).not.toHaveProperty("reasoning_effort");
    expect(capturedPayload?.messages).toEqual([{ role: "assistant", content: "done" }]);
    expect(baseStreamFn).toHaveBeenCalledOnce();
  });

  it("recognizes full OpenRouter DeepSeek V4 refs but skips custom proxy routes", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("openclaw/plugin-sdk/agent-core").StreamFn>
      ): ReturnType<import("openclaw/plugin-sdk/agent-core").StreamFn> => {
        const payload = {
          messages: [{ role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] }],
        };
        void args[2]?.onPayload?.(payload, args[0]);
        payloads.push(payload);
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const fullRef = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "openrouter/deepseek/deepseek-v4-pro",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);
    void fullRef?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "openrouter/deepseek/deepseek-v4-pro",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    const customRoute = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-pro",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);
    void customRoute?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "deepseek/deepseek-v4-pro",
        baseUrl: "https://proxy.example.com/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(payloads[0]?.messages).toEqual([
      {
        role: "assistant",
        tool_calls: [{ id: "call_1", type: "function" }],
      },
    ]);
    expect(payloads[1]?.messages).toEqual([
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] },
    ]);
  });

  it("strips OpenRouter-routed Anthropic assistant prefill when reasoning is enabled", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("openclaw/plugin-sdk/agent-core").StreamFn>
      ): ReturnType<import("openclaw/plugin-sdk/agent-core").StreamFn> => {
        const payload = {
          messages: [
            { role: "user", content: "Return JSON." },
            { role: "assistant", content: "{" },
          ],
        };
        void args[2]?.onPayload?.(payload, args[0]);
        capturedPayload = payload;
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "anthropic/claude-opus-4.6",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    void wrapped?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "anthropic/claude-opus-4.6",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(capturedPayload?.messages).toEqual([{ role: "user", content: "Return JSON." }]);
    expect(capturedPayload?.reasoning).toEqual({ effort: "high" });
    expect(baseStreamFn).toHaveBeenCalledOnce();
  });

  it("keeps OpenRouter-routed Anthropic tool-use assistant messages when reasoning is enabled", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const messages = [
      { role: "user", content: "Use the tool." },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: {} }],
      },
    ];
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("openclaw/plugin-sdk/agent-core").StreamFn>
      ): ReturnType<import("openclaw/plugin-sdk/agent-core").StreamFn> => {
        const payload = { messages: [...messages] };
        void args[2]?.onPayload?.(payload, args[0]);
        capturedPayload = payload;
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "anthropic/claude-opus-4.6",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    void wrapped?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "anthropic/claude-opus-4.6",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(capturedPayload?.messages).toEqual(messages);
    expect(capturedPayload?.reasoning).toEqual({ effort: "high" });
    expect(baseStreamFn).toHaveBeenCalledOnce();
  });

  it("keeps OpenRouter Anthropic prefill when reasoning is disabled or the route is custom", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("openclaw/plugin-sdk/agent-core").StreamFn>
      ): ReturnType<import("openclaw/plugin-sdk/agent-core").StreamFn> => {
        const payload = {
          messages: [
            { role: "user", content: "Return JSON." },
            { role: "assistant", content: "{" },
          ],
        };
        void args[2]?.onPayload?.(payload, args[0]);
        payloads.push(payload);
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const disabled = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "anthropic/claude-opus-4.6",
      streamFn: baseStreamFn,
      thinkingLevel: "off",
    } as never);
    void disabled?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "anthropic/claude-opus-4.6",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    const customRoute = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "anthropic/claude-opus-4.6",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);
    void customRoute?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "anthropic/claude-opus-4.6",
        baseUrl: "https://proxy.example.com/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.messages).toHaveLength(2);
    expect(payloads[0]).not.toHaveProperty("reasoning");
    expect(payloads[1]?.messages).toHaveLength(2);
    expect(payloads[1]?.reasoning).toEqual({ effort: "high" });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
