// Tests model selection resolution from directives, config, and session state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_CONTEXT_TOKEN_CACHE,
  providerContextTokenCacheKey,
} from "../../agents/context-cache.js";
import {
  loadManifestModelCatalog,
  loadPreparedModelCatalog as loadModelCatalogLocal,
} from "../../agents/model-catalog.runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";
import { createModelSelectionState, resolveContextTokens } from "./model-selection.js";

const DEFAULT_MOCK_CATALOG_ENTRIES = vi.hoisted(() => [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.5" },
  { provider: "inferencer", id: "deepseek-v3-4bit-mlx", name: "DeepSeek V3" },
  { provider: "kimi", id: "kimi-code", name: "Kimi Code" },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  { provider: "xai", id: "grok-4", name: "Grok 4" },
  { provider: "xai", id: "grok-4.20-reasoning", name: "Grok 4.20 (Reasoning)" },
]);

const catalogRuntimeMocks = vi.hoisted(() => {
  const loadModelCatalog = vi.fn(
    async (_params?: unknown): Promise<unknown[]> => DEFAULT_MOCK_CATALOG_ENTRIES,
  );
  return {
    loadModelCatalog,
    // Delegate to the entries mock so per-test `loadModelCatalog.mockResolvedValueOnce`
    // still drives selection; tests that need a degraded snapshot override this directly.
    loadModelCatalogSnapshot: vi.fn(async (params?: unknown) => {
      const entries = await loadModelCatalog(params as never);
      return { entries, routeVariants: entries, authoritative: true };
    }),
  };
});

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadManifestModelCatalog: vi.fn(() => []),
  loadPreparedModelCatalog: catalogRuntimeMocks.loadModelCatalog,
  loadPreparedModelCatalogSnapshot: catalogRuntimeMocks.loadModelCatalogSnapshot,
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

// Alias-aware stub: mirrors the real isStoredCredentialCompatibleWithAuthProvider
// but inlines the claude-cli->anthropic alias so tests don't need live plugin metadata.
vi.mock("../../agents/auth-profiles/order.js", () => ({
  isStoredCredentialCompatibleWithAuthProvider: ({
    provider,
    credential,
  }: {
    provider: string;
    credential: { type: string; provider: string };
  }) => {
    const normalize = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const resolveAuthKey = (v: string) => {
      const n = normalize(v);
      // claude-cli is a deprecated choice id that resolves to the anthropic auth key
      if (n === "claudecli") {
        return "anthropic";
      }
      return n;
    };
    const providerKey = resolveAuthKey(provider);
    const credentialKey = resolveAuthKey(credential.provider);
    if (credentialKey === providerKey) {
      return true;
    }
    // OpenAI Codex compat: openai api_key credential works for openai-codex provider
    if (providerKey === "openaiapicodex" || providerKey === "openaicodex") {
      return credentialKey === "openai" && credential.type === "api_key";
    }
    return false;
  },
}));

afterEach(() => {
  MODEL_CONTEXT_TOKEN_CACHE.clear();
  vi.mocked(loadManifestModelCatalog).mockReset();
  vi.mocked(loadManifestModelCatalog).mockReturnValue([]);
  authProfileStoreMock.reset();
});

const makeConfiguredModel = (overrides: Record<string, unknown> = {}) => ({
  id: "gpt-5.4",
  name: "GPT-5.4",
  reasoning: true,
  input: ["text"] as Array<"text">,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
  ...overrides,
});

describe("createModelSelectionState catalog loading", () => {
  it("skips full catalog loading for ordinary allowlist-backed turns", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel()],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
      provider: "openai",
      model: "gpt-5.4",
      hasModelDirective: false,
    });

    expect(state.allowedModelKeys.has("openai/gpt-5.4")).toBe(true);
    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("low");
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it.each(["high", "ultra"] as const)(
    "prefers per-model params.thinking=%s over global thinkingDefault",
    async (thinking) => {
      vi.mocked(loadModelCatalogLocal).mockClear();
      const cfg = {
        agents: {
          defaults: {
            thinkingDefault: "low",
            models: {
              "openai-codex/gpt-5.4": {
                params: { thinking },
              },
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

      await expect(state.resolveDefaultThinkingLevel()).resolves.toBe(thinking);
      expect(loadModelCatalogLocal).not.toHaveBeenCalled();
    },
  );

  it("keeps per-model disabled params.thinking ahead of global thinkingDefault", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "deepseek/deepseek-v4-pro": {
              params: { thinking: false },
            },
          },
        },
      },
      models: {
        providers: {
          deepseek: {
            baseUrl: "https://api.deepseek.com/v1",
            models: [makeConfiguredModel({ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" })],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "deepseek",
      defaultModel: "deepseek-v4-pro",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      hasModelDirective: false,
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("off");
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it("uses the implicit model default when no global thinking default is configured", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel()],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
      provider: "openai",
      model: "gpt-5.4",
      hasModelDirective: false,
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("medium");
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it("hydrates runtime catalog metadata when the configured allowlist entry lacks reasoning", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
    ]);
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel({ reasoning: undefined })],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
      provider: "openai",
      model: "gpt-5.4",
      hasModelDirective: false,
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("medium");
    expect(loadModelCatalogLocal).toHaveBeenCalledOnce();
  });

  it("uses manifest metadata before hydrating the runtime thinking catalog", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadManifestModelCatalog).mockClear();
    vi.mocked(loadManifestModelCatalog).mockReturnValueOnce([
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5", reasoning: true },
    ]);
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {},
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: false,
    });

    await expect(state.resolveThinkingCatalog()).resolves.toEqual([
      expect.objectContaining({ provider: "openai", id: "gpt-5.5", reasoning: true }),
    ]);
    expect(loadManifestModelCatalog).toHaveBeenCalledWith({
      config: cfg,
      fallbackToMetadataScan: false,
    });
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it("keeps configured compat when manifest thinking metadata is used", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadManifestModelCatalog).mockReturnValueOnce([
      { provider: "vllm", id: "Qwen/Qwen3-8B", name: "Qwen3", reasoning: true },
    ]);
    const cfg = {
      agents: {
        defaults: {
          models: {
            "vllm/Qwen/Qwen3-8B": {},
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "http://localhost:9000/v1",
            models: [
              makeConfiguredModel({
                id: "Qwen/Qwen3-8B",
                name: "Qwen3",
                compat: { thinkingFormat: "qwen-chat-template" },
              }),
            ],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "vllm",
      defaultModel: "Qwen/Qwen3-8B",
      provider: "vllm",
      model: "Qwen/Qwen3-8B",
      hasModelDirective: false,
    });

    await expect(state.resolveThinkingCatalog()).resolves.toEqual([
      expect.objectContaining({
        provider: "vllm",
        id: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ]);
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it("keeps configured compat when runtime thinking catalog is already loaded", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([
      {
        provider: "vllm",
        id: "Qwen/Qwen3-8B",
        name: "Qwen3",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["xhigh"] },
      },
    ]);
    const cfg = {
      agents: {
        defaults: {
          models: {
            "vllm/Qwen/Qwen3-8B": {},
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "http://localhost:9000/v1",
            models: [
              makeConfiguredModel({
                id: "Qwen/Qwen3-8B",
                name: "Qwen3",
                compat: { thinkingFormat: "qwen-chat-template" },
              }),
            ],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "vllm",
      defaultModel: "Qwen/Qwen3-8B",
      provider: "vllm",
      model: "Qwen/Qwen3-8B",
      hasModelDirective: true,
    });

    await expect(state.resolveThinkingCatalog()).resolves.toEqual([
      expect.objectContaining({
        provider: "vllm",
        id: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: {
          supportedReasoningEfforts: ["xhigh"],
          thinkingFormat: "qwen-chat-template",
        },
      }),
    ]);
    expect(loadModelCatalogLocal).toHaveBeenCalledOnce();
  });

  it("prefers per-agent thinkingDefault over model and global defaults", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "openai/gpt-5.4": {
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
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
      provider: "openai",
      model: "gpt-5.4",
      hasModelDirective: false,
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("minimal");
  });

  it("loads the full catalog for explicit model directives", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
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

    expect(loadModelCatalogLocal).toHaveBeenCalledOnce();
    expect(vi.mocked(loadModelCatalogLocal).mock.calls[0]?.[0]).not.toHaveProperty("readOnly");
  });

  it("carries catalog context limits into cold model selection", async () => {
    vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        contextWindow: 1_000_000,
        contextTokens: 272_000,
      },
    ]);

    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: { contextTokens: 1_000_000 },
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: true,
    });

    expect(
      resolveContextTokens({
        cfg: {} as OpenClawConfig,
        agentCfg: { contextTokens: 1_000_000 },
        provider: state.provider,
        model: state.model,
        modelContextWindow: state.modelContextWindow,
        modelContextTokens: state.modelContextTokens,
      }),
    ).toBe(272_000);
  });

  it("uses the first visible provider wildcard model when the configured primary is filtered out", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "openai", id: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
      { provider: "vllm", id: "qwen3-local", name: "Qwen3 Local" },
    ]);
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "openai/*": {},
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

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.5-codex");
    expect(state.allowedModelKeys.has("anthropic/claude-opus-4-5")).toBe(false);
    expect(loadModelCatalogLocal).toHaveBeenCalledOnce();
  });

  it("does not reject wildcard-only policy before an explicit model directive is resolved", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([]);
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
    expect(loadModelCatalogLocal).toHaveBeenCalledOnce();
  });

  it("keeps a stored dynamic provider wildcard model when the catalog has no rows yet", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([]);
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
    expect(loadModelCatalogLocal).toHaveBeenCalledOnce();
  });

  it("preserves OpenAI API-key session auth when model policy explicitly pins OpenClaw", async () => {
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
              agentRuntime: { id: "openclaw" },
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
    MODEL_CONTEXT_TOKEN_CACHE.set(
      providerContextTokenCacheKey("google-gemini-cli", "gemini-3.1-pro-preview"),
      1_000_000,
    );

    const result = resolveContextTokens({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });

    expect(result).toBe(1_000_000);
  });

  it("treats agent contextTokens as a cap, not an expansion beyond the model window", () => {
    MODEL_CONTEXT_TOKEN_CACHE.set(providerContextTokenCacheKey("openai", "gpt-5.5"), 272_000);

    const result = resolveContextTokens({
      cfg: {} as OpenClawConfig,
      agentCfg: { contextTokens: 1_000_000 },
      provider: "openai",
      model: "gpt-5.5",
    });

    expect(result).toBe(272_000);
  });

  it("allows agent contextTokens to lower a larger model window", () => {
    MODEL_CONTEXT_TOKEN_CACHE.set(providerContextTokenCacheKey("qwen", "qwen3.6-plus"), 1_000_000);

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

    expect(state.provider).toBe("kimi-coding");
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

  it("preserves xai beta session overrides during allowlist checks", async () => {
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
    expect(state.model).toBe("grok-4.20-experimental-beta-0304-reasoning");
    expect(state.resetModelOverride).toBe(false);
  });

  it("keeps provider-qualified stored overrides when providerOverride is also persisted", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "openai/gpt-5.5": {},
            "openai/gpt-5.4": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:dashboard:child";
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "openai/gpt-5.5",
      modelOverrideSource: "user",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.4",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.5");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openai");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("openai/gpt-5.5");
  });

  it("normalizes provider-qualified parent stored overrides before allowlist checks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "openai/gpt-5.5": {},
            "openai/gpt-5.4": {},
          },
        },
      },
    } as OpenClawConfig;
    const parentSessionKey = "agent:main:dashboard:parent";
    const sessionKey = "agent:main:dashboard:child";
    const sessionEntry = makeEntry();
    const parentEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "openai/gpt-5.5",
      modelOverrideSource: "user",
    });
    const sessionStore = { [sessionKey]: sessionEntry, [parentSessionKey]: parentEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      parentSessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.4",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.5");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[parentSessionKey]?.modelOverride).toBe("openai/gpt-5.5");
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
  });

  it("clears disallowed model overrides and falls back to the default", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4o",
            fallbacks: ["openai/gpt-4o-mini"],
          },
          models: {
            "openai/gpt-4o": {},
          },
          modelPolicy: { allow: ["openai/gpt-4o"] },
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

  it("rejects automatic repair of a locked disallowed override", async () => {
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
    const sessionKey = "agent:main:telegram:direct:locked";
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
      modelOverrideSource: "user",
      modelSelectionLocked: true,
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    await expect(
      createModelSelectionState({
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
      }),
    ).rejects.toMatchObject({
      name: "ModelSelectionLockedError",
      message: MODEL_SELECTION_LOCKED_MESSAGE,
    });
    expect(sessionStore[sessionKey]).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
      modelOverrideSource: "user",
      modelSelectionLocked: true,
    });
  });

  it("adopts a concurrent valid model while repairing a stale override", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-repair-race-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-4o" },
          models: {
            "openai/gpt-4o": {},
            "openai/gpt-5.5": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:direct:1";
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
    });
    const concurrentEntry = makeEntry({
      updatedAt: sessionEntry.updatedAt + 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    });
    await replaceSessionEntry({ sessionKey, storePath }, concurrentEntry);
    const sessionStore = { [sessionKey]: sessionEntry };

    try {
      const state = await createModelSelectionState({
        cfg,
        agentCfg: cfg.agents?.defaults,
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        defaultProvider: "openai",
        defaultModel: "gpt-4o",
        provider: "openai",
        model: "gpt-4o-mini",
        hasModelDirective: false,
      });

      expect(state).toMatchObject({
        provider: "openai",
        model: "gpt-5.5",
        resetModelOverride: false,
      });
      expect(sessionEntry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "user",
      });
      expect(sessionStore[sessionKey]).toEqual(sessionEntry);
      expect(loadSessionEntry({ sessionKey, storePath })).toEqual(sessionEntry);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects stale-model repair when the session rotates during persistence", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-repair-rotation-"));
    const storePath = path.join(tempRoot, "sessions.json");
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
      sessionId: "s1",
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
    });
    const rotatedEntry = makeEntry({
      sessionId: "s2",
      updatedAt: sessionEntry.updatedAt + 1,
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
    });
    await replaceSessionEntry({ sessionKey, storePath }, rotatedEntry);
    const sessionStore = { [sessionKey]: sessionEntry };

    try {
      await expect(
        createModelSelectionState({
          cfg,
          agentCfg: cfg.agents?.defaults,
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
          defaultProvider: "openai",
          defaultModel: "gpt-4o",
          provider: "openai",
          model: "gpt-4o-mini",
          hasModelDirective: false,
        }),
      ).rejects.toThrow(/changed while starting work/i);

      expect(sessionEntry).toMatchObject({
        sessionId: "s1",
        providerOverride: "openai",
        modelOverride: "gpt-4o-mini",
      });
      expect(sessionStore[sessionKey]).toBe(sessionEntry);
      expect(loadSessionEntry({ sessionKey, storePath })).toEqual(rotatedEntry);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps wildcard-provider overrides when configured catalog rows are unavailable", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "openai/*": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:direct:1";
    const sessionEntry = makeEntry({
      providerOverride: "openai",
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

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-added-after-startup");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openai");
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
    skipStoredModelOverride?: boolean;
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
      skipStoredModelOverride: params.skipStoredModelOverride,
    });
    return { state, sessionEntry, sessionStore };
  }

  it("clears legacy auto-failover overrides without origin metadata on normal turns", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBeUndefined();
    expect(state.resetModelOverride).toBe(true);
    expect(state.resetModelOverrideRef).toBe("openrouter/minimax/minimax-m2.7");
  });

  it("preserves auto-failover overrides that still carry origin metadata on normal turns", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: defaultProvider,
      modelOverrideFallbackOriginModel: defaultModel,
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openrouter");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBe("auto");
  });

  it("keeps a legacy auto pin when the current selection already matches it", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openrouter");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBe("auto");
  });

  it("clears stale auto-created legacy openai route pins when primary is canonical openai", async () => {
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "auto",
      modelProvider: "openai",
      model: "gpt-5.5",
      contextTokens: 350_000,
      authProfileOverride: "openai:default",
      authProfileOverrideSource: "auto",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      primaryProvider: "openai",
      primaryModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.5");
    expect(state.resetModelOverride).toBe(true);
    expect(state.resetModelOverrideRef).toBe("openai/gpt-5.5");
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelProvider).toBeUndefined();
    expect(sessionStore[sessionKey]?.model).toBeUndefined();
    expect(sessionStore[sessionKey]?.contextTokens).toBeUndefined();
    expect(sessionStore[sessionKey]?.authProfileOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.authProfileOverrideSource).toBeUndefined();
  });

  it("preserves usable Codex auth while clearing stale legacy openai route pins", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "test-key",
        },
      },
    };
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "auto",
      authProfileOverride: "openai:default",
      authProfileOverrideSource: "auto",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      primaryProvider: "openai",
      primaryModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.5");
    expect(state.resetModelOverride).toBe(true);
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.authProfileOverride).toBe("openai:default");
    expect(sessionStore[sessionKey]?.authProfileOverrideSource).toBe("auto");
  });

  it("keeps auto openai pins when canonical openai uses a custom API route", async () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.test/v1",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "auto",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      primaryProvider: "openai",
      primaryModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.5");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openai");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("gpt-5.5");
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBe("auto");
  });

  it("keeps explicit user openai route overrides", async () => {
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      primaryProvider: "openai",
      primaryModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.5");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openai");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("gpt-5.5");
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBe("user");
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

  it("can suppress a stored auto-failover override for a primary recovery probe", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: defaultProvider,
      modelOverrideFallbackOriginModel: defaultModel,
      authProfileOverride: "openrouter:fallback",
      authProfileOverrideSource: "auto",
      provider: defaultProvider,
      model: defaultModel,
      skipStoredModelOverride: true,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openrouter");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
    expect(sessionStore[sessionKey]?.authProfileOverride).toBe("openrouter:fallback");
    expect(sessionStore[sessionKey]?.authProfileOverrideSource).toBe("auto");
  });

  it("clears stale heartbeat auto-failover override when the fallback origin changed", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai",
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
      modelOverrideFallbackOriginProvider: "openai",
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

  it("keeps recovered heartbeat auto-failover override without modelOverrideSource", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: undefined,
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
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBeUndefined();
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

describe("createModelSelectionState auth-profile override flapping regression", () => {
  const sessionKey = "agent:main:telegram:direct:1";

  it("keeps alias-compatible authProfileOverride when stored credential provider is 'anthropic' for a claude-cli session", async () => {
    // Regression: the old code compared profile.provider directly to acceptedAuthProviders,
    // which cleared an 'anthropic' credential when the session ran under the 'claude-cli'
    // provider. The alias (claude-cli -> anthropic) must be respected so the override is kept.
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "api_key",
          provider: "anthropic",
          key: "test-cli-oauth-token",
        },
      },
    };
    const sessionEntry: SessionEntry = {
      sessionId: "s-cli",
      updatedAt: 1,
      authProfileOverride: "anthropic:claude-cli",
    };
    const sessionStore = { [sessionKey]: sessionEntry };

    await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "claude-cli",
      defaultModel: "claude-opus-4-7",
      provider: "claude-cli",
      model: "claude-opus-4-7",
      hasModelDirective: false,
    });

    // The override must NOT have been cleared — the anthropic credential is
    // alias-compatible with the claude-cli provider.
    expect(sessionStore[sessionKey]?.authProfileOverride).toBe("anthropic:claude-cli");
    expect(sessionEntry.authProfileOverride).toBe("anthropic:claude-cli");
  });
});

describe("createModelSelectionState resolveDefaultReasoningLevel", () => {
  it("uses manifest metadata before hydrating the runtime reasoning catalog", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadManifestModelCatalog).mockClear();
    vi.mocked(loadManifestModelCatalog).mockReturnValueOnce([
      { provider: "local", id: "fast-reasoner", name: "Fast Reasoner", reasoning: true },
    ]);
    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "local",
      defaultModel: "fast-reasoner",
      provider: "local",
      model: "fast-reasoner",
      hasModelDirective: false,
    });

    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
    expect(loadManifestModelCatalog).toHaveBeenCalledWith({
      config: {},
      fallbackToMetadataScan: false,
    });
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it("returns on when catalog model has reasoning true", async () => {
    const { loadPreparedModelCatalog: loadModelCatalogForCase } =
      await import("../../agents/model-catalog.runtime.js");
    vi.mocked(loadModelCatalogForCase).mockResolvedValueOnce([
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

describe("createModelSelectionState degraded-catalog override preservation", () => {
  const sessionKey = "agent:main:discord:channel:g1";
  // The `anthropic/*` wildcard (a non-default provider) forces the live catalog
  // load path (`needsModelCatalog`), which is the only path where a degraded
  // catalog can transiently drop a pin. Every test must load the snapshot so its
  // one-time mock is consumed and cannot leak into a sibling test.
  //
  // Allow-list without gpt-4o, so the pinned override reads as "not allowed"
  // whenever the catalog cannot vouch for it. The authoritative flag then
  // decides whether that reads as a genuine disallow or a transient outage.
  const restrictiveCfg = {
    agents: { defaults: { models: { "openai/gpt-4o-mini": {}, "anthropic/*": {} } } },
  } as unknown as OpenClawConfig;
  // Permissive allow-list that keeps gpt-4o allowed regardless of the catalog.
  const permissiveCfg = {
    agents: {
      defaults: { models: { "openai/gpt-4o": {}, "openai/gpt-4o-mini": {}, "anthropic/*": {} } },
    },
  } as unknown as OpenClawConfig;

  const makeOverrideEntry = (): SessionEntry => ({
    sessionId: "session-id",
    updatedAt: Date.now(),
    providerOverride: "openai",
    modelOverride: "gpt-4o",
    modelOverrideSource: "user",
  });

  async function run(params: {
    cfg: OpenClawConfig;
    snapshotEntries: unknown[];
    authoritative: boolean;
  }): Promise<{
    state: Awaited<ReturnType<typeof createModelSelectionState>>;
    sessionEntry: SessionEntry;
  }> {
    catalogRuntimeMocks.loadModelCatalogSnapshot.mockResolvedValueOnce({
      entries: params.snapshotEntries,
      routeVariants: params.snapshotEntries,
      authoritative: params.authoritative,
    });
    const sessionEntry = makeOverrideEntry();
    const sessionStore = { [sessionKey]: sessionEntry };
    const state = await createModelSelectionState({
      cfg: params.cfg,
      agentCfg: params.cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      primaryProvider: "openai",
      primaryModel: "gpt-4o-mini",
      provider: "openai",
      model: "gpt-4o-mini",
      hasModelDirective: false,
    });
    return { state, sessionEntry };
  }

  it("preserves a pin the degraded catalog cannot vouch for", async () => {
    // Degraded snapshot: we cannot prove the pin is really disallowed, so keep it.
    const { state, sessionEntry } = await run({
      cfg: restrictiveCfg,
      snapshotEntries: [],
      authoritative: false,
    });
    expect(state.resetModelOverride).toBe(false);
    expect(state.resetModelOverrideReason).toBe("temporarily-unavailable");
    expect(state.resetModelOverrideRef).toBe("openai/gpt-4o");
    // The pin is untouched and the turn falls back to primary.
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(state.model).toBe("gpt-4o-mini");
  });

  it("destroys a genuinely-disallowed pin on an authoritative catalog", async () => {
    // Same disallowed pin, but an authoritative catalog proves it is gone.
    const { state } = await run({
      cfg: restrictiveCfg,
      snapshotEntries: [{ provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" }],
      authoritative: true,
    });
    expect(state.resetModelOverrideReason).toBe("disallowed");
    expect(state.resetModelOverride).toBe(true);
  });

  it("keeps a configured pin that is present on an authoritative catalog", async () => {
    const { state } = await run({
      cfg: permissiveCfg,
      snapshotEntries: [
        { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
        { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
      ],
      authoritative: true,
    });
    expect(state.resetModelOverride).toBe(false);
    expect(state.resetModelOverrideReason).toBeUndefined();
    expect(state.model).toBe("gpt-4o");
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
