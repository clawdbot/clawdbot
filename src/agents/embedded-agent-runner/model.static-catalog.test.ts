// Coverage for resolving bundled static manifest model catalog rows.
import { beforeEach, describe, expect, it, vi } from "vitest";

const manifestMocks = vi.hoisted(() => ({
  listOpenClawPluginManifestMetadata: vi.fn(),
  loadPluginManifest: vi.fn(),
}));

vi.mock("../../plugins/manifest-metadata-scan.js", () => ({
  listOpenClawPluginManifestMetadata: manifestMocks.listOpenClawPluginManifestMetadata,
}));

vi.mock("../../plugins/manifest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/manifest.js")>()),
  loadPluginManifest: manifestMocks.loadPluginManifest,
}));

import { resolveBundledStaticCatalogModel } from "./model.static-catalog.js";

function setManifestPlugins(plugins: unknown[]) {
  // Static catalog resolution reads scan metadata first, then loads the manifest
  // from disk; the mock preserves that two-step contract.
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

function createMistralManifestPlugin(overrides?: {
  discovery?: "static" | "refreshable" | "runtime";
  origin?: string;
}) {
  // Mistral fixture represents a bundled plugin with a static modelCatalog row.
  return {
    id: "mistral",
    origin: overrides?.origin ?? "bundled",
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
              input: ["text", "image"],
              reasoning: true,
              contextWindow: 262144,
              maxTokens: 8192,
              cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
              mediaInput: {
                image: { maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
              },
            },
          ],
        },
      },
      discovery: {
        mistral: overrides?.discovery ?? "static",
      },
    },
  };
}

beforeEach(() => {
  manifestMocks.listOpenClawPluginManifestMetadata.mockReset();
  manifestMocks.loadPluginManifest.mockReset();
  setManifestPlugins([]);
});

describe("resolveBundledStaticCatalogModel", () => {
  it("synthesizes a runtime model from an exact bundled static manifest catalog row", () => {
    setManifestPlugins([createMistralManifestPlugin()]);

    const model = resolveBundledStaticCatalogModel({
      provider: "mistral",
      modelId: "mistral-medium-3-5",
      cfg: {},
    });

    expect(model).toEqual({
      api: "openai-completions",
      baseUrl: "https://api.mistral.ai/v1",
      compat: undefined,
      contextTokens: undefined,
      contextWindow: 262144,
      cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
      headers: undefined,
      id: "mistral-medium-3-5",
      input: ["text", "image"],
      maxTokens: 8192,
      mediaInput: {
        image: { maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
      },
      name: "Mistral Medium 3.5",
      provider: "mistral",
      reasoning: true,
    });
  });

  it("ignores non-bundled and non-static manifest catalog rows", () => {
    // Workspace plugins and refreshable/runtime catalogs are not process-stable
    // enough for this fallback path.
    for (const plugin of [
      createMistralManifestPlugin({ origin: "workspace" }),
      createMistralManifestPlugin({ discovery: "refreshable" }),
      createMistralManifestPlugin({ discovery: "runtime" }),
    ]) {
      setManifestPlugins([plugin]);

      expect(
        resolveBundledStaticCatalogModel({
          provider: "mistral",
          modelId: "mistral-medium-3-5",
          cfg: {},
        }),
      ).toBeUndefined();
    }
  });

  it("can include bundled runtime-discovery manifest catalog rows for configured fallbacks", () => {
    setManifestPlugins([createMistralManifestPlugin({ discovery: "runtime" })]);

    const model = resolveBundledStaticCatalogModel({
      provider: "mistral",
      modelId: "mistral-medium-3-5",
      cfg: {},
      includeRuntimeDiscovery: true,
    });

    expect(model?.maxTokens).toBe(8192);
  });

  it("requires an exact provider and model match", () => {
    setManifestPlugins([createMistralManifestPlugin()]);

    expect(
      resolveBundledStaticCatalogModel({
        provider: "mistral",
        modelId: "mistral-medium-2508",
        cfg: {},
      }),
    ).toBeUndefined();
    expect(
      resolveBundledStaticCatalogModel({
        provider: "openrouter",
        modelId: "mistral-medium-3-5",
        cfg: {},
      }),
    ).toBeUndefined();
  });
});
