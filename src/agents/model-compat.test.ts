/**
 * Regression coverage for model compatibility and live-model curation.
 * Exercises catalog compatibility, provider modernity hooks, and live sweep selection.
 */
import path from "node:path";
import type { Api, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  DEFAULT_SMALL_LIVE_MODEL_LIMIT,
  isHighSignalLiveModelRef,
  isModernModelRef,
  isPrioritizedHighSignalLiveModelRef,
  isSmallLiveModelRef,
  listPrioritizedHighSignalLiveModelRefs,
  listPrioritizedSmallLiveModelRefs,
  resolveHighSignalLiveModelLimit,
  selectHighSignalLiveItems,
  selectSmallLiveItems,
} from "./live-model-filter.js";

const baseModel = (): Model =>
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
  }) as Model;

function supportsDeveloperRole(model: Model): boolean | undefined {
  return (model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole;
}

function supportsUsageInStreaming(model: Model): boolean | undefined {
  return (model.compat as { supportsUsageInStreaming?: boolean } | undefined)
    ?.supportsUsageInStreaming;
}

function supportsStrictMode(model: Model): boolean | undefined {
  return (model.compat as { supportsStrictMode?: boolean } | undefined)?.supportsStrictMode;
}

function expectSupportsDeveloperRoleForcedOff(overrides?: Partial<Model>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model);
  expect(supportsDeveloperRole(normalized)).toBe(false);
}

function expectSupportsUsageInStreamingForcedOff(overrides?: Partial<Model>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model);
  expect(supportsUsageInStreaming(normalized)).toBe(false);
}

function expectSupportsStrictModeForcedOff(overrides?: Partial<Model>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model);
  expect(supportsStrictMode(normalized)).toBe(false);
}

function expectNativeStreamingSupported(overrides: Partial<Model>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model);
  expect(supportsDeveloperRole(normalized)).toBe(false);
  expect(supportsUsageInStreaming(normalized)).toBe(true);
  expect(supportsStrictMode(normalized)).toBe(false);
}

beforeEach(() => {
  // Endpoint capabilities come from manifests. Keep source tests independent
  // from partial dist output left by an earlier build in the same checkout.
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
  providerRuntimeMocks.resolveProviderModernModelRef.mockReset();
  providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeModelCompat — Anthropic baseUrl", () => {
  const anthropicBase = (): Model =>
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
    }) as Model;

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
  it.each([
    ["z.ai models", undefined],
    ["moonshot models", { provider: "moonshot", baseUrl: "https://api.moonshot.ai/v1" }],
    [
      "custom moonshot-compatible endpoints",
      { provider: "custom-kimi", baseUrl: "https://api.moonshot.cn/v1" },
    ],
    [
      "DashScope provider ids",
      { provider: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    ],
    [
      "DashScope-compatible endpoints",
      {
        provider: "custom-qwen",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      },
    ],
    [
      "Azure OpenAI chat completions",
      { provider: "azure-openai", baseUrl: "https://my-deployment.openai.azure.com/openai" },
    ],
    [
      "generic custom openai-completions providers",
      { provider: "custom-cpa", baseUrl: "https://cpa.example.com/v1" },
    ],
    [
      "Qwen proxy via openai-completions",
      { provider: "qwen-proxy", baseUrl: "https://qwen-api.example.org/compatible-mode/v1" },
    ],
    [
      "malformed baseUrl values",
      { provider: "custom-cpa", baseUrl: "://api.openai.com malformed" },
    ],
  ] satisfies Array<[string, Partial<Model> | undefined]>)(
    "forces supportsDeveloperRole off for %s",
    (_name, overrides) => {
      expectSupportsDeveloperRoleForcedOff(overrides);
    },
  );

  it.each([
    [
      "native Qwen endpoints",
      {
        provider: "qwen",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      },
    ],
    [
      "DashScope-compatible endpoints regardless of provider id",
      {
        provider: "custom-qwen",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      },
    ],
    [
      "Moonshot-native endpoints regardless of provider id",
      { provider: "custom-kimi", baseUrl: "https://api.moonshot.ai/v1" },
    ],
  ] satisfies Array<[string, Partial<Model>]>)(
    "keeps supportsUsageInStreaming on for %s",
    (_name, overrides) => {
      expectNativeStreamingSupported(overrides);
    },
  );

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

  it("forces supportsUsageInStreaming off for generic custom openai-completions provider", () => {
    expectSupportsUsageInStreamingForcedOff({
      provider: "custom-cpa",
      baseUrl: "https://cpa.example.com/v1",
    });
  });

  it.each([
    ["z.ai models", undefined],
    [
      "custom openai-completions providers",
      { provider: "custom-cpa", baseUrl: "https://cpa.example.com/v1" },
    ],
  ] satisfies Array<[string, Partial<Model> | undefined]>)(
    "forces supportsStrictMode off for %s",
    (_name, overrides) => {
      expectSupportsStrictModeForcedOff(overrides);
    },
  );

  it("leaves openai-completions model with empty baseUrl untouched", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
    };
    delete (model as { baseUrl?: unknown }).baseUrl;
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model as Model);
    expect(normalized.compat).toBeUndefined();
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
        : provider === "openai" &&
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
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.5" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.5-pro" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4-pro" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4-mini" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode", id: "claude-opus-4-6" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode", id: "gemini-3-pro" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode-go", id: "kimi-k2.5" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode-go", id: "glm-5" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode-go", id: "minimax-m2.7" })).toBe(true);
  });

  it("matches plugin-advertised modern models only for exact provider ids", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(({ provider, context }) =>
      provider === "z.ai" && context.modelId === "glm-5" ? true : undefined,
    );

    expect(isModernModelRef({ provider: "z.ai", id: "glm-5" })).toBe(true);
    expect(isModernModelRef({ provider: "z-ai", id: "glm-5" })).toBe(false);
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
    expect(isHighSignalLiveModelRef({ provider: "google", id: "gemini-3.5-flash" })).toBe(true);
    expect(isHighSignalLiveModelRef({ provider: "google", id: "gemini-3-flash-preview" })).toBe(
      false,
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

  it("keeps only the current direct OpenAI-family model in the default live matrix", () => {
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
    expect(isHighSignalLiveModelRef({ provider: "openai", id: "gpt-5.5" })).toBe(true);
    expect(isHighSignalLiveModelRef({ provider: "openai", id: "gpt-5.2-codex" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openai", id: "gpt-5.2-chat-latest" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openrouter", id: "openai/gpt-5.1-chat" })).toBe(
      false,
    );
    expect(isHighSignalLiveModelRef({ provider: "opencode", id: "gpt-5.1-codex-mini" })).toBe(
      false,
    );
    expect(isHighSignalLiveModelRef({ provider: "openai", id: "gpt-5.2" })).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "openai", id: "gpt-5.2-codex" })).toBe(false);
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
    expect(isHighSignalLiveModelRef({ provider: "minimax", id: "MiniMax-M3" })).toBe(true);
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
    ).toBe(false);
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

    expect(
      isHighSignalLiveModelRef({ provider: "xai", id: "grok-4.20-beta-latest-reasoning" }),
    ).toBe(false);
    expect(isHighSignalLiveModelRef({ provider: "xai", id: "grok-4.20-0309-reasoning" })).toBe(
      true,
    );
    expect(isHighSignalLiveModelRef({ provider: "xai", id: "grok-4.5" })).toBe(true);
    expect(isHighSignalLiveModelRef({ provider: "xai", id: "grok-4.3" })).toBe(false);
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
    expect(listPrioritizedHighSignalLiveModelRefs()).toStrictEqual([
      { provider: "anthropic", id: "claude-opus-4-8" },
      { provider: "anthropic", id: "claude-sonnet-5" },
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "anthropic", id: "claude-opus-4-7" },
      { provider: "google", id: "gemini-3.1-pro-preview" },
      { provider: "google", id: "gemini-3.5-flash" },
      { provider: "cohere", id: "command-a-plus-05-2026" },
      { provider: "moonshot", id: "kimi-k2.7-code" },
      { provider: "anthropic", id: "claude-opus-4-6" },
      { provider: "deepseek", id: "deepseek-v4-flash" },
      { provider: "deepseek", id: "deepseek-v4-pro" },
      { provider: "minimax", id: "minimax-m3" },
      { provider: "openai", id: "gpt-5.5" },
      { provider: "openrouter", id: "openai/gpt-5.2-chat" },
      { provider: "openrouter", id: "minimax/minimax-m2.7" },
      { provider: "opencode-go", id: "glm-5" },
      { provider: "openrouter", id: "ai21/jamba-large-1.7" },
      { provider: "xai", id: "grok-4.5" },
      { provider: "xai", id: "grok-4.20-0309-reasoning" },
      { provider: "zai", id: "glm-5.1" },
      { provider: "fireworks", id: "accounts/fireworks/models/glm-5p1" },
      { provider: "minimax-portal", id: "minimax-m3" },
    ]);
  });
});

describe("isSmallLiveModelRef", () => {
  it("matches the small-model live matrix without requiring provider modern hooks", () => {
    expect(isSmallLiveModelRef({ provider: "lmstudio", id: "Qwen/Qwen3.5-9B" })).toBe(true);
    expect(isSmallLiveModelRef({ provider: "ollama", id: "gemma3:4b" })).toBe(true);
    expect(isSmallLiveModelRef({ provider: "openrouter", id: "qwen/qwen3.5-9b" })).toBe(true);
    expect(isSmallLiveModelRef({ provider: "openrouter", id: "z-ai/glm-5.1" })).toBe(true);
    expect(isSmallLiveModelRef({ provider: "openai", id: "gpt-5.5" })).toBe(false);
    expect(providerRuntimeMocks.resolveProviderModernModelRef).not.toHaveBeenCalled();
  });
});

describe("listPrioritizedSmallLiveModelRefs", () => {
  it("lists priority refs as provider/id pairs", () => {
    expect(listPrioritizedSmallLiveModelRefs()).toStrictEqual([
      { provider: "lmstudio", id: "qwen/qwen3.5-9b" },
      { provider: "vllm", id: "qwen/qwen3-8b" },
      { provider: "sglang", id: "qwen/qwen3-8b" },
      { provider: "ollama", id: "gemma3:4b" },
      { provider: "openrouter", id: "qwen/qwen3.5-9b" },
      { provider: "openrouter", id: "z-ai/glm-5.1" },
      { provider: "openrouter", id: "z-ai/glm-5" },
      { provider: "zai", id: "glm-5.1" },
    ]);
  });
});

describe("selectHighSignalLiveItems", () => {
  it("prefers curated Google replacements before fallback provider spread", () => {
    const items = [
      { provider: "anthropic", id: "claude-opus-4-8" },
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "anthropic", id: "claude-opus-4-7" },
      { provider: "anthropic", id: "claude-opus-4-6" },
      { provider: "google", id: "gemini-3.1-pro-preview" },
      { provider: "google", id: "gemini-3.5-flash" },
      { provider: "deepseek", id: "deepseek-v4-flash" },
      { provider: "openai", id: "gpt-5.5" },
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
      { provider: "anthropic", id: "claude-opus-4-8" },
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "anthropic", id: "claude-opus-4-7" },
      { provider: "google", id: "gemini-3.1-pro-preview" },
    ]);
  });

  it("prioritizes DeepSeek V4 before later fallback providers", () => {
    const items = [
      { provider: "openai", id: "gpt-5.5" },
      { provider: "deepseek", id: "deepseek-v4-flash" },
      { provider: "deepseek", id: "deepseek-v4-pro" },
      { provider: "minimax", id: "minimax-m3" },
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
      { provider: "minimax", id: "minimax-m3" },
    ]);
  });

  it("prioritizes supported Fireworks GLM 5 models over GLM 4.x fallback entries", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);
    const items = [
      { provider: "fireworks", id: "accounts/fireworks/models/glm-4p7" },
      { provider: "fireworks", id: "accounts/fireworks/models/glm-5" },
      { provider: "fireworks", id: "accounts/fireworks/models/glm-5p1" },
      { provider: "fireworks", id: "accounts/fireworks/models/gpt-oss-120b" },
    ].filter(isHighSignalLiveModelRef);

    expect(
      selectHighSignalLiveItems(
        items,
        2,
        (item) => item,
        (item) => item.provider,
      ),
    ).toEqual([{ provider: "fireworks", id: "accounts/fireworks/models/glm-5p1" }]);
  });
});

describe("selectSmallLiveItems", () => {
  it("prefers constrained local and hosted small-model routes before fallback spread", () => {
    const items = [
      { provider: "openrouter", id: "z-ai/glm-5" },
      { provider: "openai", id: "gpt-5.5" },
      { provider: "vllm", id: "qwen/qwen3-8b" },
      { provider: "lmstudio", id: "qwen/qwen3.5-9b" },
      { provider: "ollama", id: "gemma3:4b" },
      { provider: "openrouter", id: "qwen/qwen3.5-9b" },
    ];

    expect(
      selectSmallLiveItems(
        items,
        3,
        (item) => item,
        (item) => item.provider,
      ),
    ).toEqual([
      { provider: "lmstudio", id: "qwen/qwen3.5-9b" },
      { provider: "vllm", id: "qwen/qwen3-8b" },
      { provider: "ollama", id: "gemma3:4b" },
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

  it("can default small live sweeps to the curated small-model cap", () => {
    expect(
      resolveHighSignalLiveModelLimit({
        useExplicitModels: false,
        defaultLimit: DEFAULT_SMALL_LIVE_MODEL_LIMIT,
      }),
    ).toBe(DEFAULT_SMALL_LIVE_MODEL_LIMIT);
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
