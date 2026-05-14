import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { createEmptyPluginRegistry } from "./registry.js";

type MockManifestRegistry = {
  plugins: Array<Record<string, unknown>>;
  diagnostics: unknown[];
};

function createEmptyMockManifestRegistry(): MockManifestRegistry {
  return { plugins: [], diagnostics: [] };
}

const mocks = vi.hoisted(() => ({
  createMockRegistry: () => ({
    plugins: [],
    diagnostics: [],
    memoryEmbeddingProviders: [],
    speechProviders: [],
    realtimeTranscriptionProviders: [],
    realtimeVoiceProviders: [],
    mediaUnderstandingProviders: [],
    imageGenerationProviders: [],
    videoGenerationProviders: [],
    musicGenerationProviders: [],
  }),
  resolveRuntimePluginRegistry: vi.fn<
    (params?: unknown) => ReturnType<typeof createEmptyPluginRegistry> | undefined
  >(() => undefined),
  resolvePluginRegistryLoadCacheKey: vi.fn((options: unknown) => JSON.stringify(options)),
  loadPluginManifestRegistry: vi.fn<(params?: Record<string, unknown>) => MockManifestRegistry>(
    () => createEmptyMockManifestRegistry(),
  ),
  resolveInstalledManifestRegistryIndexFingerprint: vi.fn(() => "test-installed-index"),
  loadBundledCapabilityRuntimeRegistry: vi.fn(),
  loadPluginRegistrySnapshot: vi.fn<
    (_params?: unknown) => { plugins: Array<Record<string, unknown>> }
  >(() => ({
    plugins: [],
  })),
  withBundledPluginAllowlistCompat: vi.fn(
    ({ config, pluginIds }: { config?: OpenClawConfig; pluginIds: string[] }) =>
      ({
        ...config,
        plugins: {
          ...config?.plugins,
          allow: Array.from(new Set([...(config?.plugins?.allow ?? []), ...pluginIds])),
        },
      }) as OpenClawConfig,
  ),
  withBundledPluginEnablementCompat: vi.fn(({ config }) => config),
  withBundledPluginVitestCompat: vi.fn(({ config }) => config),
}));

vi.mock("./loader.js", () => ({
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
  resolvePluginRegistryLoadCacheKey: mocks.resolvePluginRegistryLoadCacheKey,
}));

vi.mock("./active-runtime-registry.js", () => ({
  getLoadedRuntimePluginRegistry: (params?: { requiredPluginIds?: string[] }) => {
    if (params === undefined) {
      return mocks.resolveRuntimePluginRegistry();
    }
    return mocks.resolveRuntimePluginRegistry({
      onlyPluginIds: params.requiredPluginIds,
    });
  },
}));

vi.mock("./bundled-capability-runtime.js", () => ({
  loadBundledCapabilityRuntimeRegistry: mocks.loadBundledCapabilityRuntimeRegistry,
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: mocks.loadPluginManifestRegistry,
  resolveInstalledManifestRegistryIndexFingerprint:
    mocks.resolveInstalledManifestRegistryIndexFingerprint,
}));

vi.mock("./manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistry: mocks.loadPluginManifestRegistry,
  };
});

vi.mock("./plugin-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-registry.js")>();
  return {
    ...actual,
    loadPluginRegistrySnapshot: mocks.loadPluginRegistrySnapshot,
    loadPluginRegistrySnapshotWithMetadata: (params?: { index?: unknown }) => {
      const snapshot = (params?.index ?? mocks.loadPluginRegistrySnapshot(params)) as {
        plugins?: Array<Record<string, unknown>>;
      };
      return {
        snapshot: {
          ...snapshot,
          plugins:
            snapshot.plugins && snapshot.plugins.length > 0
              ? snapshot.plugins
              : [
                  {
                    pluginId: "__test_manifest_registry_fixture__",
                    origin: "bundled",
                    enabled: true,
                  },
                ],
        },
        source: params?.index ? "provided" : "derived",
        diagnostics: [],
      };
    },
    loadPluginManifestRegistryForPluginRegistry: (
      ...args: Parameters<typeof mocks.loadPluginManifestRegistry>
    ) => {
      const [{ includeDisabled: _includeDisabled, ...params } = {}] = args as [
        Record<string, unknown>?,
      ];
      return mocks.loadPluginManifestRegistry(params);
    },
  };
});

vi.mock("./bundled-compat.js", () => ({
  withBundledPluginAllowlistCompat: mocks.withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat: mocks.withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat: mocks.withBundledPluginVitestCompat,
}));

let resolvePluginCapabilityProviders: typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProviders;
let resolvePluginCapabilityProvider: typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProvider;
let resolveBundledCapabilityProviderIds: typeof import("./capability-provider-runtime.js").resolveBundledCapabilityProviderIds;
let resolveManifestCapabilityProviderIds: typeof import("./capability-provider-runtime.js").resolveManifestCapabilityProviderIds;
let clearCurrentPluginMetadataSnapshot: typeof import("./current-plugin-metadata-snapshot.js").clearCurrentPluginMetadataSnapshot;
let setCurrentPluginMetadataSnapshot: typeof import("./current-plugin-metadata-snapshot.js").setCurrentPluginMetadataSnapshot;

function expectResolvedCapabilityProviderIds(providers: Array<{ id: string }>, expected: string[]) {
  expect(providers.map((provider) => provider.id)).toEqual(expected);
}

function expectNoResolvedCapabilityProviders(providers: Array<{ id: string }>) {
  expectResolvedCapabilityProviderIds(providers, []);
}

function expectActiveRegistryLookup(pluginIds: string[]) {
  expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({ onlyPluginIds: pluginIds });
}

function expectInitialRuntimeRegistryLookup() {
  expect(mocks.resolveRuntimePluginRegistry).toHaveBeenNthCalledWith(1);
}

function requireManifestRegistryLoadParams(index = 0): Record<string, unknown> {
  const call = mocks.loadPluginManifestRegistry.mock.calls[index] as
    | [Record<string, unknown>]
    | undefined;
  if (!call) {
    throw new Error(`loadPluginManifestRegistry call ${index} missing`);
  }
  return call[0];
}

function expectManifestRegistryLoad(index: number, config: OpenClawConfig | Record<string, never>) {
  const params = requireManifestRegistryLoadParams(index);
  expect(params.config).toEqual(config);
  expect(params.env).toBe(process.env);
}

function requireRuntimeRegistryLookup(params: {
  activate?: boolean;
  onlyPluginIds?: string[];
}): Record<string, unknown> {
  const lookup = mocks.resolveRuntimePluginRegistry.mock.calls
    .map(([options]) => options)
    .find(
      (options): options is Record<string, unknown> =>
        Boolean(options) &&
        typeof options === "object" &&
        (params.activate === undefined ||
          (options as { activate?: unknown }).activate === params.activate) &&
        (params.onlyPluginIds === undefined ||
          JSON.stringify((options as { onlyPluginIds?: unknown }).onlyPluginIds) ===
            JSON.stringify(params.onlyPluginIds)),
    );
  if (!lookup) {
    throw new Error("runtime registry lookup missing");
  }
  return lookup;
}

function collectActiveRegistryLookups() {
  return mocks.resolveRuntimePluginRegistry.mock.calls
    .map(([options]) => options)
    .filter((options): options is { onlyPluginIds?: string[] } =>
      Boolean(
        options &&
        typeof options === "object" &&
        Object.hasOwn(options as Record<string, unknown>, "onlyPluginIds") &&
        !Object.hasOwn(options as Record<string, unknown>, "activate"),
      ),
    );
}

function expectBundledCompatLoadPath(params: {
  cfg: OpenClawConfig;
  allowlistCompat: OpenClawConfig;
  enablementCompat: {
    plugins: {
      allow?: string[];
      entries: { openai: { enabled: boolean } };
    };
  };
}) {
  expectManifestRegistryLoad(0, params.cfg);
  expect(mocks.withBundledPluginEnablementCompat).toHaveBeenCalledWith({
    config: params.allowlistCompat,
    pluginIds: ["openai"],
  });
  expect(mocks.withBundledPluginVitestCompat).toHaveBeenCalledWith({
    config: params.enablementCompat,
    pluginIds: ["openai"],
    env: process.env,
  });
  expectActiveRegistryLookup(["openai"]);
}

function createCompatChainConfig() {
  const cfg = { plugins: { allow: ["custom-plugin"] } } as OpenClawConfig;
  const allowlistCompat = {
    plugins: {
      allow: ["custom-plugin", "openai"],
    },
  } as OpenClawConfig;
  const enablementCompat = {
    plugins: {
      allow: ["custom-plugin", "openai"],
      entries: { openai: { enabled: true } },
    },
  };
  return { cfg, allowlistCompat, enablementCompat };
}

function setBundledCapabilityFixture(
  contractKey: string,
  pluginId = "openai",
  providerId = pluginId,
) {
  mocks.loadPluginManifestRegistry.mockReturnValue({
    plugins: [
      {
        id: pluginId,
        origin: "bundled",
        contracts: { [contractKey]: [providerId] },
      },
      {
        id: "custom-plugin",
        origin: "workspace",
        contracts: {},
      },
    ] as never,
    diagnostics: [],
  });
}

function expectCompatChainApplied(params: {
  key:
    | "memoryEmbeddingProviders"
    | "speechProviders"
    | "realtimeTranscriptionProviders"
    | "realtimeVoiceProviders"
    | "mediaUnderstandingProviders"
    | "imageGenerationProviders"
    | "videoGenerationProviders"
    | "musicGenerationProviders";
  contractKey: string;
  cfg: OpenClawConfig;
  allowlistCompat: OpenClawConfig;
  enablementCompat: {
    plugins: {
      allow?: string[];
      entries: { openai: { enabled: boolean } };
    };
  };
}) {
  setBundledCapabilityFixture(params.contractKey);
  mocks.withBundledPluginEnablementCompat.mockReturnValue(params.enablementCompat);
  mocks.withBundledPluginVitestCompat.mockReturnValue(params.enablementCompat);
  expectNoResolvedCapabilityProviders(
    resolvePluginCapabilityProviders({ key: params.key, cfg: params.cfg }),
  );
  expectBundledCompatLoadPath(params);
}

describe("resolvePluginCapabilityProviders", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({
      resolveBundledCapabilityProviderIds,
      resolveManifestCapabilityProviderIds,
      resolvePluginCapabilityProvider,
      resolvePluginCapabilityProviders,
    } = await import("./capability-provider-runtime.js"));
    ({ clearCurrentPluginMetadataSnapshot, setCurrentPluginMetadataSnapshot } =
      await import("./current-plugin-metadata-snapshot.js"));
  });

  beforeEach(() => {
    clearCurrentPluginMetadataSnapshot();
    mocks.resolveRuntimePluginRegistry.mockReset();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.resolvePluginRegistryLoadCacheKey.mockReset();
    mocks.resolvePluginRegistryLoadCacheKey.mockImplementation((options: unknown) =>
      JSON.stringify(options),
    );
    mocks.loadPluginRegistrySnapshot.mockReset();
    mocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue(createEmptyMockManifestRegistry());
    mocks.loadBundledCapabilityRuntimeRegistry.mockReset();
    mocks.loadBundledCapabilityRuntimeRegistry.mockImplementation(() => mocks.createMockRegistry());
    mocks.withBundledPluginAllowlistCompat.mockClear();
    mocks.withBundledPluginAllowlistCompat.mockImplementation(
      ({ config, pluginIds }: { config?: OpenClawConfig; pluginIds: string[] }) =>
        ({
          ...config,
          plugins: {
            ...config?.plugins,
            allow: Array.from(new Set([...(config?.plugins?.allow ?? []), ...pluginIds])),
          },
        }) as OpenClawConfig,
    );
    mocks.withBundledPluginEnablementCompat.mockReset();
    mocks.withBundledPluginEnablementCompat.mockImplementation(({ config }) => config);
    mocks.withBundledPluginVitestCompat.mockReset();
    mocks.withBundledPluginVitestCompat.mockImplementation(({ config }) => config);
  });

  it("resolves bundled capability ids from the current metadata snapshot", () => {
    setCurrentPluginMetadataSnapshot({
      policyHash: resolveInstalledPluginIndexPolicyHash({}),
      workspaceDir: "/workspace",
      index: { plugins: [] },
      registryDiagnostics: [],
      manifestRegistry: { plugins: [], diagnostics: [] },
      plugins: [
        {
          id: "fal",
          origin: "bundled",
          contracts: { imageGenerationProviders: ["fal"] },
        },
      ],
      diagnostics: [],
      byPluginId: new Map(),
      normalizePluginId: (id: string) => id,
      owners: {
        channels: new Map(),
        channelConfigs: new Map(),
        providers: new Map(),
        modelCatalogProviders: new Map(),
        cliBackends: new Map(),
        setupProviders: new Map(),
        commandAliases: new Map(),
        contracts: new Map(),
      },
      metrics: {
        registrySnapshotMs: 0,
        manifestRegistryMs: 0,
        ownerMapsMs: 0,
        totalMs: 0,
        indexPluginCount: 0,
        manifestPluginCount: 1,
      },
    } as never);

    expect(
      resolveBundledCapabilityProviderIds({
        key: "imageGenerationProviders",
        workspaceDir: "/workspace",
      }),
    ).toEqual(["fal"]);
    expect(mocks.loadPluginManifestRegistry).not.toHaveBeenCalled();
  });

  it("resolves enabled external capability ids from the current metadata snapshot", () => {
    setCurrentPluginMetadataSnapshot({
      policyHash: resolveInstalledPluginIndexPolicyHash({}),
      workspaceDir: "/workspace",
      index: {
        plugins: [
          { pluginId: "external-image", origin: "global", enabled: true },
          { pluginId: "external-disabled", origin: "global", enabled: false },
        ],
      },
      registryDiagnostics: [],
      manifestRegistry: { plugins: [], diagnostics: [] },
      plugins: [
        {
          id: "external-image",
          origin: "global",
          contracts: { imageGenerationProviders: ["external-image"] },
        },
        {
          id: "external-disabled",
          origin: "global",
          contracts: { imageGenerationProviders: ["external-disabled"] },
        },
      ],
      diagnostics: [],
      byPluginId: new Map(),
      normalizePluginId: (id: string) => id,
      owners: {
        channels: new Map(),
        channelConfigs: new Map(),
        providers: new Map(),
        modelCatalogProviders: new Map(),
        cliBackends: new Map(),
        setupProviders: new Map(),
        commandAliases: new Map(),
        contracts: new Map(),
      },
      metrics: {
        registrySnapshotMs: 0,
        manifestRegistryMs: 0,
        ownerMapsMs: 0,
        totalMs: 0,
        indexPluginCount: 2,
        manifestPluginCount: 2,
      },
    } as never);

    expect(
      resolveManifestCapabilityProviderIds({
        key: "imageGenerationProviders",
        workspaceDir: "/workspace",
      }),
    ).toEqual(["external-image"]);
    expect(mocks.loadPluginManifestRegistry).not.toHaveBeenCalled();
  });

  it("uses the active registry when capability providers are already loaded", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push({
      pluginId: "openai",
      pluginName: "openai",
      source: "test",
      provider: {
        id: "openai",
        label: "openai",
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({ key: "speechProviders" });

    expectResolvedCapabilityProviderIds(providers, ["openai"]);
    expect(mocks.loadPluginManifestRegistry).not.toHaveBeenCalled();
    expectInitialRuntimeRegistryLookup();
  });

  it("targets enabled external capability plugins without bundled fallback capture", () => {
    const loaded = createEmptyPluginRegistry();
    loaded.imageGenerationProviders.push({
      pluginId: "external-image",
      pluginName: "external-image",
      source: "test",
      provider: {
        id: "external-image",
        label: "External Image",
        isConfigured: () => true,
        generate: async () => ({
          kind: "image",
          images: [],
        }),
      },
    } as never);
    mocks.loadPluginRegistrySnapshot.mockReturnValue({
      plugins: [{ pluginId: "external-image", origin: "global", enabled: true }],
    });
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "external-image",
          origin: "global",
          contracts: { imageGenerationProviders: ["external-image"] },
        },
      ],
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockImplementation((options?: unknown) =>
      options ? loaded : undefined,
    );

    expectResolvedCapabilityProviderIds(
      resolvePluginCapabilityProviders({ key: "imageGenerationProviders" }),
      ["external-image"],
    );
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenLastCalledWith({
      onlyPluginIds: ["external-image"],
    });
    expect(mocks.loadBundledCapabilityRuntimeRegistry).not.toHaveBeenCalled();
  });

  it("merges enabled generation providers missing from the active registry", () => {
    const active = createEmptyPluginRegistry();
    active.imageGenerationProviders.push({
      pluginId: "xai",
      pluginName: "xai",
      source: "test",
      provider: {
        id: "xai",
        defaultModel: "grok-2-image",
        models: ["grok-2-image"],
        isConfigured: () => true,
        generateImage: async () => ({ images: [] }),
      },
    } as never);
    const loaded = createEmptyPluginRegistry();
    loaded.imageGenerationProviders.push({
      pluginId: "fal",
      pluginName: "fal",
      source: "test",
      provider: {
        id: "fal",
        defaultModel: "fal-ai/flux/dev",
        models: ["fal-ai/flux/dev"],
        isConfigured: () => true,
        generateImage: async () => ({ images: [] }),
      },
    } as never);
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "fal",
          origin: "bundled",
          contracts: { imageGenerationProviders: ["fal"] },
        },
        {
          id: "xai",
          origin: "bundled",
          contracts: { imageGenerationProviders: ["xai"] },
        },
      ] as never,
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );

    const providers = resolvePluginCapabilityProviders({
      key: "imageGenerationProviders",
      cfg: { plugins: { allow: ["fal", "xai"] } } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["xai", "fal"]);
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith();
    expectActiveRegistryLookup(["fal", "xai"]);
  });

  it("cold-loads enabled external manifest-contract providers missing from startup registry", () => {
    const loaded = createEmptyPluginRegistry();
    loaded.speechProviders.push({
      pluginId: "fish-audio",
      pluginName: "Fish Audio",
      source: "test",
      provider: {
        id: "fish-audio",
        label: "Fish Audio",
        isConfigured: () => true,
        synthesize: async () => ({ kind: "audio", data: Buffer.from([]), mimeType: "audio/mpeg" }),
      },
    } as never);
    mocks.loadPluginRegistrySnapshot.mockReturnValue({
      plugins: [{ pluginId: "fish-audio", origin: "global", enabled: true }],
    });
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "fish-audio",
          origin: "global",
          enabledByDefault: false,
          contracts: { speechProviders: ["fish-audio"] },
        },
      ],
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockImplementation((options?: unknown) => {
      if (
        options &&
        typeof options === "object" &&
        (options as { activate?: unknown }).activate === false
      ) {
        return loaded;
      }
      return undefined;
    });

    const provider = resolvePluginCapabilityProvider({
      key: "speechProviders",
      providerId: "fish-audio",
    });

    expect(provider?.id).toBe("fish-audio");
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      onlyPluginIds: ["fish-audio"],
    });
    const inactiveLookup = requireRuntimeRegistryLookup({
      activate: false,
      onlyPluginIds: ["fish-audio"],
    });
    expect(inactiveLookup.activate).toBe(false);
    expect(inactiveLookup.onlyPluginIds).toEqual(["fish-audio"]);
    expect(mocks.loadBundledCapabilityRuntimeRegistry).not.toHaveBeenCalled();
  });

  it("uses active non-speech capability providers even when cfg has explicit plugin entries", () => {
    const active = createEmptyPluginRegistry();
    active.mediaUnderstandingProviders.push({
      pluginId: "deepgram",
      pluginName: "Deepgram",
      source: "test",
      provider: {
        id: "deepgram",
        capabilities: ["audio"],
      },
    } as never);
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({
      key: "mediaUnderstandingProviders",
      cfg: {
        plugins: { entries: { deepgram: { enabled: true } } },
        tools: {
          media: {
            models: [{ provider: "deepgram" }],
          },
        },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["deepgram"]);
    expect(mocks.loadPluginManifestRegistry).not.toHaveBeenCalled();
    expectInitialRuntimeRegistryLookup();
  });

  it("merges configured media-understanding providers missing from the active registry", () => {
    const active = createEmptyPluginRegistry();
    active.mediaUnderstandingProviders.push({
      pluginId: "openai",
      pluginName: "OpenAI",
      source: "test",
      provider: {
        id: "openai",
        capabilities: ["image"],
      },
    } as never);
    const loaded = createEmptyPluginRegistry();
    loaded.mediaUnderstandingProviders.push(
      {
        pluginId: "deepgram",
        pluginName: "Deepgram",
        source: "test",
        provider: {
          id: "deepgram",
          capabilities: ["audio"],
        },
      } as never,
      {
        pluginId: "google",
        pluginName: "Google",
        source: "test",
        provider: {
          id: "google",
          capabilities: ["image", "audio", "video"],
        },
      } as never,
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "deepgram",
          origin: "bundled",
          contracts: { mediaUnderstandingProviders: ["deepgram"] },
        },
        {
          id: "google",
          origin: "bundled",
          contracts: { mediaUnderstandingProviders: ["google"] },
        },
      ] as never,
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );

    const providers = resolvePluginCapabilityProviders({
      key: "mediaUnderstandingProviders",
      cfg: {
        plugins: { allow: ["openai", "deepgram", "google"] },
        tools: {
          media: {
            audio: { enabled: true, models: [{ provider: "deepgram", model: "nova-3" }] },
          },
        },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["openai", "deepgram"]);
    expectInitialRuntimeRegistryLookup();
    expectActiveRegistryLookup(["deepgram", "google"]);
  });

  it("keeps active speech providers when cfg requests an active provider alias", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push({
      pluginId: "microsoft",
      pluginName: "microsoft",
      source: "test",
      provider: {
        id: "microsoft",
        label: "microsoft",
        aliases: ["edge"],
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: {
        plugins: { entries: { microsoft: { enabled: true } } },
        messages: { tts: { provider: "edge" } },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["microsoft"]);
    expect(mocks.loadPluginManifestRegistry).not.toHaveBeenCalled();
    expectInitialRuntimeRegistryLookup();
  });

  it("keeps active capability providers when cfg has no explicit plugin config", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push({
      pluginId: "acme",
      pluginName: "acme",
      source: "test",
      provider: {
        id: "acme",
        label: "acme",
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "microsoft",
          origin: "bundled",
          contracts: { speechProviders: ["microsoft"] },
        },
      ] as never,
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: { messages: { tts: { provider: "acme" } } } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["acme"]);
    expectInitialRuntimeRegistryLookup();
    expect(
      mocks.resolveRuntimePluginRegistry.mock.calls.some(
        ([options]) =>
          Boolean(options) &&
          typeof options === "object" &&
          Object.hasOwn(options as Record<string, unknown>, "config"),
      ),
    ).toBe(false);
  });

  it("merges active and allowlisted bundled capability providers when cfg is passed", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push({
      pluginId: "openai",
      pluginName: "openai",
      source: "test",
      provider: {
        id: "openai",
        label: "openai",
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    const loaded = createEmptyPluginRegistry();
    loaded.speechProviders.push({
      pluginId: "microsoft",
      pluginName: "microsoft",
      source: "test",
      provider: {
        id: "microsoft",
        label: "microsoft",
        aliases: ["edge"],
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "microsoft",
          origin: "bundled",
          contracts: { speechProviders: ["microsoft"] },
        },
      ] as never,
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: {
        plugins: { allow: ["openai", "microsoft"] },
        messages: { tts: { provider: "edge" } },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["openai", "microsoft"]);
    expectInitialRuntimeRegistryLookup();
    expectActiveRegistryLookup(["microsoft"]);
  });

  it("uses bundled capability capture when runtime snapshot is empty for a requested speech provider", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push({
      pluginId: "openai",
      pluginName: "openai",
      source: "test",
      provider: {
        id: "openai",
        label: "openai",
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    const captured = createEmptyPluginRegistry();
    captured.speechProviders.push({
      pluginId: "google",
      pluginName: "google",
      source: "test",
      provider: {
        id: "google",
        label: "google",
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "google",
          origin: "bundled",
          contracts: { speechProviders: ["google"] },
        },
        {
          id: "microsoft",
          origin: "bundled",
          contracts: { speechProviders: ["microsoft"] },
        },
      ] as never,
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : createEmptyPluginRegistry(),
    );
    mocks.loadBundledCapabilityRuntimeRegistry.mockReturnValue(captured);

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: {
        messages: { tts: { provider: "google" } },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["openai", "google"]);
    expectActiveRegistryLookup(["google"]);
    expect(mocks.loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledWith({
      pluginIds: ["google"],
      env: process.env,
      pluginSdkResolution: undefined,
    });
  });

  it("uses bundled capability capture when runtime snapshot misses a requested speech provider", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push({
      pluginId: "openai",
      pluginName: "openai",
      source: "test",
      provider: {
        id: "openai",
        label: "openai",
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    const loaded = createEmptyPluginRegistry();
    loaded.speechProviders.push({
      pluginId: "azure-speech",
      pluginName: "azure-speech",
      source: "test",
      provider: {
        id: "azure-speech",
        label: "Azure Speech",
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    const captured = createEmptyPluginRegistry();
    captured.speechProviders.push({
      pluginId: "google",
      pluginName: "google",
      source: "test",
      provider: {
        id: "google",
        label: "google",
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "azure-speech",
          origin: "bundled",
          contracts: { speechProviders: ["azure-speech"] },
        },
        {
          id: "google",
          origin: "bundled",
          contracts: { speechProviders: ["google"] },
        },
      ] as never,
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );
    mocks.loadBundledCapabilityRuntimeRegistry.mockReturnValue(captured);

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: {
        messages: { tts: { provider: "google" } },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["openai", "google"]);
    expect(mocks.loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledWith({
      pluginIds: ["google"],
      env: process.env,
      pluginSdkResolution: undefined,
    });
  });

  it("loads requested realtime voice providers missing from active registry", () => {
    const active = createEmptyPluginRegistry();
    active.realtimeVoiceProviders.push({
      pluginId: "openai",
      pluginName: "openai",
      source: "test",
      provider: { id: "openai" },
    } as never);
    const loaded = createEmptyPluginRegistry();
    loaded.realtimeVoiceProviders.push({
      pluginId: "google",
      pluginName: "Google",
      source: "test",
      provider: { id: "google" },
    } as never);
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "google",
          origin: "bundled",
          contracts: { realtimeVoiceProviders: ["google"] },
        },
      ] as never,
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );

    const provider = resolvePluginCapabilityProvider({
      key: "realtimeVoiceProviders",
      providerId: "google",
      cfg: { plugins: { allow: ["openai", "google"] } } as OpenClawConfig,
    });

    expect(provider?.id).toBe("google");
    expectActiveRegistryLookup(["google"]);
  });

  it("does not merge unrelated bundled capability providers when cfg requests one provider", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push({
      pluginId: "openai",
      pluginName: "openai",
      source: "test",
      provider: {
        id: "openai",
        label: "openai",
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    const loaded = createEmptyPluginRegistry();
    loaded.speechProviders.push(
      {
        pluginId: "microsoft",
        pluginName: "microsoft",
        source: "test",
        provider: {
          id: "microsoft",
          label: "microsoft",
          aliases: ["edge"],
          isConfigured: () => true,
          synthesize: async () => ({
            audioBuffer: Buffer.from("x"),
            outputFormat: "mp3",
            voiceCompatible: false,
            fileExtension: ".mp3",
          }),
        },
      } as never,
      {
        pluginId: "elevenlabs",
        pluginName: "elevenlabs",
        source: "test",
        provider: {
          id: "elevenlabs",
          label: "elevenlabs",
          isConfigured: () => true,
          synthesize: async () => ({
            audioBuffer: Buffer.from("x"),
            outputFormat: "mp3",
            voiceCompatible: false,
            fileExtension: ".mp3",
          }),
        },
      } as never,
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "microsoft",
          origin: "bundled",
          contracts: { speechProviders: ["microsoft"] },
        },
        {
          id: "elevenlabs",
          origin: "bundled",
          contracts: { speechProviders: ["elevenlabs"] },
        },
      ] as never,
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: {
        plugins: { allow: ["openai", "microsoft", "elevenlabs"] },
        messages: { tts: { provider: "edge" } },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["openai", "microsoft"]);
  });

  it.each([
    ["memoryEmbeddingProviders", "memoryEmbeddingProviders"],
    ["speechProviders", "speechProviders"],
    ["realtimeTranscriptionProviders", "realtimeTranscriptionProviders"],
    ["realtimeVoiceProviders", "realtimeVoiceProviders"],
    ["mediaUnderstandingProviders", "mediaUnderstandingProviders"],
    ["imageGenerationProviders", "imageGenerationProviders"],
    ["videoGenerationProviders", "videoGenerationProviders"],
    ["musicGenerationProviders", "musicGenerationProviders"],
  ] as const)("applies bundled compat before fallback loading for %s", (key, contractKey) => {
    const { cfg, allowlistCompat, enablementCompat } = createCompatChainConfig();
    expectCompatChainApplied({
      key,
      contractKey,
      cfg,
      allowlistCompat,
      enablementCompat,
    });
  });

  it("reads manifest-derived capability plugin ids for each config snapshot", () => {
    const { cfg, enablementCompat } = createCompatChainConfig();
    setBundledCapabilityFixture("mediaUnderstandingProviders");
    mocks.withBundledPluginEnablementCompat.mockReturnValue(enablementCompat);
    mocks.withBundledPluginVitestCompat.mockReturnValue(enablementCompat);

    expectNoResolvedCapabilityProviders(
      resolvePluginCapabilityProviders({ key: "mediaUnderstandingProviders", cfg }),
    );
    expectNoResolvedCapabilityProviders(
      resolvePluginCapabilityProviders({ key: "mediaUnderstandingProviders", cfg }),
    );

    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(2);
    expect(mocks.withBundledPluginAllowlistCompat).toHaveBeenCalledTimes(2);
    expect(mocks.withBundledPluginAllowlistCompat).toHaveBeenCalledWith({
      config: cfg,
      pluginIds: ["openai"],
    });
  });

  it("reuses capability snapshot loads for the same config object", () => {
    const { cfg, enablementCompat } = createCompatChainConfig();
    const loaded = createEmptyPluginRegistry();
    loaded.mediaUnderstandingProviders.push({
      pluginId: "openai",
      pluginName: "openai",
      source: "test",
      provider: {
        id: "openai",
        capabilities: ["image"],
      },
    } as never);
    setBundledCapabilityFixture("mediaUnderstandingProviders");
    mocks.withBundledPluginEnablementCompat.mockReturnValue(enablementCompat);
    mocks.withBundledPluginVitestCompat.mockReturnValue(enablementCompat);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    expectResolvedCapabilityProviderIds(
      resolvePluginCapabilityProviders({ key: "mediaUnderstandingProviders", cfg }),
      ["openai"],
    );
    expectResolvedCapabilityProviderIds(
      resolvePluginCapabilityProviders({ key: "mediaUnderstandingProviders", cfg }),
      ["openai"],
    );

    const snapshotLoads = mocks.resolveRuntimePluginRegistry.mock.calls.filter(
      ([options]) => options !== undefined,
    );
    expect(snapshotLoads).toHaveLength(1);
  });

  it("resolves manifest-derived capability plugin ids for equivalent config snapshots independently", () => {
    const first = createCompatChainConfig();
    const second = createCompatChainConfig();
    setBundledCapabilityFixture("mediaUnderstandingProviders");
    mocks.withBundledPluginEnablementCompat.mockReturnValue(first.enablementCompat);
    mocks.withBundledPluginVitestCompat.mockReturnValue(first.enablementCompat);

    expectNoResolvedCapabilityProviders(
      resolvePluginCapabilityProviders({
        key: "mediaUnderstandingProviders",
        cfg: first.cfg,
      }),
    );
    expectNoResolvedCapabilityProviders(
      resolvePluginCapabilityProviders({
        key: "mediaUnderstandingProviders",
        cfg: second.cfg,
      }),
    );

    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(2);
    expect(mocks.withBundledPluginAllowlistCompat).toHaveBeenCalledTimes(2);
    expect(mocks.withBundledPluginAllowlistCompat).toHaveBeenNthCalledWith(1, {
      config: first.cfg,
      pluginIds: ["openai"],
    });
    expect(mocks.withBundledPluginAllowlistCompat).toHaveBeenNthCalledWith(2, {
      config: second.cfg,
      pluginIds: ["openai"],
    });
  });

  it("reuses a compatible active registry even when the capability list is empty", () => {
    const active = createEmptyPluginRegistry();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({
      key: "mediaUnderstandingProviders",
      cfg: {} as OpenClawConfig,
    });

    expectNoResolvedCapabilityProviders(providers);
    expectActiveRegistryLookup([]);
  });

  it("loads bundled capability providers even without an explicit cfg", () => {
    const compatConfig = {
      plugins: {
        enabled: true,
        allow: ["google"],
        entries: { google: { enabled: true } },
      },
    } as OpenClawConfig;
    const loaded = createEmptyPluginRegistry();
    loaded.mediaUnderstandingProviders.push({
      pluginId: "google",
      pluginName: "google",
      source: "test",
      provider: {
        id: "google",
        capabilities: ["image", "audio", "video"],
        describeImage: vi.fn(),
        transcribeAudio: vi.fn(),
        describeVideo: vi.fn(),
        autoPriority: { image: 30, audio: 40, video: 10 },
        nativeDocumentInputs: ["pdf"],
      },
    } as never);
    setBundledCapabilityFixture("mediaUnderstandingProviders", "google", "google");
    mocks.withBundledPluginEnablementCompat.mockReturnValue(compatConfig);
    mocks.withBundledPluginVitestCompat.mockReturnValue(compatConfig);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    const providers = resolvePluginCapabilityProviders({ key: "mediaUnderstandingProviders" });

    expectResolvedCapabilityProviderIds(providers, ["google"]);
    expectManifestRegistryLoad(0, {});
    expectActiveRegistryLookup(["google"]);
  });

  it("loads fallback snapshots without startup dependency repair", () => {
    const cfg = { plugins: { allow: ["custom-plugin"] } } as OpenClawConfig;
    const enablementCompat = {
      plugins: {
        allow: ["custom-plugin", "openai"],
        entries: { openai: { enabled: true } },
      },
    };
    setBundledCapabilityFixture("mediaUnderstandingProviders");
    mocks.withBundledPluginEnablementCompat.mockReturnValue(enablementCompat);
    mocks.withBundledPluginVitestCompat.mockReturnValue(enablementCompat);

    expectNoResolvedCapabilityProviders(
      resolvePluginCapabilityProviders({
        key: "mediaUnderstandingProviders",
        cfg,
      }),
    );

    expectActiveRegistryLookup(["openai"]);
  });

  it("does not resolve non-speech capability providers when plugins are globally disabled", () => {
    const cfg = { plugins: { enabled: false, allow: ["custom-plugin"] } } as OpenClawConfig;
    const active = createEmptyPluginRegistry();
    active.mediaUnderstandingProviders.push({
      pluginId: "openai",
      pluginName: "openai",
      source: "test",
      provider: {
        id: "openai",
        capabilities: ["image"],
      },
    } as never);
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({
      key: "mediaUnderstandingProviders",
      cfg,
    });

    expectNoResolvedCapabilityProviders(providers);
    expect(mocks.loadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(mocks.withBundledPluginAllowlistCompat).not.toHaveBeenCalled();
    expect(mocks.withBundledPluginEnablementCompat).not.toHaveBeenCalled();
    expect(mocks.withBundledPluginVitestCompat).not.toHaveBeenCalled();
    expect(mocks.resolveRuntimePluginRegistry).not.toHaveBeenCalled();
  });

  it("loads bundled speech providers through compat when plugins are globally disabled", () => {
    const cfg = {
      plugins: { enabled: false },
      messages: { tts: { provider: "mistral" } },
    } as OpenClawConfig;
    const allowlistCompat = {
      ...cfg,
      plugins: {
        enabled: false,
        allow: ["microsoft"],
      },
    } as OpenClawConfig;
    const compatConfig = {
      ...cfg,
      plugins: {
        enabled: true,
        allow: ["microsoft"],
        entries: { microsoft: { enabled: true } },
      },
    } as OpenClawConfig;
    const loaded = createEmptyPluginRegistry();
    loaded.speechProviders.push({
      pluginId: "microsoft",
      pluginName: "microsoft",
      source: "test",
      provider: {
        id: "microsoft",
        label: "microsoft",
        aliases: ["edge"],
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "microsoft",
          origin: "bundled",
          contracts: { speechProviders: ["microsoft"] },
        },
      ] as never,
      diagnostics: [],
    });
    mocks.withBundledPluginEnablementCompat.mockReturnValue(compatConfig);
    mocks.withBundledPluginVitestCompat.mockReturnValue(compatConfig);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg,
    });

    expectResolvedCapabilityProviderIds(providers, ["microsoft"]);
    expectManifestRegistryLoad(0, cfg);
    expect(mocks.withBundledPluginAllowlistCompat).toHaveBeenCalledWith({
      config: cfg,
      pluginIds: ["microsoft"],
    });
    expect(mocks.withBundledPluginEnablementCompat).toHaveBeenCalledWith({
      config: allowlistCompat,
      pluginIds: ["microsoft"],
    });
    expectInitialRuntimeRegistryLookup();
    expectActiveRegistryLookup(["microsoft"]);
  });

  it.each([
    "imageGenerationProviders",
    "videoGenerationProviders",
    "musicGenerationProviders",
  ] as const)("uses an explicit empty plugin scope for %s when no bundled owner exists", (key) => {
    const providers = resolvePluginCapabilityProviders({
      key,
      cfg: {} as OpenClawConfig,
    });

    expectNoResolvedCapabilityProviders(providers as Array<{ id: string }>);
    expectManifestRegistryLoad(0, {});
    expectInitialRuntimeRegistryLookup();
    expectActiveRegistryLookup([]);
  });

  it("scopes media capability snapshot loads to manifest-derived bundled owners", () => {
    const cfg = { plugins: { allow: ["openai", "minimax"] } } as OpenClawConfig;
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          origin: "bundled",
          contracts: {
            imageGenerationProviders: ["openai"],
            videoGenerationProviders: ["openai"],
          },
        },
        {
          id: "minimax",
          origin: "bundled",
          contracts: {
            imageGenerationProviders: ["minimax"],
            videoGenerationProviders: ["minimax"],
            musicGenerationProviders: ["minimax"],
          },
        },
      ] as never,
      diagnostics: [],
    });

    resolvePluginCapabilityProviders({ key: "imageGenerationProviders", cfg });
    resolvePluginCapabilityProviders({ key: "videoGenerationProviders", cfg });
    resolvePluginCapabilityProviders({ key: "musicGenerationProviders", cfg });

    const snapshotLoadOptions = collectActiveRegistryLookups();
    expect(snapshotLoadOptions.map((options) => options.onlyPluginIds)).toEqual([
      ["minimax", "openai"],
      ["minimax", "openai"],
      ["minimax"],
    ]);
  });

  it("does not unscoped-load media generation capabilities without bundled owners", () => {
    const cfg = { plugins: { allow: ["openai"] } } as OpenClawConfig;
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          origin: "bundled",
          contracts: {
            imageGenerationProviders: ["openai"],
          },
        },
      ] as never,
      diagnostics: [],
    });

    expectNoResolvedCapabilityProviders(
      resolvePluginCapabilityProviders({ key: "imageGenerationProviders", cfg }),
    );
    expectNoResolvedCapabilityProviders(
      resolvePluginCapabilityProviders({ key: "musicGenerationProviders", cfg }),
    );

    const snapshotLoadOptions = collectActiveRegistryLookups();
    expect(snapshotLoadOptions.map((options) => options.onlyPluginIds)).toEqual([["openai"], []]);
  });

  it("loads only the bundled owner plugin for a targeted provider lookup", () => {
    const cfg = { plugins: { allow: ["custom-plugin"] } } as OpenClawConfig;
    const allowlistCompat = {
      plugins: {
        allow: ["custom-plugin", "google"],
      },
    } as OpenClawConfig;
    const enablementCompat = {
      plugins: {
        allow: ["custom-plugin", "google"],
        entries: { google: { enabled: true } },
      },
    };
    const loaded = createEmptyPluginRegistry();
    loaded.memoryEmbeddingProviders.push({
      pluginId: "google",
      pluginName: "google",
      source: "test",
      provider: {
        id: "gemini",
        create: async () => ({ provider: null }),
      },
    } as never);
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "google",
          origin: "bundled",
          contracts: { memoryEmbeddingProviders: ["gemini"] },
        },
        {
          id: "openai",
          origin: "bundled",
          contracts: { memoryEmbeddingProviders: ["openai"] },
        },
      ] as never,
      diagnostics: [],
    });
    mocks.withBundledPluginEnablementCompat.mockReturnValue(enablementCompat);
    mocks.withBundledPluginVitestCompat.mockReturnValue(enablementCompat);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    const provider = resolvePluginCapabilityProvider({
      key: "memoryEmbeddingProviders",
      providerId: "gemini",
      cfg,
    });

    expect(provider?.id).toBe("gemini");
    expect(mocks.withBundledPluginAllowlistCompat).toHaveBeenCalledWith({
      config: cfg,
      pluginIds: ["google"],
    });
    expect(mocks.withBundledPluginEnablementCompat).toHaveBeenCalledWith({
      config: allowlistCompat,
      pluginIds: ["google"],
    });
    expectActiveRegistryLookup(["google"]);
  });

  it("does not load targeted non-speech capability providers when plugins are globally disabled", () => {
    const cfg = { plugins: { enabled: false, allow: ["custom-plugin"] } } as OpenClawConfig;
    const loaded = createEmptyPluginRegistry();
    loaded.memoryEmbeddingProviders.push({
      pluginId: "google",
      pluginName: "google",
      source: "test",
      provider: {
        id: "gemini",
        create: async () => ({ provider: null }),
      },
    } as never);
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "google",
          origin: "bundled",
          contracts: { memoryEmbeddingProviders: ["gemini"] },
        },
        {
          id: "openai",
          origin: "bundled",
          contracts: { memoryEmbeddingProviders: ["openai"] },
        },
      ] as never,
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    const provider = resolvePluginCapabilityProvider({
      key: "memoryEmbeddingProviders",
      providerId: "gemini",
      cfg,
    });

    expect(provider).toBeUndefined();
    expect(mocks.loadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(mocks.withBundledPluginAllowlistCompat).not.toHaveBeenCalled();
    expect(mocks.withBundledPluginEnablementCompat).not.toHaveBeenCalled();
    expect(mocks.withBundledPluginVitestCompat).not.toHaveBeenCalled();
    expect(mocks.resolveRuntimePluginRegistry).not.toHaveBeenCalled();
  });

  it("loads targeted bundled speech providers through compat when plugins are globally disabled", () => {
    const cfg = { plugins: { enabled: false, allow: ["custom-plugin"] } } as OpenClawConfig;
    const allowlistCompat = {
      plugins: {
        enabled: false,
        allow: ["custom-plugin", "microsoft"],
      },
    } as OpenClawConfig;
    const enablementCompat = {
      plugins: {
        enabled: true,
        allow: ["custom-plugin", "microsoft"],
        entries: { microsoft: { enabled: true } },
      },
    };
    const loaded = createEmptyPluginRegistry();
    loaded.speechProviders.push({
      pluginId: "microsoft",
      pluginName: "microsoft",
      source: "test",
      provider: {
        id: "microsoft",
        label: "microsoft",
        aliases: ["edge"],
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "microsoft",
          origin: "bundled",
          contracts: { speechProviders: ["microsoft"] },
        },
        {
          id: "openai",
          origin: "bundled",
          contracts: { speechProviders: ["openai"] },
        },
      ] as never,
      diagnostics: [],
    });
    mocks.withBundledPluginEnablementCompat.mockReturnValue(enablementCompat);
    mocks.withBundledPluginVitestCompat.mockReturnValue(enablementCompat);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    const provider = resolvePluginCapabilityProvider({
      key: "speechProviders",
      providerId: "microsoft",
      cfg,
    });

    expect(provider?.id).toBe("microsoft");
    expect(mocks.withBundledPluginAllowlistCompat).toHaveBeenCalledWith({
      config: cfg,
      pluginIds: ["microsoft"],
    });
    expect(mocks.withBundledPluginEnablementCompat).toHaveBeenCalledWith({
      config: allowlistCompat,
      pluginIds: ["microsoft"],
    });
    expectInitialRuntimeRegistryLookup();
    expectActiveRegistryLookup(["microsoft"]);
  });
});
