// Covers plugin-owned model id normalization through selection surfaces.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRawModelSelectionFixture } from "../auto-reply/reply/model-selection.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildModelAliasIndexCore,
  resolveModelAliasFromPair,
  resolveModelRefWithConfiguredAliases,
} from "./model-selection-shared.js";

const normalizeProviderModelIdWithPluginMock = vi.fn();

function normalizeLegacyFixtureModel({
  provider,
  context,
}: {
  provider: string;
  context: { modelId?: string };
}) {
  return provider === "custom-provider" && context.modelId === "custom-legacy-model"
    ? "custom-modern-model"
    : undefined;
}
const emptyPluginMetadataSnapshot = vi.hoisted(() => ({
  configFingerprint: "model-selection-plugin-runtime-test-empty-plugin-metadata",
  plugins: [
    {
      modelIdNormalization: {
        providers: {
          google: {
            aliases: {
              "gemini-3.1-pro": "gemini-3.1-pro-preview",
            },
          },
        },
      },
    },
  ],
}));
const getCurrentPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());
const loadPreparedModelCatalogSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithPluginMock(params),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: getCurrentPluginMetadataSnapshotMock,
}));

vi.mock("./model-catalog.runtime.js", () => ({
  loadManifestModelCatalog: () => [],
  loadProviderScopedThinkingCatalog: async () => [],
  loadPreparedModelCatalog: async () => [],
  loadPreparedModelCatalogSnapshot: loadPreparedModelCatalogSnapshotMock,
}));

let createPreparedModelSelectionState: typeof import("../auto-reply/reply/model-selection.js").createModelSelectionState;

function createModelSelectionStateForTest(
  params: Parameters<typeof prepareRawModelSelectionFixture>[0],
) {
  return createPreparedModelSelectionState(prepareRawModelSelectionFixture(params));
}
describe("model-selection plugin runtime normalization", () => {
  beforeAll(async () => {
    ({ createModelSelectionState: createPreparedModelSelectionState } =
      await import("../auto-reply/reply/model-selection.js"));
  });

  beforeEach(() => {
    normalizeProviderModelIdWithPluginMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(emptyPluginMetadataSnapshot);
    loadPreparedModelCatalogSnapshotMock.mockReset();
    loadPreparedModelCatalogSnapshotMock.mockResolvedValue({ entries: [], authoritative: true });
  });

  it("delegates provider-owned model id normalization to plugin runtime hooks", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

    const { parseModelRef } = await import("./model-selection.js");

    expect(parseModelRef("custom-legacy-model", "custom-provider")).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledWith({
      provider: "custom-provider",
      context: {
        provider: "custom-provider",
        modelId: "custom-legacy-model",
      },
    });
  });

  it("keeps static normalization while skipping plugin runtime hooks when disabled", async () => {
    const { parseModelRef } = await import("./model-selection.js");

    expect(
      parseModelRef("gemini-3.1-pro", "google", {
        allowPluginNormalization: false,
      }),
    ).toEqual({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
  });

  it.each([
    "selected-provider/selected-provider/selected-provider/model",
    "speech-summary",
    "selected-provider/speech-summary",
  ])("normalizes only the authored selected target for %s", (raw) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "unused-provider/another-model": { alias: "unused" },
            "selected-provider/selected-provider/selected-provider/model": {
              alias: "speech-summary",
            },
          },
        },
      },
    };
    normalizeProviderModelIdWithPluginMock.mockImplementation(({ provider, context, config }) => {
      expect(config).toBe(cfg);
      expect(provider).toBe("selected-provider");
      expect(context.modelId).toBe("selected-provider/model");
      return "runtime-summary";
    });

    expect(
      resolveModelRefWithConfiguredAliases({ cfg, raw, defaultProvider: "unused-provider" }),
    ).toEqual({ provider: "selected-provider", model: "runtime-summary" });
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledOnce();
  });

  it.each(["configured/configured/model", "speech-summary"])(
    "preserves exact configured provider model paths for %s",
    (raw) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "unused-provider/another-model": { alias: "unused" },
              "configured/configured/model": { alias: "speech-summary" },
            },
          },
        },
        models: {
          providers: {
            configured: {
              api: "openai-completions",
              baseUrl: "https://configured.test/v1",
              models: [
                {
                  id: "configured/model",
                  name: "Configured model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 1_024,
                },
              ],
            },
          },
        },
      };

      expect(
        resolveModelRefWithConfiguredAliases({ cfg, raw, defaultProvider: "unused-provider" }),
      ).toEqual({ provider: "configured", model: "configured/model" });
      expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      raw: "shared",
      expected: { provider: "other-provider", model: "second" },
    },
    {
      raw: "selected-provider/Shared",
      expected: { provider: "selected-provider", model: "first" },
    },
    {
      raw: "redirected/model",
      expected: { provider: "selected-provider", model: "third" },
    },
    {
      raw: "shared",
      agentAlias: "Shared",
      expected: { provider: "selected-provider", model: "first" },
    },
    {
      raw: "selected-provider/shared",
      agentAlias: "",
      expected: { provider: "selected-provider", model: "shared" },
    },
  ])(
    "preserves alias precedence for $raw with agent alias $agentAlias",
    ({ raw, agentAlias, expected }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "selected-provider/first": { alias: "shared" },
              "other-provider/second": { alias: "Shared" },
              "selected-provider/third": { alias: "redirected/model" },
            },
          },
          entries: {
            ops: {
              models: {
                "selected-provider/first": agentAlias === undefined ? {} : { alias: agentAlias },
              },
            },
          },
        },
      };

      expect(
        resolveModelRefWithConfiguredAliases({
          cfg,
          raw,
          agentId: "ops",
          defaultProvider: "unused-provider",
        }),
      ).toEqual(expected);
      expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: expected.provider,
          context: { provider: expected.provider, modelId: expected.model },
        }),
      );
    },
  );

  const runtimeAliasCollisionCases: Array<{
    name: string;
    defaults: Record<string, { alias: string }>;
    agent: Record<string, { alias: string }>;
    expected: { provider: string; model: string };
  }> = [
    {
      name: "canonical agent key disables a legacy default alias",
      defaults: { "provider/legacy": { alias: "fast" } },
      agent: { "provider/current": { alias: "" } },
      expected: { provider: "fallback-provider", model: "fast" },
    },
    {
      name: "legacy agent key disables a canonical default alias",
      defaults: { "provider/current": { alias: "fast" } },
      agent: { "provider/legacy": { alias: "" } },
      expected: { provider: "fallback-provider", model: "fast" },
    },
    {
      name: "agent alias replaces the default at its runtime canonical key",
      defaults: { "provider/legacy": { alias: "fast" } },
      agent: { "provider/current": { alias: "slow" } },
      expected: { provider: "fallback-provider", model: "fast" },
    },
    {
      name: "another provider wins after a later duplicate alias is disabled",
      defaults: {
        "provider/older": { alias: "fast" },
        "other-provider/other": { alias: "fast" },
        "provider/legacy": { alias: "fast" },
      },
      agent: { "provider/current": { alias: "" } },
      expected: { provider: "other-provider", model: "other" },
    },
  ];

  it.each(runtimeAliasCollisionCases)(
    "preserves runtime alias collisions: $name",
    ({ defaults, agent, expected }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "unused-provider/primary" },
            models: {
              "unused-provider/another-model": { alias: "unused" },
              ...defaults,
            },
          },
          entries: { worker: { models: agent } },
        },
      };
      normalizeProviderModelIdWithPluginMock.mockImplementation(({ provider, context }) => {
        if (provider === "unused-provider") {
          throw new Error("Unrelated provider normalization must remain cold");
        }
        return provider === "provider" && context.modelId === "legacy" ? "current" : undefined;
      });

      expect(
        resolveModelRefWithConfiguredAliases({
          cfg,
          raw: "fast",
          agentId: "worker",
          defaultProvider: "fallback-provider",
        }),
      ).toEqual(expected);
    },
  );

  it("keeps allowed model selection on manifest policy without executable hooks", async () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue("runtime-only-model");
    const { resolveAllowedModelRefCore } = await import("./model-selection-resolve.js");

    expect(
      resolveAllowedModelRefCore({
        cfg: {
          agents: {
            defaults: {
              modelPolicy: { allow: ["google/gemini-3.1-pro"] },
              models: { "google/gemini-3.1-pro": { alias: "approved" } },
            },
          },
        },
        catalog: [
          { provider: "google", id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
        ],
        raw: "google/gemini-3.1-pro",
        defaultProvider: "google",
      }),
    ).toEqual({
      key: "google/gemini-3.1-pro-preview",
      ref: { provider: "google", model: "gemini-3.1-pro-preview" },
    });
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
  });

  it("keeps provider plugin normalization when inferring provider for bare defaults", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

    const { resolveConfiguredModelRef } = await import("./model-selection.js");

    expect(
      resolveConfiguredModelRef({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "custom-legacy-model" },
              models: {
                "custom-provider/custom-legacy-model": {},
              },
            },
          },
        },
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
      }),
    ).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
  });

  it.each([
    {
      name: "keeps model visibility policy construction off plugin runtime hooks by default",
      allowPluginNormalization: undefined,
    },
    {
      name: "propagates explicit plugin runtime normalization opt-in through model visibility policy",
      allowPluginNormalization: true,
    },
  ])("$name", async ({ allowPluginNormalization }) => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);
    const { createModelVisibilityPolicy } = await import("./model-visibility-policy.js");
    const policy = createModelVisibilityPolicy({
      cfg: {
        agents: { defaults: { models: { "custom-provider/custom-legacy-model": {} } } },
      },
      catalog: [],
      defaultProvider: "custom-provider",
      defaultModel: "custom-legacy-model",
      ...(allowPluginNormalization ? { allowPluginNormalization } : {}),
    });

    if (allowPluginNormalization) {
      expect(policy.allowedKeys.has("custom-provider/custom-modern-model")).toBe(true);
      expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalled();
    } else {
      expect(policy.allowedKeys.has("custom-provider/custom-legacy-model")).toBe(true);
      expect(policy.allowedKeys.has("custom-provider/custom-modern-model")).toBe(false);
      expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
    }
  });

  it.each(["unrestricted", "catalog", "synthetic"] as const)(
    "preserves selected and catalog model refs in %s visibility policy",
    async (mode) => {
      normalizeProviderModelIdWithPluginMock.mockImplementation(({ provider, context }) => {
        if (provider !== "custom-provider") {
          return undefined;
        }
        return context.modelId === "custom-legacy-model"
          ? "custom-modern-model"
          : "incorrectly-renormalized-model";
      });
      const { parseModelRef } = await import("./model-selection.js");
      const { createModelVisibilityPolicy } = await import("./model-visibility-policy.js");
      const selected = { provider: "custom-provider", model: "custom-modern-model" };
      expect(parseModelRef("custom-legacy-model", "custom-provider")).toEqual(selected);
      const policy = createModelVisibilityPolicy({
        cfg: {
          agents: {
            defaults: {
              modelPolicy: {
                allow: mode === "unrestricted" ? [] : ["custom-provider/custom-legacy-model"],
              },
            },
          },
        },
        catalog:
          mode === "synthetic"
            ? []
            : [{ provider: selected.provider, id: selected.model, name: "Selected model" }],
        defaultProvider: "custom-provider",
        allowPluginNormalization: true,
      });
      const normalizationCalls = normalizeProviderModelIdWithPluginMock.mock.calls.length;

      expect(policy.resolveSelection(selected)).toEqual(selected);
      if (mode !== "unrestricted") {
        expect(
          policy.resolveSelection({ provider: "other-provider", model: "not-allowed" }),
        ).toEqual(selected);
      }
      expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledTimes(normalizationCalls);
    },
  );

  it.each([
    { provider: "provider-a", model: "shared", defaultProvider: "provider-b", expected: "first" },
    { provider: "provider-c", model: "shared", defaultProvider: "provider-c", expected: "second" },
    { provider: "provider-c", model: "shared", defaultProvider: "provider-a", expected: null },
    {
      provider: "provider-a",
      model: "qualified",
      defaultProvider: "provider-a",
      expected: "third",
    },
    {
      provider: "provider-a",
      model: " shared@work ",
      defaultProvider: "provider-a",
      expected: "first",
    },
    {
      provider: "provider-a",
      model: "version@20251001@work",
      defaultProvider: "provider-a",
      expected: "versioned",
    },
    {
      provider: "provider-a",
      model: "quant@q8_0@work",
      defaultProvider: "provider-a",
      expected: "quantized",
    },
    {
      provider: "provider-a",
      model: "@owner/model@work",
      defaultProvider: "provider-a",
      expected: "path",
    },
    { provider: "provider-a", model: "unknown", defaultProvider: "provider-a", expected: null },
  ])(
    "looks up the prepared alias for $provider/$model with default $defaultProvider without parsing misses",
    ({ provider, model, defaultProvider, expected }) => {
      const aliasIndex = buildModelAliasIndexCore({
        cfg: {
          agents: {
            defaults: {
              models: {
                "provider-a/first": { alias: "shared" },
                "provider-b/second": { alias: "Shared" },
                "provider-b/third": { alias: "provider-a/qualified" },
                "provider-a/fourth": { alias: "qualified" },
                "provider-a/versioned": { alias: "version@20251001" },
                "provider-a/quantized": { alias: "quant@q8_0" },
                "provider-a/path": { alias: "@owner/model" },
              },
            },
          },
        },
        defaultProvider,
      });
      const normalizationCalls = normalizeProviderModelIdWithPluginMock.mock.calls.length;

      expect(resolveModelAliasFromPair({ provider, model, defaultProvider, aliasIndex })).toEqual(
        expected
          ? {
              provider: expected === "second" || expected === "third" ? "provider-b" : "provider-a",
              model: expected,
            }
          : null,
      );
      expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledTimes(normalizationCalls);
    },
  );

  it("keeps plugin-normalized stored overrides allowed in auto-reply runtime selection", async () => {
    // Stored session overrides are runtime inputs, so provider-owned
    // normalization keeps old persisted ids usable without resetting them.
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

    const cfg = {
      agents: {
        defaults: {
          models: {
            "custom-provider/custom-legacy-model": {},
          },
        },
      },
    };
    const sessionKey = "agent:main:discord:channel:c1";
    const sessionEntry = {
      sessionId: sessionKey,
      updatedAt: 1,
      providerOverride: "custom-provider",
      modelOverride: "custom-legacy-model",
    };
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "custom-provider",
      defaultModel: "custom-legacy-model",
      provider: "custom-provider",
      model: "custom-legacy-model",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("custom-provider");
    expect(state.model).toBe("custom-modern-model");
    expect(state.resetModelOverride).toBe(false);
  });

  it("reuses one lifecycle metadata snapshot across auto-reply model normalization", async () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue(undefined);
    const configuredRefs = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`custom-provider/model-${index}`, {}]),
    );
    const cfg = {
      agents: {
        defaults: {
          modelPolicy: { allow: Object.keys(configuredRefs) },
          models: configuredRefs,
        },
      },
    };

    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      defaultProvider: "custom-provider",
      defaultModel: "model-0",
      provider: "custom-provider",
      model: "model-0",
      hasModelDirective: false,
    });

    expect(state.allowedModelCatalog).toHaveLength(20);
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledTimes(1);
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config: cfg,
      allowWorkspaceScopedSnapshot: true,
    });
  });

  it("keeps concurrent model-policy runs isolated while sharing metadata", async () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue(undefined);
    let signalFirstCatalogLoad: (() => void) | undefined;
    let releaseFirstCatalogLoad: (() => void) | undefined;
    const firstCatalogLoadStarted = new Promise<void>((resolve) => {
      signalFirstCatalogLoad = resolve;
    });
    const firstCatalogLoadRelease = new Promise<void>((resolve) => {
      releaseFirstCatalogLoad = resolve;
    });
    loadPreparedModelCatalogSnapshotMock
      .mockImplementationOnce(async () => {
        signalFirstCatalogLoad?.();
        await firstCatalogLoadRelease;
        return { entries: [], authoritative: true };
      })
      .mockResolvedValue({ entries: [], authoritative: true });
    const createConfig = (model: string) => ({
      agents: {
        defaults: {
          modelPolicy: { allow: [`custom-provider/${model}`] },
          models: { [`custom-provider/${model}`]: {} },
        },
      },
    });
    const firstConfig = createConfig("first");
    const secondConfig = createConfig("second");

    const select = (cfg: ReturnType<typeof createConfig>, model: string) =>
      createModelSelectionStateForTest({
        cfg,
        agentCfg: cfg.agents.defaults,
        defaultProvider: "custom-provider",
        defaultModel: model,
        provider: "custom-provider",
        model,
        hasModelDirective: true,
      });

    const firstPromise = select(firstConfig, "first");
    await firstCatalogLoadStarted;
    const secondPromise = select(secondConfig, "second");
    await vi.waitFor(() => expect(loadPreparedModelCatalogSnapshotMock).toHaveBeenCalledTimes(2));
    releaseFirstCatalogLoad?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect([...first.allowedModelKeys]).toContain("custom-provider/first");
    expect([...first.allowedModelKeys]).not.toContain("custom-provider/second");
    expect([...second.allowedModelKeys]).toContain("custom-provider/second");
    expect([...second.allowedModelKeys]).not.toContain("custom-provider/first");
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledTimes(2);
    expect(getCurrentPluginMetadataSnapshotMock.mock.calls).toEqual([
      [{ config: firstConfig, allowWorkspaceScopedSnapshot: true }],
      [{ config: secondConfig, allowWorkspaceScopedSnapshot: true }],
    ]);
  });

  it("preserves runtime discovery fallback across configured, stored, and fallback refs", async () => {
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    const aliases = new Map([
      ["configured-legacy", "configured-modern"],
      ["stored-legacy", "stored-modern"],
      ["fallback-legacy", "fallback-modern"],
    ]);
    normalizeProviderModelIdWithPluginMock.mockImplementation(({ context, plugins }) => {
      if (plugins) {
        expect(plugins.length).toBeGreaterThan(0);
      }
      const modelId = (context as { modelId?: string }).modelId ?? "";
      return aliases.get(modelId);
    });
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "custom-provider/configured-legacy",
            fallbacks: ["custom-provider/fallback-legacy"],
          },
          modelPolicy: {
            allow: ["custom-provider/configured-legacy", "custom-provider/stored-legacy"],
          },
          models: {
            "custom-provider/configured-legacy": {},
            "custom-provider/stored-legacy": {},
          },
        },
      },
    };
    const sessionKey = "agent:main:discord:channel:c1";
    const sessionEntry = {
      sessionId: sessionKey,
      updatedAt: 1,
      providerOverride: "custom-provider",
      modelOverride: "stored-legacy",
    };

    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      defaultProvider: "custom-provider",
      defaultModel: "configured-legacy",
      provider: "custom-provider",
      model: "configured-legacy",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("custom-provider");
    expect(state.model).toBe("stored-modern");
    expect([...state.allowedModelKeys]).toEqual(
      expect.arrayContaining([
        "custom-provider/configured-modern",
        "custom-provider/stored-modern",
      ]),
    );
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config: cfg,
      allowWorkspaceScopedSnapshot: true,
    });
    expect(
      normalizeProviderModelIdWithPluginMock.mock.calls.map(
        ([call]) => (call as { context?: { modelId?: string } }).context?.modelId,
      ),
    ).toEqual(expect.arrayContaining(["configured-legacy", "stored-legacy", "fallback-legacy"]));
  });

  it("forwards manifestPlugins to the runtime normalization call so it can skip the slot-or-load disk walk", async () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue(undefined);
    const preparedPlugins = [
      {
        modelIdNormalization: {
          providers: {
            custom: { prefixWhenBare: "prepared" },
          },
        },
      },
    ];
    const { normalizeModelRef } = await import("./model-ref-shared.js");
    normalizeModelRef("custom", "my-model", { manifestPlugins: preparedPlugins });
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "custom",
        plugins: preparedPlugins,
      }),
    );
  });

  it("omits plugins from the runtime call when no manifestPlugins are prepared (preserves current behavior)", async () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue(undefined);
    const { normalizeModelRef } = await import("./model-ref-shared.js");
    normalizeModelRef("custom", "my-model");
    const callArgs = normalizeProviderModelIdWithPluginMock.mock.calls[0]?.[0] as
      | { plugins?: unknown }
      | undefined;
    expect(callArgs).toBeDefined();
    expect(callArgs?.plugins).toBeUndefined();
  });
});
