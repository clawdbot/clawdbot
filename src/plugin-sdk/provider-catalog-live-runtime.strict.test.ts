import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import {
  buildLiveModelProviderConfig,
  buildOpenAICompatibleLiveModelProviderConfig,
  buildOpenAICompatibleProviderFamilyCatalog,
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";

const { fetchGuard } = vi.hoisted(() => ({ fetchGuard: vi.fn<LiveModelCatalogFetchGuard>() }));
vi.mock("./ssrf-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ssrf-runtime.js")>()),
  fetchWithSsrFGuard: fetchGuard,
}));

const seed: ModelProviderConfig = {
  baseUrl: "https://catalog.example/v1",
  api: "openai-completions",
  models: [
    {
      id: "known",
      name: "Known",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
  ],
};

afterEach(() => {
  clearLiveCatalogCacheForTests();
  fetchGuard.mockReset();
});

describe("strict catalog acquisition", () => {
  it.each(["ids", "projection", "openai-compatible"] as const)(
    "%s preserves failure, authoritative empty and recovery without seeds",
    async (projection) => {
      const release = vi.fn(async () => {});
      const failure = new Error("catalog transport unavailable");
      fetchGuard
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({
          response: Response.json({ data: [] }),
          finalUrl: `${seed.baseUrl}/models`,
          release,
        })
        .mockResolvedValueOnce({
          response: Response.json({ data: [{ id: "known" }] }),
          finalUrl: `${seed.baseUrl}/models`,
          release,
        });
      const params = {
        discoveryMode: "strict" as const,
        providerId: "demo",
        providerConfig: seed,
        apiKey: "synthetic-key",
        fetchGuard,
      };
      const acquire = () =>
        projection === "openai-compatible"
          ? buildOpenAICompatibleLiveModelProviderConfig(params)
          : buildLiveModelProviderConfig({
              ...params,
              endpoint: `${seed.baseUrl}/models`,
              models: seed.models,
              ...(projection === "projection"
                ? { projectRows: (rows: readonly unknown[]) => (rows.length ? seed.models : []) }
                : {}),
            });
      await expect(acquire()).rejects.toBe(failure);
      await expect(acquire()).resolves.toMatchObject({ models: [] });
      await expect(acquire()).resolves.toMatchObject({ models: seed.models });
      expect(release).toHaveBeenCalledTimes(2);
    },
  );

  it.each([401, 503])(
    "HTTP %s preserves a healthy family sibling and captured auth",
    async (status) => {
      const release = vi.fn(async () => {});
      fetchGuard.mockImplementation(async ({ url, init }) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer resolved-family-key");
        return {
          response: url.includes("unavailable")
            ? Response.json({}, { status })
            : Response.json({ data: [{ id: "known" }] }),
          finalUrl: url,
          release,
        };
      });
      const family = buildOpenAICompatibleProviderFamilyCatalog({
        discoveryMode: "strict",
        credentialProviderId: "family",
        entries: ["unavailable", "healthy"].map((id) => ({
          id,
          label: id,
          baseUrl: `https://${id}.example/v1`,
          models: seed.models,
          buildProvider: () => ({ ...seed, baseUrl: `https://${id}.example/v1` }),
        })),
        staticCatalog: async () => ({ providers: {} }),
        augmentModelCatalog: () => [],
      });
      const resolveProviderApiKey = vi.fn(() => ({
        apiKey: "family:profile",
        discoveryApiKey: "resolved-family-key",
        profileId: "family:profile",
      }));
      const resolveProviderAuth = vi.fn(() => {
        throw new Error("Do not reselect auth");
      });
      await expect(
        family.catalog.run({ config: {}, env: {}, resolveProviderApiKey, resolveProviderAuth }),
      ).resolves.toMatchObject({
        providers: { healthy: { models: seed.models } },
        outcomes: [
          {
            provider: "unavailable",
            profileId: "family:profile",
            status: status === 401 ? "auth-rejected" : "unavailable",
            ...(status === 401 ? { rejectionScope: "catalog" } : {}),
          },
          { provider: "healthy", profileId: "family:profile", status: "ready" },
        ],
      });
      expect(resolveProviderApiKey).toHaveBeenCalledOnce();
      expect(resolveProviderAuth).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(2);
    },
  );
});
