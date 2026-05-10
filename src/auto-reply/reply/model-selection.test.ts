import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_CONTEXT_TOKEN_CACHE } from "../../agents/context-cache.js";
import { loadModelCatalog } from "../../agents/model-catalog.runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createModelSelectionState, resolveContextTokens } from "./model-selection.js";

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.5" },
    { provider: "inferencer", id: "deepseek-v3-4bit-mlx", name: "DeepSeek V3" },
    { provider: "kimi", id: "kimi-code", name: "Kimi Code" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
    { provider: "xai", id: "grok-4", name: "Grok 4" },
    { provider: "xai", id: "grok-4.20-reasoning", name: "Grok 4.20 (Reasoning)" },
  ]),
}));

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

vi.mock("../../channels/plugins/session-conversation.js", () => ({
  resolveSessionParentSessionKey: (sessionKey?: string) =>
    sessionKey?.replace(/:thread:[^:]+$/, "").replace(/:topic:[^:]+$/, "") ?? null,
}));

const authProfileStoreMock = vi.hoisted(() => {
  let store = { version: 1, profiles: {} } as {
    version: 1;
    profiles: Record<string, { type: "api_key"; provider: string; key: string }>;
  };
  const ensureAuthProfileStore = vi.fn(() => store);
  return {
    get store() {
      return store;
    },
    set store(next) {
      store = next;
    },
    ensureAuthProfileStore,
    reset() {
      store = { version: 1, profiles: {} };
      ensureAuthProfileStore.mockClear();
    },
  };
});

vi.mock("../../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: authProfileStoreMock.ensureAuthProfileStore,
}));

afterEach(() => {
  MODEL_CONTEXT_TOKEN_CACHE.clear();
  authProfileStoreMock.reset();
});

const makeConfiguredModel = (overrides: Record<string, unknown> = {}) => ({
  id: "gpt-5.4",
  name: "GPT-5.4",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
  ...overrides,
});

describe("createModelSelectionState catalog loading", () => {
  it("skips full catalog loading for ordinary allowlist-backed turns", async () => {
    vi.mocked(loadModelCatalog).mockClear();
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "openai-codex/gpt-5.4": {},
          },
        },
      },
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel()],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.4",
      provider: "openai-codex",
      model: "gpt-5.4",
      hasModelDirective: false,
    });

    expect(state.allowedModelKeys.has("openai-codex/gpt-5.4")).toBe(true);
    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("low");
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
    expect(loadModelCatalog).not.toHaveBeenCalled();
  });

  it("uses the implicit model default when no global thinking default is configured", async () => {
    vi.mocked(loadModelCatalog).mockClear();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {},
          },
        },
      },
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel()],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.4",
      provider: "openai-codex",
      model: "gpt-5.4",
      hasModelDirective: false,
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("medium");
    expect(loadModelCatalog).not.toHaveBeenCalled();
  });

  it("hydrates runtime catalog metadata when the configured allowlist entry lacks reasoning", async () => {
    vi.mocked(loadModelCatalog).mockClear();
    vi.mocked(loadModelCatalog).mockResolvedValueOnce([
      { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
    ]);
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {},
          },
        },
      },
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel({ reasoning: undefined })],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.4",
      provider: "openai-codex",
      model: "gpt-5.4",
      hasModelDirective: false,
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("medium");
    expect(loadModelCatalog).toHaveBeenCalledOnce();
  });

  it("prefers per-agent thinkingDefault over model and global defaults", async () => {
    vi.mocked(loadModelCatalog).mockClear();
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "openai-codex/gpt-5.4": {
              params: { thinking: "high" },
            },
          },
        },
        list: [
          {
            id: "alpha",
            thinkingDefault: "minimal",
          },
        ],
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentId: "alpha",
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.4",
      provider: "openai-codex",
      model: "gpt-5.4",
      hasModelDirective: false,
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("minimal");
  });

  it("loads the full catalog for explicit model directives", async () => {
    vi.mocked(loadModelCatalog).mockClear();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o": {},
          },
        },
      },
    } as OpenClawConfig;

    await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
      hasModelDirective: true,
    });

    expect(loadModelCatalog).toHaveBeenCalledOnce();
  });

  it("uses the first visible provider wildcard model when the configured primary is filtered out", async () => {
    vi.mocked(loadModelCatalog).mockClear();
    vi.mocked(loadModelCatalog).mockResolvedValueOnce([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "openai-codex", id: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
      { provider: "vllm", id: "qwen3-local", name: "Qwen3 Local" },
    ]);
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "openai-codex/*": {},
            "vllm/*": {},
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      provider: "anthropic",
      model: "claude-opus-4-5",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai-codex");
    expect(state.model).toBe("gpt-5.5-codex");
    expect(state.allowedModelKeys.has("anthropic/claude-opus-4-5")).toBe(false);
    expect(loadModelCatalog).toHaveBeenCalledOnce();
  });

  it("does not reject wildcard-only policy before an explicit model directive is resolved", async () => {
    vi.mocked(loadModelCatalog).mockClear();
    vi.mocked(loadModelCatalog).mockResolvedValueOnce([]);
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "vllm/*": {},
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      provider: "anthropic",
      model: "claude-opus-4-5",
      hasModelDirective: true,
    });

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-5");
    expect(state.allowedModelKeys.has("vllm/*")).toBe(true);
    expect(loadModelCatalog).toHaveBeenCalledOnce();
  });

  it("keeps a stored dynamic provider wildcard model when the catalog has no rows yet", async () => {
    vi.mocked(loadModelCatalog).mockClear();
    vi.mocked(loadModelCatalog).mockResolvedValueOnce([]);
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "vllm/*": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      providerOverride: "vllm",
      modelOverride: "new-local-model",
      modelOverrideSource: "user",
    };
    const sessionStore = { main: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      provider: "anthropic",
      model: "claude-opus-4-5",
      hasModelDirective: false,
      sessionEntry,
      sessionStore,
      sessionKey: "main",
    });

    expect(state.provider).toBe("vllm");
    expect(state.model).toBe("new-local-model");
    expect(sessionStore.main.modelOverride).toBe("new-local-model");
    expect(loadModelCatalog).toHaveBeenCalledOnce();
  });

  it("preserves OpenAI API-key session auth when model policy explicitly pins PI", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "openai:work": { type: "api_key", provider: "openai", key: "sk-test" },
      },
    };
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      authProfileOverride: "openai:work",
    };
    const sessionStore = { main: sessionEntry };

    await createModelSelectionState({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "pi" },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: false,
      sessionEntry,
      sessionStore,
      sessionKey: "main",
    });

    expect(sessionEntry.authProfileOverride).toBe("openai:work");
    expect(sessionStore.main.authProfileOverride).toBe("openai:work");
  });
});

describe("resolveContextTokens", () => {
  it("prefers provider-qualified cache keys over bare model ids", () => {
    MODEL_CONTEXT_TOKEN_CACHE.set("gemini-3.1-pro-preview", 200_000);
    MODEL_CONTEXT_TOKEN_CACHE.set("google-gemini-cli/gemini-3.1-pro-preview", 1_000_000);

    const result = resolveContextTokens({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });

    expect(result).toBe(1_000_000);
  });

  it("treats agent contextTokens as a cap, not an expansion beyond the model window", () => {
    MODEL_CONTEXT_TOKEN_CACHE.set("openai/gpt-5.5", 272_000);

    const result = resolveContextTokens({
      cfg: {} as OpenClawConfig,
      agentCfg: { contextTokens: 1_000_000 },
      provider: "openai",
      model: "gpt-5.5",
    });

    expect(result).toBe(272_000);
  });

  it("allows agent contextTokens to lower a larger model window", () => {
    MODEL_CONTEXT_TOKEN_CACHE.set("qwen/qwen3.6-plus", 1_000_000);

    const result = resolveContextTokens({
      cfg: {} as OpenClawConfig,
      agentCfg: { contextTokens: 180_000 },
      provider: "qwen",
      model: "qwen3.6-plus",
    });

    expect(result).toBe(180_000);
  });
});

const makeEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "session-id",
  updatedAt: Date.now(),
  ...overrides,
});

describe("createModelSelectionState parent inheritance", () => {
  const defaultProvider = "openai";
  const defaultModel = "gpt-4o-mini";

  async function resolveState(params: {
    cfg: OpenClawConfig;
    sessionEntry: ReturnType<typeof makeEntry>;
    sessionStore: Record<string, ReturnType<typeof makeEntry>>;
    sessionKey: string;
    parentSessionKey?: string;
  }) {
    return createModelSelectionState({
      cfg: params.cfg,
      agentCfg: params.cfg.agents?.defaults,
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      parentSessionKey: params.parentSessionKey,
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });
  }

  async function resolveHeartbeatStoredOverrideState(hasResolvedHeartbeatModelOverride: boolean) {
    const cfg = {} as OpenClawConfig;
    const sessionKey = "agent:main:discord:channel:c1";
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    return createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      provider: "anthropic",
      model: "claude-opus-4-6",
      hasModelDirective: false,
      hasResolvedHeartbeatModelOverride,
    });
  }

  async function resolveStateWithParent(params: {
    cfg: OpenClawConfig;
    parentKey: string;
    sessionKey: string;
    parentEntry: ReturnType<typeof makeEntry>;
    sessionEntry?: ReturnType<typeof makeEntry>;
    parentSessionKey?: string;
  }) {
    const sessionEntry = params.sessionEntry ?? makeEntry();
    const sessionStore = {
      [params.parentKey]: params.parentEntry,
      [params.sessionKey]: sessionEntry,
    };
    return resolveState({
      cfg: params.cfg,
      sessionEntry,
      sessionStore,
      sessionKey: params.sessionKey,
      parentSessionKey: params.parentSessionKey,
    });
  }

  it("inherits parent override from explicit parentSessionKey", async () => {
    const cfg = {} as OpenClawConfig;
    const parentKey = "agent:main:discord:channel:c1";
    const sessionKey = "agent:main:discord:channel:c1:thread:123";
    const parentEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    const state = await resolveStateWithParent({
      cfg,
      parentKey,
      sessionKey,
      parentEntry,
      parentSessionKey: parentKey,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
  });

  it("derives parent key from topic session suffix", async () => {
    const cfg = {} as OpenClawConfig;
    const parentKey = "agent:main:telegram:group:123";
    const sessionKey = "agent:main:telegram:group:123:topic:99";
    const parentEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    const state = await resolveStateWithParent({
      cfg,
      parentKey,
      sessionKey,
      parentEntry,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
  });

  it("prefers child override over parent", async () => {
    const cfg = {} as OpenClawConfig;
    const parentKey = "agent:main:telegram:group:123";
    const sessionKey = "agent:main:telegram:group:123:topic:99";
    const parentEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    const sessionEntry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
    });
    const state = await resolveStateWithParent({
      cfg,
      parentKey,
      parentEntry,
      sessionEntry,
      sessionKey,
    });

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-6");
  });

  it("ignores parent override when disallowed", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o-mini": {},
          },
        },
      },
    } as OpenClawConfig;
    const parentKey = "agent:main:slack:channel:c1";
    const sessionKey = "agent:main:slack:channel:c1:thread:123";
    const parentEntry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
    });
    const state = await resolveStateWithParent({
      cfg,
      parentKey,
      sessionKey,
      parentEntry,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
  });

  it("applies stored override when heartbeat override was not resolved", async () => {
    const state = await resolveHeartbeatStoredOverrideState(false);

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
  });

  it("skips stored override when heartbeat override was resolved", async () => {
    const state = await resolveHeartbeatStoredOverrideState(true);

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-6");
  });
});

describe("createModelSelectionState respects session model override", () => {
  const defaultProvider = "inferencer";
  const defaultModel = "deepseek-v3-4bit-mlx";

  async function resolveState(sessionEntry: ReturnType<typeof makeEntry>) {
    const cfg = {} as OpenClawConfig;
    const sessionKey = "agent:main:main";
    const sessionStore = { [sessionKey]: sessionEntry };

    return createModelSelectionState({
      cfg,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });
  }

  it("applies session modelOverride when set", async () => {
    const state = await resolveState(
      makeEntry({
        providerOverride: "kimi-coding",
        modelOverride: "kimi-code",
      }),
    );

    expect(state.provider).toBe("kimi");
    expect(state.model).toBe("kimi-code");
  });

  it("falls back to default when no modelOverride is set", async () => {
    const state = await resolveState(makeEntry());

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
  });

  it("respects modelOverride even when session model field differs", async () => {
    // From issue #14783: stored override should beat last-used fallback model.
    const state = await resolveState(
      makeEntry({
        model: "kimi-code",
        modelProvider: "kimi",
        contextTokens: 262_000,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
      }),
    );

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-6");
  });

  it("uses default provider when providerOverride is not set but modelOverride is", async () => {
    const state = await resolveState(
      makeEntry({
        modelOverride: "deepseek-v3-4bit-mlx",
      }),
    );

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe("deepseek-v3-4bit-mlx");
  });

  it("splits legacy combined modelOverride when providerOverride is missing", async () => {
    const state = await resolveState(
      makeEntry({
        modelOverride: "ollama-beelink2/qwen2.5-coder:7b",
      }),
    );

    expect(state.provider).toBe("ollama-beelink2");
    expect(state.model).toBe("qwen2.5-coder:7b");
  });

  it("normalizes deprecated xai beta session overrides before allowlist checks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "xai/grok-4",
          },
          models: {
            "xai/grok-4": {},
            "xai/grok-4.20-experimental-beta-0304-reasoning": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:group:123:topic:99";
    const sessionEntry = makeEntry({
      providerOverride: "xai",
      modelOverride: "grok-4.20-experimental-beta-0304-reasoning",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "xai",
      defaultModel: "grok-4",
      provider: "xai",
      model: "grok-4",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("xai");
    expect(state.model).toBe("grok-4.20-beta-latest-reasoning");
    expect(state.resetModelOverride).toBe(false);
  });

  it("clears disallowed model overrides and falls back to the default", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-4o" },
          models: {
            "openai/gpt-4o": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:direct:1";
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
      hasModelDirective: false,
    });

    expect(state.resetModelOverride).toBe(true);
    expect(state.resetModelOverrideRef).toBe("openai/gpt-4o-mini");
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
  });

  it("keeps wildcard-provider overrides when configured catalog rows are unavailable", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "openai-codex/*": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:direct:1";
    const sessionEntry = makeEntry({
      providerOverride: "openai-codex",
      modelOverride: "gpt-added-after-startup",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai-codex");
    expect(state.model).toBe("gpt-added-after-startup");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openai-codex");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("gpt-added-after-startup");
  });

  it("keeps allowed legacy combined session overrides after normalization", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          models: {
            "anthropic/claude-opus-4-6": {},
            "ollama-beelink2/qwen2.5-coder:7b": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:direct:2";
    const sessionEntry = makeEntry({
      modelOverride: "ollama-beelink2/qwen2.5-coder:7b",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      provider: "anthropic",
      model: "claude-opus-4-6",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("ollama-beelink2");
    expect(state.model).toBe("qwen2.5-coder:7b");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.modelOverride).toBe("ollama-beelink2/qwen2.5-coder:7b");
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
  });
});

describe("createModelSelectionState auto-failover overrides", () => {
  const defaultProvider = "mac-studio";
  const defaultModel = "MiniMax-M2.7-MLX";
  const sessionKey = "agent:main:telegram:direct:1";

  async function resolveStateWithOverride(params: {
    providerOverride: string;
    modelOverride: string;
    modelOverrideSource: "auto" | "user" | undefined;
    modelOverrideFallbackOriginProvider?: string;
    modelOverrideFallbackOriginModel?: string;
    fallbackNoticeSelectedModel?: string;
    authProfileOverride?: string;
    authProfileOverrideSource?: "auto" | "user";
    provider?: string;
    model?: string;
    primaryProvider?: string;
    primaryModel?: string;
    isHeartbeat?: boolean;
  }) {
    const cfg = {} as OpenClawConfig;
    const sessionEntry = makeEntry({
      providerOverride: params.providerOverride,
      modelOverride: params.modelOverride,
      modelOverrideSource: params.modelOverrideSource,
      modelOverrideFallbackOriginProvider: params.modelOverrideFallbackOriginProvider,
      modelOverrideFallbackOriginModel: params.modelOverrideFallbackOriginModel,
      fallbackNoticeSelectedModel: params.fallbackNoticeSelectedModel,
      authProfileOverride: params.authProfileOverride,
      authProfileOverrideSource: params.authProfileOverrideSource,
    });
    const sessionStore = { [sessionKey]: sessionEntry };
    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      primaryProvider: params.primaryProvider,
      primaryModel: params.primaryModel,
      provider: params.provider ?? defaultProvider,
      model: params.model ?? defaultModel,
      hasModelDirective: false,
      isHeartbeat: params.isHeartbeat,
    });
    return { state, sessionEntry, sessionStore };
  }

  it("preserves auto-failover overrides across turns until reset", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openrouter");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBe("auto");
    expect(state.resetModelOverride).toBe(false);
  });

  it("still clears disallowed auto-failover overrides through allowlist validation", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: `${defaultProvider}/${defaultModel}` },
          models: {
            [`${defaultProvider}/${defaultModel}`]: {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionEntry = makeEntry({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      hasModelDirective: false,
    });

    expect(state.resetModelOverride).toBe(true);
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBeUndefined();
  });

  it("keeps pre-loaded fallback provider/model for an auto-failover override", async () => {
    const cfg = {} as OpenClawConfig;
    const sessionEntry = makeEntry({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
    });
    const sessionStore = { [sessionKey]: sessionEntry };
    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBe("auto");
    expect(state.resetModelOverride).toBe(false);
  });

  it("clears stale heartbeat auto-failover override when the fallback origin changed", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai-codex",
      modelOverrideFallbackOriginModel: "gpt-5.3",
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      isHeartbeat: true,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
    expect(state.resetModelOverride).toBe(true);
    expect(state.resetModelOverrideRef).toBe("openrouter/minimax/minimax-m2.7");
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideFallbackOriginProvider).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideFallbackOriginModel).toBeUndefined();
  });

  it("preserves user auth profile when clearing a stale heartbeat auto-failover override", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "mac-studio:local": {
          type: "api_key",
          provider: defaultProvider,
          key: "test-key",
        },
      },
    };
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai-codex",
      modelOverrideFallbackOriginModel: "gpt-5.3",
      authProfileOverride: "mac-studio:local",
      authProfileOverrideSource: "user",
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      isHeartbeat: true,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
    expect(state.resetModelOverride).toBe(true);
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.authProfileOverride).toBe("mac-studio:local");
    expect(sessionStore[sessionKey]?.authProfileOverrideSource).toBe("user");
  });

  it("keeps heartbeat auto-failover override when the fallback origin still matches default", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: defaultProvider,
      modelOverrideFallbackOriginModel: defaultModel,
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      isHeartbeat: true,
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openrouter");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
  });

  it("keeps heartbeat auto-failover override when the origin matches the channel primary", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-4o",
      primaryProvider: "openai",
      primaryModel: "gpt-4o",
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      isHeartbeat: true,
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openrouter");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
  });

  it("clears legacy heartbeat auto-failover override when no origin metadata exists", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      isHeartbeat: true,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
    expect(state.resetModelOverride).toBe(true);
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBeUndefined();
  });

  it("uses fallback notice metadata for legacy heartbeat auto-failover overrides", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      fallbackNoticeSelectedModel: `${defaultProvider}/${defaultModel}`,
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      isHeartbeat: true,
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBe("auto");
  });

  it("preserves a user-selected override across turns", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "user",
    });

    // User-selected override must persist.
    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openrouter");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
  });

  it("preserves a legacy override with no modelOverrideSource (treated as user)", async () => {
    // Sessions persisted before modelOverrideSource was introduced lack the field.
    // Backward-compat rule: missing source + present override = user selection.
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: undefined,
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
  });

  it("does not touch an auto-failover override inherited from a parent session", async () => {
    // Auto clearing only applies to a direct session override, not one inherited
    // from a parent. The parent's own session state is managed separately.
    const cfg = {} as OpenClawConfig;
    const parentKey = "agent:main:telegram:direct:1";
    const childKey = "agent:main:telegram:direct:1:thread:99";
    const parentEntry = makeEntry({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
    });
    const childEntry = makeEntry(); // no override of its own
    const sessionStore = { [parentKey]: parentEntry, [childKey]: childEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry: childEntry,
      sessionStore,
      sessionKey: childKey,
      parentSessionKey: parentKey,
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });

    // Parent auto-override is applied to the child (it has no direct override).
    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    // Parent session entry is not modified by the child's selection logic.
    expect(sessionStore[parentKey]?.providerOverride).toBe("openrouter");
    expect(state.resetModelOverride).toBe(false);
  });
});

describe("createModelSelectionState resolveDefaultReasoningLevel", () => {
  it("returns on when catalog model has reasoning true", async () => {
    const { loadModelCatalog } = await import("../../agents/model-catalog.runtime.js");
    vi.mocked(loadModelCatalog).mockResolvedValueOnce([
      { provider: "openrouter", id: "x-ai/grok-4.1-fast", name: "Grok", reasoning: true },
    ]);
    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "openrouter",
      defaultModel: "x-ai/grok-4.1-fast",
      provider: "openrouter",
      model: "x-ai/grok-4.1-fast",
      hasModelDirective: false,
    });
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
  });

  it("returns off when catalog model has no reasoning", async () => {
    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      provider: "openai",
      model: "gpt-4o-mini",
      hasModelDirective: false,
    });
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("off");
  });
});
