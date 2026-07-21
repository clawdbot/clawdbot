import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveOAuthApiKeyMarker } from "./model-auth-markers.js";
import {
  buildPreparedModelCatalogSnapshot,
  findModelCatalogEntry,
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

const metadataSnapshot = { plugins: [] } as unknown as PluginMetadataSnapshot;

function registry(entries: ModelCatalogEntry[]): ModelRegistry {
  return { getAll: () => entries } as unknown as ModelRegistry;
}

async function build(params: {
  config?: OpenClawConfig;
  entries?: ModelCatalogEntry[];
  readOnly?: boolean;
  includeProviderPluginAugmentation?: boolean;
}) {
  return await buildPreparedModelCatalogSnapshot({
    agentDir: "/tmp/model-catalog-test",
    authCredentials: {},
    config: params.config ?? { plugins: { enabled: false } },
    metadataSnapshot,
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
          input: ["text", "image"],
        },
      ],
    });

    expect(snapshot.entries.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "alpha/a",
      "beta/z",
    ]);
    expect(snapshot.routeVariants).toEqual(snapshot.entries);
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
      input: ["text", "image"],
    });
    expect(snapshot.routeVariants).toHaveLength(2);
  });

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
