import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "./registry.js";

type MockManifestRegistry = {
  plugins: Array<Record<string, unknown>>;
  diagnostics: unknown[];
};

function createEmptyMockManifestRegistry(): MockManifestRegistry {
  return { plugins: [], diagnostics: [] };
}

const mocks = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn<
    (params?: unknown) => ReturnType<typeof createEmptyPluginRegistry> | undefined
  >(() => undefined),
  loadPluginManifestRegistry: vi.fn<() => MockManifestRegistry>(() =>
    createEmptyMockManifestRegistry(),
  ),
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
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: mocks.loadPluginManifestRegistry,
}));

vi.mock("./bundled-compat.js", () => ({
  withBundledPluginAllowlistCompat: mocks.withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat: mocks.withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat: mocks.withBundledPluginVitestCompat,
}));

let resolvePluginCapabilityProviders: typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProviders;
let resolvePluginCapabilityProvider: typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProvider;

function expectResolvedCapabilityProviderIds(providers: Array<{ id: string }>, expected: string[]) {
  expect(providers.map((provider) => provider.id)).toEqual(expected);
}

function expectNoResolvedCapabilityProviders(providers: Array<{ id: string }>) {
  expectResolvedCapabilityProviderIds(providers, []);
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
  expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith({
    config: params.cfg,
    env: process.env,
  });
  expect(mocks.withBundledPluginEnablementCompat).toHaveBeenCalledWith({
    config: params.allowlistCompat,
    pluginIds: ["openai"],
  });
  expect(mocks.withBundledPluginVitestCompat).toHaveBeenCalledWith({
    config: params.enablementCompat,
    pluginIds: ["openai"],
    env: process.env,
  });
  expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
    config: params.enablementCompat,
  });
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

function setBundledCapabilityFixture(contractKey: string) {
  mocks.loadPluginManifestRegistry.mockReturnValue({
    plugins: [
      {
        id: "openai",
        origin: "bundled",
        contracts: { [contractKey]: ["openai"] },
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
    ({ resolvePluginCapabilityProvider, resolvePluginCapabilityProviders } =
      await import("./capability-provider-runtime.js"));
  });

  beforeEach(() => {
    mocks.resolveRuntimePluginRegistry.mockReset();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue(createEmptyMockManifestRegistry());
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
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith();
  });

  it("keeps active capability providers even when cfg is passed", () => {
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
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : createEmptyPluginRegistry(),
    );

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: { messages: { tts: { provider: "edge" } } } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["microsoft"]);
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith();
    expect(mocks.resolveRuntimePluginRegistry).not.toHaveBeenCalledWith({
      config: expect.anything(),
    });
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

  it("reuses a compatible active registry even when the capability list is empty", () => {
    const active = createEmptyPluginRegistry();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({
      key: "mediaUnderstandingProviders",
      cfg: {} as OpenClawConfig,
    });

    expectNoResolvedCapabilityProviders(providers);
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: expect.anything(),
    });
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
    setBundledCapabilityFixture("mediaUnderstandingProviders");
    mocks.withBundledPluginEnablementCompat.mockReturnValue(compatConfig);
    mocks.withBundledPluginVitestCompat.mockReturnValue(compatConfig);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    const providers = resolvePluginCapabilityProviders({ key: "mediaUnderstandingProviders" });

    expectResolvedCapabilityProviderIds(providers, ["google"]);
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith({
      config: undefined,
      env: process.env,
    });
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({ config: compatConfig });
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
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: enablementCompat,
    });
  });
});
