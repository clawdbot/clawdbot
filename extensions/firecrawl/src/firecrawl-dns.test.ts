import { lookup } from "node:dns/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFirecrawlWebFetchProvider } from "../web-fetch-provider.js";
import { createFirecrawlFreeWebSearchProvider } from "../web-search-provider.js";

const unresolvableHost = "openclaw-firecrawl-proof.invalid";

beforeAll(async () => {
  // .invalid must fail in the real resolver before any provider request can be sent.
  await expect(lookup(unresolvableHost, { all: true })).rejects.toMatchObject({
    code: "ENOTFOUND",
  });
});

beforeEach(() => {
  vi.stubEnv("FIRECRAWL_API_KEY", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(["search", "scrape"] as const)("Firecrawl %s DNS diagnostics", (operation) => {
  it.each(["http", "https"])("preserves the real resolver failure for %s", async (scheme) => {
    const baseUrl = `${scheme}://${unresolvableHost}:3002`;
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          firecrawl: { config: { webSearch: { baseUrl }, webFetch: { baseUrl } } },
        },
      },
    };
    const provider =
      operation === "search"
        ? createFirecrawlFreeWebSearchProvider()
        : createFirecrawlWebFetchProvider();
    const tool = provider.createTool({ config });
    if (!tool) {
      throw new Error("Expected Firecrawl provider tool");
    }
    const args =
      operation === "search"
        ? { query: "synthetic DNS proof" }
        : { url: "https://example.com/proof", extractMode: "text" };

    await expect(tool.execute(args)).rejects.toThrow(
      /Unable to resolve Firecrawl baseUrl host: openclaw-firecrawl-proof\.invalid.*ENOTFOUND/,
    );
  });
});
