/** Exercises runtime capability-provider loading from manifest-backed plugin contracts. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import { removeBundledDiscoveryStateRoot } from "./bundled-discovery.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { PluginManifestRegistry } from "./manifest-registry.types.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-helpers.js";

// Real machine state instead of a module mock: the plugins project runs every
// file in one shared worker (isolate=false), so a mocked bundled-discovery
// module here and the real module in sibling suites would shadow each other
// depending on file order.
let discoveryCompatRoot: string | undefined;
let discoveryEnvSnapshot: ReturnType<typeof captureEnv> | undefined;
function setBundledDiscoveryCompat(): void {
  if (!discoveryCompatRoot) {
    discoveryCompatRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-capability-compat-")),
    );
    const seedSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", discoveryCompatRoot);
    try {
      writeConfigMachineState("plugins.bundledDiscovery", "compat");
    } finally {
      seedSnapshot.restore();
    }
  }
  discoveryEnvSnapshot ??= captureEnv(["OPENCLAW_STATE_DIR"]);
  setTestEnvValue("OPENCLAW_STATE_DIR", discoveryCompatRoot);
  clearBundledDiscoveryModeMemo();
}
function restoreBundledDiscoveryState(): void {
  discoveryEnvSnapshot?.restore();
  discoveryEnvSnapshot = undefined;
  clearBundledDiscoveryModeMemo();
}

function createEmptyMockManifestRegistry(): PluginManifestRegistry {
  return { plugins: [], diagnostics: [] };
}

const mocks = vi.hoisted(() => ({
  createMockRegistry: () => ({
    plugins: [],
    diagnostics: [],
    embeddingProviders: [],
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
  loadPluginManifestRegistryCore: vi.fn<
    (params?: Record<string, unknown>) => PluginManifestRegistry
  >(() => createEmptyMockManifestRegistry()),
  resolveInstalledManifestRegistryIndexFingerprint: vi.fn(() => "test-installed-index"),
  loadBundledCapabilityRuntimeRegistry: vi.fn(),
  loadPluginRegistrySnapshot: vi.fn<
    (_params?: unknown) => { plugins: Array<Record<string, unknown>> }
  >(() => ({
    plugins: [],
  })),
  withBundledPluginEnablementCompat: vi.fn(({ config }) => config),
}));

vi.mock("./loader.js", () => ({
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
  resolvePluginRegistryLoadCacheKey: mocks.resolvePluginRegistryLoadCacheKey,
}));

vi.mock("./active-runtime-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./active-runtime-registry.js")>()),
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
  loadPluginManifestRegistryForInstalledIndex: mocks.loadPluginManifestRegistryCore,
  resolveInstalledManifestRegistryIndexFingerprint:
    mocks.resolveInstalledManifestRegistryIndexFingerprint,
}));

vi.mock("./manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryCore: mocks.loadPluginManifestRegistryCore,
  };
});

vi.mock("./plugin-registry-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-registry-snapshot.js")>();
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
      ...args: Parameters<typeof mocks.loadPluginManifestRegistryCore>
    ) => {
      const [{ includeDisabled: _includeDisabled, ...params } = {}] = args as [
        Record<string, unknown>?,
      ];
      return mocks.loadPluginManifestRegistryCore(params);
    },
  };
});

vi.mock("./bundled-compat.js", () => ({
  withBundledPluginEnablementCompat: mocks.withBundledPluginEnablementCompat,
}));
let resolvePluginCapabilityProviders: typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProviders;
let resolvePluginCapabilityProvider: typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProvider;
let prepareMediaCapabilityProviders: typeof import("./capability-provider-runtime.js").prepareMediaCapabilityProviders;
let setCurrentPluginMetadataSnapshot: typeof import("./current-plugin-metadata.test-support.js").setCurrentPluginMetadataSnapshot;
let clearPluginMetadataLifecycleCaches: typeof import("./plugin-metadata-lifecycle.js").clearPluginMetadataLifecycleCaches;

function expectResolvedCapabilityProviderIds(providers: Array<{ id: string }>, expected: string[]) {
  expect(providers.map((provider) => provider.id)).toEqual(expected);
}

function expectNoResolvedCapabilityProviders(providers: Array<{ id: string }>) {
  expectResolvedCapabilityProviderIds(providers, []);
}

type CapabilityFixtureRegistry = ReturnType<typeof createEmptyPluginRegistry>;
type CapabilityFixtureKey =
  | "embeddingProviders"
  | "speechProviders"
  | "realtimeTranscriptionProviders"
  | "realtimeVoiceProviders"
  | "mediaUnderstandingProviders"
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders";

function addCapabilityProvider(
  registry: CapabilityFixtureRegistry,
  key: CapabilityFixtureKey,
  params: {
    id: string;
    pluginId?: string;
    pluginName?: string;
    provider?: Record<string, unknown>;
  },
) {
  const pluginId = params.pluginId ?? params.id;
  (registry[key] as unknown[]).push({
    pluginId,
    pluginName: params.pluginName ?? pluginId,
    source: "test",
    provider: { id: params.id, ...params.provider },
  });
}

function addSpeechProvider(
  registry: CapabilityFixtureRegistry,
  id: string,
  params: {
    pluginId?: string;
    pluginName?: string;
    label?: string;
    aliases?: string[];
    provider?: Record<string, unknown>;
  } = {},
) {
  addCapabilityProvider(registry, "speechProviders", {
    id,
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    provider: {
      label: params.label ?? params.pluginName ?? id,
      ...(params.aliases ? { aliases: params.aliases } : {}),
      isConfigured: () => true,
      synthesize: async () => ({
        audioBuffer: Buffer.from("x"),
        outputFormat: "mp3",
        voiceCompatible: false,
        fileExtension: ".mp3",
      }),
      ...params.provider,
    },
  });
}

function setCapabilityManifestPlugins(
  plugins: Array<{
    id: string;
    origin?: "bundled" | "global";
    enabledByDefault?: boolean;
    contracts: Record<string, string[]>;
  }>,
) {
  mocks.loadPluginManifestRegistryCore.mockReturnValue({
    plugins: plugins.map(createPluginManifestRecordFixture),
    diagnostics: [],
  });
}

function expectActiveRegistryLookup(pluginIds: string[]) {
  expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({ onlyPluginIds: pluginIds });
}

function expectInitialRuntimeRegistryLookup() {
  expect(mocks.resolveRuntimePluginRegistry).toHaveBeenNthCalledWith(1);
}

function requireManifestRegistryLoadParams(index = 0): Record<string, unknown> {
  const call = mocks.loadPluginManifestRegistryCore.mock.calls[index] as
    | [Record<string, unknown>]
    | undefined;
  if (!call) {
    throw new Error(`loadPluginManifestRegistryCore call ${index} missing`);
  }
  return call[0];
}

function expectManifestRegistryLoad(
  index: number,
  config: OpenClawConfig | Record<string, never> | undefined,
) {
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
  enablementCompat: {
    plugins: {
      allow?: string[];
      entries: { openai: { enabled: boolean } };
    };
  };
}) {
  expectManifestRegistryLoad(0, params.cfg);
  expect(mocks.withBundledPluginEnablementCompat).toHaveBeenCalledWith({
    config: params.cfg,
    pluginIds: ["openai"],
  });
  expectActiveRegistryLookup(["openai"]);
}

function createCompatChainConfig() {
  setBundledDiscoveryCompat();
  const cfg = { plugins: { allow: ["custom-plugin"] } } as OpenClawConfig;
  const enablementCompat = {
    plugins: {
      allow: ["custom-plugin"],
      entries: { openai: { enabled: true } },
    },
  };
  return { cfg, enablementCompat };
}

function setBundledCapabilityFixture(
  contractKey: string,
  pluginId = "openai",
  providerId = pluginId,
) {
  mocks.loadPluginManifestRegistryCore.mockReturnValue({
    plugins: [
      createPluginManifestRecordFixture({
        id: pluginId,
        origin: "bundled",
        contracts: { [contractKey]: [providerId] },
      }),
      createPluginManifestRecordFixture({
        id: "custom-plugin",
        origin: "workspace",
        contracts: {},
      }),
    ],
    diagnostics: [],
  });
}

function expectCompatChainApplied(params: {
  key:
    | "embeddingProviders"
    | "speechProviders"
    | "realtimeTranscriptionProviders"
    | "realtimeVoiceProviders"
    | "mediaUnderstandingProviders"
    | "imageGenerationProviders"
    | "videoGenerationProviders"
    | "musicGenerationProviders";
  contractKey: string;
  cfg: OpenClawConfig;
  enablementCompat: {
    plugins: {
      allow?: string[];
      entries: { openai: { enabled: boolean } };
    };
  };
}) {
  setBundledCapabilityFixture(params.contractKey);
  mocks.withBundledPluginEnablementCompat.mockReturnValue(params.enablementCompat);
  expectNoResolvedCapabilityProviders(
    resolvePluginCapabilityProviders({ key: params.key, cfg: params.cfg }),
  );
  expectBundledCompatLoadPath(params);
}

describe("resolvePluginCapabilityProviders", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({
      prepareMediaCapabilityProviders,
      resolvePluginCapabilityProvider,
      resolvePluginCapabilityProviders,
    } = await import("./capability-provider-runtime.js"));
    ({ setCurrentPluginMetadataSnapshot } =
      await import("./current-plugin-metadata.test-support.js"));
    ({ clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js"));
  });

  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    mocks.resolveRuntimePluginRegistry.mockReset();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.resolvePluginRegistryLoadCacheKey.mockReset();
    mocks.resolvePluginRegistryLoadCacheKey.mockImplementation((options: unknown) =>
      JSON.stringify(options),
    );
    mocks.loadPluginRegistrySnapshot.mockReset();
    mocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    mocks.loadPluginManifestRegistryCore.mockReset();
    mocks.loadPluginManifestRegistryCore.mockReturnValue(createEmptyMockManifestRegistry());
    mocks.loadBundledCapabilityRuntimeRegistry.mockReset();
    mocks.loadBundledCapabilityRuntimeRegistry.mockImplementation(() => mocks.createMockRegistry());
    mocks.withBundledPluginEnablementCompat.mockReset();
    mocks.withBundledPluginEnablementCompat.mockImplementation(({ config }) => config);
    restoreBundledDiscoveryState();
  });

  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    // isolate:false shared worker: the compat state root must not outlive
    // this file's last test into sibling suites.
    restoreBundledDiscoveryState();
  });

  afterAll(async () => {
    restoreBundledDiscoveryState();
    if (discoveryCompatRoot) {
      const stateRoot = discoveryCompatRoot;
      discoveryCompatRoot = undefined;
      await removeBundledDiscoveryStateRoot(stateRoot);
    }
  });

  it("resolves bundled capability plugins from the current metadata snapshot", () => {
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
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );
    setCurrentPluginMetadataSnapshot({
      policyHash: resolveInstalledPluginIndexPolicyHash({}),
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
        modelIdNormalizationPolicies: new Map(),
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

    expectResolvedCapabilityProviderIds(
      resolvePluginCapabilityProviders({ key: "imageGenerationProviders" }),
      ["fal"],
    );
    expectActiveRegistryLookup(["fal"]);
    expect(mocks.loadPluginManifestRegistryCore).not.toHaveBeenCalled();
  });

  it("prepares media capability families from one supplied metadata snapshot", () => {
    const loaded = createEmptyPluginRegistry();
    for (const key of [
      "mediaUnderstandingProviders",
      "imageGenerationProviders",
      "videoGenerationProviders",
      "musicGenerationProviders",
    ] as const) {
      loaded[key].push({
        pluginId: "media",
        pluginName: "media",
        source: "test",
        provider: { id: key },
      } as never);
    }
    mocks.resolveRuntimePluginRegistry.mockReturnValue(loaded);
    const pluginMetadataSnapshot = {
      index: { plugins: [] },
      plugins: [
        {
          id: "media",
          origin: "bundled",
          contracts: {
            mediaUnderstandingProviders: ["mediaUnderstandingProviders"],
            imageGenerationProviders: ["imageGenerationProviders"],
            videoGenerationProviders: ["videoGenerationProviders"],
            musicGenerationProviders: ["musicGenerationProviders"],
          },
        },
      ],
    } as never;
    const prepared = prepareMediaCapabilityProviders({ pluginMetadataSnapshot, registry: loaded });

    expect(prepared.mediaUnderstandingProviders?.map((provider) => provider.id)).toEqual([
      "mediaUnderstandingProviders",
    ]);
    expect(prepared.imageGenerationProviders?.map((provider) => provider.id)).toEqual([
      "imageGenerationProviders",
    ]);
    expect(prepared.videoGenerationProviders?.map((provider) => provider.id)).toEqual([
      "videoGenerationProviders",
    ]);
    expect(prepared.musicGenerationProviders?.map((provider) => provider.id)).toEqual([
      "musicGenerationProviders",
    ]);
    expect(mocks.loadPluginManifestRegistryCore).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "explicitly disabled",
      plugins: { entries: { blocked: { enabled: false } } },
    },
    { name: "denylisted", plugins: { deny: ["blocked"] } },
    { name: "outside the restrictive allowlist", plugins: { allow: ["allowed"] } },
  ])("never prepares or executes a $name bundled capability provider", ({ plugins }) => {
    const generateImage = vi.fn();
    const registry = createEmptyPluginRegistry();
    addCapabilityProvider(registry, "imageGenerationProviders", {
      id: "blocked",
      provider: { generateImage },
    });
    const prepared = prepareMediaCapabilityProviders({
      cfg: { plugins } as OpenClawConfig,
      registry,
      pluginMetadataSnapshot: {
        index: { plugins: [{ pluginId: "blocked", origin: "bundled", enabled: false }] },
        plugins: [
          {
            id: "blocked",
            origin: "bundled",
            contracts: { imageGenerationProviders: ["blocked"] },
          },
        ],
      } as never,
    });

    for (const provider of prepared.imageGenerationProviders ?? []) {
      (provider as unknown as { generateImage: () => void }).generateImage();
    }

    expect(generateImage).not.toHaveBeenCalled();
    expect(prepared.imageGenerationProviders).toEqual([]);
  });

  it.each([
    {
      name: "explicitly disabled",
      plugins: { entries: { blocked: { enabled: false } } },
    },
    { name: "denylisted", plugins: { deny: ["blocked"] } },
    { name: "outside the restrictive allowlist", plugins: { allow: ["allowed"] } },
  ])("never selects an already-active $name bundled provider", ({ plugins }) => {
    const active = createEmptyPluginRegistry();
    addCapabilityProvider(active, "imageGenerationProviders", { id: "blocked" });
    addSpeechProvider(active, "blocked");
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : createEmptyPluginRegistry(),
    );
    setCapabilityManifestPlugins([
      {
        id: "blocked",
        contracts: {
          imageGenerationProviders: ["blocked"],
          speechProviders: ["blocked"],
        },
      },
    ]);
    const cfg = { plugins } as OpenClawConfig;

    expect(
      resolvePluginCapabilityProvider({
        key: "imageGenerationProviders",
        providerId: "blocked",
        cfg,
      }),
    ).toBeUndefined();
    expect(resolvePluginCapabilityProviders({ key: "imageGenerationProviders", cfg })).toEqual([]);
    expect(
      resolvePluginCapabilityProvider({ key: "speechProviders", providerId: "blocked", cfg }),
    ).toBeUndefined();
    expect(resolvePluginCapabilityProviders({ key: "speechProviders", cfg })).toEqual([]);
    expect(mocks.loadBundledCapabilityRuntimeRegistry).not.toHaveBeenCalled();
  });

  it("preserves restrictive-allowlist compatibility only for known bundled active owners", () => {
    setBundledDiscoveryCompat();
    const active = createEmptyPluginRegistry();
    active.plugins.push({ id: "bundled-owner", origin: "bundled" } as never);
    addSpeechProvider(active, "bundled-provider", { pluginId: "bundled-owner" });
    addSpeechProvider(active, "unknown-provider", { pluginId: "unknown-owner" });
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : createEmptyPluginRegistry(),
    );
    const cfg = { plugins: { allow: ["allowed-plugin"] } } as OpenClawConfig;

    expect(
      resolvePluginCapabilityProvider({
        key: "speechProviders",
        providerId: "bundled-provider",
        cfg,
      })?.id,
    ).toBe("bundled-provider");
    expect(
      resolvePluginCapabilityProvider({
        key: "speechProviders",
        providerId: "unknown-provider",
        cfg,
      }),
    ).toBeUndefined();
    expect(resolvePluginCapabilityProviders({ key: "speechProviders", cfg })).toEqual([
      expect.objectContaining({ id: "bundled-provider" }),
    ]);
  });

  it.each([{ entries: { blocked: { enabled: false } } }, { deny: ["blocked"] }])(
    "never lets global-disable speech compatibility override owner prohibition",
    (plugins) => {
      const active = createEmptyPluginRegistry();
      addSpeechProvider(active, "blocked");
      mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
        params === undefined ? active : createEmptyPluginRegistry(),
      );
      setCapabilityManifestPlugins([
        { id: "blocked", contracts: { speechProviders: ["blocked"] } },
      ]);
      const cfg = { plugins: { enabled: false, ...plugins } } as OpenClawConfig;

      expect(
        resolvePluginCapabilityProvider({ key: "speechProviders", providerId: "blocked", cfg }),
      ).toBeUndefined();
      expect(resolvePluginCapabilityProviders({ key: "speechProviders", cfg })).toEqual([]);
      expect(mocks.loadBundledCapabilityRuntimeRegistry).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "explicitly disabled",
      plugins: { entries: { blocked: { enabled: false } } },
    },
    { name: "denylisted", plugins: { deny: ["blocked"] } },
    { name: "outside the restrictive allowlist", plugins: { allow: ["allowed"] } },
  ])(
    "never re-imports a $name bundled provider through cold compatibility capture",
    ({ plugins }) => {
      const captured = createEmptyPluginRegistry();
      addCapabilityProvider(captured, "imageGenerationProviders", { id: "blocked" });
      mocks.resolveRuntimePluginRegistry.mockReturnValue(createEmptyPluginRegistry());
      mocks.loadBundledCapabilityRuntimeRegistry.mockReturnValue(captured);
      setCapabilityManifestPlugins([
        { id: "blocked", contracts: { imageGenerationProviders: ["blocked"] } },
      ]);

      expect(
        resolvePluginCapabilityProviders({
          key: "imageGenerationProviders",
          cfg: { plugins } as OpenClawConfig,
        }),
      ).toEqual([]);
      expect(mocks.loadBundledCapabilityRuntimeRegistry).not.toHaveBeenCalled();
    },
  );

  it("leaves a media family unresolved for loaded providers without contracts", () => {
    const loaded = createEmptyPluginRegistry();
    loaded.imageGenerationProviders.push({
      pluginId: "legacy-image",
      pluginName: "legacy-image",
      source: "test",
      provider: { id: "legacy-image" },
    } as never);

    const prepared = prepareMediaCapabilityProviders({
      registry: loaded,
      pluginMetadataSnapshot: { index: { plugins: [] }, plugins: [] } as never,
    });

    expect(prepared.imageGenerationProviders).toBeUndefined();
  });

  it("leaves a media family unresolved when an eligible owner is not loaded", () => {
    const loaded = createEmptyPluginRegistry();
    loaded.imageGenerationProviders.push({
      pluginId: "loaded-image",
      pluginName: "loaded-image",
      source: "test",
      provider: { id: "loaded-image" },
    } as never);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params && (params as { onlyPluginIds?: string[] }).onlyPluginIds?.includes("lazy-image")
        ? undefined
        : loaded,
    );

    const prepared = prepareMediaCapabilityProviders({
      cfg: { plugins: { allow: ["loaded-image", "lazy-image"] } },
      registry: loaded,
      pluginMetadataSnapshot: {
        index: { plugins: [] },
        plugins: [
          {
            id: "loaded-image",
            origin: "bundled",
            contracts: { imageGenerationProviders: ["loaded-image"] },
          },
          {
            id: "lazy-image",
            origin: "bundled",
            contracts: { imageGenerationProviders: ["lazy-image"] },
          },
        ],
      } as never,
    });

    expect(prepared.imageGenerationProviders).toBeUndefined();
  });

  it("prepares disabled media families as authoritative empty arrays", () => {
    const loaded = createEmptyPluginRegistry();
    loaded.imageGenerationProviders.push({
      pluginId: "loaded-image",
      pluginName: "loaded-image",
      source: "test",
      provider: { id: "loaded-image" },
    } as never);
    mocks.resolveRuntimePluginRegistry.mockReturnValue(loaded);

    const prepared = prepareMediaCapabilityProviders({
      cfg: { plugins: { enabled: false } },
      registry: loaded,
      pluginMetadataSnapshot: { index: { plugins: [] }, plugins: [] } as never,
    });

    expect(prepared.imageGenerationProviders).toEqual([]);
  });

  it("resolves enabled external capability plugins from the current metadata snapshot", () => {
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
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );
    setCurrentPluginMetadataSnapshot({
      policyHash: resolveInstalledPluginIndexPolicyHash({}),
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
        modelIdNormalizationPolicies: new Map(),
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

    expectResolvedCapabilityProviderIds(
      resolvePluginCapabilityProviders({ key: "imageGenerationProviders" }),
      ["external-image"],
    );
    expectActiveRegistryLookup(["external-image"]);
    expect(mocks.loadPluginManifestRegistryCore).not.toHaveBeenCalled();
  });

  it("uses the active registry when capability providers are already loaded", () => {
    const active = createEmptyPluginRegistry();
    addSpeechProvider(active, "openai");
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({ key: "speechProviders" });

    expectResolvedCapabilityProviderIds(providers, ["openai"]);
    expect(mocks.loadPluginManifestRegistryCore).not.toHaveBeenCalled();
    expectInitialRuntimeRegistryLookup();
  });

  it.each(["active", "manifest"] as const)(
    "applies current normalized policy to every %s provider lookup",
    (source) => {
      const registry = createEmptyPluginRegistry();
      addSpeechProvider(registry, "first");
      addSpeechProvider(registry, "second");
      setCapabilityManifestPlugins([
        { id: "first", contracts: { speechProviders: ["first"] } },
        { id: "second", contracts: { speechProviders: ["second"] } },
      ]);
      mocks.resolveRuntimePluginRegistry.mockImplementation((options?: unknown) =>
        source === "active" || options !== undefined ? registry : undefined,
      );
      const plugins = {
        allow: [" FIRST ", "second"],
        deny: [] as string[],
        entries: { " FIRST ": { enabled: true }, second: { enabled: false } },
      };
      const cfg: OpenClawConfig = { plugins };
      const resolve = () => resolvePluginCapabilityProviders({ key: "speechProviders", cfg });

      expect(resolve()).toEqual([registry.speechProviders[0]?.provider]);
      plugins.entries[" FIRST "].enabled = false;
      plugins.entries.second.enabled = true;
      expect(resolve()).toEqual([registry.speechProviders[1]?.provider]);
      plugins.deny.push(" SECOND ");
      expect(resolve()).toEqual([]);
    },
  );

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
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        createPluginManifestRecordFixture({
          id: "external-image",
          origin: "global",
          contracts: { imageGenerationProviders: ["external-image"] },
        }),
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
    addCapabilityProvider(loaded, "imageGenerationProviders", {
      id: "xai",
      provider: { defaultModel: "shadowed-model" },
    });
    addCapabilityProvider(loaded, "imageGenerationProviders", {
      id: "unconfigured-image",
      provider: { isConfigured: () => false },
    });
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        createPluginManifestRecordFixture({
          id: "fal",
          origin: "bundled",
          contracts: { imageGenerationProviders: ["fal"] },
        }),
        createPluginManifestRecordFixture({
          id: "xai",
          origin: "bundled",
          contracts: { imageGenerationProviders: ["xai"] },
        }),
        createPluginManifestRecordFixture({
          id: "unconfigured-image",
          origin: "bundled",
          contracts: { imageGenerationProviders: ["unconfigured-image"] },
        }),
      ],
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );

    const cfg: OpenClawConfig = { plugins: { allow: ["fal", "xai", "unconfigured-image"] } };
    const providers = resolvePluginCapabilityProviders({
      key: "imageGenerationProviders",
      cfg,
    });

    expectResolvedCapabilityProviderIds(providers, ["xai", "fal", "unconfigured-image"]);
    expect(providers[0]).toBe(active.imageGenerationProviders[0]?.provider);
    expect(providers[1]).toBe(loaded.imageGenerationProviders[0]?.provider);
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith();
    expectActiveRegistryLookup(["fal", "unconfigured-image", "xai"]);

    const requestedProviders = resolvePluginCapabilityProviders({
      key: "imageGenerationProviders",
      cfg,
      additionalProviderIds: [" FAL ", "fal"],
    });
    expectResolvedCapabilityProviderIds(requestedProviders, ["xai", "fal", "unconfigured-image"]);
    expect(requestedProviders[0]).toBe(active.imageGenerationProviders[0]?.provider);
    expect(requestedProviders[1]).toBe(loaded.imageGenerationProviders[0]?.provider);
    expectResolvedCapabilityProviderIds(
      resolvePluginCapabilityProviders({
        key: "imageGenerationProviders",
        cfg,
        additionalProviderIds: [],
      }),
      ["xai", "fal", "unconfigured-image"],
    );
  });

  it.each([
    {
      key: "speechProviders" as const,
      contracts: { speechProviders: ["openai"] },
      seedLoadedProvider: (registry: ReturnType<typeof createEmptyPluginRegistry>) => {
        registry.speechProviders.push({
          pluginId: "openai",
          pluginName: "OpenAI",
          source: "test",
          provider: {
            id: "openai",
            label: "OpenAI",
            isConfigured: () => true,
            synthesize: async () => ({
              audioBuffer: Buffer.from("x"),
              outputFormat: "mp3",
              voiceCompatible: false,
              fileExtension: ".mp3",
            }),
          },
        } as never);
      },
    },
    {
      key: "realtimeTranscriptionProviders" as const,
      contracts: { realtimeTranscriptionProviders: ["openai"] },
      seedLoadedProvider: (registry: ReturnType<typeof createEmptyPluginRegistry>) => {
        registry.realtimeTranscriptionProviders.push({
          pluginId: "openai",
          pluginName: "OpenAI",
          source: "test",
          provider: {
            id: "openai",
            label: "OpenAI",
            isConfigured: () => true,
            createSession: () => ({
              connect: async () => {},
              sendAudio() {},
              close() {},
              isConnected: () => true,
            }),
          },
        } as never);
      },
    },
    {
      key: "realtimeVoiceProviders" as const,
      contracts: { realtimeVoiceProviders: ["openai"] },
      seedLoadedProvider: (registry: ReturnType<typeof createEmptyPluginRegistry>) => {
        registry.realtimeVoiceProviders.push({
          pluginId: "openai",
          pluginName: "OpenAI",
          source: "test",
          provider: {
            id: "openai",
            label: "OpenAI",
            isConfigured: () => true,
            createBridge: () => ({
              connect: async () => {},
              sendAudio() {},
              setMediaTimestamp() {},
              submitToolResult() {},
              acknowledgeMark() {},
              close() {},
              isConnected: () => true,
            }),
          },
        } as never);
      },
    },
  ])("uses agents.defaults.voiceModel to scope %s", ({ key, contracts, seedLoadedProvider }) => {
    const loaded = createEmptyPluginRegistry();
    seedLoadedProvider(loaded);
    const cfg = {
      agents: {
        defaults: {
          voiceModel: { primary: "openai/gpt-4o-mini-tts" },
        },
      },
    } as OpenClawConfig;
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        createPluginManifestRecordFixture({
          id: "openai",
          origin: "bundled",
          contracts,
        }),
      ],
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    const providers = resolvePluginCapabilityProviders({ key, cfg });

    expectResolvedCapabilityProviderIds(providers, ["openai"]);
    expectActiveRegistryLookup(["openai"]);
  });

  it.each([
    ["voice model", "speechProviders", { agents: { defaults: { voiceModel: "openai/model" } } }],
    ["sole Talk speech", "speechProviders", { talk: { providers: { openai: {} } } }],
    [
      "Talk speech alias",
      "speechProviders",
      { talk: { provider: "voice-alias", providers: { "voice-alias": {} } } },
    ],
    [
      "Talk realtime alias",
      "realtimeVoiceProviders",
      { talk: { realtime: { provider: "voice-alias", providers: { "voice-alias": {} } } } },
    ],
  ] as const)("loads a missing provider requested by %s", (_source, key, cfg) => {
    const active = createEmptyPluginRegistry();
    addCapabilityProvider(active, key, { id: "google" });
    const loaded = createEmptyPluginRegistry();
    addCapabilityProvider(loaded, key, { id: "openai", provider: { aliases: ["voice-alias"] } });
    setCapabilityManifestPlugins([
      { id: "google", contracts: { [key]: ["google"] } },
      { id: "openai", contracts: { [key]: ["openai", "voice-alias"] } },
    ]);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );

    const providers = resolvePluginCapabilityProviders({ key, cfg: cfg as OpenClawConfig });

    expectResolvedCapabilityProviderIds(providers, ["google", "openai"]);
    expectActiveRegistryLookup(["openai"]);
  });

  it.each([
    {
      key: "realtimeTranscriptionProviders" as const,
      seedLoadedProviders: (registry: ReturnType<typeof createEmptyPluginRegistry>) => {
        registry.realtimeTranscriptionProviders.push(
          {
            pluginId: "openai",
            pluginName: "OpenAI",
            source: "test",
            provider: { id: "openai", label: "OpenAI" },
          } as never,
          {
            pluginId: "google",
            pluginName: "Google",
            source: "test",
            provider: { id: "google", label: "Google" },
          } as never,
        );
      },
    },
    {
      key: "realtimeVoiceProviders" as const,
      seedLoadedProviders: (registry: ReturnType<typeof createEmptyPluginRegistry>) => {
        registry.realtimeVoiceProviders.push(
          {
            pluginId: "openai",
            pluginName: "OpenAI",
            source: "test",
            provider: { id: "openai", label: "OpenAI" },
          } as never,
          {
            pluginId: "google",
            pluginName: "Google",
            source: "test",
            provider: { id: "google", label: "Google" },
          } as never,
        );
      },
    },
  ])(
    "does not filter cold-loaded %s entries to a generic voiceModel provider",
    ({ key, seedLoadedProviders }) => {
      const loaded = createEmptyPluginRegistry();
      seedLoadedProviders(loaded);
      const cfg = {
        agents: {
          defaults: {
            voiceModel: {
              primary: "google/gemini-live-2.5-flash-preview-native-audio",
            },
          },
        },
      } as OpenClawConfig;
      mocks.loadPluginManifestRegistryCore.mockReturnValue({
        plugins: [
          createPluginManifestRecordFixture({
            id: "openai",
            origin: "bundled",
            contracts: { [key]: ["openai"] },
          }),
          createPluginManifestRecordFixture({
            id: "google",
            origin: "bundled",
            contracts: { [key]: ["google"] },
          }),
        ],
        diagnostics: [],
      });
      mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
        params === undefined ? undefined : loaded,
      );

      const providers = resolvePluginCapabilityProviders({ key, cfg });

      expectResolvedCapabilityProviderIds(providers, ["openai", "google"]);
      expectActiveRegistryLookup(["google", "openai"]);
    },
  );

  it("cold-loads enabled external manifest-contract providers missing from startup registry", () => {
    const loaded = createEmptyPluginRegistry();
    loaded.speechProviders.push({
      pluginId: "fish-audio-speech",
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
      plugins: [{ pluginId: "fish-audio-speech", origin: "global", enabled: true }],
    });
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        createPluginManifestRecordFixture({
          id: "fish-audio-speech",
          origin: "global",
          enabledByDefault: false,
          contracts: { speechProviders: ["fish-audio"] },
        }),
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
      onlyPluginIds: ["fish-audio-speech"],
    });
    const inactiveLookup = requireRuntimeRegistryLookup({
      activate: false,
      onlyPluginIds: ["fish-audio-speech"],
    });
    expect(inactiveLookup.activate).toBe(false);
    expect(inactiveLookup.onlyPluginIds).toEqual(["fish-audio-speech"]);
    expect(mocks.loadBundledCapabilityRuntimeRegistry).not.toHaveBeenCalled();
  });

  it("preserves active media providers while checking the complete family", () => {
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
    setCapabilityManifestPlugins([
      { id: "deepgram", contracts: { mediaUnderstandingProviders: ["deepgram"] } },
    ]);

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
    expect(providers[0]).toBe(active.mediaUnderstandingProviders[0]?.provider);
    expectInitialRuntimeRegistryLookup();
  });

  it.each([
    { name: "automatic partial registry", active: "partial", expected: ["qa-image", "qa-audio"] },
    { name: "automatic cold registry", active: "cold", expected: ["qa-image", "qa-audio"] },
    { name: "automatic complete registry", active: "full", expected: ["qa-image", "qa-audio"] },
    {
      name: "explicit media selection",
      active: "partial",
      explicit: true,
      expected: ["qa-image", "qa-audio"],
    },
    {
      name: "disabled audio owner",
      active: "partial",
      disabledOwner: true,
      expected: ["qa-image"],
    },
    { name: "denied audio owner", active: "partial", deniedOwner: true, expected: ["qa-image"] },
    {
      name: "excluded audio owner",
      active: "partial",
      excludedOwner: true,
      expected: ["qa-image"],
    },
    { name: "globally disabled plugins", active: "full", globalDisabled: true, expected: [] },
  ])("keeps media discovery complete for $name", (testCase) => {
    const image = { id: "qa-image", capabilities: ["image"], describeImage: vi.fn() };
    const audio = {
      id: "qa-audio",
      capabilities: ["audio"],
      defaultModels: { audio: "fixture-audio" },
      autoPriority: { audio: 1 },
      transcribeAudioWithContext: vi.fn(),
    };
    const registry = (providers: Array<typeof image | typeof audio>) => {
      const value = createEmptyPluginRegistry();
      for (const provider of providers) {
        addCapabilityProvider(value, "mediaUnderstandingProviders", {
          id: provider.id,
          provider,
        });
      }
      return value;
    };
    const active = registry(
      testCase.active === "cold" ? [] : testCase.active === "full" ? [image, audio] : [image],
    );
    const loaded = registry([image, audio]);
    const activeImage = active.mediaUnderstandingProviders.find(
      (entry) => entry.provider.id === image.id,
    )?.provider;
    mocks.resolveRuntimePluginRegistry.mockImplementation((options?: unknown) =>
      options === undefined ? active : loaded,
    );
    setCapabilityManifestPlugins([
      { id: "qa-image", contracts: { mediaUnderstandingProviders: ["qa-image"] } },
      { id: "qa-audio", contracts: { mediaUnderstandingProviders: ["qa-audio"] } },
    ]);
    const cfg: OpenClawConfig = {
      plugins: {
        enabled: !testCase.globalDisabled,
        allow: testCase.excludedOwner ? ["qa-image"] : ["qa-image", "qa-audio"],
        deny: testCase.deniedOwner ? ["qa-audio"] : [],
        entries: {
          "qa-image": { enabled: true },
          "qa-audio": { enabled: !testCase.disabledOwner },
        },
      },
      ...(testCase.explicit
        ? { tools: { media: { models: [{ provider: "qa-audio", capabilities: ["audio"] }] } } }
        : {}),
    };
    const resolve = () =>
      resolvePluginCapabilityProviders({ key: "mediaUnderstandingProviders", cfg });
    const first = resolve();
    expect(first.map(({ id }) => id).toSorted()).toEqual([...testCase.expected].toSorted());
    if (activeImage && !testCase.globalDisabled) {
      expect(first.find(({ id }) => id === image.id)).toBe(activeImage);
    }
    expect(
      resolve()
        .map(({ id }) => id)
        .toSorted(),
    ).toEqual([...testCase.expected].toSorted());
    expect(image.describeImage).not.toHaveBeenCalled();
    expect(audio.transcribeAudioWithContext).not.toHaveBeenCalled();
  });

  it.each([
    { name: "complete", complete: true, disabled: false },
    { name: "partial", complete: false, disabled: false },
    { name: "disabled", complete: true, disabled: true },
  ])(
    "keeps $name prepared media facts distinct from unresolved discovery",
    ({ complete, disabled }) => {
      const registry = createEmptyPluginRegistry();
      const ids = complete ? ["qa-image", "qa-audio"] : ["qa-image"];
      for (const id of ids) {
        addCapabilityProvider(registry, "mediaUnderstandingProviders", { id });
        registry.plugins.push(createPluginRecord({ id, origin: "bundled" }));
      }
      const prepared = prepareMediaCapabilityProviders({
        cfg: { plugins: { enabled: !disabled, allow: ["qa-image", "qa-audio"] } },
        registry,
        pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: ["qa-image", "qa-audio"].map((id) => ({
            id,
            contracts: { mediaUnderstandingProviders: [id] },
          })),
        }),
      });
      if (disabled) {
        expect(prepared.mediaUnderstandingProviders).toEqual([]);
      } else if (!complete) {
        expect(prepared.mediaUnderstandingProviders).toBeUndefined();
      } else {
        expect(prepared.mediaUnderstandingProviders?.map(({ id }) => id).toSorted()).toEqual([
          "qa-audio",
          "qa-image",
        ]);
      }
    },
  );

  it("keeps the full media provider family available with explicit models", () => {
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
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        createPluginManifestRecordFixture({
          id: "deepgram",
          origin: "bundled",
          contracts: { mediaUnderstandingProviders: ["deepgram"] },
        }),
        createPluginManifestRecordFixture({
          id: "google",
          origin: "bundled",
          contracts: { mediaUnderstandingProviders: ["google"] },
        }),
      ],
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
            models: [{ provider: "deepgram", model: "nova-3", capabilities: ["audio"] }],
            audio: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["openai", "deepgram", "google"]);
    expect(providers[0]).toBe(active.mediaUnderstandingProviders[0]?.provider);
    expectInitialRuntimeRegistryLookup();
    expectActiveRegistryLookup(["deepgram", "google"]);
  });

  it("keeps active speech providers when cfg requests an active provider alias", () => {
    const active = createEmptyPluginRegistry();
    addSpeechProvider(active, "microsoft", { aliases: ["edge"] });
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: {
        plugins: { entries: { microsoft: { enabled: true } } },
        tts: { provider: "edge" },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["microsoft"]);
    expect(mocks.loadPluginManifestRegistryCore).not.toHaveBeenCalled();
    expectInitialRuntimeRegistryLookup();
  });

  it("keeps active capability providers when cfg has no explicit plugin config", () => {
    const active = createEmptyPluginRegistry();
    addSpeechProvider(active, "acme");
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        createPluginManifestRecordFixture({
          id: "microsoft",
          origin: "bundled",
          contracts: { speechProviders: ["microsoft"] },
        }),
      ],
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: { tts: { provider: "acme" } } as OpenClawConfig,
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
    addSpeechProvider(active, "openai");
    const loaded = createEmptyPluginRegistry();
    addSpeechProvider(loaded, "microsoft", { aliases: ["edge"] });
    setCapabilityManifestPlugins([
      { id: "microsoft", contracts: { speechProviders: ["microsoft"] } },
    ]);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: {
        plugins: { allow: ["openai", "microsoft"] },
        tts: { provider: "edge" },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["openai", "microsoft"]);
    expectInitialRuntimeRegistryLookup();
    expectActiveRegistryLookup(["microsoft"]);
  });

  it("uses bundled capability capture when runtime snapshot is empty for a requested speech provider", () => {
    const active = createEmptyPluginRegistry();
    addSpeechProvider(active, "openai");
    const captured = createEmptyPluginRegistry();
    addSpeechProvider(captured, "google");
    setCapabilityManifestPlugins([
      { id: "google", contracts: { speechProviders: ["google"] } },
      { id: "microsoft", contracts: { speechProviders: ["microsoft"] } },
    ]);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : createEmptyPluginRegistry(),
    );
    mocks.loadBundledCapabilityRuntimeRegistry.mockReturnValue(captured);

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: {
        tts: { provider: "google" },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["openai", "google"]);
    expectActiveRegistryLookup(["google"]);
    expect(mocks.loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledWith({
      pluginIds: ["google"],
      onlyPluginIds: ["google"],
      activate: false,
      config: { tts: { provider: "google" } },
    });
  });

  it("uses bundled capability capture when runtime snapshot misses a requested speech provider", () => {
    const active = createEmptyPluginRegistry();
    addSpeechProvider(active, "openai");
    const loaded = createEmptyPluginRegistry();
    addSpeechProvider(loaded, "azure-speech", { label: "Azure Speech" });
    const captured = createEmptyPluginRegistry();
    addSpeechProvider(captured, "google");
    setCapabilityManifestPlugins([
      { id: "azure-speech", contracts: { speechProviders: ["azure-speech"] } },
      { id: "google", contracts: { speechProviders: ["google"] } },
    ]);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );
    mocks.loadBundledCapabilityRuntimeRegistry.mockReturnValue(captured);

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: {
        tts: { provider: "google" },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["openai", "google"]);
    expect(mocks.loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledWith({
      pluginIds: ["google"],
      onlyPluginIds: ["google"],
      activate: false,
      config: { tts: { provider: "google" } },
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
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        createPluginManifestRecordFixture({
          id: "google",
          origin: "bundled",
          contracts: { realtimeVoiceProviders: ["google"] },
        }),
      ],
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

  it("cold-loads a capability provider by runtime alias", () => {
    const active = createEmptyPluginRegistry();
    active.realtimeTranscriptionProviders.push({
      pluginId: "deepgram",
      pluginName: "Deepgram",
      source: "test",
      provider: { id: "deepgram", label: "Deepgram" },
    } as never);
    const loaded = createEmptyPluginRegistry();
    loaded.realtimeTranscriptionProviders.push({
      pluginId: "openai",
      pluginName: "OpenAI",
      source: "test",
      provider: {
        id: "openai",
        aliases: [" OpenAI-Realtime "],
        label: "OpenAI",
      },
    } as never);
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        createPluginManifestRecordFixture({
          id: "deepgram",
          origin: "bundled",
          contracts: { realtimeTranscriptionProviders: ["deepgram"] },
        }),
        createPluginManifestRecordFixture({
          id: "openai",
          origin: "bundled",
          contracts: { realtimeTranscriptionProviders: ["openai"] },
        }),
      ],
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );

    const provider = resolvePluginCapabilityProvider({
      key: "realtimeTranscriptionProviders",
      providerId: "openai-realtime",
    });

    expect(provider?.id).toBe("openai");
    expectActiveRegistryLookup(["deepgram", "openai"]);
    expect(mocks.loadPluginManifestRegistryCore).toHaveBeenCalledOnce();
  });

  it("prefers a canonical provider id over an earlier provider alias", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push(
      {
        pluginId: "microsoft",
        pluginName: "Microsoft",
        source: "test",
        provider: { id: "microsoft", aliases: [" EDGE "], label: "Microsoft" },
      } as never,
      {
        pluginId: "edge",
        pluginName: "Edge",
        source: "test",
        provider: { id: "edge", label: "Edge" },
      } as never,
    );
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const provider = resolvePluginCapabilityProvider({
      key: "speechProviders",
      providerId: "edge",
    });

    expect(provider?.id).toBe("edge");
  });

  it("does not merge unrelated bundled capability providers when cfg requests one provider", () => {
    const active = createEmptyPluginRegistry();
    addSpeechProvider(active, "openai");
    const loaded = createEmptyPluginRegistry();
    addSpeechProvider(loaded, "microsoft", { aliases: ["edge"] });
    addSpeechProvider(loaded, "elevenlabs");
    setCapabilityManifestPlugins([
      { id: "microsoft", contracts: { speechProviders: ["microsoft"] } },
      { id: "elevenlabs", contracts: { speechProviders: ["elevenlabs"] } },
    ]);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: {
        plugins: { allow: ["openai", "microsoft", "elevenlabs"] },
        tts: { provider: "edge" },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["openai", "microsoft"]);
  });

  it("reuses one manifest snapshot for multiple requested speech providers", () => {
    const loaded = createEmptyPluginRegistry();
    addSpeechProvider(loaded, "google");
    addSpeechProvider(loaded, "microsoft");
    setCapabilityManifestPlugins([
      { id: "google", contracts: { speechProviders: ["google"] } },
      { id: "microsoft", contracts: { speechProviders: ["microsoft"] } },
    ]);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: {
        tts: {
          provider: "google",
          providers: { microsoft: {} },
        },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["google", "microsoft"]);
    expectActiveRegistryLookup(["google", "microsoft"]);
    expect(mocks.loadPluginManifestRegistryCore).toHaveBeenCalledOnce();
  });

  it.each([
    ["partial alias", ["google", "edge"], [], ["google", "microsoft"]],
    ["unknown alias", ["edge", "unknown"], [], ["google", "microsoft", "elevenlabs"]],
    ["denied canonical", ["google", "edge"], ["google"], ["microsoft", "elevenlabs"]],
  ] as const)("preserves cold %s provider coverage", (_name, requested, deny, expected) => {
    const loaded = createEmptyPluginRegistry();
    addSpeechProvider(loaded, "google");
    addSpeechProvider(loaded, "microsoft", { aliases: ["edge"] });
    addSpeechProvider(loaded, "elevenlabs");
    setCapabilityManifestPlugins(
      ["google", "microsoft", "elevenlabs"].map((id) => ({
        id,
        contracts: { speechProviders: [id] },
      })),
    );
    mocks.resolveRuntimePluginRegistry.mockImplementation((options?: unknown) =>
      options === undefined ? undefined : loaded,
    );
    const cfg: OpenClawConfig = {
      plugins: { allow: ["google", "microsoft", "elevenlabs"], deny: [...deny] },
      tts: {
        provider: requested[0],
        providers: Object.fromEntries(requested.slice(1).map((id) => [id, {}])),
      },
    };

    expectResolvedCapabilityProviderIds(
      resolvePluginCapabilityProviders({ key: "speechProviders", cfg }),
      [...expected],
    );
  });

  it.each([
    ["embeddingProviders", "embeddingProviders"],
    ["speechProviders", "speechProviders"],
    ["realtimeTranscriptionProviders", "realtimeTranscriptionProviders"],
    ["realtimeVoiceProviders", "realtimeVoiceProviders"],
    ["mediaUnderstandingProviders", "mediaUnderstandingProviders"],
    ["imageGenerationProviders", "imageGenerationProviders"],
    ["videoGenerationProviders", "videoGenerationProviders"],
    ["musicGenerationProviders", "musicGenerationProviders"],
  ] as const)("applies bundled compat before fallback loading for %s", (key, contractKey) => {
    const { cfg, enablementCompat } = createCompatChainConfig();
    expectCompatChainApplied({
      key,
      contractKey,
      cfg,
      enablementCompat,
    });
  });

  it.each(["same", "equivalent"] as const)(
    "reuses manifest metadata while applying bundled compat to each %s config",
    (configIdentity) => {
      const first = createCompatChainConfig();
      const second = configIdentity === "same" ? first : createCompatChainConfig();
      setBundledCapabilityFixture("mediaUnderstandingProviders");
      mocks.withBundledPluginEnablementCompat.mockReturnValue(first.enablementCompat);

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

      expect(mocks.loadPluginManifestRegistryCore).toHaveBeenCalledOnce();
      expect(mocks.withBundledPluginEnablementCompat).toHaveBeenNthCalledWith(1, {
        config: first.cfg,
        pluginIds: ["openai"],
      });
      expect(mocks.withBundledPluginEnablementCompat).toHaveBeenNthCalledWith(2, {
        config: second.cfg,
        pluginIds: ["openai"],
      });
    },
  );

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
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    const providers = resolvePluginCapabilityProviders({ key: "mediaUnderstandingProviders" });

    expectResolvedCapabilityProviderIds(providers, ["google"]);
    expectManifestRegistryLoad(0, undefined);
    expectActiveRegistryLookup(["google"]);
  });

  it("loads fallback snapshots without startup dependency repair", () => {
    setBundledDiscoveryCompat();
    const cfg = { plugins: { allow: ["custom-plugin"] } } as OpenClawConfig;
    const enablementCompat = {
      plugins: {
        allow: ["custom-plugin", "openai"],
        entries: { openai: { enabled: true } },
      },
    };
    setBundledCapabilityFixture("mediaUnderstandingProviders");
    mocks.withBundledPluginEnablementCompat.mockReturnValue(enablementCompat);

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
    expect(mocks.loadPluginManifestRegistryCore).not.toHaveBeenCalled();
    expect(mocks.withBundledPluginEnablementCompat).not.toHaveBeenCalled();
    expect(mocks.resolveRuntimePluginRegistry).not.toHaveBeenCalled();
  });

  it("loads bundled speech providers through compat when plugins are globally disabled", () => {
    const cfg = {
      plugins: { enabled: false },
      tts: { provider: "mistral" },
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
    addSpeechProvider(loaded, "microsoft", { aliases: ["edge"] });
    setCapabilityManifestPlugins([
      { id: "microsoft", contracts: { speechProviders: ["microsoft"] } },
    ]);
    mocks.withBundledPluginEnablementCompat.mockReturnValue(compatConfig);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg,
    });

    expectResolvedCapabilityProviderIds(providers, ["microsoft"]);
    expectManifestRegistryLoad(0, cfg);
    expect(mocks.withBundledPluginEnablementCompat).toHaveBeenCalledWith({
      config: cfg,
      pluginIds: ["microsoft"],
    });
    expectInitialRuntimeRegistryLookup();
    expectActiveRegistryLookup(["microsoft"]);
    expect(mocks.loadPluginManifestRegistryCore).toHaveBeenCalledOnce();
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
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        createPluginManifestRecordFixture({
          id: "openai",
          origin: "bundled",
          contracts: {
            imageGenerationProviders: ["openai"],
            videoGenerationProviders: ["openai"],
          },
        }),
        createPluginManifestRecordFixture({
          id: "minimax",
          origin: "bundled",
          contracts: {
            imageGenerationProviders: ["minimax"],
            videoGenerationProviders: ["minimax"],
            musicGenerationProviders: ["minimax"],
          },
        }),
      ],
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
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        createPluginManifestRecordFixture({
          id: "openai",
          origin: "bundled",
          contracts: {
            imageGenerationProviders: ["openai"],
          },
        }),
      ],
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
    setBundledDiscoveryCompat();
    const cfg = { plugins: { allow: ["custom-plugin"] } } as OpenClawConfig;
    const enablementCompat = {
      plugins: {
        allow: ["custom-plugin", "google"],
        entries: { google: { enabled: true } },
      },
    };
    const loaded = createEmptyPluginRegistry();
    loaded.embeddingProviders.push({
      pluginId: "google",
      pluginName: "google",
      source: "test",
      provider: {
        id: "gemini",
        create: async () => ({ provider: null }),
      },
    } as never);
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        createPluginManifestRecordFixture({
          id: "google",
          origin: "bundled",
          contracts: { embeddingProviders: ["gemini"] },
        }),
        createPluginManifestRecordFixture({
          id: "openai",
          origin: "bundled",
          contracts: { embeddingProviders: ["openai"] },
        }),
      ],
      diagnostics: [],
    });
    mocks.withBundledPluginEnablementCompat.mockReturnValue(enablementCompat);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    const provider = resolvePluginCapabilityProvider({
      key: "embeddingProviders",
      providerId: "gemini",
      cfg,
    });

    expect(provider?.id).toBe("gemini");
    expect(mocks.withBundledPluginEnablementCompat).toHaveBeenCalledWith({
      config: cfg,
      pluginIds: ["google"],
    });
    expectActiveRegistryLookup(["google"]);
  });

  it("does not load targeted non-speech capability providers when plugins are globally disabled", () => {
    const cfg = { plugins: { enabled: false, allow: ["custom-plugin"] } } as OpenClawConfig;
    const loaded = createEmptyPluginRegistry();
    loaded.embeddingProviders.push({
      pluginId: "google",
      pluginName: "google",
      source: "test",
      provider: {
        id: "gemini",
        create: async () => ({ provider: null }),
      },
    } as never);
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        createPluginManifestRecordFixture({
          id: "google",
          origin: "bundled",
          contracts: { embeddingProviders: ["gemini"] },
        }),
        createPluginManifestRecordFixture({
          id: "openai",
          origin: "bundled",
          contracts: { embeddingProviders: ["openai"] },
        }),
      ],
      diagnostics: [],
    });
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    const provider = resolvePluginCapabilityProvider({
      key: "embeddingProviders",
      providerId: "gemini",
      cfg,
    });

    expect(provider).toBeUndefined();
    expect(mocks.loadPluginManifestRegistryCore).not.toHaveBeenCalled();
    expect(mocks.withBundledPluginEnablementCompat).not.toHaveBeenCalled();
    expect(mocks.resolveRuntimePluginRegistry).not.toHaveBeenCalled();
  });

  it("loads targeted bundled speech providers through compat when plugins are globally disabled", () => {
    const cfg = { plugins: { enabled: false, allow: ["custom-plugin"] } } as OpenClawConfig;
    const enablementCompat = {
      plugins: {
        enabled: true,
        allow: ["custom-plugin", "microsoft"],
        entries: { microsoft: { enabled: true } },
      },
    };
    const loaded = createEmptyPluginRegistry();
    addSpeechProvider(loaded, "microsoft", { aliases: ["edge"] });
    setCapabilityManifestPlugins([
      { id: "microsoft", contracts: { speechProviders: ["microsoft"] } },
      { id: "openai", contracts: { speechProviders: ["openai"] } },
    ]);
    mocks.withBundledPluginEnablementCompat.mockReturnValue(enablementCompat);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    const provider = resolvePluginCapabilityProvider({
      key: "speechProviders",
      providerId: "microsoft",
      cfg,
    });

    expect(provider?.id).toBe("microsoft");
    expect(mocks.withBundledPluginEnablementCompat).toHaveBeenCalledWith({
      config: cfg,
      pluginIds: ["microsoft"],
    });
    expectInitialRuntimeRegistryLookup();
    expectActiveRegistryLookup(["microsoft"]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
