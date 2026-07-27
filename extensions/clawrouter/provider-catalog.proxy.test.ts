import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { buildClawRouterProviderConfig } from "./provider-catalog.js";

afterEach(() => {
  clearLiveCatalogCacheForTests();
  fetchWithSsrFGuardMock.mockReset();
});

describe("ClawRouter catalog proxy policy", () => {
  it.each([
    { baseUrl: undefined, expectedMode: "trusted_env_proxy" },
    { baseUrl: "https://clawrouter.openclaw.ai", expectedMode: "trusted_env_proxy" },
    { baseUrl: "https://clawrouter.openclaw.ai/v1/", expectedMode: "trusted_env_proxy" },
    { baseUrl: "https://clawrouter.example/v1", expectedMode: undefined },
  ])("uses endpoint provenance for baseUrl=$baseUrl", async ({ baseUrl, expectedMode }) => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }) => ({
      response: Response.json({ providers: [] }),
      finalUrl: url,
      release,
    }));

    await buildClawRouterProviderConfig({
      apiKey: "test-key",
      discoveryApiKey: "test-key",
      ...(baseUrl ? { baseUrl } : {}),
    });

    const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    if (expectedMode) {
      expect(request).toMatchObject({ mode: expectedMode, requireHttps: true });
    } else {
      expect(request).not.toHaveProperty("mode");
    }
    expect(release).toHaveBeenCalledOnce();
  });
});
