import { beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import {
  buildLiveModelProviderConfig,
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";
import type { ModelDefinitionConfig } from "./provider-model-shared.js";

function buildModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

describe("live provider catalog projection", () => {
  beforeEach(() => clearLiveCatalogCacheForTests());

  it("keeps cache admission and fallback shared", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: Response.json({ data: [{ slug: "" }] }),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      })
      .mockResolvedValueOnce({
        response: Response.json({ data: [{ slug: "projected-model" }] }),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      });
    const buildProvider = async () =>
      await buildLiveModelProviderConfig({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://provider.example.test/v1",
        },
        models: [buildModel("fallback-model")],
        fetchGuard,
        ttlMs: 60_000,
        projectRows: (rows) =>
          rows.flatMap((row) => {
            const slug =
              row && typeof row === "object" && "slug" in row && typeof row.slug === "string"
                ? row.slug.trim()
                : "";
            return slug ? [buildModel(slug)] : [];
          }),
      });

    expect((await buildProvider()).models.map((model) => model.id)).toEqual(["fallback-model"]);
    expect((await buildProvider()).models.map((model) => model.id)).toEqual(["projected-model"]);
    expect(fetchGuard).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("caches the anonymous fallback independently after an authenticated 401", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async ({ init }) => ({
      response: new Headers(init?.headers).has("authorization")
        ? new Response("", { status: 401 })
        : Response.json({ data: [{ id: "public-model", object: "model" }] }),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));
    const buildProvider = async () =>
      await buildLiveModelProviderConfig({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://provider.example.test/v1",
        },
        models: [buildModel("fallback-model")],
        apiKey: "runtime-key",
        discoveryApiKey: "rejected-key",
        fetchGuard,
        ttlMs: 60_000,
        fallbackToAnonymousOnUnauthorized: true,
        projectRows: (rows) =>
          rows.flatMap((row) =>
            row && typeof row === "object" && "id" in row && typeof row.id === "string"
              ? [buildModel(row.id)]
              : [],
          ),
      });

    const first = await buildProvider();
    const second = await buildProvider();
    expect(first.apiKey).toBe("runtime-key");
    expect(first.models.map((model) => model.id)).toEqual(["public-model"]);
    expect(second.models.map((model) => model.id)).toEqual(["public-model"]);
    expect(fetchGuard).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
  });
});
