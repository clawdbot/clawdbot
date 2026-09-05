import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  PluginManifestRecord,
  PluginManifestRegistry,
} from "../../plugins/manifest-registry.types.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { inspectConfiguredModelReferences } from "./model-reference-validation.js";

/**
 * Minimal snapshot factory: builds a PluginMetadataSnapshot from a manifest
 * registry so inspectConfiguredModelReferences exercises the real planner +
 * inspection path (not a mock).
 */
function createSnapshotFromRegistry(
  registry: PluginManifestRegistry,
  providerOwners: Record<string, string[]>,
): PluginMetadataSnapshot {
  const providers = new Map(Object.entries(providerOwners));
  return {
    policyHash: "test",
    index: { plugins: [] } as never,
    registryIndex: { plugins: [] } as never,
    registryDiagnostics: [],
    manifestRegistry: registry,
    plugins: registry.plugins,
    diagnostics: [],
    byPluginId: new Map(registry.plugins.map((p) => [p.id, p])),
    normalizePluginId: (id: string) => id,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers,
      modelCatalogProviders: providers,
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
      indexPluginCount: registry.plugins.length,
      manifestPluginCount: registry.plugins.length,
    },
  };
}

/**
 * Mirrors the Google plugin manifest after the fix (with modelCatalog.providers.google.models).
 * The discovery is "runtime", but static models are declared so the doctor
 * known-set includes them without a live discovery call.
 */
const googleManifest = {
  id: "google",
  providers: ["google"],
  modelCatalog: {
    discovery: { google: "runtime" },
    providers: {
      google: {
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        models: [
          { id: "gemini-2.5-pro" },
          { id: "gemini-2.5-flash" },
          { id: "gemini-2.5-flash-lite" },
          { id: "gemini-3.5-flash" },
          { id: "gemini-3.6-flash" },
          { id: "gemini-3.7-flash" },
          { id: "gemini-3.5-flash-lite" },
          { id: "gemini-3.1-pro-preview" },
          { id: "gemini-3.1-flash-lite" },
          { id: "gemini-3-flash-preview" },
        ],
      },
    },
  },
} as unknown as PluginManifestRecord;

const googleRegistry: PluginManifestRegistry = {
  plugins: [googleManifest],
  diagnostics: [],
};

describe("inspectConfiguredModelReferences — Google doctor known-set", () => {
  it("classifies a configured Google model as known after the manifest fix", () => {
    const snapshot = createSnapshotFromRegistry(googleRegistry, { google: ["google"] });
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "google/gemini-2.5-pro" },
        },
      },
    } as unknown as OpenClawConfig;

    const inspections = inspectConfiguredModelReferences({
      cfg,
      metadataSnapshot: snapshot,
    });

    const googleRef = inspections.find((i) => i.ref === "google/gemini-2.5-pro");
    expect(googleRef).toBeDefined();
    expect(googleRef?.status).toBe("known");
    expect(googleRef?.active).toBe(true);
  });

  it("still flags an unknown Google model id as unknown-model", () => {
    const snapshot = createSnapshotFromRegistry(googleRegistry, { google: ["google"] });
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "google/gemini-99-nonexistent" },
        },
      },
    } as unknown as OpenClawConfig;

    const inspections = inspectConfiguredModelReferences({
      cfg,
      metadataSnapshot: snapshot,
    });

    const unknownRef = inspections.find((i) => i.ref === "google/gemini-99-nonexistent");
    expect(unknownRef).toBeDefined();
    expect(unknownRef?.status).toBe("unknown-model");
  });
});
