// Exercises startup provider discovery scoping with disposable home and state boundaries.
import os from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "../plugins/plugin-metadata.test-support.js";
import {
  prepareProviderExternalAuthWithPlugin,
  resolveProviderSyntheticAuthWithPlugin,
} from "../plugins/provider-runtime.js";
import {
  prepareSyntheticAuthWithProvider,
  resolveSyntheticAuthWithProvider,
} from "../plugins/provider-synthetic-auth.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { MODELS_CONFIG_IMPLICIT_ENV_VARS } from "./models-config.e2e-harness.js";

const mocks = vi.hoisted(() => ({
  prepareProviderStaticCatalog: vi.fn(),
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderCatalog: vi.fn(),
  runProviderStaticCatalog: vi.fn(),
}));
const BUNDLED_PLUGINS_DIR = fileURLToPath(new URL("../../extensions/", import.meta.url));

vi.mock("../plugins/provider-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-runtime.js")>();
  return {
    ...actual,
    prepareProviderExternalAuthWithPlugin: vi.fn(actual.prepareProviderExternalAuthWithPlugin),
    resolveProviderSyntheticAuthWithPlugin: vi.fn(actual.resolveProviderSyntheticAuthWithPlugin),
  };
});

vi.mock("../plugins/provider-discovery.js", () => ({
  resolveRuntimePluginDiscoveryProviders: mocks.resolveRuntimePluginDiscoveryProviders,
  runProviderCatalog: mocks.runProviderCatalog,
  runProviderStaticCatalog: mocks.runProviderStaticCatalog,
  groupPluginDiscoveryProvidersByOrder: (providers: ProviderPlugin[]) => ({
    simple: providers,
    profile: [],
    paired: [],
    late: [],
  }),
  normalizePluginDiscoveryResult: ({
    provider,
    result,
  }: {
    provider: ProviderPlugin;
    result?: { provider?: unknown; providers?: Record<string, unknown> } | null;
  }) =>
    result?.providers ??
    (result?.provider
      ? Object.fromEntries(
          [provider.id, ...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].map((id) => [
            id.trim().toLowerCase(),
            result.provider,
          ]),
        )
      : {}),
  prepareProviderStaticCatalog: mocks.prepareProviderStaticCatalog,
}));

import {
  prepareImplicitProviderStaticCatalog,
  resolveImplicitProviders,
} from "./models-config.providers.implicit.js";

function metadataOwners(
  overrides: Partial<PluginMetadataSnapshotOwnerMaps>,
): PluginMetadataSnapshotOwnerMaps {
  // Tests only populate the owner map under inspection; keep the rest explicit.
  return {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
    modelIdNormalizationPolicies: new Map(),
    ...overrides,
  };
}

function createProvider(id: string): ProviderPlugin {
  // Minimal discovery plugin used to assert orchestration, not provider behavior.
  return {
    id,
    label: id,
    auth: [],
    catalog: {
      order: "simple",
      run: async () => null,
    },
  };
}

function createProviderWithStaticCatalog(id: string): ProviderPlugin {
  return {
    ...createProvider(id),
    staticCatalog: {
      order: "simple",
      run: async () => null,
    },
  };
}

function createStaticOnlyProvider(id: string): ProviderPlugin {
  return {
    id,
    label: id,
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => null,
    },
  };
}

function createTextModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

function firstMockArg(mock: { mock: { calls: unknown[][] } }, label: string): unknown {
  // Centralizes the mock-call assertion so failed discovery paths report intent.
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call[0];
}

describe("resolveImplicitProviders startup discovery scope", () => {
  let state: OpenClawTestState;
  let ambientHome: MockInstance<typeof os.homedir>;

  beforeEach(async () => {
    vi.clearAllMocks();
    state = await createOpenClawTestState({
      label: "provider-discovery-scope",
      env: Object.fromEntries(
        [...MODELS_CONFIG_IMPLICIT_ENV_VARS, "CODEX_API_KEY", "CODEX_HOME", "GOOGLE_CLOUD_API_KEY"]
          .filter((key) => key !== "VITEST" && key !== "NODE_ENV")
          .map((key) => [key, undefined]),
      ),
    });
    // Missing explicit home fields must never reach the operator's OS home.
    // The sentinel keeps a failing isolation regression inside this disposable fixture.
    ambientHome = vi.spyOn(os, "homedir").mockReturnValue(state.path("ambient-home-sentinel"));
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([createProvider("openai")]);
    mocks.runProviderCatalog.mockResolvedValue({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [],
        },
      },
    });
    mocks.runProviderStaticCatalog.mockResolvedValue({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [],
        },
      },
    });
    mocks.prepareProviderStaticCatalog.mockResolvedValue({
      providers: [],
      entries: [],
    });
  });

  afterEach(async () => {
    try {
      expect(ambientHome).not.toHaveBeenCalled();
    } finally {
      try {
        await state.cleanup();
      } finally {
        ambientHome.mockRestore();
      }
    }
  });

  it("keeps catalog auth scoped when an ambient credential is present", async () => {
    mocks.runProviderCatalog.mockImplementationOnce(
      async ({
        resolveProviderAuth,
      }: Parameters<typeof import("../plugins/provider-discovery.js").runProviderCatalog>[0]) => {
        expect(resolveProviderAuth("openai")).toMatchObject({
          discoveryApiKey: "scoped-catalog-test-key",
          mode: "api_key",
          source: "env",
        });
        return null;
      },
    );

    await withEnvAsync({ OPENAI_API_KEY: "ambient-catalog-test-key" }, async () => {
      await resolveImplicitProviders({
        agentDir: state.agentDir(),
        config: {},
        env: { ...state.env, OPENAI_API_KEY: "scoped-catalog-test-key" },
        providerDiscoveryProviderIds: ["openai"],
      });
    });

    expect(mocks.runProviderCatalog).toHaveBeenCalledOnce();
  });

  it.each([
    { scoped: false, api: "openai-completions" as const },
    { scoped: true, api: "openai-completions" as const },
    { scoped: false, api: "openai-responses" as const },
    { scoped: true, api: "openai-responses" as const },
  ])(
    "prepares configured native auth within the discovery scope (scoped: $scoped, api: $api)",
    async ({ scoped, api }) => {
      const prepareNative = vi.fn<NonNullable<ProviderPlugin["prepareSyntheticAuth"]>>(
        async () => ({ apiKey: "native-auth-ready", source: "native fixture", mode: "oauth" }),
      );
      const provider: ProviderPlugin = {
        ...createProvider("openai-completions"),
        pluginId: "auth-owner",
        hookAliases: ["openai-responses"],
        prepareSyntheticAuth: prepareNative,
      };
      const metadata = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "auth-owner", providers: [provider.id] }],
      });
      const pluginMetadataSnapshot = {
        ...metadata,
        index: {
          ...metadata.index,
          plugins: metadata.index.plugins.map((plugin) =>
            Object.assign({}, plugin, { syntheticAuthRefs: [provider.id] }),
          ),
        },
      };
      const config = {
        models: {
          providers: {
            "custom-native": {
              api,
              baseUrl: "https://native.example.test",
              models: [],
            },
            "unrelated-provider": {
              baseUrl: "https://unrelated.example.test",
              models: [],
            },
          },
        },
      };
      const prepared = vi
        .mocked(prepareProviderExternalAuthWithPlugin)
        .mockImplementation((params) =>
          prepareSyntheticAuthWithProvider(provider, params.context, params),
        );
      const resolved = vi
        .mocked(resolveProviderSyntheticAuthWithPlugin)
        .mockImplementation((params) =>
          resolveSyntheticAuthWithProvider(provider, params.context, params),
        );
      mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
      let discoveryApiKey: string | undefined;
      mocks.runProviderCatalog.mockImplementationOnce(
        async ({
          resolveProviderAuth,
        }: Parameters<typeof import("../plugins/provider-discovery.js").runProviderCatalog>[0]) => {
          const auth = resolveProviderAuth("custom-native");
          discoveryApiKey = auth.discoveryApiKey;
          return {
            providers: {
              [provider.id]: {
                apiKey: auth.apiKey,
                baseUrl: "https://native.example.test",
                models: [],
              },
            },
          };
        },
      );
      try {
        await resolveImplicitProviders({
          agentDir: state.agentDir(),
          authStore: { version: 1, profiles: {} },
          config,
          env: state.env,
          pluginMetadataSnapshot,
          ...(scoped ? { providerDiscoveryProviderIds: [provider.id] } : {}),
        });
        expect(mocks.runProviderCatalog).toHaveBeenCalledOnce();
        expect(discoveryApiKey).toBe(scoped ? undefined : "native-auth-ready");
        expect(
          prepareNative.mock.calls.filter(([context]) => context.provider === "custom-native"),
        ).toHaveLength(scoped ? 0 : 1);
        expect(prepared.mock.calls.map(([params]) => params.provider)).not.toContain(
          "unrelated-provider",
        );
      } finally {
        prepared.mockRestore();
        resolved.mockRestore();
      }
    },
  );

  it("loads configured provider entrypoints but runs static hooks only for unresolved refs", async () => {
    const openai = createStaticOnlyProvider("openai");
    const anthropic = createStaticOnlyProvider("anthropic");
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([openai, anthropic]);
    mocks.prepareProviderStaticCatalog.mockResolvedValue({
      providers: [anthropic],
      entries: [],
    });

    const prepared = await prepareImplicitProviderStaticCatalog({
      config: {},
      env: state.env,
      providerDiscoveryProviderIds: ["openai", "anthropic"],
      staticCatalogProviderIds: ["anthropic"],
    });

    expect(mocks.prepareProviderStaticCatalog).toHaveBeenCalledWith({
      providers: [anthropic],
    });
    expect(prepared.providers).toEqual([openai, anthropic]);
  });

  it("prepares a sole family hook for a selected catalog identity", async () => {
    const byteplus = { ...createStaticOnlyProvider("byteplus"), pluginId: "byteplus" };
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([byteplus]);

    await prepareImplicitProviderStaticCatalog({
      config: {},
      env: state.env,
      pluginMetadataSnapshot: {
        index: { plugins: [] } as never,
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: metadataOwners({
          modelCatalogProviders: new Map([["byteplus-plan", ["byteplus"]]]),
        }),
      },
      providerDiscoveryProviderIds: ["byteplus-plan"],
      staticCatalogProviderIds: ["byteplus-plan"],
    });

    expect(mocks.prepareProviderStaticCatalog).toHaveBeenCalledWith({ providers: [byteplus] });
  });

  it("passes startup provider scopes as plugin owner filters", async () => {
    await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: state.env,
      explicitProviders: {},
      pluginMetadataSnapshot: {
        index: { plugins: [] } as never,
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: metadataOwners({
          providers: new Map([["openai", ["openai"]]]),
        }),
      },
      providerDiscoveryProviderIds: ["openai"],
      providerDiscoveryTimeoutMs: 1234,
    });

    const discoveryOptions = firstMockArg(
      mocks.resolveRuntimePluginDiscoveryProviders,
      "runtime plugin discovery",
    ) as { onlyPluginIds?: string[] };
    expect(discoveryOptions?.onlyPluginIds).toEqual(["openai"]);
    const catalogOptions = firstMockArg(mocks.runProviderCatalog, "provider catalog") as {
      timeoutMs?: number;
    };
    expect(catalogOptions?.timeoutMs).toBe(1234);
  });

  it("treats an explicit empty provider scope as no discovery", async () => {
    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: state.env,
      explicitProviders: {},
      providerDiscoveryProviderIds: [],
    });

    expect(mocks.resolveRuntimePluginDiscoveryProviders).not.toHaveBeenCalled();
    expect(mocks.runProviderCatalog).not.toHaveBeenCalled();
    expect(mocks.runProviderStaticCatalog).not.toHaveBeenCalled();
    expect(providers).toEqual({});
  });

  it("runs only the selected catalog hook within a shared plugin owner", async () => {
    const alpha = { ...createProvider("alpha"), pluginId: "shared" };
    const beta = { ...createProvider("beta"), pluginId: "shared" };
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([alpha, beta]);
    mocks.runProviderCatalog.mockImplementation(
      async ({ provider }: { provider: ProviderPlugin }) => ({
        providers: {
          [provider.id]: {
            baseUrl: `https://${provider.id}.example.test`,
            api: "openai-completions",
            models: [],
          },
        },
      }),
    );

    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: state.env,
      explicitProviders: {},
      pluginMetadataSnapshot: {
        index: { plugins: [] } as never,
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: metadataOwners({
          providers: new Map([
            ["alpha", ["shared"]],
            ["beta", ["shared"]],
          ]),
        }),
      },
      providerDiscoveryProviderIds: ["alpha"],
    });

    expect(mocks.runProviderCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.runProviderCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ provider: alpha, providerIds: ["alpha"] }),
    );
    expect(Object.keys(providers ?? {})).toEqual(["alpha"]);
  });

  it("filters a shared catalog hook result to its selected identity", async () => {
    const family = {
      ...createProvider("family"),
      pluginId: "family",
      hookAliases: ["family-plan"],
    };
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([family]);
    mocks.runProviderCatalog.mockResolvedValue({
      providers: {
        family: {
          baseUrl: "https://family.example.test",
          api: "openai-completions",
          models: [],
        },
        "family-plan": {
          baseUrl: "https://family-plan.example.test",
          api: "openai-completions",
          models: [],
        },
      },
    });

    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: state.env,
      explicitProviders: {},
      pluginMetadataSnapshot: {
        index: { plugins: [] } as never,
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: metadataOwners({
          modelCatalogProviders: new Map([
            ["family", ["family"]],
            ["family-plan", ["family"]],
          ]),
        }),
      },
      providerDiscoveryProviderIds: ["family-plan"],
    });

    expect(mocks.runProviderCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ provider: family, providerIds: ["family-plan"] }),
    );
    expect(Object.keys(providers ?? {})).toEqual(["family-plan"]);
  });

  it("retains a single-provider catalog under its selected registered alias", async () => {
    const canonical = { ...createProvider("canonical"), pluginId: "canonical" };
    canonical.aliases = ["alias"];
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([canonical]);
    mocks.runProviderCatalog.mockResolvedValue({
      provider: {
        baseUrl: "https://canonical.example.test",
        api: "openai-completions",
        models: [],
      },
    });

    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: state.env,
      explicitProviders: {},
      pluginMetadataSnapshot: {
        index: { plugins: [] } as never,
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: metadataOwners({ providers: new Map([["alias", ["canonical"]]]) }),
      },
      providerDiscoveryProviderIds: ["alias"],
    });

    expect(mocks.runProviderCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ provider: canonical, providerIds: ["alias"] }),
    );
    expect(Object.keys(providers ?? {})).toEqual(["alias"]);
  });

  it.each([
    {
      name: "maps live provider backend ids to owning plugin ids",
      env: { OPENCLAW_LIVE_TEST: "1", OPENCLAW_LIVE_PROVIDERS: "claude-cli" },
      owners: { providers: new Map([["claude-cli", ["anthropic"]]]) },
      expected: ["anthropic"],
    },
    {
      name: "honors gateway live provider filters",
      env: { OPENCLAW_LIVE_TEST: "1", OPENCLAW_LIVE_GATEWAY_PROVIDERS: "claude-cli" },
      owners: { providers: new Map([["claude-cli", ["anthropic"]]]) },
      expected: ["anthropic"],
    },
    {
      name: "keeps explicit plugin-id filters when no owning provider plugin exists",
      env: { OPENCLAW_LIVE_TEST: "1", OPENCLAW_LIVE_PROVIDERS: "openrouter" },
      owners: {},
      expected: ["openrouter"],
    },
    {
      name: "maps live provider backend ids through plugin metadata cli backend owners",
      env: { OPENCLAW_LIVE_TEST: "1", OPENCLAW_LIVE_PROVIDERS: "claude-cli" },
      owners: { cliBackends: new Map([["claude-cli", ["anthropic"]]]) },
      expected: ["anthropic"],
    },
    {
      name: "normalizes mixed-case backend ids through plugin metadata owners",
      env: { OPENCLAW_LIVE_TEST: "1", OPENCLAW_LIVE_PROVIDERS: "Claude-CLI" },
      owners: { cliBackends: new Map([["claude-cli", ["anthropic"]]]) },
      expected: ["anthropic"],
    },
    {
      name: "does not resolve provider aliases through plugin metadata owners",
      env: { OPENCLAW_LIVE_TEST: "1", OPENCLAW_LIVE_PROVIDERS: "bytedance" },
      owners: { providers: new Map([["volcengine", ["volcengine"]]]) },
      expected: ["bytedance"],
    },
    {
      name: "scopes normal startup discovery to requested provider owners",
      env: {},
      providerIds: ["openai"],
      owners: { providers: new Map([["openai", ["openai"]]]) },
      expected: ["openai"],
    },
    {
      name: "maps mixed-case startup provider ids through model catalog owners",
      env: {},
      providerIds: ["OpenAI"],
      owners: { modelCatalogProviders: new Map([["openai", ["codex"]]]) },
      expected: ["codex"],
    },
  ])("$name", async ({ env, expected, owners, providerIds }) => {
    await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: { ...state.env, VITEST: "1", ...env },
      explicitProviders: {},
      pluginMetadataSnapshot: {
        index: { plugins: [] } as never,
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: metadataOwners(owners),
      },
      ...(providerIds ? { providerDiscoveryProviderIds: providerIds } : {}),
    });

    expect(
      firstMockArg(mocks.resolveRuntimePluginDiscoveryProviders, "runtime plugin discovery"),
    ).toMatchObject({ onlyPluginIds: expected });
  });

  it("records an unavailable outcome when live catalog discovery times out", async () => {
    mocks.runProviderCatalog.mockImplementationOnce(() => new Promise<void>(() => {}));
    const outcomes: Array<{ provider: string; status: string }> = [];

    await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: state.env,
      explicitProviders: {},
      providerDiscoveryProviderIds: ["openai"],
      providerDiscoveryTimeoutMs: 1,
      onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
    });

    expect(outcomes).toEqual([{ provider: "openai", status: "unavailable" }]);
  });

  it.each(["timeout", "secret-unavailable"] as const)(
    "records every selected family identity after %s without accepting late success",
    async (failure) => {
      const family = createProvider("family");
      const healthy = createProvider("healthy");
      mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([family, healthy]);
      const completion = createDeferredCore();
      let lateCatalog: Promise<void> | undefined;
      const outcomes: Array<{ provider: string; status: string }> = [];
      mocks.runProviderCatalog.mockImplementation((params) => {
        if (params.provider.id === "healthy") {
          return Promise.resolve({
            provider: {
              baseUrl: "https://healthy.example.test/v1",
              models: [createTextModel("healthy-live", "Healthy live")],
            },
          });
        }
        if (failure === "secret-unavailable") {
          return Promise.reject(
            new SecretSurfaceUnavailableError({
              ownerKind: "provider",
              ownerId: "family",
              state: "unavailable",
              paths: ["models.providers.family.apiKey"],
              refKeys: [],
              reason: "fixture secret is unavailable",
            }),
          );
        }
        lateCatalog = completion.promise.then(() => {
          params.reportCatalogOutcome?.({ provider: "family-plan", status: "ready" });
        });
        return lateCatalog;
      });
      const providers = await resolveImplicitProviders({
        agentDir: state.agentDir(),
        config: {},
        env: state.env,
        explicitProviders: {},
        providerDiscoveryProviderIds: ["family", "family-plan", "healthy"],
        providerDiscoveryTimeoutMs: 1,
        pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [
            createPluginManifestRecordFixture({
              id: "family",
              providers: ["family", "family-plan"],
            }),
            createPluginManifestRecordFixture({ id: "healthy", providers: ["healthy"] }),
          ],
        }),
        onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
      });
      const expected = [
        { provider: "family", status: "unavailable" },
        { provider: "family-plan", status: "unavailable" },
      ];
      try {
        expect(providers?.healthy?.models.map((model) => model.id)).toEqual(["healthy-live"]);
        expect(outcomes).toEqual(expected);
      } finally {
        completion.resolve();
        await lateCatalog;
      }
      expect(outcomes).toEqual(expected);
    },
  );

  it("rethrows non-timeout live catalog discovery failures", async () => {
    mocks.runProviderCatalog.mockRejectedValueOnce(
      new Error("provider catalog timed out after provider-defined retry window"),
    );
    const outcomes: Array<{ provider: string; status: string }> = [];

    await expect(
      resolveImplicitProviders({
        agentDir: state.agentDir(),
        config: {},
        env: state.env,
        explicitProviders: {},
        providerDiscoveryProviderIds: ["openai"],
        providerDiscoveryTimeoutMs: 1_000,
        onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
      }),
    ).rejects.toThrow("provider catalog timed out after provider-defined retry window");

    expect(outcomes).toEqual([]);
  });

  it("can keep startup discovery on provider discovery entries only", async () => {
    await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: state.env,
      explicitProviders: {},
      providerDiscoveryEntriesOnly: true,
    });

    const discoveryOptions = firstMockArg(
      mocks.resolveRuntimePluginDiscoveryProviders,
      "runtime plugin discovery",
    ) as { discoveryEntriesOnly?: boolean };
    expect(discoveryOptions?.discoveryEntriesOnly).toBe(true);
  });

  it("does not fall through to live catalogs when entries-only providers lack static rows", async () => {
    await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: state.env,
      explicitProviders: {},
      providerDiscoveryEntriesOnly: true,
    });

    expect(mocks.runProviderCatalog).not.toHaveBeenCalled();
    expect(mocks.runProviderStaticCatalog).not.toHaveBeenCalled();
  });

  it("uses static provider catalogs for entries-only startup discovery", async () => {
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      createProviderWithStaticCatalog("codex"),
    ]);

    await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: state.env,
      explicitProviders: {},
      providerDiscoveryEntriesOnly: true,
    });

    expect(mocks.runProviderStaticCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.runProviderCatalog).not.toHaveBeenCalled();
  });

  it("reuses prepared static results while preserving the requesting provider scope", async () => {
    const openai = { ...createStaticOnlyProvider("openai"), pluginId: "openai" };
    const anthropic = { ...createStaticOnlyProvider("anthropic"), pluginId: "anthropic" };
    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: state.env,
      explicitProviders: {},
      pluginMetadataSnapshot: {
        index: { plugins: [] } as never,
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: metadataOwners({
          providers: new Map([
            ["openai", ["openai"]],
            ["anthropic", ["anthropic"]],
          ]),
        }),
      },
      preparedStaticProviderCatalog: {
        providers: [openai, anthropic],
        entries: [
          {
            provider: openai,
            result: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  api: "openai-responses",
                  models: [],
                },
                unrelated: {
                  baseUrl: "https://unrelated.example.test",
                  api: "openai-completions",
                  models: [],
                },
              },
            },
          },
          {
            provider: anthropic,
            result: {
              providers: {
                anthropic: {
                  baseUrl: "https://api.anthropic.com",
                  api: "anthropic-messages",
                  models: [],
                },
              },
            },
          },
        ],
      },
      providerDiscoveryEntriesOnly: true,
      providerDiscoveryProviderIds: ["openai"],
    });

    expect(Object.keys(providers ?? {})).toEqual(["openai"]);
    expect(mocks.resolveRuntimePluginDiscoveryProviders).not.toHaveBeenCalled();
    expect(mocks.runProviderStaticCatalog).not.toHaveBeenCalled();
  });

  it("runs a prepared provider's static hook when its result was not prepared", async () => {
    const anthropic = { ...createStaticOnlyProvider("anthropic"), pluginId: "anthropic" };
    mocks.runProviderStaticCatalog.mockResolvedValueOnce({
      providers: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
          models: [],
        },
      },
    });

    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: state.env,
      explicitProviders: {},
      pluginMetadataSnapshot: {
        index: { plugins: [] } as never,
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: metadataOwners({
          providers: new Map([["anthropic", ["anthropic"]]]),
        }),
      },
      preparedStaticProviderCatalog: {
        providers: [anthropic],
        entries: [],
      },
      providerDiscoveryEntriesOnly: true,
      providerDiscoveryProviderIds: ["anthropic"],
    });

    expect(Object.keys(providers ?? {})).toEqual(["anthropic"]);
    expect(mocks.resolveRuntimePluginDiscoveryProviders).not.toHaveBeenCalled();
    expect(mocks.runProviderStaticCatalog).toHaveBeenCalledWith({ provider: anthropic });
  });

  it("uses static-only provider catalogs for scoped startup discovery", async () => {
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      createStaticOnlyProvider("openai"),
    ]);

    await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: state.env,
      explicitProviders: {},
      providerDiscoveryProviderIds: ["openai"],
    });

    expect(mocks.runProviderStaticCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.runProviderCatalog).not.toHaveBeenCalled();
  });

  it("fills missing static catalog apiKey from Google Vertex ADC auth evidence", async () => {
    const credentialsPath = await state.writeJson("application_default_credentials.json", {
      type: "authorized_user",
    });
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      createStaticOnlyProvider("google"),
    ]);
    mocks.runProviderStaticCatalog.mockResolvedValue({
      providers: {
        "google-vertex": {
          baseUrl: "https://aiplatform.googleapis.com",
          api: "google-vertex" as const,
          models: [createTextModel("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview")],
        },
      },
    });

    const providers = await withEnvAsync(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: BUNDLED_PLUGINS_DIR,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      async () =>
        await resolveImplicitProviders({
          agentDir: state.agentDir(),
          config: {},
          env: {
            ...state.env,
            OPENCLAW_BUNDLED_PLUGINS_DIR: BUNDLED_PLUGINS_DIR,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
            GOOGLE_CLOUD_PROJECT: "vertex-project",
            GOOGLE_CLOUD_LOCATION: "global",
          } as NodeJS.ProcessEnv,
          explicitProviders: {},
          providerDiscoveryEntriesOnly: true,
        }),
    );

    expect(providers?.["google-vertex"]?.apiKey).toBe("gcp-vertex-credentials");
  });

  it("falls back to static provider catalogs when runtime discovery has no rows", async () => {
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      createProviderWithStaticCatalog("minimax"),
    ]);
    mocks.runProviderCatalog.mockResolvedValue(null);
    mocks.runProviderStaticCatalog.mockResolvedValue({
      providers: {
        minimax: {
          baseUrl: "https://api.minimax.io/anthropic",
          api: "anthropic-messages" as const,
          models: [createTextModel("MiniMax-M2.7", "MiniMax M2.7")],
        },
      },
    });

    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {},
      env: state.env,
      explicitProviders: {},
      providerDiscoveryProviderIds: ["minimax"],
    });

    expect(mocks.runProviderCatalog).toHaveBeenCalledTimes(1);
    // Static catalogs are the startup fallback when scoped runtime discovery is empty.
    expect(mocks.runProviderStaticCatalog).toHaveBeenCalledTimes(1);
    expect(providers?.minimax?.models.map((model) => model.id)).toEqual(["MiniMax-M2.7"]);
  });

  it("inherits discovered input for a configured model whose source row omitted it", async () => {
    const explicitProvider = {
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      apiKey: "AWS_PROFILE",
      models: [createTextModel("vision-model", "Vision Model")],
    };
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      createProvider("amazon-bedrock"),
    ]);
    mocks.runProviderCatalog.mockResolvedValue({
      provider: {
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        models: [
          { ...createTextModel("vision-model", "Vision Model"), input: ["text", "image"] },
          createTextModel("discovered-only", "Discovered Only"),
        ],
      },
    });

    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: { models: { providers: { "amazon-bedrock": explicitProvider } } },
      env: { ...state.env, AWS_PROFILE: "default" },
      explicitProviders: { "amazon-bedrock": explicitProvider },
      sourceModelFields: new Map([
        ["amazon-bedrock/vision-model", { inputOmitted: true, cost: undefined }],
      ]),
    });

    expect(providers?.["amazon-bedrock"]?.models).toMatchObject([
      { id: "vision-model", input: ["text", "image"] },
    ]);
  });

  it("keeps explicit provider models manual without provider wildcard visibility", async () => {
    const explicitProvider = {
      baseUrl: "http://vllm.example/v1",
      api: "openai-completions" as const,
      models: [createTextModel("manual-model", "Manual Model")],
    };
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([createProvider("vllm")]);
    mocks.runProviderCatalog.mockResolvedValue({
      provider: {
        baseUrl: "http://vllm.example/v1",
        api: "openai-completions" as const,
        models: [createTextModel("discovered-model", "Discovered Model")],
      },
    });

    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {
        agents: {
          defaults: {
            models: {
              "vllm/manual-model": {},
            },
          },
        },
        models: {
          providers: {
            vllm: explicitProvider,
          },
        },
      },
      env: state.env,
      explicitProviders: {
        vllm: explicitProvider,
      },
    });

    expect(providers?.vllm?.models.map((model) => model.id)).toEqual(["manual-model"]);
  });

  it("merges discovered self-hosted models into explicit provider models for wildcard visibility", async () => {
    const explicitProvider = {
      baseUrl: "http://vllm.example/v1",
      api: "openai-completions" as const,
      models: [createTextModel("manual-model", "Manual Model")],
    };
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([createProvider("vllm")]);
    mocks.runProviderCatalog.mockResolvedValue({
      provider: {
        baseUrl: "http://vllm.example/v1",
        api: "openai-completions" as const,
        models: [createTextModel("discovered-model", "Discovered Model")],
      },
    });

    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      config: {
        agents: {
          defaults: {
            models: {
              "vllm/*": {},
            },
          },
        },
        models: {
          providers: {
            vllm: explicitProvider,
          },
        },
      },
      env: state.env,
      explicitProviders: {
        vllm: explicitProvider,
      },
    });

    expect(providers?.vllm?.models.map((model) => model.id)).toEqual([
      "manual-model",
      "discovered-model",
    ]);
  });
});
