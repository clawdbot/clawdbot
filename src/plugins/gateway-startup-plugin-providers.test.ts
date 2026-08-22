import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectConfiguredAgentModelProviderIds } from "./gateway-startup-plugin-providers.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";

function createManifestRecord(
  plugin: Pick<PluginManifestRecord, "id"> & Partial<PluginManifestRecord>,
): PluginManifestRecord {
  return {
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/tmp/plugins/${plugin.id}`,
    source: `/tmp/plugins/${plugin.id}/index.ts`,
    manifestPath: `/tmp/plugins/${plugin.id}/openclaw.plugin.json`,
    ...plugin,
  };
}

function createManifestRegistry(
  plugins: Array<Pick<PluginManifestRecord, "id"> & Partial<PluginManifestRecord>>,
): PluginManifestRegistry {
  return { plugins: plugins.map(createManifestRecord), diagnostics: [] };
}

describe("configured Gateway model provider ownership", () => {
  it("does not inspect model catalogs when no agent model refs are configured", () => {
    const registry = createManifestRegistry([
      {
        id: "unused",
        providers: ["unused"],
        modelCatalog: {
          providers: {
            unused: {
              get models(): never {
                throw new Error("unconfigured catalog was inspected");
              },
            },
          },
        },
      },
    ]);

    expect(collectConfiguredAgentModelProviderIds({}, registry)).toEqual(new Set());
  });

  it("does not normalize unrelated rows in a large catalog", () => {
    let unrelatedNormalizationReads = 0;
    const unrelatedModels = Array.from({ length: 10_000 }, (_, index) => ({
      id: `unrelated-${index}`,
      get name() {
        unrelatedNormalizationReads += 1;
        return `Unrelated ${index}`;
      },
    }));
    const registry = createManifestRegistry([
      {
        id: "selected",
        providers: ["selected"],
        modelCatalog: {
          providers: {
            selected: {
              api: "bedrock-converse-stream",
              models: [{ id: "requested" }, ...unrelatedModels],
            },
          },
        },
      },
      {
        id: "unrelated",
        providers: ["unrelated"],
        modelCatalog: {
          providers: {
            unrelated: { models: unrelatedModels },
          },
        },
      },
    ]);
    const config = {
      agents: { defaults: { model: "selected/requested" } },
    } as OpenClawConfig;

    expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(new Set(["selected"]));
    expect(unrelatedNormalizationReads).toBe(0);
  });
});
