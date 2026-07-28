// Firecrawl scrape-cache tests cover cache reuse across case-equivalent URL spellings,
// driven over a real loopback HTTP transport so the upstream request count is observed.
import { createServer, type Server } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runFirecrawlScrape, testing } from "./firecrawl-client.js";

const servers = new Set<Server>();

type ScrapePayload = {
  success: true;
  data: { markdown: string; metadata: Record<string, unknown> };
};

async function listen(server: Server): Promise<string> {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP listener address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/** Serves one fixed scrape payload and reports how many upstream requests arrived. */
async function startScrapeServer(payload: ScrapePayload): Promise<{
  baseUrl: string;
  requestCount: () => number;
}> {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  const baseUrl = await listen(server);
  return { baseUrl, requestCount: () => requests };
}

function configFor(baseUrl: string): OpenClawConfig {
  return {
    plugins: {
      entries: {
        firecrawl: { config: { webFetch: { apiKey: "test-firecrawl-key", baseUrl } } },
      },
    },
  } as unknown as OpenClawConfig;
}

afterEach(async () => {
  testing.SCRAPE_CACHE.clear();
  await Promise.all([...servers].map(closeServer));
  servers.clear();
});

describe("firecrawl scrape cache across case-equivalent URLs", () => {
  it("serves one upstream fetch to both spellings while echoing each caller's own URL", async () => {
    const { baseUrl, requestCount } = await startScrapeServer({
      success: true,
      // No sourceURL: Firecrawl reported no final URL, so the result falls back to the request URL.
      data: { markdown: "# Cached page", metadata: { statusCode: 200 } },
    });
    const cfg = configFor(baseUrl);

    const first = await runFirecrawlScrape({
      cfg,
      url: "HTTPS://EXAMPLE.com/Page",
      extractMode: "markdown",
    });
    const second = await runFirecrawlScrape({
      cfg,
      url: "https://example.com/Page",
      extractMode: "markdown",
    });

    expect(requestCount()).toBe(1);
    expect(second.cached).toBe(true);
    expect(first.url).toBe("HTTPS://EXAMPLE.com/Page");
    expect(second.url).toBe("https://example.com/Page");
    expect(second.finalUrl).toBe("https://example.com/Page");
    expect(second.text).toBe(first.text);
  });

  it("keeps the final URL Firecrawl reported instead of rebinding it to the caller", async () => {
    const { baseUrl, requestCount } = await startScrapeServer({
      success: true,
      data: {
        markdown: "# Cached page",
        metadata: { statusCode: 200, sourceURL: "https://example.com/canonical" },
      },
    });
    const cfg = configFor(baseUrl);

    await runFirecrawlScrape({ cfg, url: "HTTPS://EXAMPLE.com/Page", extractMode: "markdown" });
    const second = await runFirecrawlScrape({
      cfg,
      url: "https://example.com/Page",
      extractMode: "markdown",
    });

    expect(requestCount()).toBe(1);
    expect(second.url).toBe("https://example.com/Page");
    expect(second.finalUrl).toBe("https://example.com/canonical");
  });
});
