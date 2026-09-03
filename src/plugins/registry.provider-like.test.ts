/** Verifies provider-like plugin registry entries across capability families. */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { registryContainsRuntimePluginIds } from "./active-runtime-registry.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import type {
  OpenClawPluginApi,
  ProviderPluginCatalog,
  UnifiedModelCatalogProviderContext,
} from "./types.js";

function createTestRegistry() {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

describe("plugin registry provider-like registrations", () => {
  it("captures unified model catalog provider registrations", () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "catalog-owner",
      name: "Catalog Owner",
      source: "/tmp/catalog-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerModelCatalogProvider(record, {
      provider: "catalog-provider",
      kinds: ["text", "video_generation"],
      staticCatalog: () => [
        {
          kind: "text",
          provider: "catalog-provider",
          model: "catalog-model",
          source: "static",
        },
      ],
    });

    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const catalogRegistration = pluginRegistry.registry.modelCatalogProviders[0];
    expect(catalogRegistration?.pluginId).toBe("catalog-owner");
    expect(catalogRegistration?.provider.provider).toBe("catalog-provider");
    expect(catalogRegistration?.provider.kinds).toEqual(["text", "video_generation"]);
  });

  it("combines same-plugin overlapping model catalog hooks", async () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "catalog-owner",
      name: "Catalog Owner",
      source: "/tmp/catalog-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerModelCatalogProvider(record, {
      provider: "catalog-provider",
      kinds: ["voice"],
      staticCatalog: () => [
        {
          kind: "voice",
          provider: "catalog-provider",
          model: "tts-model",
          source: "static",
        },
      ],
    });
    pluginRegistry.registerModelCatalogProvider(record, {
      provider: "catalog-provider",
      kinds: ["voice"],
      staticCatalog: () => [
        {
          kind: "voice",
          provider: "catalog-provider",
          model: "realtime-model",
          source: "static",
        },
      ],
    });

    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const catalogProvider = pluginRegistry.registry.modelCatalogProviders[0]?.provider;
    await expect(catalogProvider?.staticCatalog?.({} as never)).resolves.toEqual([
      {
        kind: "voice",
        provider: "catalog-provider",
        model: "tts-model",
        source: "static",
      },
      {
        kind: "voice",
        provider: "catalog-provider",
        model: "realtime-model",
        source: "static",
      },
    ]);
  });

  it("does not duplicate manifest-declared capability provider ids during runtime registration", () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "kitchen-sink",
      name: "Kitchen Sink",
      source: "/tmp/kitchen-sink/index.js",
      origin: "global",
      enabled: true,
      contracts: {
        speechProviders: ["kitchen-sink-speech-provider"],
      },
      configSchema: false,
    });

    pluginRegistry.registerSpeechProvider(record, {
      id: "kitchen-sink-speech-provider",
      label: "Kitchen Sink Speech",
      isConfigured: () => true,
      synthesize: async () => ({
        audioBuffer: Buffer.alloc(0),
        fileExtension: "mp3",
        outputFormat: "audio/mpeg",
        voiceCompatible: true,
      }),
    });

    expect(record.speechProviderIds).toEqual(["kitchen-sink-speech-provider"]);
    expect(pluginRegistry.registry.speechProviders).toHaveLength(1);
  });
});

const reservationCases = [
  {
    family: "text",
    kind: "text",
    registryKey: "providers",
    ownedKey: "providerIds",
    label: "provider",
  },
  {
    family: "speech",
    kind: "voice",
    registryKey: "speechProviders",
    ownedKey: "speechProviderIds",
    label: "speech provider",
  },
  {
    family: "transcription",
    kind: "voice",
    registryKey: "realtimeTranscriptionProviders",
    ownedKey: "realtimeTranscriptionProviderIds",
    label: "realtime transcription provider",
  },
  {
    family: "realtime",
    kind: "voice",
    registryKey: "realtimeVoiceProviders",
    ownedKey: "realtimeVoiceProviderIds",
    label: "realtime voice provider",
  },
  {
    family: "image",
    kind: "image_generation",
    registryKey: "imageGenerationProviders",
    ownedKey: "imageGenerationProviderIds",
    label: "image-generation provider",
  },
  {
    family: "video",
    kind: "video_generation",
    registryKey: "videoGenerationProviders",
    ownedKey: "videoGenerationProviderIds",
    label: "video-generation provider",
  },
  {
    family: "music",
    kind: "music_generation",
    registryKey: "musicGenerationProviders",
    ownedKey: "musicGenerationProviderIds",
    label: "music-generation provider",
  },
] as const;

function registerReservedProvider(
  api: OpenClawPluginApi,
  family: (typeof reservationCases)[number]["family"],
  id: string,
  run: ProviderPluginCatalog["run"],
) {
  const provider = { id, label: "Catalog provider", defaultModel: "default", models: ["default"] };
  const unused = () => {
    throw new Error("registration must not invoke provider operations");
  };
  switch (family) {
    case "text":
      return api.registerProvider({
        ...provider,
        auth: [],
        catalog: { run },
        staticCatalog: { run },
      });
    case "speech":
      return api.registerSpeechProvider({ ...provider, isConfigured: unused, synthesize: unused });
    case "transcription":
      return api.registerRealtimeTranscriptionProvider({
        ...provider,
        isConfigured: unused,
        createSession: unused,
      });
    case "realtime":
      return api.registerRealtimeVoiceProvider({
        ...provider,
        isConfigured: unused,
        createBridge: unused,
      });
    case "image":
      return api.registerImageGenerationProvider({
        ...provider,
        capabilities: { generate: { maxCount: 1 }, edit: { enabled: false } },
        generateImage: unused,
      });
    case "video":
      return api.registerVideoGenerationProvider({
        ...provider,
        capabilities: { generate: { maxDurationSeconds: 4 } },
        generateVideo: unused,
      });
    case "music":
      return api.registerMusicGenerationProvider({
        ...provider,
        capabilities: { generate: { maxTracks: 1 } },
        generateMusic: unused,
      });
  }
}

function createCatalogOwner(builder: ReturnType<typeof createTestRegistry>, id: string) {
  const record = createPluginRecord({
    id,
    name: id,
    source: `/plugins/${id}/index.ts`,
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  return { record, api: builder.createApi(record, { config: {} }) };
}

function catalogOwners(builder: ReturnType<typeof createTestRegistry>) {
  return builder.registry.modelCatalogProviders.map(({ pluginId, provider }) => ({
    pluginId,
    provider: provider.provider,
    kinds: provider.kinds,
  }));
}

const catalogContext: UnifiedModelCatalogProviderContext = {
  config: {},
  env: {},
  resolveProviderApiKey: () => ({ apiKey: undefined }),
  resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
};

describe.each(reservationCases)(
  "$family catalog ownership",
  ({ family, kind, registryKey, ownedKey, label }) => {
    it.each(["catalog-provider", "  Catalog-Provider  ", "", "   "])(
      "reserves only accepted provider IDs without executing hooks (%j)",
      (id) => {
        const builder = createTestRegistry();
        const { api, record } = createCatalogOwner(builder, "owner");
        const run = vi.fn(async () => null);

        expect(registerReservedProvider(api, family, id, run)).toBeUndefined();
        expect(run).not.toHaveBeenCalled();
        if (!id.trim()) {
          expect(builder.registry[registryKey]).toEqual([]);
          expect(record[ownedKey]).toEqual([]);
          expect(catalogOwners(builder)).toEqual([]);
          expect(builder.registry.diagnostics).toEqual([
            {
              level: "error",
              pluginId: "owner",
              source: record.source,
              message: `${label} registration missing id`,
            },
          ]);
          return;
        }
        expect(builder.registry[registryKey].map(({ provider }) => provider.id)).toEqual([
          family === "text" ? id.trim() : id,
        ]);
        expect(record[ownedKey]).toEqual([id.trim()]);
        expect(catalogOwners(builder)).toEqual([
          { pluginId: "owner", provider: id.trim(), kinds: [kind] },
        ]);
        expect(builder.registry.diagnostics).toEqual([]);
      },
    );

    it.each(["automatic-first", "explicit-first"] as const)(
      "preserves cross-plugin ownership and provider registration (%s)",
      (order) => {
        const builder = createTestRegistry();
        const alpha = createCatalogOwner(builder, "alpha");
        const beta = createCatalogOwner(builder, "beta");
        const run = vi.fn(async () => null);
        const explicit = (api: OpenClawPluginApi) =>
          api.registerModelCatalogProvider({ provider: "catalog-provider", kinds: ["text"] });
        if (order === "automatic-first") {
          registerReservedProvider(alpha.api, family, "catalog-provider", run);
          explicit(beta.api);
        } else {
          explicit(alpha.api);
          registerReservedProvider(beta.api, family, "catalog-provider", run);
        }
        expect(catalogOwners(builder)).toEqual([
          {
            pluginId: "alpha",
            provider: "catalog-provider",
            kinds: [order === "automatic-first" ? kind : "text"],
          },
        ]);
        expect(builder.registry[registryKey].map(({ pluginId }) => pluginId)).toEqual([
          order === "automatic-first" ? "alpha" : "beta",
        ]);
        expect(builder.registry.diagnostics).toEqual([
          {
            level: "error",
            pluginId: "beta",
            source: beta.record.source,
            message: "model catalog provider already registered: catalog-provider (alpha)",
          },
        ]);
        expect(run).not.toHaveBeenCalled();
      },
    );

    it.each(["automatic-first", "explicit-first"] as const)(
      "retains explicit static/live contributions alongside a same-plugin reservation (%s)",
      async (order) => {
        const builder = createTestRegistry();
        const { api } = createCatalogOwner(builder, "owner");
        const run = vi.fn(async () => null);
        const row = { kind, provider: "catalog-provider", model: "explicit-model" };
        const staticCatalog = vi.fn(() => [{ ...row, source: "static" as const }]);
        const liveCatalog = vi.fn(() => [{ ...row, source: "live" as const }]);
        const automatic = () => registerReservedProvider(api, family, "catalog-provider", run);
        const explicit = () =>
          api.registerModelCatalogProvider({
            provider: "catalog-provider",
            kinds: [kind],
            staticCatalog,
            liveCatalog,
          });
        if (order === "automatic-first") {
          automatic();
          explicit();
        } else {
          explicit();
          automatic();
        }
        expect(catalogOwners(builder)).toEqual([
          { pluginId: "owner", provider: "catalog-provider", kinds: [kind] },
        ]);
        expect(run).not.toHaveBeenCalled();
        expect(staticCatalog).not.toHaveBeenCalled();
        expect(liveCatalog).not.toHaveBeenCalled();
        const provider = expectDefined(
          builder.registry.modelCatalogProviders[0],
          "catalog reservation",
        ).provider;
        const staticRows = await provider.staticCatalog?.(catalogContext);
        const liveRows = await provider.liveCatalog?.(catalogContext);
        // Automatic rows are intentionally not an oracle; the explicit API contribution is.
        expect(staticRows?.filter((entry) => entry.model === row.model)).toEqual([
          { ...row, source: "static" },
        ]);
        expect(liveRows?.filter((entry) => entry.model === row.model)).toEqual([
          { ...row, source: "live" },
        ]);
        expect(staticCatalog).toHaveBeenCalledExactlyOnceWith(catalogContext);
        expect(liveCatalog).toHaveBeenCalledExactlyOnceWith(catalogContext);
        expect(builder.registry.diagnostics).toEqual([]);
      },
    );
  },
);

describe("catalog reservation lifecycle", () => {
  it.each(["none", "static", "live", "both"] as const)(
    "reserves text only when eligible (%s)",
    (mode) => {
      const builder = createTestRegistry();
      const { api } = createCatalogOwner(builder, "owner");
      const run = vi.fn(async () => null);
      api.registerProvider({
        id: "text-provider",
        label: "Text provider",
        auth: [],
        ...(mode === "live" || mode === "both" ? { catalog: { run } } : {}),
        ...(mode === "static" || mode === "both" ? { staticCatalog: { run } } : {}),
      });
      expect(builder.registry.providers).toHaveLength(1);
      expect(catalogOwners(builder)).toEqual(
        mode === "none" ? [] : [{ pluginId: "owner", provider: "text-provider", kinds: ["text"] }],
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("keeps the first overlapping row, distinct kinds, rollback, and record-authoritative containment", () => {
    const builder = createTestRegistry();
    const alpha = createCatalogOwner(builder, "alpha");
    const beta = createCatalogOwner(builder, "beta");
    const run = vi.fn(async () => null);
    for (const { family } of reservationCases) {
      registerReservedProvider(alpha.api, family, "catalog-provider", run);
    }
    beta.api.registerModelCatalogProvider({ provider: "other-provider", kinds: ["voice"] });
    const explicit = vi.fn(() => []);
    alpha.api.registerModelCatalogProvider({
      provider: "catalog-provider",
      kinds: ["voice", "video_generation", "voice"],
      staticCatalog: explicit,
    });
    expect(catalogOwners(builder)).toEqual([
      { pluginId: "alpha", provider: "catalog-provider", kinds: ["text"] },
      { pluginId: "alpha", provider: "catalog-provider", kinds: ["voice", "video_generation"] },
      { pluginId: "alpha", provider: "catalog-provider", kinds: ["image_generation"] },
      { pluginId: "alpha", provider: "catalog-provider", kinds: ["video_generation"] },
      { pluginId: "alpha", provider: "catalog-provider", kinds: ["music_generation"] },
      { pluginId: "beta", provider: "other-provider", kinds: ["voice"] },
    ]);
    expect(registryContainsRuntimePluginIds(builder.registry, ["alpha", "beta"])).toBe(true);
    expect(registryContainsRuntimePluginIds(builder.registry, [])).toBe(false);
    builder.registry.plugins.push({ ...alpha.record, status: "disabled" });
    expect(registryContainsRuntimePluginIds(builder.registry, ["alpha"])).toBe(false);
    builder.registry.plugins.pop();
    builder.rollbackPluginGlobalSideEffects(alpha.record.id, alpha.record);
    expect(catalogOwners(builder)).toEqual([
      { pluginId: "beta", provider: "other-provider", kinds: ["voice"] },
    ]);
    for (const { registryKey } of reservationCases) {
      expect(builder.registry[registryKey]).toEqual([]);
    }
    expect(registryContainsRuntimePluginIds(builder.registry, ["alpha"])).toBe(false);
    expect(registryContainsRuntimePluginIds(builder.registry, ["beta"])).toBe(true);
    expect(builder.registry.diagnostics).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(explicit).not.toHaveBeenCalled();
  });

  it("rejects missing explicit provider and kinds without claiming ownership", () => {
    const builder = createTestRegistry();
    const { api, record } = createCatalogOwner(builder, "owner");
    api.registerModelCatalogProvider({ provider: " ", kinds: ["text"] });
    api.registerModelCatalogProvider({ provider: "catalog-provider", kinds: [] });
    expect(catalogOwners(builder)).toEqual([]);
    expect(builder.registry.diagnostics).toEqual([
      {
        level: "error",
        pluginId: "owner",
        source: record.source,
        message: "model catalog provider registration missing provider",
      },
      {
        level: "error",
        pluginId: "owner",
        source: record.source,
        message: 'model catalog provider "catalog-provider" registration missing kinds',
      },
    ]);
  });
});
