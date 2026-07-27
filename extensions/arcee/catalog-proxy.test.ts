import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import arceePlugin from "./index.js";

afterEach(() => {
  clearLiveCatalogCacheForTests();
  fetchWithSsrFGuardMock.mockReset();
});

describe("Arcee catalog proxy policy", () => {
  it("uses trusted environment proxies for its fixed vendor catalog", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }) => ({
      response: Response.json({ data: [] }),
      finalUrl: url,
      release,
    }));

    const provider = await registerSingleProviderPlugin(arceePlugin);
    await runSingleProviderCatalog(provider, {
      resolveProviderApiKey: (id?: string) =>
        id === "arcee" ? { apiKey: "test-key" } : { apiKey: undefined },
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "trusted_env_proxy", requireHttps: true }),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
