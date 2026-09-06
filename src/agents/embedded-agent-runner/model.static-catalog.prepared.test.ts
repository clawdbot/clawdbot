import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { getModelProviderLocalService } from "../provider-local-service.js";
import {
  getModelProviderRequestRouteFacts,
  getModelProviderRequestTransport,
} from "../provider-request-config.js";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistryCore: vi.fn(),
  normalizePluginDiscoveryResult: vi.fn(),
  resolveActivatableProviderOwnerPluginIds: vi.fn(),
  resolveBundledProviderCompatPluginIds: vi.fn(),
  resolveOwningPluginIdsForProviderRef: vi.fn(),
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderStaticCatalog: vi.fn(),
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => undefined,
  withPluginMetadataSnapshotScope: (_snapshot: unknown, run: () => unknown) => run(),
}));

vi.mock("../../plugins/manifest-metadata-scan.js", () => ({
  listOpenClawPluginManifestMetadata: () => [],
}));

vi.mock("../../plugins/manifest-owner-policy.js", () => ({
  passesManifestOwnerBasePolicy: () => true,
}));

vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: mocks.loadPluginManifestRegistryCore,
}));

vi.mock("../../plugins/manifest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/manifest.js")>()),
  loadPluginManifest: vi.fn(),
}));

vi.mock("../../plugins/providers.js", () => ({
  resolveActivatableProviderOwnerPluginIds: mocks.resolveActivatableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds: mocks.resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProviderRef: mocks.resolveOwningPluginIdsForProviderRef,
}));

vi.mock("../../plugins/provider-discovery.js", () => ({
  normalizePluginDiscoveryResult: mocks.normalizePluginDiscoveryResult,
  resolveRuntimePluginDiscoveryProviders: mocks.resolveRuntimePluginDiscoveryProviders,
  runProviderStaticCatalog: mocks.runProviderStaticCatalog,
}));

import {
  createBundledProviderStaticCatalogContextResolver,
  loadBundledProviderStaticCatalogContextModels,
} from "./model.static-catalog.js";

const cfg = { plugins: { entries: { google: { enabled: true } } } };
const provider = {
  id: "google",
  pluginId: "google",
  label: "Google",
  auth: [],
  staticCatalog: { run: vi.fn() },
};
const unconfiguredProvider = {
  id: "anthropic",
  pluginId: "anthropic",
  label: "Anthropic",
  auth: [],
  staticCatalog: { run: vi.fn() },
};

function createMetadataSnapshot(pluginIds: string[]): PluginMetadataSnapshot {
  const plugins = pluginIds.map((id) => ({
    id,
    origin: "bundled" as const,
    providerDiscoverySource: `/fixtures/${id}/provider-discovery.ts`,
  }));
  return {
    index: {
      plugins: pluginIds.map((pluginId) => ({ pluginId })),
    },
    manifestRegistry: {
      diagnostics: [],
      plugins,
    },
    plugins,
    owners: {
      providerEndpoints: [],
      providerRequests: new Map(),
    },
  } as unknown as PluginMetadataSnapshot;
}

describe("prepared bundled provider static catalogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveActivatableProviderOwnerPluginIds.mockImplementation(
      ({ pluginIds }: { pluginIds: string[] }) => pluginIds,
    );
    mocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google"]);
    mocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(["google"]);
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          id: "google",
          origin: "bundled",
          providerDiscoverySource: "/fixtures/google/provider-discovery.ts",
        },
      ],
    });
  });

  it("keeps provider-scoped lookup on the prepared metadata generation", async () => {
    const metadataSnapshot = createMetadataSnapshot(["google"]);
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
    mocks.runProviderStaticCatalog.mockResolvedValue({ marker: "static-result" });
    mocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        models: [{ id: "gemini-3.1-pro-preview", contextWindow: 1_048_576 }],
      },
    });

    await expect(
      loadBundledProviderStaticCatalogContextModels({
        cfg,
        metadataSnapshot,
        providerIds: ["google"],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "gemini-3.1-pro-preview", provider: "google" }),
    ]);

    expect(mocks.resolveOwningPluginIdsForProviderRef).toHaveBeenCalledWith(
      expect.objectContaining({ metadataSnapshot }),
    );
    expect(mocks.resolveActivatableProviderOwnerPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({
        registry: metadataSnapshot.index,
        manifestRegistry: metadataSnapshot.manifestRegistry,
      }),
    );
    expect(mocks.resolveBundledProviderCompatPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({ manifestRegistry: metadataSnapshot.manifestRegistry }),
    );
    expect(mocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledWith(
      expect.objectContaining({ pluginMetadataSnapshot: metadataSnapshot }),
    );
  });

  it("keeps nested provider ownership on the prepared metadata generation", async () => {
    const metadataSnapshot = createMetadataSnapshot(["shared", "unrelated"]);
    mocks.resolveOwningPluginIdsForProviderRef.mockImplementation(
      ({ provider: providerId }: { provider: string }) =>
        providerId === "outer"
          ? ["shared"]
          : providerId === "nested"
            ? ["shared", "unrelated"]
            : undefined,
    );
    mocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["shared", "unrelated"]);
    mocks.resolveRuntimePluginDiscoveryProviders.mockImplementation(
      async ({ onlyPluginIds }: { onlyPluginIds: string[] }) =>
        onlyPluginIds.map((pluginId) => ({
          id: pluginId,
          pluginId,
          label: pluginId,
          auth: [],
        })),
    );
    mocks.normalizePluginDiscoveryResult.mockImplementation(
      ({ provider: catalogProvider }: { provider: { pluginId: string } }) =>
        catalogProvider.pluginId === "shared"
          ? {
              nested: {
                models: [{ id: "model", contextWindow: 256_000 }],
              },
            }
          : {},
    );

    const resolveContext = createBundledProviderStaticCatalogContextResolver({
      cfg,
      metadataSnapshot,
    });
    await expect(resolveContext({ provider: "outer", modelId: "nested/model" })).resolves.toEqual({
      contextWindow: 256_000,
    });

    expect(mocks.resolveOwningPluginIdsForProviderRef).toHaveBeenCalledTimes(3);
    for (const [params] of mocks.resolveOwningPluginIdsForProviderRef.mock.calls) {
      expect(params).toEqual(expect.objectContaining({ metadataSnapshot }));
    }
    expect(mocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["shared"],
        pluginMetadataSnapshot: metadataSnapshot,
      }),
    );
  });

  it("projects heterogeneous prepared rows without rerunning hooks or resolving empty providers", async () => {
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
    mocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        api: "fixture-api",
        baseUrl: "https://fixture.example/v1",
        authHeader: false,
        maxTokens: 4096,
        request: { headers: { "X-Catalog": "prepared" } },
        localService: { command: "fixture-service" },
        models: [
          {
            id: "gemini-3.1-pro-preview",
            name: "Gemini Pro",
            contextWindow: 1_048_576,
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0.5 },
            maxTokens: 0,
          },
          {
            id: "fallback-model",
            name: "",
            baseUrl: "",
            input: [],
            contextWindow: 0,
            contextTokens: 0,
          },
        ],
      },
      empty: {
        request: {
          headers: { "X-Unused": { source: "env", provider: "default", id: "UNUSED_HEADER" } },
        },
        models: [],
      },
    });

    const metadataSnapshot = createMetadataSnapshot(["google"]);
    const models = await loadBundledProviderStaticCatalogContextModels({
      cfg,
      metadataSnapshot,
      preparedStaticProviderCatalog: {
        entries: [{ provider, result: { marker: "prepared-static-result" } as never }],
      },
    });

    expect(models).toEqual([
      expect.objectContaining({
        id: "gemini-3.1-pro-preview",
        provider: "google",
        api: "fixture-api",
        baseUrl: "https://fixture.example/v1",
        authHeader: false,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0.5 },
        contextWindow: 1_048_576,
        maxTokens: 0,
      }),
      expect.objectContaining({
        id: "fallback-model",
        name: "fallback-model",
        provider: "google",
        api: "fixture-api",
        baseUrl: "",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 0,
        contextTokens: 0,
        maxTokens: 4096,
      }),
    ]);
    for (const model of models) {
      expect(getModelProviderRequestRouteFacts(model)?.providerMetadataOwners).toBe(
        metadataSnapshot.owners,
      );
      expect(getModelProviderRequestTransport(model)).toEqual({
        headers: { "X-Catalog": "prepared" },
      });
      expect(getModelProviderLocalService(model)).toEqual({ command: "fixture-service" });
    }
    expect(mocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledOnce();
    expect(mocks.runProviderStaticCatalog).not.toHaveBeenCalled();
  });

  it("runs hooks omitted from a configured-only prepared catalog on full load", async () => {
    mocks.runProviderStaticCatalog.mockResolvedValue({ marker: "full-static-result" });
    mocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        models: [{ id: "gemini-3.1-pro-preview", contextWindow: 1_048_576 }],
      },
    });

    await expect(
      loadBundledProviderStaticCatalogContextModels({
        cfg,
        metadataSnapshot: createMetadataSnapshot(["google"]),
        preparedStaticProviderCatalog: {
          providers: [provider],
          entries: [],
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "gemini-3.1-pro-preview",
        provider: "google",
      }),
    ]);
    expect(mocks.resolveRuntimePluginDiscoveryProviders).not.toHaveBeenCalled();
    expect(mocks.runProviderStaticCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ provider }),
    );
  });

  it("discovers unconfigured providers when the full catalog is requested", async () => {
    mocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["anthropic", "google"]);
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          id: "anthropic",
          origin: "bundled",
          providerDiscoverySource: "/fixtures/anthropic/provider-discovery.ts",
        },
        {
          id: "google",
          origin: "bundled",
          providerDiscoverySource: "/fixtures/google/provider-discovery.ts",
        },
      ],
    });
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([unconfiguredProvider]);
    mocks.runProviderStaticCatalog.mockResolvedValue({ marker: "unconfigured-static-result" });
    mocks.normalizePluginDiscoveryResult.mockImplementation(
      ({ provider: catalogProvider }: { provider: { id: string } }) => ({
        [catalogProvider.id]: {
          models: [{ id: `${catalogProvider.id}-model`, contextWindow: 128_000 }],
        },
      }),
    );

    await expect(
      loadBundledProviderStaticCatalogContextModels({
        cfg,
        metadataSnapshot: createMetadataSnapshot(["anthropic", "google"]),
        preparedStaticProviderCatalog: {
          providers: [provider],
          entries: [{ provider, result: { marker: "prepared-static-result" } as never }],
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "anthropic-model", provider: "anthropic" }),
      expect.objectContaining({ id: "google-model", provider: "google" }),
    ]);
    expect(mocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledOnce();
    expect(mocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledWith(
      expect.objectContaining({ onlyPluginIds: ["anthropic"] }),
    );
    expect(mocks.runProviderStaticCatalog).toHaveBeenCalledOnce();
    expect(mocks.runProviderStaticCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ provider: unconfiguredProvider }),
    );
  });
});
