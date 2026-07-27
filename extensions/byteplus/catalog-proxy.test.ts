import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import plugin from "./index.js";

afterEach(() => {
  clearLiveCatalogCacheForTests();
  fetchWithSsrFGuardMock.mockReset();
});

describe("BytePlus catalog proxy policy", () => {
  it("uses trusted environment proxies for both fixed vendor catalogs", async () => {
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }) => {
      const release = vi.fn(async () => undefined);
      releases.push(release);
      return { response: Response.json({ data: [] }), finalUrl: url, release };
    });

    const provider = await registerSingleProviderPlugin(plugin);
    await provider.catalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      resolveProviderAuth: () => ({ apiKey: "test-key", mode: "api_key", source: "env" }),
    } as never);

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    for (const [request] of fetchWithSsrFGuardMock.mock.calls) {
      expect(request).toMatchObject({ mode: "trusted_env_proxy", requireHttps: true });
    }
    expect(releases).toHaveLength(2);
    for (const release of releases) {
      expect(release).toHaveBeenCalledOnce();
    }
  });
});
