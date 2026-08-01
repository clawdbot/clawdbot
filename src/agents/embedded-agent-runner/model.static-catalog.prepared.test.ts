import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { getModelProviderMetadataOwners } from "../provider-request-config.js";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistry: vi.fn(),
  normalizePluginDiscoveryResult: vi.fn(),
  resolveBundledProviderCompatPluginIds: vi.fn(),
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderStaticCatalog: vi.fn(),
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: () => undefined,
}));

vi.mock("../../plugins/manifest-metadata-scan.js", () => ({
  listOpenClawPluginManifestMetadata: () => [],
}));

vi.mock("../../plugins/manifest-owner-policy.js", () => ({
  passesManifestOwnerBasePolicy: () => true,
}));

vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: mocks.loadPluginManifestRegistry,
}));

vi.mock("../../plugins/manifest.js", () => ({
  loadPluginManifest: vi.fn(),
}));

vi.mock("../../plugins/providers.js", () => ({
  resolveActivatableProviderOwnerPluginIds: vi.fn(),
  resolveBundledProviderCompatPluginIds: mocks.resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProviderRef: vi.fn(),
}));

vi.mock("../../plugins/provider-discovery.js", () => ({
  normalizePluginDiscoveryResult: mocks.normalizePluginDiscoveryResult,
  resolveRuntimePluginDiscoveryProviders: mocks.resolveRuntimePluginDiscoveryProviders,
  runProviderStaticCatalog: mocks.runProviderStaticCatalog,
}));

import { loadBundledProviderStaticCatalogContextModels } from "./model.static-catalog.js";

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
  return {
    manifestRegistry: {
      diagnostics: [],
      plugins: pluginIds.map((id) => ({
        id,
        origin: "bundled",
        providerDiscoverySource: `/fixtures/${id}/provider-discovery.ts`,
      })),
    },
    owners: {
      providerEndpoints: [],
      providerRequests: new Map(),
    },
  } as unknown as PluginMetadataSnapshot;
}

describe("prepared bundled provider static catalogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google"]);
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "google",
          origin: "bundled",
          providerDiscoverySource: "/fixtures/google/provider-discovery.ts",
        },
      ],
    });
  });

  it("projects prepared rows without rerunning hooks", async () => {
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
    mocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        models: [
          {
            id: "gemini-3.1-pro-preview",
            name: "Gemini Pro",
            contextWindow: 1_048_576,
          },
        ],
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
        contextWindow: 1_048_576,
      }),
    ]);
    expect(getModelProviderMetadataOwners(models[0]!)).toBe(metadataSnapshot.owners);
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
    mocks.loadPluginManifestRegistry.mockReturnValue({
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
