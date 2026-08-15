import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";

const manifestMocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  listOpenClawPluginManifestMetadata: vi.fn(),
  loadPluginManifest: vi.fn(),
  loadPluginManifestRegistryCore: vi.fn(),
}));
const providerMocks = vi.hoisted(() => ({
  normalizePluginDiscoveryResult: vi.fn(),
  resolveActivatableProviderOwnerPluginIds: vi.fn(),
  resolveBundledProviderCompatPluginIds: vi.fn(),
  resolveOwningPluginIdsForProviderRef: vi.fn(),
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderStaticCatalog: vi.fn(),
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: manifestMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../../plugins/manifest-metadata-scan.js", () => ({
  listOpenClawPluginManifestMetadata: manifestMocks.listOpenClawPluginManifestMetadata,
}));

vi.mock("../../plugins/manifest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/manifest.js")>()),
  loadPluginManifest: manifestMocks.loadPluginManifest,
}));

vi.mock("../../plugins/manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/manifest-registry.js")>()),
  loadPluginManifestRegistryCore: manifestMocks.loadPluginManifestRegistryCore,
}));

vi.mock("../../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/providers.js")>()),
  resolveActivatableProviderOwnerPluginIds: providerMocks.resolveActivatableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds: providerMocks.resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProviderRef: providerMocks.resolveOwningPluginIdsForProviderRef,
}));

vi.mock("../../plugins/provider-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-discovery.js")>()),
  normalizePluginDiscoveryResult: providerMocks.normalizePluginDiscoveryResult,
  resolveRuntimePluginDiscoveryProviders: providerMocks.resolveRuntimePluginDiscoveryProviders,
  runProviderStaticCatalog: providerMocks.runProviderStaticCatalog,
}));

import {
  bundledStaticCatalogProviderUsesRuntimeAugment,
  createBundledStaticCatalogModelResolver,
  loadBundledProviderStaticCatalogContextModels,
  resolveBundledStaticCatalogModel,
} from "./model.static-catalog.js";

function createMistralManifestPlugin() {
  return {
    id: "mistral",
    origin: "bundled",
    providers: ["mistral"],
    modelCatalog: {
      providers: {
        mistral: {
          baseUrl: "https://api.mistral.ai/v1",
          api: "openai-completions",
          models: [
            {
              id: "mistral-medium-3-5",
              name: "Mistral Medium 3.5",
              contextWindow: 262144,
              maxTokens: 8192,
            },
          ],
        },
      },
      discovery: { mistral: "static" },
    },
  };
}

function setCurrentManifestPlugins(plugins: unknown[]) {
  const snapshot = { plugins, manifestRegistry: { plugins } };
  manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(snapshot);
}

function setManifestPlugins(plugins: unknown[]) {
  const byPluginDir = new Map(
    plugins.map((plugin) => {
      const id = (plugin as { id?: string }).id ?? "plugin";
      return [`/fixtures/${id}`, plugin];
    }),
  );
  manifestMocks.listOpenClawPluginManifestMetadata.mockReturnValue(
    [...byPluginDir].map(([pluginDir, plugin]) => ({
      pluginDir,
      manifest: plugin,
      origin: (plugin as { origin?: string }).origin,
    })),
  );
  manifestMocks.loadPluginManifest.mockImplementation((pluginDir: string) => {
    const plugin = byPluginDir.get(pluginDir);
    return plugin
      ? { ok: true, manifest: plugin }
      : { ok: false, error: "missing manifest", manifestPath: `${pluginDir}/openclaw.plugin.json` };
  });
}

beforeEach(() => {
  for (const mock of Object.values(manifestMocks)) {
    mock.mockReset();
  }
  for (const mock of Object.values(providerMocks)) {
    mock.mockReset();
  }
  manifestMocks.listOpenClawPluginManifestMetadata.mockReturnValue([]);
  manifestMocks.loadPluginManifestRegistryCore.mockReturnValue({ plugins: [] });
  providerMocks.resolveActivatableProviderOwnerPluginIds.mockImplementation(
    ({ pluginIds }: { pluginIds: string[] }) => pluginIds,
  );
  providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue([]);
  providerMocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(undefined);
  providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([]);
  providerMocks.runProviderStaticCatalog.mockResolvedValue(undefined);
  providerMocks.normalizePluginDiscoveryResult.mockReturnValue({});
});

describe("bundled static model catalog snapshot cache", () => {
  it("reuses the current plugin snapshot across separate static model lookups", () => {
    const cfg = {};
    setCurrentManifestPlugins([createMistralManifestPlugin()]);

    expect(
      resolveBundledStaticCatalogModel({
        provider: "mistral",
        modelId: "mistral-medium-3-5",
        cfg,
      })?.id,
    ).toBe("mistral-medium-3-5");
    expect(
      resolveBundledStaticCatalogModel({ provider: "mistral", modelId: "missing", cfg }),
    ).toBeUndefined();
    expect(manifestMocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
      workspaceDir: undefined,
      allowWorkspaceScopedSnapshot: true,
    });
    expect(manifestMocks.listOpenClawPluginManifestMetadata).not.toHaveBeenCalled();
    expect(manifestMocks.loadPluginManifest).not.toHaveBeenCalled();
  });

  it("observes replacement plugin generations inside a prepared model resolver", () => {
    const cfg = {};
    setCurrentManifestPlugins([createMistralManifestPlugin()]);
    const resolveModel = createBundledStaticCatalogModelResolver({ cfg });

    expect(resolveModel({ provider: "mistral", modelId: "mistral-medium-3-5" })?.id).toBe(
      "mistral-medium-3-5",
    );

    const replacementPlugin = createMistralManifestPlugin();
    replacementPlugin.modelCatalog.providers.mistral.models =
      replacementPlugin.modelCatalog.providers.mistral.models.map((model) => ({
        ...model,
        id: "mistral-medium-next",
        name: "Mistral Medium Next",
      }));
    setCurrentManifestPlugins([replacementPlugin]);

    expect(resolveModel({ provider: "mistral", modelId: "mistral-medium-3-5" })).toBeUndefined();
    expect(resolveModel({ provider: "mistral", modelId: "mistral-medium-next" })?.name).toBe(
      "Mistral Medium Next",
    );
    expect(manifestMocks.listOpenClawPluginManifestMetadata).not.toHaveBeenCalled();
    expect(manifestMocks.loadPluginManifest).not.toHaveBeenCalled();
  });

  it("pins lifecycle lookups to the supplied plugin generation", () => {
    const cfg = {};
    const capturedPlugin = {
      ...createMistralManifestPlugin(),
      modelIdNormalization: {
        providers: {
          mistral: {
            aliases: { latest: "mistral-medium-3-5" },
          },
        },
      },
    };
    const capturedSnapshot = {
      plugins: [capturedPlugin],
      manifestRegistry: { plugins: [capturedPlugin] },
    } as unknown as PluginMetadataSnapshot;
    const resolveModel = createBundledStaticCatalogModelResolver({
      cfg,
      metadataSnapshot: capturedSnapshot,
    });

    const replacementPlugin = {
      ...createMistralManifestPlugin(),
      modelIdNormalization: {
        providers: {
          mistral: {
            aliases: { latest: "mistral-medium-next" },
          },
        },
      },
    };
    replacementPlugin.modelCatalog.providers.mistral.models =
      replacementPlugin.modelCatalog.providers.mistral.models.map((model) => ({
        ...model,
        id: "mistral-medium-next",
        name: "Mistral Medium Next",
      }));
    setCurrentManifestPlugins([replacementPlugin]);

    expect(resolveModel({ provider: "mistral", modelId: "mistral-medium-3-5" })?.id).toBe(
      "mistral-medium-3-5",
    );
    expect(resolveModel({ provider: "mistral", modelId: "latest" })?.id).toBe("mistral-medium-3-5");
    expect(resolveModel({ provider: "mistral", modelId: "mistral-medium-next" })).toBeUndefined();
    expect(manifestMocks.getCurrentPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(manifestMocks.listOpenClawPluginManifestMetadata).not.toHaveBeenCalled();
    expect(manifestMocks.loadPluginManifest).not.toHaveBeenCalled();
  });

  it("uses the matching configured workspace snapshot", () => {
    const cfg = {};
    const workspaceDir = "/configured-workspace";
    setCurrentManifestPlugins([createMistralManifestPlugin()]);

    expect(
      resolveBundledStaticCatalogModel({
        provider: "mistral",
        modelId: "mistral-medium-3-5",
        cfg,
        workspaceDir,
      })?.id,
    ).toBe("mistral-medium-3-5");
    expect(manifestMocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
      workspaceDir,
    });
    expect(manifestMocks.listOpenClawPluginManifestMetadata).not.toHaveBeenCalled();
  });

  it("requires the default discovery context for unconfigured snapshot lookups", () => {
    setCurrentManifestPlugins([createMistralManifestPlugin()]);

    expect(
      resolveBundledStaticCatalogModel({ provider: "mistral", modelId: "mistral-medium-3-5" })?.id,
    ).toBe("mistral-medium-3-5");
    expect(manifestMocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: undefined,
      env: process.env,
      workspaceDir: undefined,
      allowWorkspaceScopedSnapshot: true,
      requireDefaultDiscoveryContext: true,
    });
    expect(manifestMocks.listOpenClawPluginManifestMetadata).not.toHaveBeenCalled();
  });

  it("keeps a custom environment on its own manifest discovery path", () => {
    const env = { HOME: "/custom-home" };
    const plugin = createMistralManifestPlugin();
    setManifestPlugins([plugin]);
    setCurrentManifestPlugins([plugin]);

    expect(
      resolveBundledStaticCatalogModel({
        provider: "mistral",
        modelId: "mistral-medium-3-5",
        cfg: {},
        env,
      })?.id,
    ).toBe("mistral-medium-3-5");
    expect(manifestMocks.getCurrentPluginMetadataSnapshot).not.toHaveBeenCalledWith(
      expect.objectContaining({ env }),
    );
    expect(manifestMocks.listOpenClawPluginManifestMetadata).toHaveBeenCalledWith(env);
    expect(manifestMocks.loadPluginManifest).toHaveBeenCalledTimes(1);
  });

  it("preserves plugin enablement policy for current snapshot catalog rows", () => {
    setCurrentManifestPlugins([createMistralManifestPlugin()]);

    for (const cfg of [
      { plugins: { enabled: false } },
      { plugins: { entries: { mistral: { enabled: false } } } },
      { plugins: { deny: ["mistral"] } },
      { plugins: { allow: ["google"] } },
    ]) {
      expect(
        resolveBundledStaticCatalogModel({
          provider: "mistral",
          modelId: "mistral-medium-3-5",
          cfg,
        }),
      ).toBeUndefined();
    }

    expect(manifestMocks.listOpenClawPluginManifestMetadata).not.toHaveBeenCalled();
    expect(manifestMocks.loadPluginManifest).not.toHaveBeenCalled();
  });

  it("reuses current snapshot rows for runtime-augmentation lookup", () => {
    const cfg = {};
    const plugin = createMistralManifestPlugin();
    setCurrentManifestPlugins([
      { ...plugin, modelCatalog: { ...plugin.modelCatalog, runtimeAugment: true } },
    ]);

    expect(bundledStaticCatalogProviderUsesRuntimeAugment({ provider: "mistral", cfg })).toBe(true);
    expect(bundledStaticCatalogProviderUsesRuntimeAugment({ provider: "mistral", cfg })).toBe(true);
    expect(manifestMocks.listOpenClawPluginManifestMetadata).not.toHaveBeenCalled();
    expect(manifestMocks.loadPluginManifest).not.toHaveBeenCalled();
  });

  it("reuses current snapshot manifests for provider static context warmup", async () => {
    const cfg = { plugins: { entries: { google: { enabled: true } } } };
    const provider = { id: "google", pluginId: "google", label: "Google", auth: [] };
    setCurrentManifestPlugins([
      {
        id: "google",
        origin: "bundled",
        providerDiscoverySource: "/fixtures/google/provider-discovery.ts",
      },
    ]);
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google"]);
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
    providerMocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        models: [{ id: "gemini-3.1-pro-preview", name: "Gemini Pro", contextWindow: 1_048_576 }],
      },
    });

    await expect(loadBundledProviderStaticCatalogContextModels({ cfg })).resolves.toEqual([
      expect.objectContaining({ provider: "google", contextWindow: 1_048_576 }),
    ]);
    expect(manifestMocks.loadPluginManifestRegistryCore).not.toHaveBeenCalled();
  });
});
