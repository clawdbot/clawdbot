import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveOAuthApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { CHUTES_BASE_URL } from "./models.js";

const CHUTES_OAUTH_MARKER = resolveOAuthApiKeyMarker("chutes");

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function runChutesCatalog(params: { apiKey?: string; discoveryApiKey?: string }) {
  const provider = await registerSingleProviderPlugin(plugin);
  const result = await provider.catalog?.run({
    config: {},
    resolveProviderAuth: () => ({
      apiKey: params.apiKey ?? "",
      discoveryApiKey: params.discoveryApiKey,
    }),
  } as never);
  return result ?? null;
}

async function runChutesCatalogProvider(params: { apiKey: string; discoveryApiKey?: string }) {
  const result = await runChutesCatalog(params);
  if (!result || !("provider" in result)) {
    throw new Error("expected Chutes catalog to return one provider");
  }
  return result.provider;
}

async function withRealChutesDiscovery<T>(
  run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<T>,
) {
  const originalVitest = process.env.VITEST;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFetch = globalThis.fetch;
  delete process.env.VITEST;
  delete process.env.NODE_ENV;

  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ id: "chutes/private-model" }] }),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  try {
    return await run(fetchMock);
  } finally {
    restoreEnvVar("VITEST", originalVitest);
    restoreEnvVar("NODE_ENV", originalNodeEnv);
    globalThis.fetch = originalFetch;
  }
}

describe("chutes implicit provider auth mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes the env vars used by core api-key auto-detection", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.envVars).toEqual(["CHUTES_API_KEY", "CHUTES_OAUTH_TOKEN"]);
  });

  it("does not publish a provider when no API key is resolved", async () => {
    await expect(runChutesCatalog({})).resolves.toBeNull();
  });

  it("keeps api-key resolved Chutes profiles on the API-key loader path", async () => {
    const provider = await runChutesCatalogProvider({ apiKey: "chutes-live-api-key" });

    expect(provider.baseUrl).toBe(CHUTES_BASE_URL);
    expect(provider.apiKey).toBe("chutes-live-api-key");
    expect(provider.apiKey).not.toBe(CHUTES_OAUTH_MARKER);
  });

  it("uses the OAuth marker only for oauth-backed Chutes profiles", async () => {
    const provider = await runChutesCatalogProvider({
      apiKey: CHUTES_OAUTH_MARKER,
      discoveryApiKey: "oauth-access-token",
    });

    expect(provider.baseUrl).toBe(CHUTES_BASE_URL);
    expect(provider.apiKey).toBe(CHUTES_OAUTH_MARKER);
  });

  it("forwards oauth access token to Chutes model discovery", async () => {
    await withRealChutesDiscovery(async (fetchMock) => {
      await runChutesCatalogProvider({
        apiKey: CHUTES_OAUTH_MARKER,
        discoveryApiKey: "my-chutes-access-token",
      });

      const chutesCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("chutes.ai"));
      expect(chutesCalls.length).toBeGreaterThan(0);
      const request = chutesCalls[0]?.[1] as { headers?: Record<string, string> } | undefined;
      expect(request?.headers?.Authorization).toBe("Bearer my-chutes-access-token");
    });
  });
});
