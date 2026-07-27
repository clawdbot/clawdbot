import type { ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import zaiPlugin from "./index.js";
import {
  ZAI_CN_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_GLOBAL_BASE_URL,
} from "./model-definitions.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

afterEach(() => {
  clearLiveCatalogCacheForTests();
  fetchWithSsrFGuardMock.mockReset();
});

async function runCatalog(baseUrl: string) {
  const provider = await registerSingleProviderPlugin(zaiPlugin);
  await provider.catalog?.run({
    config: { models: { providers: { zai: { baseUrl, models: [] } } } },
    env: {},
    resolveProviderApiKey: () => ({ apiKey: "test-key" }),
    resolveProviderAuth: () => ({ apiKey: "test-key", mode: "api_key", source: "env" }),
  } as ProviderCatalogContext);
}

describe("Z.AI catalog proxy policy", () => {
  it.each([
    ZAI_GLOBAL_BASE_URL,
    ZAI_CN_BASE_URL,
    ZAI_CODING_GLOBAL_BASE_URL,
    ZAI_CODING_CN_BASE_URL,
  ])("uses trusted environment proxies for canonical base %s", async (baseUrl) => {
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }) => ({
      response: Response.json({ data: [] }),
      finalUrl: url,
      release: async () => undefined,
    }));

    await runCatalog(baseUrl);

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "trusted_env_proxy", requireHttps: true }),
    );
  });

  it("keeps custom bases strict", async () => {
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }) => ({
      response: Response.json({ data: [] }),
      finalUrl: url,
      release: async () => undefined,
    }));

    await runCatalog("https://zai.example/v1");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ mode: "trusted_env_proxy" }),
    );
  });
});
