// tools.web.fetch.headers tests cover operator header delivery, reserved and
// credential header refusal, unsendable-value rejection, and cache partitioning.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupFn } from "../../infra/net/ssrf.js";
import * as logger from "../../logger.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import "./web-fetch.test-mocks.js";
import { createWebFetchTool } from "./web-fetch.js";

const lookupMock = vi.fn();

function markdownResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}

function createToolWithHeaders(
  headers: Record<string, string>,
  opts?: { cacheTtlMinutes?: number },
): ReturnType<typeof createWebFetchTool> {
  return createWebFetchTool({
    lookupFn: lookupMock as unknown as LookupFn,
    config: {
      tools: {
        web: {
          fetch: { cacheTtlMinutes: opts?.cacheTtlMinutes ?? 0, headers },
        },
      },
    },
  });
}

function getRequestHeaders(
  fetchSpy: ReturnType<typeof vi.fn>,
  callIndex = 0,
): Record<string, string> {
  const call = fetchSpy.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected fetch call at index ${callIndex}`);
  }
  return (call[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {};
}

describe("web_fetch configured request headers", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    lookupMock.mockImplementation(async (hostname: string) => {
      void hostname;
      return [{ address: "93.184.216.34", family: 4 }];
    });
  });

  afterEach(() => {
    global.fetch = priorFetch;
    lookupMock.mockReset();
    vi.restoreAllMocks();
  });

  it("sends configured headers with the direct fetch request", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Routed"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createToolWithHeaders({
      "ATL-SG-SERVICE-INJECTION-URL": "http://host.docker.internal:9999",
    });

    await tool?.execute?.("call", { url: "https://example.com/routed" });

    expect(getRequestHeaders(fetchSpy)["ATL-SG-SERVICE-INJECTION-URL"]).toBe(
      "http://host.docker.internal:9999",
    );
  });

  it("keeps fetch-owned header names and casing when no headers are configured", async () => {
    // A plain record reaches the wire verbatim, so the canonical casing and order
    // must survive for users who configure nothing.
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Untouched"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createWebFetchTool({
      lookupFn: lookupMock as unknown as LookupFn,
      config: { tools: { web: { fetch: { cacheTtlMinutes: 0 } } } },
    });

    await tool?.execute?.("call", { url: "https://example.com/untouched" });

    expect(Object.keys(getRequestHeaders(fetchSpy))).toEqual([
      "Accept",
      "User-Agent",
      "Accept-Language",
    ]);
  });

  it("refuses configured headers that would override the fetch contract", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Precedence"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createToolWithHeaders({
      accept: "text/plain",
      "user-agent": "operator-agent/1.0",
      "Accept-Language": "de-DE",
    });

    await tool?.execute?.("call", { url: "https://example.com/precedence" });

    const headers = getRequestHeaders(fetchSpy);
    expect(headers.Accept).toBe("text/markdown, text/html;q=0.9, */*;q=0.1");
    expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9");
    // Positive assertion: a dropped User-Agent must fail this test too.
    expect(headers["User-Agent"]).toContain("Mozilla/5.0");
  });

  it("refuses credential headers, which would reach model-chosen hosts", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Credentials"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createToolWithHeaders({
      Authorization: "Bearer operator-token",
      Cookie: "session=abc",
      "Proxy-Authorization": "Basic abc",
      "X-Api-Key": "live-key",
      apikey: "live-key",
      "X-Routing-Target": "staging",
    });

    await tool?.execute?.("call", { url: "https://example.com/credentials" });

    const names = Object.keys(getRequestHeaders(fetchSpy));
    expect(names).toContain("X-Routing-Target");
    expect(names).not.toContain("Authorization");
    expect(names).not.toContain("Cookie");
    expect(names).not.toContain("Proxy-Authorization");
    expect(names).not.toContain("X-Api-Key");
    expect(names).not.toContain("apikey");
  });

  it("refuses framing headers that undici rejects or ignores", async () => {
    // Upgrade/Expect/Keep-Alive/Transfer-Encoding make fetch throw, so letting one
    // through would break every web_fetch call.
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Connection"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createToolWithHeaders({
      Upgrade: "h2c",
      Expect: "100-continue",
      "Keep-Alive": "timeout=5",
      "Transfer-Encoding": "chunked",
      Host: "elsewhere.example",
      Connection: "close",
      "Content-Length": "0",
      "X-Routing-Target": "staging",
    });

    const result = await tool?.execute?.("call", { url: "https://example.com/connection" });

    expect((result?.details as { status?: number } | undefined)?.status).toBe(200);
    expect(Object.keys(getRequestHeaders(fetchSpy))).toEqual([
      "Accept",
      "User-Agent",
      "Accept-Language",
      "X-Routing-Target",
    ]);
  });

  it("trims values and ignores ones that are empty after trimming", async () => {
    // undici trims field values, so an untrimmed value would partition the cache
    // on bytes the request never sends.
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Trimmed"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createToolWithHeaders({ "X-Padded": "  staging  ", "X-Blank": "   " });

    await tool?.execute?.("call", { url: "https://example.com/trimmed" });

    const headers = getRequestHeaders(fetchSpy);
    expect(headers["X-Padded"]).toBe("staging");
    expect(Object.keys(headers)).not.toContain("X-Blank");
  });

  it("keeps one entry when configured names differ only in case", async () => {
    // A record carrying both would be comma-appended into "staging, prod".
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Collision"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createToolWithHeaders({
      "X-Routing-Target": "staging",
      "x-routing-target": "prod",
    });

    await tool?.execute?.("call", { url: "https://example.com/collision" });

    const headers = getRequestHeaders(fetchSpy);
    const routingNames = Object.keys(headers).filter(
      (name) => name.toLowerCase() === "x-routing-target",
    );
    expect(routingNames).toHaveLength(1);
    expect(headers[routingNames[0] ?? ""]).not.toContain(",");
  });

  it("ignores entries whose name or value the request cannot carry", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Normalized"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createToolWithHeaders({
      // Names are validated at request time, not at config load, so a typo drops
      // one entry instead of rejecting the whole config.
      "  ": "blank-name",
      "X Routing Target": "space-in-name",
      "X-Injected": "value\r\nX-Smuggled: yes",
      // Above U+00FF, so Headers/undici would throw and break every fetch.
      "X-Unicode": "staging 東京",
      "X-Em-Dash": "staging—eu",
      "X-Placeholder": "prefix-${UNSET_TARGET}-suffix",
      "  X-Trimmed  ": "trimmed",
    });

    await tool?.execute?.("call", { url: "https://example.com/normalized" });

    const headers = getRequestHeaders(fetchSpy);
    expect(headers["X-Trimmed"]).toBe("trimmed");
    const names = Object.keys(headers);
    expect(names).not.toContain("X Routing Target");
    expect(names).not.toContain("X-Injected");
    expect(names).not.toContain("X-Placeholder");
    expect(names).not.toContain("X-Smuggled");
    expect(names).not.toContain("X-Unicode");
    expect(names).not.toContain("X-Em-Dash");
  });

  it("still fetches when every configured header is unusable, naming it in a warning", async () => {
    // The whole request must not fail because one config value is unsendable.
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Survives"));
    global.fetch = withFetchPreconnect(fetchSpy);
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});

    const tool = createToolWithHeaders({ "X-Survives-Unicode": "東京" });

    const result = await tool?.execute?.("call", { url: "https://example.com/survives" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((result?.details as { status?: number } | undefined)?.status).toBe(200);
    const warned = warnSpy.mock.calls
      .map(([message]) => message)
      .filter((message) => message.includes("X-Survives-Unicode"));
    expect(warned).toHaveLength(1);
    // Names are safe to log; values are not.
    expect(warned[0]).not.toContain("東京");
  });

  it("partitions the fetch cache by configured headers", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Cached"));
    global.fetch = withFetchPreconnect(fetchSpy);
    const url = "https://example.com/cache-partition";

    await createToolWithHeaders(
      { "ATL-SG-SERVICE-INJECTION-URL": "http://host.docker.internal:9999" },
      { cacheTtlMinutes: 15 },
    )?.execute?.("call", { url });
    await createToolWithHeaders(
      { "ATL-SG-SERVICE-INJECTION-URL": "http://host.docker.internal:8888" },
      { cacheTtlMinutes: 15 },
    )?.execute?.("call", { url });
    // Same header set must still hit the cache written by the first call.
    await createToolWithHeaders(
      { "ATL-SG-SERVICE-INJECTION-URL": "http://host.docker.internal:9999" },
      { cacheTtlMinutes: 15 },
    )?.execute?.("call", { url });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(getRequestHeaders(fetchSpy, 1)["ATL-SG-SERVICE-INJECTION-URL"]).toBe(
      "http://host.docker.internal:8888",
    );
  });

  it("declaring the same headers in a different order reuses one cache entry", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Sorted"));
    global.fetch = withFetchPreconnect(fetchSpy);
    const url = "https://example.com/cache-sorted";

    await createToolWithHeaders({ "X-A": "1", "X-B": "2" }, { cacheTtlMinutes: 15 })?.execute?.(
      "call",
      { url },
    );
    await createToolWithHeaders({ "X-B": "2", "X-A": "1" }, { cacheTtlMinutes: 15 })?.execute?.(
      "call",
      { url },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not partition the cache for headers the request never carries", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Unpartitioned"));
    global.fetch = withFetchPreconnect(fetchSpy);
    const url = "https://example.com/cache-unpartitioned";

    const plain = createWebFetchTool({
      lookupFn: lookupMock as unknown as LookupFn,
      config: { tools: { web: { fetch: { cacheTtlMinutes: 15 } } } },
    });
    await plain?.execute?.("call", { url });
    // A refused or dropped header sends a byte-identical request, so both must
    // share the entry: rejection happens before the cache key is computed.
    await createToolWithHeaders({ accept: "text/plain" }, { cacheTtlMinutes: 15 })?.execute?.(
      "call",
      { url },
    );
    await createToolWithHeaders(
      { "X Invalid Name": "dropped", "Transfer-Encoding": "chunked" },
      { cacheTtlMinutes: 15 },
    )?.execute?.("call", { url });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
