import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderModernModelRef: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", () => {
  return {
    resolveProviderModernModelRef: providerRuntimeMocks.resolveProviderModernModelRef,
  };
});

import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import {
  DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT,
  isHighSignalLiveModelRef,
  isModernModelRef,
  isPrioritizedHighSignalLiveModelRef,
  listPrioritizedHighSignalLiveModelRefs,
  resolveHighSignalLiveModelLimit,
  selectHighSignalLiveItems,
} from "./live-model-filter.js";

const baseModel = (): Model<Api> =>
  ({
    id: "glm-4.7",
    name: "GLM-4.7",
    api: "openai-completions",
    provider: "zai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  }) as Model<Api>;

function supportsDeveloperRole(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole;
}

function supportsUsageInStreaming(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsUsageInStreaming?: boolean } | undefined)
    ?.supportsUsageInStreaming;
}

function supportsStrictMode(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsStrictMode?: boolean } | undefined)?.supportsStrictMode;
}

function expectSupportsDeveloperRoleForcedOff(overrides?: Partial<Model<Api>>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model<Api>);
  expect(supportsDeveloperRole(normalized)).toBe(false);
}

function expectSupportsUsageInStreamingForcedOff(overrides?: Partial<Model<Api>>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model<Api>);
  expect(supportsUsageInStreaming(normalized)).toBe(false);
}

function expectSupportsStrictModeForcedOff(overrides?: Partial<Model<Api>>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model<Api>);
  expect(supportsStrictMode(normalized)).toBe(false);
}

function expectNativeStreamingSupported(overrides: Partial<Model<Api>>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model<Api>);
  expect(supportsDeveloperRole(normalized)).toBe(false);
  expect(supportsUsageInStreaming(normalized)).toBe(true);
  expect(supportsStrictMode(normalized)).toBe(false);
}

beforeEach(() => {
  providerRuntimeMocks.resolveProviderModernModelRef.mockReset();
  providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(undefined);
});

describe("normalizeModelCompat — Anthropic baseUrl", () => {
  const anthropicBase = (): Model<Api> =>
    ({
      id: "claude-opus-4-6",
      name: "claude-opus-4-6",
      api: "anthropic-messages",
      provider: "anthropic",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    }) as Model<Api>;

  it("strips /v1 suffix from anthropic-messages baseUrl", () => {
    const model = { ...anthropicBase(), baseUrl: "https://api.anthropic.com/v1" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

  it("strips trailing /v1/ (with slash) from anthropic-messages baseUrl", () => {
    const model = { ...anthropicBase(), baseUrl: "https://api.anthropic.com/v1/" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

  it("leaves anthropic-messages baseUrl without /v1 unchanged", () => {
    const model = { ...anthropicBase(), baseUrl: "https://api.anthropic.com" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

  it("leaves baseUrl undefined unchanged for anthropic-messages", () => {
    const model = anthropicBase();
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBeUndefined();
  });

  it("does not strip /v1 from non-anthropic-messages models", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
      api: "openai-responses" as Api,
      baseUrl: "https://api.openai.com/v1",
    };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("strips /v1 from custom Anthropic proxy baseUrl", () => {
    const model = {
      ...anthropicBase(),
      baseUrl: "https://my-proxy.example.com/anthropic/v1",
    };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://my-proxy.example.com/anthropic");
  });
});

describe("normalizeModelCompat", () => {
  it("forces supportsDeveloperRole off for z.ai models", () => {
    expectSupportsDeveloperRoleForcedOff();
  });

  it("forces supportsDeveloperRole off for moonshot models", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "moonshot",
      baseUrl: "https://api.moonshot.ai/v1",
    });
  });

  it("forces supportsDeveloperRole off for custom moonshot-compatible endpoints", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "custom-kimi",
      baseUrl: "https://api.moonshot.cn/v1",
    });
  });

  it("forces supportsDeveloperRole off for DashScope provider ids", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
  });

  it("forces supportsDeveloperRole off for DashScope-compatible endpoints", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "custom-qwen",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    });
  });

  it("keeps supportsUsageInStreaming on for native Qwen endpoints", () => {
    expectNativeStreamingSupported({
      provider: "qwen",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    });
  });

  it("keeps supportsUsageInStreaming on for DashScope-compatible endpoints regardless of provider id", () => {
    expectNativeStreamingSupported({
      provider: "custom-qwen",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    });
  });

  it("keeps supportsUsageInStreaming on for Moonshot-native endpoints regardless of provider id", () => {
    expectNativeStreamingSupported({
      provider: "custom-kimi",
      baseUrl: "https://api.moonshot.ai/v1",
    });
  });

  it("leaves native api.openai.com model untouched", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat).toBeUndefined();
  });

  it("forces supportsDeveloperRole off for Azure OpenAI (Chat Completions, not Responses API)", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "azure-openai",
      baseUrl: "https://my-deployment.openai.azure.com/openai",
    });
  });
  it("forces supportsDeveloperRole off for generic custom openai-completions provider", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "custom-cpa",
      baseUrl: "https://cpa.example.com/v1",
    });
  });

  it("forces supportsUsageInStreaming off for generic custom openai-completions provider", () => {
    expectSupportsUsageInStreamingForcedOff({
      provider: "custom-cpa",
      baseUrl: "https://cpa.example.com/v1",
    });
  });

  it("forces supportsStrictMode off for z.ai models", () => {
    expectSupportsStrictModeForcedOff();
  });

  it("forces supportsStrictMode off for custom openai-completions provider", () => {
    expectSupportsStrictModeForcedOff({
      provider: "custom-cpa",
      baseUrl: "https://cpa.example.com/v1",
    });
  });

  it("forces supportsDeveloperRole off for Qwen proxy via openai-completions", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "qwen-proxy",
      baseUrl: "https://qwen-api.example.org/compatible-mode/v1",
    });
  });

  it("leaves openai-completions model with empty baseUrl untouched", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
    };
    delete (model as { baseUrl?: unknown }).baseUrl;
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model as Model<Api>);
    expect(normalized.compat).toBeUndefined();
  });

  it("forces supportsDeveloperRole off for malformed baseUrl values", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "custom-cpa",
      baseUrl: "://api.openai.com malformed",
    });
  });

  it("respects explicit supportsDeveloperRole true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsDeveloperRole: true },
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(true);
  });

  it("respects explicit supportsUsageInStreaming true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsUsageInStreaming: true },
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsUsageInStreaming(normalized)).toBe(true);
  });

  it("preserves explicit supportsUsageInStreaming false on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsUsageInStreaming: false },
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
  });

  it("still forces flags off when not explicitly set by user", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
    expect(supportsStrictMode(normalized)).toBe(false);
  });

  it("respects explicit supportsStrictMode true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsStrictMode: true },
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsStrictMode(normalized)).toBe(true);
  });

  it("does not mutate caller model when forcing supportsDeveloperRole off", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized).not.toBe(model);
    expect(supportsDeveloperRole(model)).toBeUndefined();
    expect(supportsUsageInStreaming(model)).toBeUndefined();
    expect(supportsStrictMode(model)).toBeUndefined();
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
    expect(supportsStrictMode(normalized)).toBe(false);
  });

  it("does not override explicit compat false", () => {
    const model = baseModel();
    model.compat = {
      supportsDeveloperRole: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
    expect(supportsStrictMode(normalized)).toBe(false);
  });

  it("leaves fully explicit non-native compat untouched", () => {
    const model = baseModel();
    model.baseUrl = "https://proxy.example.com/v1";
    model.compat = {
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
    };
    const normalized = normalizeModelCompat(model);
    expect(normalized).toBe(model);
  });

  it("preserves explicit usage compat when developer role is explicitly enabled", () => {
    const model = baseModel();
    model.baseUrl = "https://proxy.example.com/v1";
    model.compat = {
      supportsDeveloperRole: true,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(true);
    expect(supportsUsageInStreaming(normalized)).toBe(true);
    expect(supportsStrictMode(normalized)).toBe(true);
  });
});

describe("isModernModelRef", () => {
  it("uses provider runtime hooks before fallback heuristics", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(false);

    expect(isModernModelRef({ provider: "openrouter", id: "claude-opus-4-6" })).toBe(false);
  });

  it("includes plugin-advertised modern models", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(({ provider, context }) =>
      provider === "openai" &&
      ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano"].includes(
        context.modelId,
      )
        ? true
        : provider === "openai-codex" &&
            ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini"].includes(
              context.modelId,
            )
          ? true
          : provider === "opencode" && ["claude-opus-4-6", "gemini-3-pro"].includes(context.modelId)
            ? true
            : provider === "opencode-go"
              ? true
              : undefined,
    );

    expect(isModernModelRef({ provider: "openai", id: "gpt-5.5" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.5-pro" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4-pro" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4-mini" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4-nano" })).toBe(true);
    expect(isModernModelRef({ provider: "openai-codex", id: "gpt-5.5" })).toBe(true);
    expect(isModernModelRef({ provider: "openai-codex", id: "gpt-5.5-pro" })).toBe(true);
    expect(isModernModelRef({ provider: "openai-codex", id: "gpt-5.4" })).toBe(true);
    expect(isModernModelRef({ provider: "openai-codex", id: "gpt-5.4-pro" })).toBe(true);
    expect(isModernModelRef({ provider: "openai-codex", id: "gpt-5.4-mini" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode", id: "claude-opus-4-6" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode", id: "gemini-3-pro" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode-go", id: "kimi-k2.5" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode-go", id: "glm-5" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode-go", id: "minimax-m2.7" })).toBe(true);
  });

  it("matches plugin-advertised modern models across canonical provider aliases", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(({ provider, context }) =>
      provider === "zai" && context.modelId === "glm-5" ? true : undefined,
    );

    expect(isModernModelRef({ provider: "z.ai", id: "glm-5" })).toBe(true);
    expect(isModernModelRef({ provider: "z-ai", id: "glm-5" })).toBe(true);
  });

  it("excludes provider-declined modern models", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(({ provider, context }) =>
      provider === "opencode" && context.modelId === "minimax-m2.7" ? false : undefined,
    );

    expect(isModernModelRef({ provider: "opencode", id: "minimax-m2.7" })).toBe(false);
  });
});

describe("isHighSignalLiveModelRef", () => {
  it("keeps modern higher-signal Claude families", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(({ provider, context }) =>
      provider === "anthropic" && ["claude-sonnet-4-6", "claude-opus-4-6"].includes(context.modelId)
        ? true
        : undefined,
    );

    expect(isHighSignalLiveModelRef({ provider: "anthropic", id: "claude-sonnet-4-6" })).toBe(true);
    expect(isHighSignalLiveModelRef({ provider: "anthropic", id: "claude-opus-4-6" })).toBe(true);
  });

  it("drops low-signal or old Claude variants even when provider marks them modern", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expect(isHighSignalLiveModelRef({ provider: "anthropic", id: "claude-opus-4-5" })).toBe(false);
    expect(
      isHighSignalLiveModelRef({ provider: "anthropic", id: "claude-haiku-4-5-20251001" }),
    ).toBe(false);
    expect(
      isHighSignalLiveModelRef({ provider: "opencode", id: "claude-3-5-haiku-20241022" }),
    ).toBe(false);
  });

  it("keeps only curated Gemini routes in the default live matrix", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expect(isHighSignalLiveModelRef({ provider: "google", id: "gemini-2.5-flash-lite" })).toBe(
      false,
    );
    expect(isHighSignalLiveModelRef({ provider: "openrouter", id: "google/gemini-2.5-pro" })).toBe(
      false,
    );
    expect(isHighSignalLiveModelRef({ provider: "google", id: "gemini-3-flash-preview" })).toBe(
      true,
    );
    expect(isHighSignalLiveModelRef({ provider: "google", id: "gemini-3-pro-preview" })).toBe(
      false,
    );
    expect(
      isHighSignalLiveModelRef({ provider: "google", id: "gemini-3.1-pro-preview-customtools" }),
    ).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "google", id: "gemma-4-31b-it" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "google", id: "gemini-flash-latest" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "google", id: "gemini-flash-lite-latest" })).toBe(
      false,
    );
  });

  it("keeps only GPT-5.2 OpenAI-family models in the default live matrix", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expect(isHighSignalLiveModelRef({ provider: "openrouter", id: "openai/gpt-3.5-turbo" })).toBe(
      false,
    );
    expect(isHighSignalLiveModelRef({ provider: "openrouter", id: "openai/gpt-oss-120b" })).toBe(
      false,
    );
    expect(isHighSignalLiveModelRef({ provider: "openrouter", id: "openai/o1" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openai", id: "gpt-4.1" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openai", id: "gpt-4o" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openai", id: "gpt-5" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openai", id: "gpt-5.1" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openai", id: "gpt-5.4" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openai", id: "gpt-5.5" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openai", id: "gpt-5.2-codex" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openai", id: "gpt-5.2-chat-latest" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openrouter", id: "openai/gpt-5.1-chat" })).toBe(
      false,
    );
    expect(isHighSignalLiveModelRef({ provider: "opencode", id: "gpt-5.1-codex-mini" })).toBe(
      false,
    );
    expect(isHighSignalLiveModelRef({ provider: "openai", id: "gpt-5.2" })).toBe(true);
    expect(isHighSignalLiveModelRef({ provider: "openai-codex", id: "gpt-5.2" })).toBe(true);
    expect(isHighSignalLiveModelRef({ provider: "openai-codex", id: "gpt-5.2-codex" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openrouter", id: "openai/gpt-5.2-chat" })).toBe(
      true,
    );
  });

  it("drops old MiniMax 2.1 models from the default live matrix", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expect(isHighSignalLiveModelRef({ provider: "minimax", id: "MiniMax-M2.1" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openrouter", id: "minimax/minimax-m2.1" })).toBe(
      false,
    );
    expect(
      isHighSignalLiveModelRef({ provider: "openrouter", id: "minimax/minimax-m2.1:free" }),
    ).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "minimax", id: "MiniMax-M2.7" })).toBe(true);
    expect(isHighSignalLiveModelRef({ provider: "openrouter", id: "minimax/minimax-m2.7" })).toBe(
      true,
    );
  });

  it("keeps only curated OpenRouter routes in the default live matrix", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expect(isHighSignalLiveModelRef({ provider: "openrouter", id: "openai/gpt-5.2-chat" })).toBe(
      true,
    );
    expect(isHighSignalLiveModelRef({ provider: "openrouter", id: "minimax/minimax-m2.7" })).toBe(
      true,
    );
    expect(isHighSignalLiveModelRef({ provider: "openrouter", id: "ai21/jamba-large-1.7" })).toBe(
      true,
    );
    expect(
      isHighSignalLiveModelRef({ provider: "openrouter", id: "allenai/olmo-3.1-32b-instruct" }),
    ).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openrouter", id: "amazon/nova-lite-v1" })).toBe(
      false,
    );
    expect(isHighSignalLiveModelRef({ provider: "openrouter", id: "amazon/nova-micro-v1" })).toBe(
      false,
    );
  });

  it("drops GLM 4.x models from the default live matrix while keeping GLM 5", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expect(isHighSignalLiveModelRef({ provider: "zai", id: "glm-4.7" })).toBe(false);
    expect(
      isHighSignalLiveModelRef({ provider: "fireworks", id: "accounts/fireworks/models/glm-4p7" }),
    ).toBe(false);
    expect(
      isHighSignalLiveModelRef({
        provider: "fireworks",
        id: "accounts/fireworks/models/glm-4p5-air",
      }),
    ).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "zai", id: "glm-5.1" })).toBe(true);
    expect(
      isHighSignalLiveModelRef({ provider: "fireworks", id: "accounts/fireworks/models/glm-5" }),
    ).toBe(true);
    expect(
      isHighSignalLiveModelRef({ provider: "fireworks", id: "accounts/fireworks/models/glm-5p1" }),
    ).toBe(true);
    expect(
      isHighSignalLiveModelRef({
        provider: "fireworks",
        id: "accounts/fireworks/models/gpt-oss-120b",
      }),
    ).toBe(false);
    expect(
      isHighSignalLiveModelRef({
        provider: "fireworks",
        id: "accounts/fireworks/models/minimax-m2p7",
      }),
    ).toBe(false);
  });

  it("drops Fireworks Kimi routes from the default high-thinking live matrix", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expect(
      isHighSignalLiveModelRef({
        provider: "fireworks",
        id: "accounts/fireworks/models/kimi-k2p6",
      }),
    ).toBe(false);
    expect(
      isHighSignalLiveModelRef({
        provider: "fireworks",
        id: "accounts/fireworks/routers/kimi-k2p5-turbo",
      }),
    ).toBe(false);
  });

  it("keeps only curated xAI routes in the default live matrix", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expect(isHighSignalLiveModelRef({ provider: "xai", id: "grok-4.3" })).toBe(true);
    expect(isHighSignalLiveModelRef({ provider: "xai", id: "grok-3" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "xai", id: "grok-4-1-fast-non-reasoning" })).toBe(
      false,
    );
    expect(isHighSignalLiveModelRef({ provider: "xai", id: "grok-4-fast-non-reasoning" })).toBe(
      false,
    );
    expect(isHighSignalLiveModelRef({ provider: "xai", id: "grok-4-1-fast" })).toBe(false);
  });

  it("keeps DeepSeek V4 models in the default live matrix when the provider marks them modern", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(({ provider, context }) =>
      provider === "deepseek" && context.modelId.startsWith("deepseek-v4") ? true : undefined,
    );

    expect(isHighSignalLiveModelRef({ provider: "deepseek", id: "deepseek-v4-flash" })).toBe(true);
    expect(isHighSignalLiveModelRef({ provider: "deepseek", id: "deepseek-v4-pro" })).toBe(true);
    expect(isHighSignalLiveModelRef({ provider: "deepseek", id: "deepseek-chat" })).toBe(false);
  });
});

describe("isPrioritizedHighSignalLiveModelRef", () => {
  it("matches only curated priority entries without invoking provider runtime checks", () => {
    expect(
      isPrioritizedHighSignalLiveModelRef({
        provider: "anthropic",
        id: "claude-sonnet-4-6",
      }),
    ).toBe(true);
    expect(
      isPrioritizedHighSignalLiveModelRef({
        provider: "openrouter",
        id: "amazon/nova-lite-v1",
      }),
    ).toBe(false);
    expect(providerRuntimeMocks.resolveProviderModernModelRef).not.toHaveBeenCalled();
  });

  it("lists priority refs as provider/id pairs", () => {
    expect(listPrioritizedHighSignalLiveModelRefs()).toContainEqual({
      provider: "openai",
      id: "gpt-5.2",
    });
  });
});

describe("selectHighSignalLiveItems", () => {
  it("prefers curated Google replacements before fallback provider spread", () => {
    const items = [
      { provider: "anthropic", id: "claude-opus-4-7" },
      { provider: "anthropic", id: "claude-opus-4-6" },
      { provider: "google", id: "gemini-3.1-pro-preview" },
      { provider: "google", id: "gemini-3-flash-preview" },
      { provider: "deepseek", id: "deepseek-v4-flash" },
      { provider: "openai", id: "gpt-5.2" },
      { provider: "opencode", id: "big-pickle" },
    ];

    expect(
      selectHighSignalLiveItems(
        items,
        4,
        (item) => item,
        (item) => item.provider,
      ),
    ).toEqual([
      { provider: "anthropic", id: "claude-opus-4-7" },
      { provider: "anthropic", id: "claude-opus-4-6" },
      { provider: "google", id: "gemini-3.1-pro-preview" },
      { provider: "google", id: "gemini-3-flash-preview" },
    ]);
  });

  it("prioritizes DeepSeek V4 before later fallback providers", () => {
    const items = [
      { provider: "openai", id: "gpt-5.2" },
      { provider: "deepseek", id: "deepseek-v4-flash" },
      { provider: "deepseek", id: "deepseek-v4-pro" },
      { provider: "minimax", id: "minimax-m2.7" },
    ];

    expect(
      selectHighSignalLiveItems(
        items,
        3,
        (item) => item,
        (item) => item.provider,
      ),
    ).toEqual([
      { provider: "deepseek", id: "deepseek-v4-flash" },
      { provider: "deepseek", id: "deepseek-v4-pro" },
      { provider: "minimax", id: "minimax-m2.7" },
    ]);
  });

  it("prioritizes Fireworks GLM 5 models over GLM 4.x fallback entries", () => {
    const items = [
      { provider: "fireworks", id: "accounts/fireworks/models/glm-4p7" },
      { provider: "fireworks", id: "accounts/fireworks/models/glm-5" },
      { provider: "fireworks", id: "accounts/fireworks/models/glm-5p1" },
      { provider: "fireworks", id: "accounts/fireworks/models/gpt-oss-120b" },
    ];

    expect(
      selectHighSignalLiveItems(
        items,
        2,
        (item) => item,
        (item) => item.provider,
      ),
    ).toEqual([
      { provider: "fireworks", id: "accounts/fireworks/models/glm-5" },
      { provider: "fireworks", id: "accounts/fireworks/models/glm-5p1" },
    ]);
  });
});

describe("resolveHighSignalLiveModelLimit", () => {
  it("defaults modern live sweeps to the curated high-signal cap", () => {
    expect(
      resolveHighSignalLiveModelLimit({
        useExplicitModels: false,
      }),
    ).toBe(DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT);
  });

  it("leaves explicit model lists uncapped unless a cap is provided", () => {
    expect(
      resolveHighSignalLiveModelLimit({
        useExplicitModels: true,
      }),
    ).toBe(0);
    expect(
      resolveHighSignalLiveModelLimit({
        rawMaxModels: "3",
        useExplicitModels: true,
      }),
    ).toBe(3);
  });
});
