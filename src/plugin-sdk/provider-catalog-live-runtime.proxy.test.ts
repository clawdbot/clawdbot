import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("./ssrf-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ssrf-runtime.js")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import {
  buildOpenAICompatibleProviderCatalog,
  fetchLiveProviderModelRows,
} from "./provider-catalog-live-runtime.js";

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
});

describe("live provider catalog proxy policy", () => {
  it("keeps the generic catalog fetch strict by default", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: Response.json({ data: [] }),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    });

    await fetchLiveProviderModelRows({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
    });

    const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(request).toMatchObject({ url: "https://provider.example.test/v1/models" });
    expect(request).not.toHaveProperty("mode");
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    "http://localhost:4000/v1/models",
    "https://127.0.0.1:4000/v1/models",
    "https://[::1]:4000/v1/models",
  ])("keeps operator-local catalog endpoint %s on the strict path", async (endpoint) => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: Response.json({ data: [] }),
      finalUrl: endpoint,
      release,
    });

    await fetchLiveProviderModelRows({ providerId: "litellm", endpoint });

    const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(request).toMatchObject({ url: endpoint });
    expect(request).not.toHaveProperty("mode");
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "canonical HTTPS provider",
      config: {},
      expectedUrl: "https://provider.example.test/v1/models",
      expectedMode: "trusted_env_proxy",
      modelDiscovery: undefined,
    },
    {
      name: "operator override",
      config: {
        models: { providers: { provider: { baseUrl: "https://model.lan:4000", models: [] } } },
      },
      expectedUrl: "https://model.lan:4000/models",
      expectedMode: undefined,
      modelDiscovery: undefined,
    },
    {
      name: "canonical base URL persisted by onboarding",
      config: {
        models: {
          providers: {
            provider: { baseUrl: "https://provider.example.test/v1/", models: [] },
          },
        },
      },
      expectedUrl: "https://provider.example.test/v1/models",
      expectedMode: "trusted_env_proxy",
      modelDiscovery: undefined,
    },
    {
      name: "fixed cleartext catalog endpoint",
      config: {},
      expectedUrl: "http://catalog.example.test/models",
      expectedMode: undefined,
      modelDiscovery: {
        endpointUrl: {
          url: "http://catalog.example.test/models",
          requireBaseUrl: "https://provider.example.test/v1",
        },
      },
    },
  ])(
    "uses endpoint provenance for $name",
    async ({ config, expectedMode, expectedUrl, modelDiscovery }) => {
      const release = vi.fn(async () => undefined);
      fetchWithSsrFGuardMock.mockImplementation(async ({ url }) => ({
        response: Response.json({ data: [] }),
        finalUrl: url,
        release,
      }));

      await buildOpenAICompatibleProviderCatalog({
        ctx: {
          config,
          env: {},
          resolveProviderApiKey: () => ({ apiKey: "test-key" }),
          resolveProviderAuth: () => ({
            apiKey: "test-key",
            mode: "api_key",
            source: "profile",
          }),
        },
        providerId: "provider",
        buildProvider: () => ({
          api: "openai-completions",
          baseUrl: "https://provider.example.test/v1",
          models: [],
        }),
        allowExplicitBaseUrl: true,
        modelDiscovery,
      });

      const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
      expect(request).toMatchObject({ url: expectedUrl });
      if (expectedMode) {
        expect(request).toMatchObject({ mode: expectedMode, requireHttps: true });
      } else {
        expect(request).not.toHaveProperty("mode");
      }
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("does not build a live provider before auth is resolved", async () => {
    const buildProvider = vi.fn(() => ({
      api: "openai-completions" as const,
      baseUrl: "https://provider.example.test/v1",
      models: [],
    }));

    await expect(
      buildOpenAICompatibleProviderCatalog({
        ctx: {
          config: {},
          env: {},
          resolveProviderApiKey: () => ({ apiKey: undefined }),
          resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
        },
        providerId: "provider",
        buildProvider,
      }),
    ).resolves.toBeNull();

    expect(buildProvider).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});
