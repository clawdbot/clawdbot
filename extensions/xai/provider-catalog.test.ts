// Xai tests cover provider catalog plugin behavior.
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLiveXaiOAuthProvider, buildXaiProvider } from "./provider-catalog.js";

const GROK_OAUTH_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const GROK_OAUTH_MODELS_ENDPOINT = `${GROK_OAUTH_BASE_URL}/models`;
const GROK_CLIENT_VERSION_HEADERS = { "x-grok-client-version": "0.1.202" };

function mockModelsResponse(body: unknown, status = 200): LiveModelCatalogFetchGuard {
  return vi.fn(async () => ({
    response: Response.json(body, { status }),
    finalUrl: GROK_OAUTH_MODELS_ENDPOINT,
    release: async () => {},
  })) as unknown as LiveModelCatalogFetchGuard;
}

afterEach(() => {
  clearLiveCatalogCacheForTests();
});

describe("xai grok oauth provider catalog", () => {
  it("reports the Grok CLI client version on the OAuth proxy route", async () => {
    const provider = await buildLiveXaiOAuthProvider({
      discoveryApiKey: "oauth-discovery-token",
      fetchGuard: mockModelsResponse({ data: [{ id: "grok-4.3" }] }),
    });

    expect(provider.baseUrl).toBe(GROK_OAUTH_BASE_URL);
    expect(provider.auth).toBe("oauth");
    expect(provider.headers).toEqual(GROK_CLIENT_VERSION_HEADERS);
    expect(provider.models.map((model) => model.id)).toEqual(["grok-4.3"]);
  });

  it("keeps the client version header when live discovery is unavailable", async () => {
    const provider = await buildLiveXaiOAuthProvider({
      discoveryApiKey: "oauth-discovery-token",
      fetchGuard: mockModelsResponse({ error: "unavailable" }, 503),
    });

    expect(provider.baseUrl).toBe(GROK_OAUTH_BASE_URL);
    expect(provider.auth).toBe("oauth");
    expect(provider.headers).toEqual(GROK_CLIENT_VERSION_HEADERS);
    expect(provider.models.length).toBeGreaterThan(0);
  });

  it("withholds the Grok CLI header when an operator overrides the xAI base URL", async () => {
    const provider = await buildLiveXaiOAuthProvider({
      discoveryApiKey: "oauth-discovery-token",
      configuredBaseUrl: "https://grok-proxy.internal.example/v1",
      fetchGuard: mockModelsResponse({ data: [{ id: "grok-4.3" }] }),
    });

    expect(provider.headers).toBeUndefined();
  });

  it("keeps the header when the operator pins the canonical Grok proxy", async () => {
    const provider = await buildLiveXaiOAuthProvider({
      discoveryApiKey: "oauth-discovery-token",
      configuredBaseUrl: `${GROK_OAUTH_BASE_URL}/`,
      fetchGuard: mockModelsResponse({ data: [{ id: "grok-4.3" }] }),
    });

    expect(provider.headers).toEqual(GROK_CLIENT_VERSION_HEADERS);
  });

  it("leaves the API-key xAI route without the Grok CLI header", () => {
    const provider = buildXaiProvider();

    expect(provider.baseUrl).toBe("https://api.x.ai/v1");
    expect(provider.headers).toBeUndefined();
  });
});
