// Tests model selection resolution from directives, config, and session state.
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  getContextWindowCaches,
  providerContextTokenCacheKey,
} from "../../agents/context-cache.js";
import {
  loadManifestModelCatalog,
  loadProviderScopedThinkingCatalog,
  loadPreparedModelCatalog as loadModelCatalogLocal,
} from "../../agents/model-catalog.runtime.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { normalizeModelRef } from "../../agents/model-ref-shared.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import { createModelManifestPluginContext } from "../../agents/model-selection-shared.js";
import * as providerModelNormalizationRuntime from "../../agents/provider-model-normalization.runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { SessionEntry } from "../../config/sessions.js";
import * as currentPluginMetadata from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import * as activeThinkingPolicy from "../../plugins/provider-thinking-active.js";
import { prepareModelCatalogThinkingPolicies } from "../../plugins/provider-thinking.js";
import { resolveDefaultModel } from "./directive-handling.defaults.js";
import {
  createModelSelectionState as createPreparedModelSelectionState,
  resolveContextTokens,
} from "./model-selection.js";
import { prepareRawModelSelectionFixture } from "./model-selection.test-support.js";

type ModelSelectionFixtureParams = Parameters<typeof prepareRawModelSelectionFixture>[0];
type DefaultedSelectionFields = "agentCfg" | "provider" | "model" | "hasModelDirective";

function createModelSelectionState(
  params: Omit<ModelSelectionFixtureParams, DefaultedSelectionFields> &
    Partial<Pick<ModelSelectionFixtureParams, DefaultedSelectionFields>>,
) {
  return createPreparedModelSelectionState(
    prepareRawModelSelectionFixture({
      agentCfg: params.cfg.agents?.defaults,
      provider: params.defaultProvider,
      model: params.defaultModel,
      hasModelDirective: false,
      ...params,
    }),
  );
}
type PersistReplySessionEntry =
  (typeof import("./session-entry-persistence.js"))["persistReplySessionEntry"];

const DEFAULT_MOCK_CATALOG_ENTRIES = vi.hoisted(() => [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.5" },
  { provider: "inferencer", id: "deepseek-v3-4bit-mlx", name: "DeepSeek V3" },
  { provider: "kimi", id: "kimi-code", name: "Kimi Code" },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  { provider: "xai", id: "grok-4", name: "Grok 4" },
  { provider: "xai", id: "grok-4.20-reasoning", name: "Grok 4.20 (Reasoning)" },
]);

const cliBackendsMocks = vi.hoisted(() => ({
  resolveCliRuntimeCanonicalProvider: vi.fn(({ runtime }: { runtime: string }) =>
    runtime === "claude-cli" ? "anthropic" : undefined,
  ),
}));

const sessionPersistenceMocks = vi.hoisted(() => ({
  persistReplySessionEntry: vi.fn<PersistReplySessionEntry>(),
}));

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

vi.mock("../../agents/cli-backends.js", () => ({
  resolveCliRuntimeCanonicalProvider: cliBackendsMocks.resolveCliRuntimeCanonicalProvider,
}));

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadManifestModelCatalog: vi.fn(() => []),
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
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

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: vi.fn<
    typeof import("../../plugins/current-plugin-metadata-snapshot.js").getCurrentPluginMetadataSnapshot
  >(() => createPluginMetadataSnapshot({ manifestRegistry: { plugins: [], diagnostics: [] } })),
}));

vi.mock("./session-entry-persistence.js", () => ({
  persistReplySessionEntry: sessionPersistenceMocks.persistReplySessionEntry,
}));

const authProfileStoreMock = vi.hoisted(() => {
  let store = { version: 1, profiles: {} } as {
    version: 1;
    profiles: Record<string, { type: "api_key"; provider: string; key: string }>;
  };
  const ensureAuthProfileStore = vi.fn<
    typeof import("../../agents/auth-profiles.runtime.js").ensureAuthProfileStore
  >(() => store);
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
  getContextWindowCaches().discoveredTokenCache.clear();
  cliBackendsMocks.resolveCliRuntimeCanonicalProvider.mockClear();
  sessionPersistenceMocks.persistReplySessionEntry.mockReset();
  vi.mocked(loadManifestModelCatalog).mockReset();
  vi.mocked(loadManifestModelCatalog).mockReturnValue([]);
  authProfileStoreMock.reset();
  vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
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
  it.each([
    { primaryModel: "model", resetModelOverride: false },
    { primaryModel: "custom/model", resetModelOverride: true },
  ])("compares the complete heartbeat primary $primaryModel", async (testCase) => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: `custom/${testCase.primaryModel}` } },
      models: {
        providers: {
          custom: {
            baseUrl: "https://custom.example/v1",
            models: [
              makeConfiguredModel({ id: "model" }),
              makeConfiguredModel({ id: "custom/model" }),
            ],
          },
        },
      },
    };
    const { defaultProvider, defaultModel } = resolveDefaultModel({ cfg });
    const preparedPrimaryModel = resolveDefaultModelForAgent({ cfg });
    const entry = makeEntry({
      providerOverride: "custom",
      modelOverride: "model",
      modelOverrideSource: "auto",
    });

    const state = await createModelSelectionState({
      cfg,
      defaultProvider,
      defaultModel,
      primaryProvider: preparedPrimaryModel.provider,
      primaryModel: preparedPrimaryModel.model,
      preparedDefaultModel: preparedPrimaryModel,
      preparedPrimaryModel,
      provider: "custom",
      model: "model",
      sessionEntry: entry,
      sessionStore: { main: entry },
      sessionKey: "main",
      isHeartbeat: true,
    });

    expect(state).toMatchObject({
      provider: "custom",
      model: testCase.primaryModel,
      resetModelOverride: testCase.resetModelOverride,
    });
    expect(entry.modelOverride).toBe(testCase.resetModelOverride ? undefined : "model");
  });

  it.each(["configured-literal", "manifest-alias"] as const)(
    "prepares the original configured default for %s selection",
    async (mode) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: mode === "configured-literal" ? "custom/custom/model" : "custom/legacy",
          },
        },
        ...(mode === "configured-literal"
          ? {
              models: {
                providers: {
                  custom: {
                    baseUrl: "https://custom.example/v1",
                    models: [makeConfiguredModel({ id: "custom/model" })],
                  },
                },
              },
            }
          : {}),
      };
      const registry = makeRegistry([{ id: "custom", channels: [], providers: ["custom"] }]);
      for (const plugin of registry.plugins) {
        plugin.modelIdNormalization = {
          providers: { custom: { aliases: { legacy: "first", first: "second" } } },
        };
      }
      const snapshot = createPluginMetadataSnapshot({ config: cfg, manifestRegistry: registry });
      const currentSnapshot = vi
        .spyOn(currentPluginMetadata, "getCurrentPluginMetadataSnapshot")
        .mockReturnValue(snapshot);
      onTestFinished(() => currentSnapshot.mockRestore());
      const normalize = vi
        .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
        .mockImplementation((params) =>
          params.provider === "custom" ? `runtime-${params.context.modelId}` : undefined,
        );
      onTestFinished(() => normalize.mockRestore());
      const { defaultProvider, defaultModel } = resolveDefaultModel({ cfg });
      expect(defaultModel).toBe(mode === "configured-literal" ? "custom/model" : "first");
      expect(normalize).not.toHaveBeenCalled();
      const manifestPluginContext = createModelManifestPluginContext({
        cfg,
        pluginMetadataSnapshot: snapshot,
      });
      let preparedDefault: ReturnType<typeof resolveDefaultModelForAgent> | undefined;
      const prepareDefaultModel = () =>
        (preparedDefault ??= resolveDefaultModelForAgent({ cfg, manifestPluginContext }));

      const state = await createModelSelectionState({
        cfg,
        manifestPluginContext,
        defaultProvider,
        defaultModel,
        preparedDefaultModel: prepareDefaultModel,
        preparedInitialModel: prepareDefaultModel,
        preparedPrimaryModel: prepareDefaultModel,
      });

      expect(state).toMatchObject({
        provider: "custom",
        model: mode === "configured-literal" ? "custom/model" : "runtime-first",
      });
      if (mode === "configured-literal") {
        expect(normalize).not.toHaveBeenCalled();
      } else {
        expect(normalize).toHaveBeenCalledWith(
          expect.objectContaining({ context: { provider: "custom", modelId: "first" } }),
        );
        expect(normalize).not.toHaveBeenCalledWith(
          expect.objectContaining({ context: { provider: "custom", modelId: "second" } }),
        );
      }
    },
  );

  it("keeps a prepared primary pin during heartbeat comparison without origin metadata", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "fixture-provider/legacy-pin" } },
    };
    const normalize = vi
      .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
      .mockImplementation((params) => {
        if (params.provider !== "fixture-provider") {
          return undefined;
        }
        return params.context.modelId === "legacy-pin"
          ? "captured-pin"
          : params.context.modelId === "captured-pin"
            ? "replayed-pin"
            : undefined;
      });
    onTestFinished(() => normalize.mockRestore());
    const preparedPrimaryModel = normalizeModelRef("fixture-provider", "legacy-pin", {
      config: cfg,
    });
    const entry = makeEntry({
      providerOverride: "fixture-provider",
      modelOverride: "legacy-pin",
      modelOverrideSource: "auto",
    });

    const state = await createModelSelectionState({
      cfg,
      defaultProvider: "fixture-provider",
      defaultModel: "legacy-pin",
      primaryProvider: preparedPrimaryModel.provider,
      primaryModel: preparedPrimaryModel.model,
      provider: preparedPrimaryModel.provider,
      model: preparedPrimaryModel.model,
      preparedInitialModel: preparedPrimaryModel,
      preparedPrimaryModel,
      sessionEntry: entry,
      sessionStore: { main: entry },
      sessionKey: "main",
      isHeartbeat: true,
    });

    expect(state).toMatchObject({
      provider: "fixture-provider",
      model: "captured-pin",
      resetModelOverride: false,
    });
    expect(entry).toMatchObject({ modelOverride: "legacy-pin", modelOverrideSource: "auto" });
    expect(normalize).not.toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ modelId: "captured-pin" }) }),
    );
  });

  it.each(["current", "reset-primary"] as const)(
    "retains prepared reply operands through %s selection",
    async (mode) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "fixture-provider/raw-primary" } },
      };
      const aliases = new Map([
        ["raw-primary", "captured-primary"],
        ["legacy-pin", "captured-pin"],
        ["captured-primary", "replayed-primary"],
        ["captured-pin", "replayed-pin"],
      ]);
      const normalize = vi
        .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
        .mockImplementation((params) =>
          params.provider === "fixture-provider" ? aliases.get(params.context.modelId) : undefined,
        );
      onTestFinished(() => normalize.mockRestore());
      const preparedInitialModel = normalizeModelRef("fixture-provider", "legacy-pin", {
        config: cfg,
      });
      const preparedPrimaryModel = normalizeModelRef("fixture-provider", "raw-primary", {
        config: cfg,
      });
      const sessionEntry =
        mode === "reset-primary"
          ? makeEntry({
              providerOverride: "fixture-provider",
              modelOverride: "captured-pin",
              modelOverrideSource: "auto",
              modelOverrideRouteResolution: "resolved",
              modelOverrideFallbackOriginProvider: "fixture-provider",
              modelOverrideFallbackOriginModel: "obsolete-primary",
            })
          : undefined;
      const params = {
        cfg,
        agentCfg: cfg.agents?.defaults,
        defaultProvider: "fixture-provider",
        defaultModel: "raw-primary",
        primaryProvider: preparedPrimaryModel.provider,
        primaryModel: preparedPrimaryModel.model,
        provider: preparedInitialModel.provider,
        model: preparedInitialModel.model,
        preparedInitialModel,
        preparedPrimaryModel,
        sessionEntry,
        sessionStore: sessionEntry ? { main: sessionEntry } : undefined,
        sessionKey: "main",
        hasModelDirective: false,
        isHeartbeat: mode === "reset-primary",
      };

      const state = await createModelSelectionState(params);

      expect(state).toMatchObject({
        provider: "fixture-provider",
        model: mode === "reset-primary" ? "captured-primary" : "captured-pin",
        resetModelOverride: mode === "reset-primary",
      });
      expect(normalize).not.toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ modelId: "captured-pin" }),
        }),
      );
    },
  );

  it.each(["directive", "one-turn", "locked"] as const)(
    "keeps raw input for an intentionally skipped %s policy selection",
    async (mode) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "fixture-provider/raw-default" } },
      };
      const normalize = vi
        .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
        .mockImplementation((params) =>
          params.provider === "fixture-provider" && params.context.modelId === "raw-default"
            ? "runtime-default"
            : undefined,
        );
      onTestFinished(() => normalize.mockRestore());
      const state = await createModelSelectionState({
        cfg,
        defaultProvider: "fixture-provider",
        defaultModel: "raw-default",
        hasModelDirective: mode === "directive",
        hasOneTurnModelOverride: mode === "one-turn",
        sessionEntry: makeEntry({ modelSelectionLocked: mode === "locked" }),
      });

      expect(state).toMatchObject({ provider: "fixture-provider", model: "raw-default" });
    },
  );

  it.each(["unrestricted", "restricted"] as const)(
    "prepares the static default before %s visibility selection",
    async (mode) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: "fixture-provider/legacy-default",
            models: {
              "fixture-provider/first-allowed": {},
              "fixture-provider/legacy-default": {},
            },
            modelPolicy: {
              allow:
                mode === "restricted"
                  ? ["fixture-provider/first-allowed", "fixture-provider/legacy-default"]
                  : [],
            },
          },
        },
      };
      const normalize = vi
        .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
        .mockImplementation((params) => {
          if (params.provider !== "fixture-provider") {
            return undefined;
          }
          return params.context.modelId === "legacy-default"
            ? "captured-default"
            : params.context.modelId === "captured-default"
              ? "replayed-default"
              : undefined;
        });
      onTestFinished(() => normalize.mockRestore());
      const { defaultProvider, defaultModel } = resolveDefaultModel({ cfg });
      expect({ defaultProvider, defaultModel }).toEqual({
        defaultProvider: "fixture-provider",
        defaultModel: "legacy-default",
      });
      expect(normalize).not.toHaveBeenCalled();
      let preparedDefault: ReturnType<typeof resolveDefaultModelForAgent> | undefined;
      const prepareDefaultModel = () => (preparedDefault ??= resolveDefaultModelForAgent({ cfg }));

      const state = await createModelSelectionState({
        cfg,
        defaultProvider,
        defaultModel,
        preparedDefaultModel: prepareDefaultModel,
        preparedInitialModel: prepareDefaultModel,
        preparedPrimaryModel: prepareDefaultModel,
      });

      expect(state).toMatchObject({
        provider: "fixture-provider",
        model: "captured-default",
        resetModelOverride: false,
      });
      if (mode === "restricted") {
        expect(state.allowedModelCatalog[0]?.id).toBe("first-allowed");
      }
    },
  );

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
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
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
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.4",
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
      defaultProvider: "deepseek",
      defaultModel: "deepseek-v4-pro",
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
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("medium");
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it("hydrates runtime catalog metadata when the configured allowlist entry lacks reasoning", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([
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
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("medium");
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
    expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledWith({
      config: cfg,
      agentId: undefined,
      provider: "openai",
      model: "gpt-5.4",
    });
  });

  it("uses the prepared gateway owner catalog without an exact-generation reload", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    catalogRuntimeMocks.loadModelCatalogSnapshot.mockClear();
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
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
      preparedModelCatalog: {
        entries: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true }],
        routeVariants: [],
        authoritative: true,
      },
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("medium");
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
    expect(catalogRuntimeMocks.loadModelCatalogSnapshot).not.toHaveBeenCalled();
  });

  it("carries prepared runtime thinking policy into ordinary configured turns", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    catalogRuntimeMocks.loadModelCatalogSnapshot.mockClear();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-mythos-5": {},
          },
        },
      },
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            models: [
              makeConfiguredModel({
                id: "claude-mythos-5",
                name: "Claude Mythos 5",
                reasoning: false,
              }),
            ],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createModelSelectionState({
      cfg,
      defaultProvider: "anthropic",
      defaultModel: "claude-mythos-5",
      preparedModelCatalog: {
        entries: [
          {
            provider: "anthropic",
            id: "claude-mythos-5",
            name: "Claude Mythos 5",
            reasoning: false,
            configuredReasoning: false,
            thinkingPolicyProvider: "claude-cli",
          },
        ],
        routeVariants: [],
        authoritative: true,
      },
    });

    await expect(state.resolveThinkingCatalog()).resolves.toEqual([
      expect.objectContaining({
        provider: "anthropic",
        id: "claude-mythos-5",
        thinkingPolicyProvider: "claude-cli",
      }),
    ]);
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
    expect(catalogRuntimeMocks.loadModelCatalogSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    { hasModelDirective: false, capturedPolicy: true, expected: "ultra" },
    { hasModelDirective: true, capturedPolicy: true, expected: "ultra" },
    { hasModelDirective: false, capturedPolicy: false, expected: "medium" },
    { hasModelDirective: true, capturedPolicy: false, expected: "medium" },
  ])(
    "keeps prepared thinking ownership through reply selection (directive=$hasModelDirective policy=$capturedPolicy)",
    async ({ hasModelDirective, capturedPolicy, expected }) => {
      const provider = "fixture-provider";
      const model = "fixture-model";
      const cfg: OpenClawConfig = {
        agents: { defaults: { models: { [`${provider}/${model}`]: { alias: "Fixture" } } } },
        models: {
          providers: {
            [provider]: {
              baseUrl: "https://fixture.invalid/v1",
              models: [makeConfiguredModel({ id: model })],
            },
          },
        },
      };
      const preparedModelCatalog: ModelCatalogSnapshot = {
        entries: [{ provider, id: model, name: "Fixture", reasoning: true }],
        routeVariants: [],
      };
      prepareModelCatalogThinkingPolicies({
        catalog: preparedModelCatalog,
        metadataSnapshot: createPluginMetadataSnapshotFixture(),
        providers: [
          {
            provider: {
              id: provider,
              ...(capturedPolicy
                ? {
                    resolveThinkingProfile: () => ({
                      levels: [{ id: "off" }, { id: "max" }, { id: "ultra" }],
                      defaultLevel: "ultra",
                    }),
                  }
                : {}),
            },
          },
        ],
      });
      const ambient = vi
        .spyOn(activeThinkingPolicy, "resolveActiveProviderThinkingProfile")
        .mockReturnValue({ levels: [{ id: "off" }], defaultLevel: "off" });
      try {
        const state = await createModelSelectionState({
          cfg,
          defaultProvider: provider,
          defaultModel: model,
          hasModelDirective,
          preparedModelCatalog,
        });
        await expect(
          state.resolveDefaultThinkingLevel({ provider, model, agentRuntime: "codex" }),
        ).resolves.toBe(expected);
        expect(ambient).not.toHaveBeenCalled();
      } finally {
        ambient.mockRestore();
      }
    },
  );

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
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
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
      defaultProvider: "vllm",
      defaultModel: "Qwen/Qwen3-8B",
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

  it("uses only configured compat for a custom route when the catalog is loaded", async () => {
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
      defaultProvider: "vllm",
      defaultModel: "Qwen/Qwen3-8B",
      hasModelDirective: true,
    });

    await expect(state.resolveThinkingCatalog()).resolves.toEqual([
      expect.objectContaining({
        provider: "vllm",
        id: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
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
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
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
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
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
      agentCfg: {},
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      hasModelDirective: true,
    });

    expect(
      resolveContextTokens({
        cfg: {} as OpenClawConfig,
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
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
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
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
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
      modelOverrideRouteResolution: "resolved",
    };
    const sessionStore = { main: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
    });

    expect(state.provider).toBe("vllm");
    expect(state.model).toBe("new-local-model");
    expect(state.requestedRouteResolution).toBe("resolved");
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
    getContextWindowCaches().discoveredTokenCache.set("gemini-3.1-pro-preview", 200_000);
    getContextWindowCaches().discoveredTokenCache.set(
      providerContextTokenCacheKey("google-gemini-cli", "gemini-3.1-pro-preview"),
      1_000_000,
    );

    const result = resolveContextTokens({
      cfg: {} as OpenClawConfig,
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });

    expect(result).toBe(1_000_000);
  });
});

const makeEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "session-id",
  updatedAt: Date.now(),
  delivery: { kind: "none" },
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
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      parentSessionKey: params.parentSessionKey,
      defaultProvider,
      defaultModel,
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
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      provider: "anthropic",
      model: "claude-opus-4-6",
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
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "xai",
      defaultModel: "grok-4",
    });

    expect(state.provider).toBe("xai");
    expect(state.model).toBe("grok-4.20-experimental-beta-0304-reasoning");
    expect(state.resetModelOverride).toBe(false);
  });

  it("preserves configured stored override aliases in the captured config", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "fixture-provider/primary" },
          models: {
            "fixture-provider/primary": {},
            "fixture-provider/captured-pin": {},
          },
        },
      },
    };
    const normalize = vi
      .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
      .mockImplementation((params) =>
        params.provider === "fixture-provider" && params.context.modelId === "legacy-pin"
          ? params.config === cfg
            ? "captured-pin"
            : "ambient-pin"
          : undefined,
      );
    onTestFinished(() => normalize.mockRestore());
    const sessionEntry = makeEntry({
      providerOverride: "fixture-provider",
      modelOverride: "legacy-pin",
      modelOverrideSource: "user",
    });
    const state = await createModelSelectionState({
      cfg,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      defaultProvider: "fixture-provider",
      defaultModel: "primary",
    });

    expect(state).toMatchObject({
      provider: "fixture-provider",
      model: "captured-pin",
      resetModelOverride: false,
    });
    expect(sessionEntry).toMatchObject({
      providerOverride: "fixture-provider",
      modelOverride: "legacy-pin",
      modelOverrideSource: "user",
    });
  });

  it("preserves a parsed stored model through an ordinary unlocked turn", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "fixture-provider/primary" } },
    };
    const normalize = vi
      .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
      .mockImplementation((params) => {
        if (params.provider !== "fixture-provider") {
          return undefined;
        }
        return params.context.modelId === "legacy-pin"
          ? "captured-pin"
          : params.context.modelId === "captured-pin"
            ? "replayed-pin"
            : undefined;
      });
    onTestFinished(() => normalize.mockRestore());
    const sessionEntry = makeEntry({
      providerOverride: "fixture-provider",
      modelOverride: "legacy-pin",
      modelOverrideSource: "user",
    });

    const state = await createModelSelectionState({
      cfg,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      defaultProvider: "fixture-provider",
      defaultModel: "primary",
    });

    expect(state).toMatchObject({
      provider: "fixture-provider",
      model: "captured-pin",
      resetModelOverride: false,
    });
    expect(sessionEntry).toMatchObject({
      providerOverride: "fixture-provider",
      modelOverride: "legacy-pin",
      modelOverrideSource: "user",
    });
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
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      model: "gpt-5.4",
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
      sessionEntry,
      sessionStore,
      sessionKey,
      parentSessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      model: "gpt-5.4",
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
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });

    expect(state.resetModelOverride).toBe(true);
    expect(state.resetModelOverrideRef).toBe("openai/gpt-4o-mini");
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
  });

  it("preserves a locked disallowed override without resetting it", async () => {
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

    const state = await createModelSelectionState({
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });
    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o-mini");
    expect(sessionStore[sessionKey]).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
      modelOverrideSource: "user",
      modelSelectionLocked: true,
    });
  });

  it("preserves a locked CLI runtime alias when its canonical model is allowed", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": {},
            "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:plugin:anthropic:catalog-adopt:claude:test";
    const sessionEntry = makeEntry({
      providerOverride: "claude-cli",
      modelOverride: "claude-opus-4-8",
      modelSelectionLocked: true,
      pluginOwnerId: "anthropic",
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "native-claude-session",
          forceReuse: true,
          forkNextResume: true,
        },
      },
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.6-sol",
      provider: "claude-cli",
      model: "claude-opus-4-8",
    });

    expect(state).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-8",
      resetModelOverride: false,
    });
    expect(sessionStore[sessionKey]).toMatchObject({
      providerOverride: "claude-cli",
      modelOverride: "claude-opus-4-8",
      modelSelectionLocked: true,
    });
    const expectedCanonicalProviderRequest = {
      runtime: "claude-cli",
      config: cfg,
      includeSetupRegistry: true,
    };
    expect(cliBackendsMocks.resolveCliRuntimeCanonicalProvider).toHaveBeenCalledTimes(2);
    expect(cliBackendsMocks.resolveCliRuntimeCanonicalProvider).toHaveBeenNthCalledWith(
      1,
      expectedCanonicalProviderRequest,
    );
    expect(cliBackendsMocks.resolveCliRuntimeCanonicalProvider).toHaveBeenNthCalledWith(
      2,
      expectedCanonicalProviderRequest,
    );
  });

  it("keeps ordinary provider overrides off the CLI setup-registry path", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: { "custom-provider/custom-model": {} },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:custom-provider";
    const sessionEntry = makeEntry({
      providerOverride: "custom-provider",
      modelOverride: "custom-model",
    });

    const state = await createModelSelectionState({
      cfg,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      defaultProvider: "custom-provider",
      defaultModel: "custom-model",
    });

    expect(state).toMatchObject({ provider: "custom-provider", model: "custom-model" });
    expect(cliBackendsMocks.resolveCliRuntimeCanonicalProvider).not.toHaveBeenCalled();
  });

  it("adopts a concurrent valid model while repairing a stale override", async () => {
    const storePath = "sessions.json";
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
    sessionPersistenceMocks.persistReplySessionEntry.mockResolvedValueOnce({
      status: "current",
      entry: concurrentEntry,
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      model: "gpt-4o-mini",
    });

    expect(state).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      resetModelOverride: false,
    });
    expect(sessionPersistenceMocks.persistReplySessionEntry).toHaveBeenCalledOnce();
    const persistenceRequest = sessionPersistenceMocks.persistReplySessionEntry.mock.calls[0]?.[0];
    expect(persistenceRequest).toMatchObject({
      storePath,
      sessionKey,
      initialEntry: expect.objectContaining({
        providerOverride: "openai",
        modelOverride: "gpt-4o-mini",
      }),
    });
    expect(persistenceRequest?.entry.providerOverride).toBeUndefined();
    expect(persistenceRequest?.entry.modelOverride).toBeUndefined();
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    });
    expect(sessionStore[sessionKey]).toEqual(sessionEntry);
  });

  it("rejects stale-model repair when the session rotates during persistence", async () => {
    const storePath = "sessions.json";
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
    sessionPersistenceMocks.persistReplySessionEntry.mockResolvedValueOnce({
      status: "lifecycle-invalidated",
      error: `Session "${sessionKey}" changed while starting work. Retry.`,
      entry: rotatedEntry,
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    await expect(
      createModelSelectionState({
        cfg,
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        defaultProvider: "openai",
        defaultModel: "gpt-4o",
        model: "gpt-4o-mini",
      }),
    ).rejects.toThrow(/changed while starting work/i);

    expect(sessionPersistenceMocks.persistReplySessionEntry).toHaveBeenCalledOnce();
    const persistenceRequest = sessionPersistenceMocks.persistReplySessionEntry.mock.calls[0]?.[0];
    expect(persistenceRequest).toMatchObject({
      storePath,
      sessionKey,
      initialEntry: expect.objectContaining({
        sessionId: "s1",
        providerOverride: "openai",
        modelOverride: "gpt-4o-mini",
      }),
    });
    expect(persistenceRequest?.entry.providerOverride).toBeUndefined();
    expect(persistenceRequest?.entry.modelOverride).toBeUndefined();
    expect(sessionEntry).toMatchObject({
      sessionId: "s1",
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
    });
    expect(sessionStore[sessionKey]).toBe(sessionEntry);
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
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-added-after-startup");
    expect(state.requestedRouteResolution).toBe("raw");
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
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
    });

    expect(state.provider).toBe("ollama-beelink2");
    expect(state.model).toBe("qwen2.5-coder:7b");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.modelOverride).toBe("ollama-beelink2/qwen2.5-coder:7b");
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
  });
});

describe("createModelSelectionState auto-failover overrides", () => {
  it("keeps a matching auto fallback pin during ordinary heartbeat comparison", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "fixture-provider/legacy-pin" } },
    };
    const normalize = vi
      .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
      .mockImplementation((params) =>
        params.provider !== "fixture-provider"
          ? undefined
          : params.context.modelId === "legacy-pin"
            ? "captured-pin"
            : params.context.modelId === "captured-pin"
              ? "replayed-pin"
              : undefined,
      );
    onTestFinished(() => normalize.mockRestore());
    const sessionEntry = makeEntry({
      providerOverride: "fixture-provider",
      modelOverride: "legacy-pin",
      modelOverrideSource: "auto",
    });

    const state = await createModelSelectionState({
      cfg,
      defaultProvider: "fixture-provider",
      defaultModel: "legacy-pin",
      primaryProvider: "fixture-provider",
      primaryModel: "legacy-pin",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: true,
    });

    expect(state.resetModelOverride).toBe(false);
    expect(state).toMatchObject({ provider: "fixture-provider", model: "captured-pin" });
    expect(sessionEntry).toMatchObject({
      providerOverride: "fixture-provider",
      modelOverride: "legacy-pin",
      modelOverrideSource: "auto",
    });
  });

  const defaultProvider = "mac-studio";
  const defaultModel = "MiniMax-M2.7-MLX";
  const sessionKey = "agent:main:telegram:direct:1";

  async function resolveStateWithOverride(params: {
    cfg?: OpenClawConfig;
    providerOverride: string;
    modelOverride: string;
    modelOverrideSource: "auto" | "user" | undefined;
    modelOverrideRouteResolution?: "resolved";
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
    const cfg = params.cfg ?? ({} as OpenClawConfig);
    const sessionEntry = makeEntry({
      providerOverride: params.providerOverride,
      modelOverride: params.modelOverride,
      modelOverrideSource: params.modelOverrideSource,
      modelOverrideRouteResolution: params.modelOverrideRouteResolution,
      modelOverrideFallbackOriginProvider: params.modelOverrideFallbackOriginProvider,
      modelOverrideFallbackOriginModel: params.modelOverrideFallbackOriginModel,
      fallbackNotice: params.fallbackNoticeSelectedModel
        ? {
            kind: "active",
            selectedModel: params.fallbackNoticeSelectedModel,
            activeModel: `${params.providerOverride}/${params.modelOverride}`,
          }
        : undefined,
      authProfileOverride: params.authProfileOverride,
      authProfileOverrideSource: params.authProfileOverrideSource,
    });
    const sessionStore = { [sessionKey]: sessionEntry };
    const state = await createModelSelectionState({
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      primaryProvider: params.primaryProvider,
      primaryModel: params.primaryModel,
      provider: params.provider ?? defaultProvider,
      model: params.model ?? defaultModel,
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
      modelOverrideRouteResolution: "resolved",
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
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
    });

    expect(state.resetModelOverride).toBe(true);
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBeUndefined();
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

  it.each(["auto", undefined] as const)(
    "keeps heartbeat fallback origin equality in the captured config with source %s",
    async (modelOverrideSource) => {
      const cfg: OpenClawConfig = {};
      const normalize = vi
        .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
        .mockImplementation((params) => {
          if (params.provider !== defaultProvider || params.context.modelId !== "legacy-primary") {
            return undefined;
          }
          return params.config === cfg ? defaultModel : "ambient-primary";
        });
      onTestFinished(() => normalize.mockRestore());

      const { state, sessionStore } = await resolveStateWithOverride({
        cfg,
        providerOverride: "openrouter",
        modelOverride: "minimax/minimax-m2.7",
        modelOverrideSource,
        modelOverrideFallbackOriginProvider: defaultProvider,
        modelOverrideFallbackOriginModel: "legacy-primary",
        provider: "openrouter",
        model: "minimax/minimax-m2.7",
        isHeartbeat: true,
      });

      expect(state).toMatchObject({
        provider: "openrouter",
        model: "minimax/minimax-m2.7",
        resetModelOverride: false,
      });
      expect(sessionStore[sessionKey]).toMatchObject({
        providerOverride: "openrouter",
        modelOverride: "minimax/minimax-m2.7",
        modelOverrideSource,
        modelOverrideFallbackOriginProvider: defaultProvider,
        modelOverrideFallbackOriginModel: "legacy-primary",
      });
    },
  );

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
      modelOverrideRouteResolution: "resolved",
    });

    // User-selected override must persist.
    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(state.requestedRouteResolution).toBe("resolved");
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
    expect(state.requestedRouteResolution).toBe("raw");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
  });

  it("keeps a canonical stored route ahead of a colliding bare alias", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "google/gemini-3.1-pro-preview", fallbacks: [] },
          models: {
            "google/gemini-2.5-flash-lite": { alias: "google-flash-lite" },
            "openrouter/google/gemini-2.5-flash-lite": {
              alias: "gemini-2.5-flash-lite",
            },
          },
        },
      },
    } as OpenClawConfig;
    const sessionEntry = makeEntry({
      providerOverride: "google",
      modelOverride: "gemini-2.5-flash-lite",
      modelOverrideSource: "user",
    });
    const state = await createModelSelectionState({
      cfg,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      defaultProvider: "google",
      defaultModel: "gemini-3.1-pro-preview",
    });

    expect(state).toMatchObject({
      provider: "google",
      model: "gemini-2.5-flash-lite",
      requestedRouteResolution: "resolved",
    });
  });

  it("canonicalizes a reset-upgraded legacy alias before fallback", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "legacy-fast-model" },
          },
        },
      },
    } as OpenClawConfig;
    const sessionEntry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "legacy-fast-model",
      // Older resets added the source without resolving the stored alias.
      modelOverrideSource: "user",
    });
    const state = await createModelSelectionState({
      cfg,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
    });

    expect(state).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      requestedRouteResolution: "resolved",
    });
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
      sessionEntry: childEntry,
      sessionStore,
      sessionKey: childKey,
      parentSessionKey: parentKey,
      defaultProvider,
      defaultModel,
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

  it.each(["/workspace/captured-auth", undefined])(
    "keeps alias-compatible authProfileOverride and its captured workspace %s",
    async (workspaceDir) => {
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
      const agentDir = "/tmp/captured-auth-owner";
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", workspace: workspaceDir }] },
      };
      const pluginMetadataSnapshot = createPluginMetadataSnapshot({
        config: cfg,
        workspaceDir,
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      const selectionParams = {
        cfg,
        agentId: "main",
        agentDir,
        workspaceDir,
        manifestPluginContext: createModelManifestPluginContext({
          cfg,
          agentId: "main",
          workspaceDir,
          pluginMetadataSnapshot,
        }),
        agentCfg: undefined,
        sessionEntry,
        sessionStore,
        sessionKey,
        defaultProvider: "claude-cli",
        defaultModel: "claude-opus-4-7",
        provider: "claude-cli",
        model: "claude-opus-4-7",
        hasModelDirective: false,
      };

      const state = await createModelSelectionState(selectionParams);

      expect(state.runtimeModelNormalization?.workspaceDir).toBe(workspaceDir);
      expect(state.runtimeModelNormalization?.pluginMetadataSnapshot).toBe(pluginMetadataSnapshot);

      // The override must NOT have been cleared — the anthropic credential is
      // alias-compatible with the claude-cli provider.
      expect(sessionStore[sessionKey]?.authProfileOverride).toBe("anthropic:claude-cli");
      expect(sessionEntry.authProfileOverride).toBe("anthropic:claude-cli");
      expect(authProfileStoreMock.ensureAuthProfileStore).toHaveBeenCalledWith(
        agentDir,
        expect.objectContaining({ config: cfg, workspaceDir, pluginMetadataSnapshot }),
      );
    },
  );
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
    });

    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
    expect(loadManifestModelCatalog).toHaveBeenCalledWith({
      config: {},
      fallbackToMetadataScan: false,
    });
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it("returns on when catalog model has reasoning true", async () => {
    vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([
      { provider: "openrouter", id: "x-ai/grok-4.1-fast", name: "Grok", reasoning: true },
    ]);
    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "openrouter",
      defaultModel: "x-ai/grok-4.1-fast",
    });
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
  });

  it("returns off when catalog model has no reasoning", async () => {
    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
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
    modelSelectionLocked?: true;
  }): Promise<{
    state: Awaited<ReturnType<typeof createModelSelectionState>>;
    sessionEntry: SessionEntry;
  }> {
    catalogRuntimeMocks.loadModelCatalogSnapshot.mockResolvedValueOnce({
      entries: params.snapshotEntries,
      routeVariants: params.snapshotEntries,
      authoritative: params.authoritative,
    });
    const sessionEntry = {
      ...makeOverrideEntry(),
      ...(params.modelSelectionLocked ? { modelSelectionLocked: true as const } : {}),
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    const state = await createModelSelectionState({
      cfg: params.cfg,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      primaryProvider: "openai",
      primaryModel: "gpt-4o-mini",
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

  it("keeps a locked pin active without a degraded-catalog fallback notice", async () => {
    const { state, sessionEntry } = await run({
      cfg: restrictiveCfg,
      snapshotEntries: [],
      authoritative: false,
      modelSelectionLocked: true,
    });
    expect(state.resetModelOverride).toBe(false);
    expect(state.resetModelOverrideReason).toBeUndefined();
    expect(state.resetModelOverrideRef).toBeUndefined();
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(state.model).toBe("gpt-4o");
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
