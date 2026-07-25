// Anthropic tests cover live model discovery request auth.
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicProvider } from "./register.runtime.js";

const guardedFetchCalls = vi.hoisted(
  () =>
    [] as Array<
      Parameters<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>[0]
    >,
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      guardedFetchCalls.push(params);
      return Promise.resolve({
        response: new Response(JSON.stringify({ data: [] })),
        finalUrl: "https://api.anthropic.com/v1/models",
        release: async () => undefined,
      });
    },
  };
});

function buildCatalogContext(apiKey: string): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey }),
  } as unknown as ProviderCatalogContext;
}

async function readDiscoveryHeaders(apiKey: string): Promise<Headers> {
  const provider = buildAnthropicProvider();
  await provider.catalog?.run?.(buildCatalogContext(apiKey));
  const request = guardedFetchCalls.at(-1);
  expect(request).toBeDefined();
  return new Headers(request?.init?.headers);
}

describe("anthropic live model discovery auth", () => {
  beforeEach(() => {
    guardedFetchCalls.length = 0;
    clearLiveCatalogCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends an API key as x-api-key", async () => {
    const headers = await readDiscoveryHeaders("sk-ant-api03-test-key");
    expect(headers.get("x-api-key")).toBe("sk-ant-api03-test-key");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("sends a subscription OAuth token as a bearer credential", async () => {
    const headers = await readDiscoveryHeaders("sk-ant-oat01-test-token");
    expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-test-token");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("never pairs an OAuth bearer credential with x-api-key", async () => {
    // Anthropic rejects the request outright when both auth headers are present,
    // so the OAuth branch must replace x-api-key rather than add to it.
    const headers = await readDiscoveryHeaders("sk-ant-oat01-test-token");
    expect(headers.get("x-api-key")).toBeNull();
  });
});
