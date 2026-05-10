import { beforeEach, describe, expect, it, vi } from "vitest";

const manifestMocks = vi.hoisted(() => ({
  isManifestPluginAvailableForControlPlane: vi.fn(() => true),
  loadManifestMetadataSnapshot: vi.fn(),
}));

vi.mock("../../plugins/manifest-contract-eligibility.js", () => ({
  isManifestPluginAvailableForControlPlane: manifestMocks.isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot: manifestMocks.loadManifestMetadataSnapshot,
}));

import { resolveBundledStaticCatalogModel } from "./model.static-catalog.js";

function setManifestPlugins(plugins: unknown[]) {
  manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
    index: undefined,
    plugins,
  });
}

function createMistralManifestPlugin(overrides?: {
  discovery?: "static" | "refreshable" | "runtime";
  origin?: string;
}) {
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
  manifestMocks.isManifestPluginAvailableForControlPlane.mockReset();
  manifestMocks.isManifestPluginAvailableForControlPlane.mockReturnValue(true);
  manifestMocks.loadManifestMetadataSnapshot.mockReset();
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
      name: "Mistral Medium 3.5",
      provider: "mistral",
      reasoning: true,
    });
  });

  it("ignores non-bundled and non-static manifest catalog rows", () => {
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
