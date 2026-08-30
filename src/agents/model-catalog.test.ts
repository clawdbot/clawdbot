import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveOAuthApiKeyMarker } from "./model-auth-markers.js";
import {
  buildPreparedModelCatalogSnapshot,
  findModelCatalogEntry,
  loadManifestModelCatalog,
  modelSupportsDocument,
  modelSupportsVision,
} from "./model-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import type { ModelRegistry } from "./sessions/index.js";

type AugmentModelCatalogWithProviderPlugins =
  typeof import("../plugins/provider-runtime.js").augmentModelCatalogWithProviderPlugins;

const mocks = vi.hoisted(() => ({
  augmentModelCatalogWithProviderPlugins: vi.fn<AugmentModelCatalogWithProviderPlugins>(
    async () => [],
  ),
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  augmentModelCatalogWithProviderPlugins: (
    ...args: Parameters<AugmentModelCatalogWithProviderPlugins>
  ) => mocks.augmentModelCatalogWithProviderPlugins(...args),
}));

const metadataSnapshot = {
  plugins: [],
  manifestRegistry: { plugins: [] },
} as unknown as PluginMetadataSnapshot;

function providerManifestSnapshot(params: {
  provider: string;
  discovery: "static" | "refreshable" | "runtime";
  modelIds: string[];
  aliases?: string[];
  modelIdAliases?: Record<string, string>;
}): PluginMetadataSnapshot {
  const plugin = {
    id: params.provider,
    origin: "bundled",
    providers: [params.provider],
    ...(params.modelIdAliases
      ? {
          modelIdNormalization: {
            providers: { [params.provider]: { aliases: params.modelIdAliases } },
          },
        }
      : {}),
    modelCatalog: {
      aliases: Object.fromEntries(
        (params.aliases ?? []).map((alias) => [alias, { provider: params.provider }]),
      ),
      providers: {
        [params.provider]: {
          api: "openai-responses",
          models: params.modelIds.map((id) => ({ id, name: id })),
        },
      },
      discovery: { [params.provider]: params.discovery },
    },
  };
  return {
    plugins: [plugin],
    manifestRegistry: { plugins: [plugin] },
  } as unknown as PluginMetadataSnapshot;
}

function registry(entries: ModelCatalogEntry[]): ModelRegistry {
  return { getAll: () => entries } as unknown as ModelRegistry;
}

async function build(params: {
  config?: OpenClawConfig;
  entries?: ModelCatalogEntry[];
  metadataSnapshot?: PluginMetadataSnapshot;
  readOnly?: boolean;
  includeProviderPluginAugmentation?: boolean;
}) {
  return await buildPreparedModelCatalogSnapshot({
    agentDir: "/tmp/model-catalog-test",
    authCredentials: {},
    config: params.config ?? { plugins: { enabled: false } },
    metadataSnapshot: params.metadataSnapshot ?? metadataSnapshot,
    modelRegistry: registry(params.entries ?? []),
    readOnly: params.readOnly ?? true,
    ...(params.includeProviderPluginAugmentation !== undefined
      ? { includeProviderPluginAugmentation: params.includeProviderPluginAugmentation }
      : {}),
  });
}

describe("prepared model catalog builder", () => {
  beforeEach(() => {
    mocks.augmentModelCatalogWithProviderPlugins.mockReset();
    mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValue([]);
  });

  it("projects and sorts one lifecycle registry generation", async () => {
    const snapshot = await build({
      entries: [
        { id: "z", name: "Zulu", provider: "beta", input: ["text"] },
        {
          id: "a",
          name: "Alpha",
          provider: "alpha",
          contextWindow: 64_000,
          thinkingLevelMap: { off: null, max: "max" },
          input: ["text", "image"],
        },
      ],
    });

    expect(snapshot.entries.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "alpha/a",
      "beta/z",
    ]);
    expect(snapshot.entries[0]?.thinkingLevelMap).toEqual({ off: null, max: "max" });
    expect(snapshot.routeVariants).toEqual(snapshot.entries);
  });

  it("keeps unranked registry rows in deterministic model-id order", async () => {
    const snapshot = await build({
      entries: [
        { id: "model-b", name: "Model B", provider: "demo" },
        { id: "model-a", name: "Model A", provider: "demo" },
      ],
    });

    expect(snapshot.entries.map((entry) => entry.id)).toEqual(["model-a", "model-b"]);
    expect(snapshot.entries.every((entry) => entry.providerOrder === undefined)).toBe(true);
  });

  it.each(["registry", "configured"])(
    "preserves distinct model namespaces from %s rows through catalog publication",
    async (source) => {
      const entries = [
        { provider: "fixture", id: "model", name: "Plain", contextWindow: 8_000 },
        { provider: "fixture", id: "fixture/model", name: "Namespaced", contextWindow: 16_000 },
      ];
      const config: OpenClawConfig = {
        plugins: { enabled: false },
        models: {
          providers: {
            fixture: {
              api: "openai-responses",
              baseUrl: "https://models.example.test/v1",
              models: entries.map(({ id, name, contextWindow }) => ({
                id,
                name,
                contextWindow,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 1_024,
              })),
            },
          },
        },
      };
      const snapshot = await build(source === "configured" ? { config } : { entries });

      for (const rows of [snapshot.entries, snapshot.routeVariants]) {
        expect(
          rows
            .map(({ id, contextWindow }) => ({ id, contextWindow }))
            .toSorted((left, right) => left.id.localeCompare(right.id)),
        ).toEqual([
          { id: "fixture/model", contextWindow: 16_000 },
          { id: "model", contextWindow: 8_000 },
        ]);
      }
    },
  );

  it("keeps account-denied runtime models out of the prepared catalog", async () => {
    const config: OpenClawConfig = { plugins: { enabled: false } };
    const runtimeManifest = providerManifestSnapshot({
      provider: "openai",
      discovery: "runtime",
      modelIds: ["gpt-5.5", "gpt-5.6"],
    });

    const declaredManifestModels = loadManifestModelCatalog({
      config,
      metadataSnapshot: runtimeManifest,
    });
    expect(declaredManifestModels.map((entry) => entry.id)).toEqual(["gpt-5.5", "gpt-5.6"]);

    const snapshot = await build({ config, metadataSnapshot: runtimeManifest });

    expect(snapshot.entries).toEqual([]);
    expect(snapshot.routeVariants).toEqual([]);
    expect(loadManifestModelCatalog({ config, metadataSnapshot: runtimeManifest })).toBe(
      declaredManifestModels,
    );
  });

  it("carries manifest capability metadata into the prepared catalog", async () => {
    const plugin = {
      id: "anthropic",
      origin: "bundled",
      providers: ["anthropic"],
      modelCatalog: {
        providers: {
          anthropic: {
            models: [
              {
                id: "claude-fable-5",
                contextWindow: 1_000_000,
                contextWindows: [
                  { id: "200k", label: "200K", contextWindow: 200_000 },
                  { id: "1m", label: "1M", contextWindow: 1_000_000 },
                ],
                contextWindowDefault: "1m",
                thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
                input: ["text", "image"],
                mediaInput: { image: { maxBytes: 4096, tokenMode: "tile" } },
              },
            ],
          },
        },
        discovery: { anthropic: "refreshable" },
      },
    };
    const snapshot = {
      plugins: [plugin],
      manifestRegistry: { plugins: [plugin] },
    } as unknown as PluginMetadataSnapshot;

    expect(
      loadManifestModelCatalog({ config: {}, metadataSnapshot: snapshot }).find(
        (entry) => entry.id === "claude-fable-5",
      ),
    ).toMatchObject({
      contextWindows: [
        { id: "200k", label: "200K", contextWindow: 200_000 },
        { id: "1m", label: "1M", contextWindow: 1_000_000 },
      ],
      contextWindowDefault: "1m",
      thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      input: ["text", "image"],
      mediaInput: { image: { maxBytes: 4096, tokenMode: "tile" } },
    });
  });

  it("drops a base context-window default when an overlay replaces the options list", async () => {
    const plugin = {
      id: "anthropic",
      origin: "bundled",
      providers: ["anthropic"],
      modelCatalog: {
        providers: {
          anthropic: {
            models: [
              {
                id: "claude-fable-5",
                contextWindow: 1_000_000,
                contextWindows: [
                  { id: "200k", label: "200K", contextWindow: 200_000 },
                  { id: "1m", label: "1M", contextWindow: 1_000_000 },
                ],
                contextWindowDefault: "1m",
              },
            ],
          },
        },
        discovery: { anthropic: "refreshable" },
      },
    };
    // Live provider discovery overlays the manifest row but replaces the
    // options list without restating a default.
    mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValueOnce([
      {
        id: "claude-fable-5",
        name: "Claude Fable 5",
        provider: "anthropic",
        contextWindow: 200_000,
        contextWindows: [{ id: "200k", label: "200K", contextWindow: 200_000 }],
      },
    ]);
    const snapshot = await build({
      metadataSnapshot: {
        plugins: [plugin],
        manifestRegistry: { plugins: [plugin] },
      } as unknown as PluginMetadataSnapshot,
      entries: [{ id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic" }],
      readOnly: false,
    });

    const merged = findModelCatalogEntry(snapshot.entries, {
      provider: "anthropic",
      modelId: "claude-fable-5",
    });
    // Options + default are one normalized unit: the overlay owns both, so the
    // base "1m" default absent from the replacement list must not leak through.
    expect(merged?.contextWindows).toEqual([{ id: "200k", label: "200K", contextWindow: 200_000 }]);
    expect(merged?.contextWindowDefault).toBeUndefined();
  });

  it("keeps an account's runtime-discovered model list authoritative", async () => {
    const snapshot = await build({
      entries: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
      metadataSnapshot: providerManifestSnapshot({
        provider: "openai",
        discovery: "runtime",
        modelIds: ["gpt-5.5", "gpt-5.6"],
      }),
    });

    expect(snapshot.entries.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "openai/gpt-5.5",
    ]);
    expect(snapshot.routeVariants.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "openai/gpt-5.5",
    ]);
  });

  it("keeps account visibility on the model normalized at discovery", async () => {
    const entry = {
      provider: "fixture",
      id: "legacy",
      name: "Account model",
      contextWindow: 8_000,
    };
    mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValueOnce([
      { ...entry, contextWindow: 16_000 },
    ]);
    const snapshot = await build({
      entries: [entry],
      metadataSnapshot: providerManifestSnapshot({
        provider: "fixture",
        discovery: "runtime",
        modelIds: ["legacy"],
        modelIdAliases: { legacy: "current", current: "other" },
      }),
      readOnly: false,
    });

    expect(snapshot.entries).toEqual([
      expect.objectContaining({ provider: "fixture", id: "current", contextWindow: 16_000 }),
    ]);
  });

  it("ranks runtime registry rows from the manifest without augmentation", async () => {
    const snapshot = await build({
      entries: [
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
      ],
      metadataSnapshot: providerManifestSnapshot({
        provider: "openai",
        discovery: "runtime",
        modelIds: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4"],
      }),
      includeProviderPluginAugmentation: false,
    });

    expect(snapshot.entries.map((entry) => entry.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.4",
    ]);
  });

  it("canonicalizes manifest-owned provider aliases in registry rows", async () => {
    const snapshot = await build({
      entries: [
        { id: "kimi-k3", name: "Kimi K3", provider: "moonshotai" },
        { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", provider: "moonshot-ai" },
      ],
      metadataSnapshot: providerManifestSnapshot({
        provider: "moonshot",
        aliases: ["moonshotai", "moonshot-ai"],
        discovery: "static",
        modelIds: ["kimi-k3", "kimi-k2.7-code"],
      }),
    });

    expect(snapshot.entries.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "moonshot/kimi-k3",
      "moonshot/kimi-k2.7-code",
    ]);
  });

  it("does not augment an account with undiscovered runtime-provider models", async () => {
    mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValueOnce([
      { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
      { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", contextWindow: 128_000 },
    ]);

    const snapshot = await build({
      entries: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
      metadataSnapshot: providerManifestSnapshot({
        provider: "openai",
        discovery: "runtime",
        modelIds: ["gpt-5.5", "gpt-5.6"],
      }),
      readOnly: false,
    });

    expect(mocks.augmentModelCatalogWithProviderPlugins).toHaveBeenCalledOnce();
    expect(snapshot.entries.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "openai/gpt-5.5",
    ]);
    expect(snapshot.entries[0]?.contextWindow).toBe(128_000);
    expect(snapshot.routeVariants.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "openai/gpt-5.5",
    ]);
  });

  it("keeps provider-owned strongest-first order after runtime augmentation", async () => {
    mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValueOnce([
      { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
    ]);

    const snapshot = await build({
      entries: [
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
      ],
      metadataSnapshot: providerManifestSnapshot({
        provider: "openai",
        discovery: "runtime",
        modelIds: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4"],
      }),
      readOnly: false,
    });

    expect(snapshot.entries.map((entry) => entry.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.4",
    ]);
  });

  it("keeps manifest rank for configured runtime models absent from the registry", async () => {
    mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValueOnce([
      { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
    ]);

    const snapshot = await build({
      config: {
        plugins: { enabled: false },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-5.6-sol",
                  name: "Configured GPT-5.6 Sol",
                  contextWindow: 1_050_000,
                  maxTokens: 128_000,
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      },
      entries: [{ id: "gpt-5.4", name: "GPT-5.4", provider: "openai" }],
      metadataSnapshot: providerManifestSnapshot({
        provider: "openai",
        discovery: "runtime",
        modelIds: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4"],
      }),
      readOnly: false,
    });

    expect(snapshot.entries.map((entry) => entry.id)).toEqual(["gpt-5.6-sol", "gpt-5.4"]);
  });

  it("preserves explicitly configured runtime-provider models", async () => {
    mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValueOnce([
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://catalog.openai.example.test/v1",
        contextWindow: 256_000,
        compat: { supportsTools: false },
      },
    ]);

    const snapshot = await build({
      config: {
        plugins: { enabled: false },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-5.4",
                  name: "Configured GPT-5.4",
                  contextWindow: 128_000,
                  maxTokens: 4_096,
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      },
      entries: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
      metadataSnapshot: providerManifestSnapshot({
        provider: "openai",
        discovery: "runtime",
        modelIds: ["gpt-5.5", "gpt-5.6"],
      }),
      readOnly: false,
    });

    expect(snapshot.entries.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.4",
    ]);
    expect(snapshot.routeVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openai",
          id: "gpt-5.4",
          api: "openai-responses",
          baseUrl: "https://catalog.openai.example.test/v1",
          contextWindow: 256_000,
          compat: { supportsTools: false },
        }),
        expect.objectContaining({
          provider: "openai",
          id: "gpt-5.4",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        }),
      ]),
    );
  });

  it.each(["static", "refreshable"] as const)(
    "keeps %s manifest models available without runtime account discovery",
    async (discovery) => {
      const snapshot = await build({
        metadataSnapshot: providerManifestSnapshot({
          provider: "manifest-provider",
          discovery,
          modelIds: ["manifest-model"],
        }),
      });

      expect(snapshot.entries).toMatchObject([
        { provider: "manifest-provider", id: "manifest-model" },
      ]);
    },
  );

  it("preserves augmentation for providers without runtime account discovery", async () => {
    mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValueOnce([
      { id: "synthetic-model", name: "Synthetic model", provider: "manifest-provider" },
    ]);

    const snapshot = await build({
      metadataSnapshot: providerManifestSnapshot({
        provider: "manifest-provider",
        discovery: "static",
        modelIds: ["manifest-model"],
      }),
      readOnly: false,
    });

    expect(snapshot.entries.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "manifest-provider/manifest-model",
      "manifest-provider/synthetic-model",
    ]);
  });

  it("overlays configured metadata onto discovered rows", async () => {
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      models: {
        providers: {
          custom: {
            baseUrl: "https://example.test/v1",
            api: "openai-completions",
            models: [
              {
                id: "demo",
                name: "Configured Demo",
                contextWindow: 32_000,
                maxTokens: 4_096,
                reasoning: true,
                thinkingLevelMap: { off: null, xhigh: "xhigh" },
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    const snapshot = await build({
      config,
      entries: [
        {
          id: "demo",
          name: "Discovered Demo",
          provider: "custom",
          input: ["text"],
        },
      ],
    });

    expect(
      findModelCatalogEntry(snapshot.entries, { provider: "custom", modelId: "demo" }),
    ).toMatchObject({
      name: "Discovered Demo",
      api: "openai-completions",
      contextWindow: 32_000,
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: "xhigh" },
      input: ["text", "image"],
    });
    expect(snapshot.routeVariants).toHaveLength(2);
  });

  it.each([false, true])(
    "keeps the first matching catalog route with borrowed-row retargeting %s",
    async (retarget) => {
      mocks.augmentModelCatalogWithProviderPlugins.mockImplementationOnce(async ({ context }) => {
        const first = context.entries[0];
        if (retarget && first) {
          first.id = "demo";
        }
        return [
          {
            id: "demo",
            name: "Route B",
            provider: "custom",
            api: "openai-completions",
            baseUrl: "https://route-b.example.test/v1",
            thinkingLevelMap: { xhigh: "xhigh", max: "max" },
            compat: { supportsTools: false },
          },
        ];
      });
      const snapshot = await build({
        config: {
          plugins: { enabled: false },
          models: {
            providers: {
              custom: {
                api: "openai-responses",
                baseUrl: "https://route-a.example.test/v1",
                models: [
                  {
                    id: "demo",
                    name: "Configured Demo",
                    contextWindow: 32_000,
                    maxTokens: 4_096,
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
        },
        entries: [
          ...(retarget
            ? [
                {
                  id: "spare",
                  name: "Earlier Route A",
                  provider: "custom",
                  api: "openai-responses",
                  baseUrl: "https://route-a.example.test/v1",
                  thinkingLevelMap: { xhigh: "high", max: "max" },
                  compat: { supportsTools: false },
                } satisfies ModelCatalogEntry,
              ]
            : []),
          {
            id: "demo",
            name: "Route A",
            provider: "custom",
            api: "openai-responses",
            baseUrl: "https://route-a.example.test/v1",
            thinkingLevelMap: { xhigh: null, max: null },
            compat: { supportsTools: true },
          },
        ],
        readOnly: false,
      });

      const selectedRoute = {
        api: "openai-responses",
        baseUrl: "https://route-a.example.test/v1",
        thinkingLevelMap: retarget ? { xhigh: "high", max: "max" } : { xhigh: null, max: null },
        compat: { supportsTools: !retarget },
      };
      expect(
        snapshot.entries.filter((entry) => entry.provider === "custom" && entry.id === "demo"),
      ).toEqual(
        Array.from({ length: retarget ? 2 : 1 }, () => expect.objectContaining(selectedRoute)),
      );
      expect(
        snapshot.routeVariants.filter(
          (entry) => entry.id === "demo" && entry.api === "openai-responses",
        ),
      ).toHaveLength(retarget ? 2 : 1);
    },
  );

  it("keeps configured models absent from registry discovery", async () => {
    const snapshot = await build({
      config: {
        plugins: { enabled: false },
        models: {
          providers: {
            custom: {
              baseUrl: "https://example.test/v1",
              api: "openai-completions",
              models: [
                {
                  id: "configured-only",
                  name: "Configured Only",
                  contextWindow: 8_192,
                  maxTokens: 1_024,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      },
    });

    expect(snapshot.entries.map((entry) => entry.id)).toEqual(["configured-only"]);
  });

  it("rejects the whole generation when catalog projection fails after a valid row", async () => {
    const projectionError = new Error("catalog projection failed");
    const brokenEntry = {
      id: "broken",
      get provider() {
        throw projectionError;
      },
    } as unknown as ModelCatalogEntry;

    await expect(
      buildPreparedModelCatalogSnapshot({
        agentDir: "/tmp/model-catalog-test",
        authCredentials: {},
        config: { plugins: { enabled: false } },
        metadataSnapshot,
        modelRegistry: registry([{ id: "valid", name: "Valid", provider: "test" }, brokenEntry]),
        readOnly: true,
      }),
    ).rejects.toBe(projectionError);
  });

  it("keeps static publication off provider runtime catalog augmentation", async () => {
    const snapshot = await build({
      config: {
        plugins: { enabled: false },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-responses",
              models: [],
            },
          },
        },
      },
      entries: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
      readOnly: false,
      includeProviderPluginAugmentation: false,
    });

    expect(snapshot.entries).toEqual([
      expect.objectContaining({ id: "gpt-5.5", provider: "openai" }),
    ]);
    expect(mocks.augmentModelCatalogWithProviderPlugins).not.toHaveBeenCalled();
  });

  it("uses the lifecycle auth snapshot for provider catalog augmentation", async () => {
    let resolvedKey: string | undefined;
    let resolvedOAuth: string | undefined;
    mocks.augmentModelCatalogWithProviderPlugins.mockImplementationOnce(async ({ context }) => {
      if (!context.resolveProviderApiKey) {
        throw new Error("expected lifecycle auth resolver");
      }
      resolvedKey = context.resolveProviderApiKey("inherited").apiKey;
      resolvedOAuth = context.resolveProviderApiKey("subscription").apiKey;
      return [];
    });

    await buildPreparedModelCatalogSnapshot({
      agentDir: "/tmp/model-catalog-test",
      authCredentials: {
        inherited: { type: "api_key", key: "test-api-key" },
        subscription: {
          type: "oauth",
          access: "test-access",
          refresh: "test-refresh",
          expires: Date.now() + 60_000,
        },
      },
      config: { plugins: { enabled: false } },
      metadataSnapshot,
      modelRegistry: registry([]),
    });

    expect(resolvedKey).toBe("test-api-key");
    expect(resolvedOAuth).toBe(resolveOAuthApiKeyMarker("subscription"));
    expect(mocks.augmentModelCatalogWithProviderPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ metadataSnapshot }),
    );
  });

  it("reports media capabilities from the prepared row", () => {
    const entry: ModelCatalogEntry = {
      id: "media",
      name: "Media",
      provider: "test",
      input: ["text", "image", "document"],
    };
    expect(modelSupportsVision(entry)).toBe(true);
    expect(modelSupportsDocument(entry)).toBe(true);
  });
});
