import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";

const mocks = vi.hoisted(() => ({
  refreshOpenAICodexToken: vi.fn(),
  openAIResponsesTransportStreamFn: vi.fn(),
}));

vi.mock("./openai-codex-provider.runtime.js", () => ({
  refreshOpenAICodexToken: mocks.refreshOpenAICodexToken,
}));

vi.mock("openclaw/plugin-sdk/provider-stream-family", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/provider-stream-family")>();
  const wrapStreamFn: NonNullable<typeof actual.OPENAI_RESPONSES_STREAM_HOOKS.wrapStreamFn> = (
    ctx,
  ) => {
    let nextStreamFn = actual.createOpenAIAttributionHeadersWrapper(ctx.streamFn, {
      codexNativeTransportStreamFn: mocks.openAIResponsesTransportStreamFn,
    });

    if (actual.resolveOpenAIFastMode(ctx.extraParams)) {
      nextStreamFn = actual.createOpenAIFastModeWrapper(nextStreamFn);
    }

    const serviceTier = actual.resolveOpenAIServiceTier(ctx.extraParams);
    if (serviceTier) {
      nextStreamFn = actual.createOpenAIServiceTierWrapper(nextStreamFn, serviceTier);
    }

    const textVerbosity = actual.resolveOpenAITextVerbosity(ctx.extraParams);
    if (textVerbosity) {
      nextStreamFn = actual.createOpenAITextVerbosityWrapper(nextStreamFn, textVerbosity);
    }

    nextStreamFn = actual.createCodexNativeWebSearchWrapper(nextStreamFn, {
      config: ctx.config,
      agentDir: ctx.agentDir,
    });
    return actual.createOpenAIResponsesContextManagementWrapper(
      actual.createOpenAIReasoningCompatibilityWrapper(nextStreamFn),
      ctx.extraParams,
    );
  };

  return {
    ...actual,
    OPENAI_RESPONSES_STREAM_HOOKS: {
      ...actual.OPENAI_RESPONSES_STREAM_HOOKS,
      wrapStreamFn,
    },
  };
});

function runWrappedPayloadCase(params: {
  wrap: NonNullable<ReturnType<typeof buildOpenAIProvider>["wrapStreamFn"]>;
  provider: string;
  modelId: string;
  model:
    | Model<"openai-responses">
    | Model<"openai-codex-responses">
    | Model<"azure-openai-responses">;
  extraParams?: Record<string, unknown>;
  cfg?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}) {
  const payload = params.payload ?? { store: false };
  let capturedOptions: (SimpleStreamOptions & { openaiWsWarmup?: boolean }) | undefined;
  const baseStreamFn: StreamFn = (model, _context, options) => {
    capturedOptions = options as (SimpleStreamOptions & { openaiWsWarmup?: boolean }) | undefined;
    options?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };

  const streamFn = params.wrap({
    provider: params.provider,
    modelId: params.modelId,
    extraParams: params.extraParams,
    config: params.cfg as never,
    agentDir: "/tmp/openai-provider-test",
    streamFn: baseStreamFn,
  } as never);

  const context: Context = { messages: [] };
  void streamFn?.(params.model, context, {});

  return {
    payload,
    options: capturedOptions,
  };
}

describe("buildOpenAIProvider", () => {
  beforeEach(() => {
    mocks.openAIResponsesTransportStreamFn.mockReset();
    mocks.openAIResponsesTransportStreamFn.mockImplementation(() => {
      throw new Error("unexpected native OpenAI Responses transport call");
    });
  });

  it("exposes grouped model/auth picker labels for API key setup", () => {
    const provider = buildOpenAIProvider();
    const apiKey = provider.auth.find((method) => method.id === "api-key");

    expect(apiKey?.wizard).toMatchObject({
      choiceLabel: "OpenAI API Key",
      groupId: "openai",
      groupLabel: "OpenAI",
      groupHint: "Direct API key",
    });
  });

  it("resolves gpt-5.4 mini and nano from GPT-5 small-model templates", () => {
    const provider = buildOpenAIProvider();
    const registry = {
      find(providerId: string, id: string) {
        if (providerId !== "openai") {
          return null;
        }
        if (id === "gpt-5-mini") {
          return {
            id,
            name: "GPT-5 mini",
            provider: "openai",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 400_000,
            maxTokens: 128_000,
          };
        }
        if (id === "gpt-5-nano") {
          return {
            id,
            name: "GPT-5 nano",
            provider: "openai",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 64_000,
          };
        }
        return null;
      },
    };

    const mini = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-mini",
      modelRegistry: registry as never,
    });
    const nano = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-nano",
      modelRegistry: registry as never,
    });

    expect(mini).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-mini",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    expect(nano).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-nano",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("surfaces gpt-5.4 mini and nano in xhigh and augmented catalog metadata", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-5.4-mini",
        } as never)
        ?.levels.some((level) => level.id === "xhigh"),
    ).toBe(true);
    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-5.4-nano",
        } as never)
        ?.levels.some((level) => level.id === "xhigh"),
    ).toBe(true);

    const entries = provider.augmentModelCatalog?.({
      env: process.env,
      entries: [
        { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
        { provider: "openai", id: "gpt-5-nano", name: "GPT-5 nano" },
      ],
    } as never);

    expect(entries).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.4-mini",
        name: "gpt-5.4-mini",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.4-nano",
        name: "gpt-5.4-nano",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
      }),
    );
  });

  it("owns native reasoning output mode for OpenAI and Azure OpenAI responses", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
      } as never),
    ).toBe("native");
    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "azure-openai-responses",
        modelApi: "azure-openai-responses",
        modelId: "gpt-5.4",
      } as never),
    ).toBe("native");
  });

  it("keeps GPT-5.4 family metadata aligned with native OpenAI docs", () => {
    const provider = buildOpenAIProvider();
    const codexProvider = buildOpenAICodexProviderPlugin();

    const openaiModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
    } as never);
    const codexModel = codexProvider.resolveDynamicModel?.({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
    } as never);

    expect(openaiModel).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
    expect(codexModel).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
  });

  it("leaves gpt-5.5 to Pi and resolves gpt-5.5-pro locally", () => {
    const provider = buildOpenAIProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.5",
      modelRegistry: {
        find: (_provider: string, id: string) =>
          id === "gpt-5.4"
            ? {
                id,
                name: "GPT-5.4",
                provider: "openai",
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
                contextWindow: 1_050_000,
                maxTokens: 128_000,
              }
            : null,
      } as never,
    });
    const pro = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.5-pro",
      modelRegistry: {
        find: (_provider: string, id: string) =>
          id === "gpt-5.4-pro"
            ? {
                id,
                name: "GPT-5.4 Pro",
                provider: "openai",
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_050_000,
                maxTokens: 128_000,
              }
            : null,
      } as never,
    });

    expect(model).toBeUndefined();
    expect(pro).toMatchObject({
      provider: "openai",
      id: "gpt-5.5-pro",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("surfaces gpt-5.5 in xhigh without synthetic catalog metadata", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-5.5",
        } as never)
        ?.levels.some((level) => level.id === "xhigh"),
    ).toBe(true);

    const entries = provider.augmentModelCatalog?.({
      env: process.env,
      entries: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4" }],
    } as never);

    expect(entries).not.toContainEqual(
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.5",
      }),
    );
  });

  it("keeps modern live selection on OpenAI 5.2+ and Codex 5.2+", () => {
    const provider = buildOpenAIProvider();
    const codexProvider = buildOpenAICodexProviderPlugin();

    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.0",
      } as never),
    ).toBe(false);
    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.2",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.4",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.5",
      } as never),
    ).toBe(true);

    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.1-codex",
      } as never),
    ).toBe(false);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.1-codex-max",
      } as never),
    ).toBe(false);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.2-codex",
      } as never),
    ).toBe(true);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.4",
      } as never),
    ).toBe(true);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.5",
      } as never),
    ).toBe(true);
  });

  it("owns replay policy for OpenAI and Codex transports", () => {
    const provider = buildOpenAIProvider();
    const codexProvider = buildOpenAICodexProviderPlugin();

    expect(
      provider.buildReplayPolicy?.({
        provider: "openai",
        modelApi: "openai",
        modelId: "gpt-5.4",
      } as never),
    ).toEqual({
      sanitizeMode: "images-only",
      applyAssistantFirstOrderingFix: false,
      sanitizeToolCallIds: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });

    expect(
      provider.buildReplayPolicy?.({
        provider: "openai",
        modelApi: "openai-completions",
        modelId: "gpt-5.4",
      } as never),
    ).toEqual({
      sanitizeMode: "images-only",
      applyAssistantFirstOrderingFix: false,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });

    expect(
      codexProvider.buildReplayPolicy?.({
        provider: "openai-codex",
        modelApi: "openai-codex-responses",
        modelId: "gpt-5.4",
      } as never),
    ).toEqual({
      sanitizeMode: "images-only",
      applyAssistantFirstOrderingFix: false,
      sanitizeToolCallIds: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });
  });

  it("owns direct OpenAI wrapper composition for responses payloads", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }
    const extraParams = provider.prepareExtraParams?.({
      provider: "openai",
      modelId: "gpt-5.4",
      extraParams: {
        fastMode: true,
        serviceTier: "priority",
        textVerbosity: "low",
      },
    } as never);
    const result = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      extraParams: extraParams ?? undefined,
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 200_000,
      } as Model<"openai-responses">,
      payload: {
        reasoning: { effort: "none" },
      },
    });

    expect(extraParams).toMatchObject({
      transport: "auto",
      openaiWsWarmup: true,
    });
    expect(result.payload.store).toBe(true);
    expect(result.payload.context_management).toEqual([
      { type: "compaction", compact_threshold: 140_000 },
    ]);
    expect(result.payload.service_tier).toBe("priority");
    expect(result.payload.text).toEqual({ verbosity: "low" });
    expect(result.payload.reasoning).toEqual({ effort: "none" });
    expect(result.payload.tools).toEqual([{ type: "web_search" }]);
  });

  it("uses native OpenAI web search instead of the managed web_search function", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const result = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: {
        tools: [
          { type: "function", name: "read" },
          { type: "function", name: "web_search" },
        ],
      },
    });

    expect(result.payload.tools).toEqual([
      { type: "function", name: "read" },
      { type: "web_search" },
    ]);
  });

  it("raises minimal reasoning when native OpenAI web search is injected", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const result = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: {
        reasoning: { effort: "minimal", summary: "auto" },
      },
    });

    expect(result.payload.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(result.payload.tools).toEqual([{ type: "web_search" }]);
  });

  it("does not inject native OpenAI web search when disabled or proxied", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const disabled = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      cfg: { tools: { web: { search: { enabled: false } } } },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: { tools: [{ type: "function", name: "web_search" }] },
    });
    const proxied = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://example-proxy.invalid/v1",
      } as Model<"openai-responses">,
      payload: { tools: [{ type: "function", name: "web_search" }] },
    });

    expect(disabled.payload.tools).toEqual([{ type: "function", name: "web_search" }]);
    expect(proxied.payload.tools).toEqual([{ type: "function", name: "web_search" }]);
  });

  it("keeps managed web_search when another search provider is configured", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const result = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      cfg: { tools: { web: { search: { enabled: true, provider: "brave" } } } },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: { tools: [{ type: "function", name: "web_search" }] },
    });

    expect(result.payload.tools).toEqual([{ type: "function", name: "web_search" }]);
  });

  it("preserves explicit OpenAI responses transport and warmup overrides", () => {
    const provider = buildOpenAIProvider();

    const explicit = {
      transport: "websocket",
      openaiWsWarmup: false,
      fastMode: true,
    };

    expect(
      provider.prepareExtraParams?.({
        provider: "openai",
        modelId: "gpt-5.4",
        extraParams: explicit,
      } as never),
    ).toBe(explicit);
  });

  it("defaults Codex responses transport without forcing warmup flags", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(
      provider.prepareExtraParams?.({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        extraParams: { effort: "high" },
      } as never),
    ).toEqual({
      effort: "high",
      transport: "auto",
    });

    const explicit = {
      transport: "sse",
      openaiWsWarmup: false,
    };
    expect(
      provider.prepareExtraParams?.({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        extraParams: explicit,
      } as never),
    ).toBe(explicit);
  });

  it("shares OpenAI responses wrapper composition across provider variants", () => {
    const provider = buildOpenAIProvider();
    const codexProvider = buildOpenAICodexProviderPlugin();

    expect(provider.wrapStreamFn).toBe(codexProvider.wrapStreamFn);
    expect(provider.buildReplayPolicy).toBe(codexProvider.buildReplayPolicy);
    expect(provider.resolveTransportTurnState).toBe(codexProvider.resolveTransportTurnState);
    expect(provider.resolveWebSocketSessionPolicy).toBe(
      codexProvider.resolveWebSocketSessionPolicy,
    );
  });

  it("owns Azure OpenAI reasoning compatibility without forcing OpenAI transport defaults", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected Azure OpenAI wrapper");
    }
    const result = runWrappedPayloadCase({
      wrap,
      provider: "azure-openai-responses",
      modelId: "gpt-5.4",
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-5.4",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as Model<"azure-openai-responses">,
      payload: {
        reasoning: { effort: "none" },
      },
    });

    expect(result.options?.transport).toBeUndefined();
    expect(result.options?.openaiWsWarmup).toBeUndefined();
    expect(result.payload.reasoning).toEqual({ effort: "none" });
  });

  it("owns Codex wrapper composition for responses payloads", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected Codex wrapper");
    }
    const payload = {
      store: false,
      text: { verbosity: "medium" },
      tools: [{ type: "function", name: "read" }],
    };
    mocks.openAIResponsesTransportStreamFn.mockImplementation((model, _context, options) => {
      options?.onPayload?.(payload, model);
      return {} as ReturnType<StreamFn>;
    });
    const result = runWrappedPayloadCase({
      wrap,
      provider: "openai-codex",
      modelId: "gpt-5.4",
      extraParams: {
        fastMode: true,
        serviceTier: "priority",
        text_verbosity: "high",
      },
      cfg: {
        auth: {
          profiles: {
            "openai-codex:default": {
              provider: "openai-codex",
              mode: "oauth",
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: {
                enabled: true,
                mode: "live",
                allowedDomains: ["example.com"],
              },
            },
          },
        },
      },
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api",
      } as Model<"openai-codex-responses">,
      payload,
    });

    expect(mocks.openAIResponsesTransportStreamFn).not.toHaveBeenCalled();
    expect(result.options?.headers).toMatchObject({
      originator: "openclaw",
      "User-Agent": expect.stringMatching(/^openclaw\//u),
    });
    expect(result.payload.store).toBe(false);
    expect(result.payload.service_tier).toBe("priority");
    expect(result.payload.text).toEqual({ verbosity: "high" });
    expect(result.payload.tools).toEqual([
      { type: "function", name: "read" },
      {
        type: "web_search",
        external_web_access: true,
        filters: { allowed_domains: ["example.com"] },
      },
    ]);
  });
  it("falls back to cached codex oauth credentials on accountId extraction failures", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      type: "oauth" as const,
      provider: "openai-codex",
      access: "cached-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
    };

    mocks.refreshOpenAICodexToken.mockReset();
    mocks.refreshOpenAICodexToken.mockRejectedValueOnce(
      new Error("Failed to extract accountId from token"),
    );

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(credential);
  });
});
