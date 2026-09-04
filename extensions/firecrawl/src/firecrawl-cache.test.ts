import { createServer, type Server } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFirecrawlFreeWebSearchProvider,
  createFirecrawlWebSearchProvider,
} from "./firecrawl-search-provider.js";
import { createFirecrawlSearchTool } from "./firecrawl-search-tool.js";

describe.each(["keyed", "free", "standalone"] as const)("Firecrawl %s search cache", (kind) => {
  let server: Server;
  let baseUrl: string;
  let networkCalls: number;
  let body: string;

  beforeEach(async () => {
    networkCalls = 0;
    body = "original";
    server = createServer((_request, response) => {
      networkCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          data: [{ url: `https://example.com/${body}`, title: body }],
        }),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a loopback TCP address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });

  async function search(query: string, cacheTtlMinutes: number) {
    const config: OpenClawConfig = {
      tools: { web: { search: { cacheTtlMinutes } } },
      plugins: {
        entries: {
          firecrawl: { config: { webSearch: { baseUrl, apiKey: "firecrawl-cache-test-key" } } },
        },
      },
    };
    if (kind === "standalone") {
      const tool = createFirecrawlSearchTool(createTestPluginApi({ config }));
      return (await tool.execute("cache-test", { query })).details;
    }
    const provider =
      kind === "free" ? createFirecrawlFreeWebSearchProvider() : createFirecrawlWebSearchProvider();
    const tool = provider.createTool({ config, searchConfig: config.tools?.web?.search });
    if (!tool) {
      throw new Error("expected Firecrawl search tool");
    }
    return await tool.execute({ query });
  }

  it.each([0, 15])("bypasses reads and writes after starting with TTL %i", async (initialTtl) => {
    const query = `${kind} cache disable from ${initialTtl}`;
    expect(await search(query, initialTtl)).toMatchObject({
      results: [{ url: "https://example.com/original" }],
    });
    if (initialTtl > 0) {
      expect(await search(query, initialTtl)).toMatchObject({ cached: true });
    }
    expect(networkCalls).toBe(1);

    for (const freshBody of ["fresh", "newest"]) {
      body = freshBody;
      const result = await search(query, 0);
      expect(result).toMatchObject({ results: [{ url: `https://example.com/${freshBody}` }] });
      expect(result).not.toHaveProperty("cached");
    }
    expect(networkCalls).toBe(3);

    // Disabled requests must neither replace an existing entry nor populate an empty cache.
    body = "reenabled";
    expect(await search(query, 15)).toMatchObject({
      results: [{ url: `https://example.com/${initialTtl > 0 ? "original" : "reenabled"}` }],
    });
    expect(networkCalls).toBe(initialTtl > 0 ? 3 : 4);
  });

  it("honors a shorter reader TTL and does not extend the replacement entry's expiry", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const query = `${kind} shorter cache TTL`;
    await search(query, 15);
    now += 59_999;
    expect(await search(query, 1)).toMatchObject({ cached: true });
    expect(networkCalls).toBe(1);

    now += 1;
    body = "fresh";
    const shortened = await search(query, 1);
    expect(shortened).toMatchObject({ results: [{ url: "https://example.com/fresh" }] });
    expect(shortened).not.toHaveProperty("cached");
    expect(networkCalls).toBe(2);

    now += 60_001;
    body = "expired";
    const expired = await search(query, 15);
    expect(expired).toMatchObject({ results: [{ url: "https://example.com/expired" }] });
    expect(expired).not.toHaveProperty("cached");
    expect(networkCalls).toBe(3);
  });
});
