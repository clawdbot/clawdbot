// tools.web.fetch.headers tests cover operator header delivery, transport
// constraints, sensitive capture metadata, and cache partitioning.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupFn } from "../../infra/net/ssrf.js";
import * as logger from "../../logger.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import "./web-fetch.test-mocks.js";
import { createWebFetchTool } from "./web-fetch.js";
import * as webGuardedFetch from "./web-guarded-fetch.js";

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
    const fetchWithRealGuard = webGuardedFetch.fetchWithWebToolsNetworkGuard;
    const guardedFetchSpy = vi
      .spyOn(webGuardedFetch, "fetchWithWebToolsNetworkGuard")
      .mockImplementation((params) => fetchWithRealGuard(params));

    const tool = createToolWithHeaders({
      "ATL-SG-SERVICE-INJECTION-URL": "http://host.docker.internal:9999",
      Authorization: "Bearer deployment-token",
      Cookie: "session=deployment-session",
      "X-Api-Key": "deployment-api-key",
      "X-Tokenizer-Version": "v2",
      "X-Trace-Token": "trace-context",
    });

    await tool?.execute?.("call", { url: "https://example.com/routed" });

    expect(getRequestHeaders(fetchSpy)["ATL-SG-SERVICE-INJECTION-URL"]).toBe(
      "http://host.docker.internal:9999",
    );
    expect(getRequestHeaders(fetchSpy).Authorization).toBe("Bearer deployment-token");
    expect(getRequestHeaders(fetchSpy).Cookie).toBe("session=deployment-session");
    expect(getRequestHeaders(fetchSpy)["X-Api-Key"]).toBe("deployment-api-key");
    expect(getRequestHeaders(fetchSpy)["X-Tokenizer-Version"]).toBe("v2");
    expect(getRequestHeaders(fetchSpy)["X-Trace-Token"]).toBe("trace-context");
    const captureMeta = guardedFetchSpy.mock.calls[0]?.[0].capture;
    expect(captureMeta === false ? undefined : captureMeta?.sensitiveRequestHeaderNames).toEqual([
      "ATL-SG-SERVICE-INJECTION-URL",
      "Authorization",
      "Cookie",
      "X-Api-Key",
      "X-Tokenizer-Version",
      "X-Trace-Token",
    ]);
  });

  it("refuses fetch-owned and framing headers", async () => {
    // Upgrade/Expect/Keep-Alive/Transfer-Encoding make fetch throw, so letting one
    // through would break every web_fetch call.
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Connection"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createToolWithHeaders({
      accept: "text/plain",
      "user-agent": "operator-agent/1.0",
      "Accept-Language": "de-DE",
      "Sec-Fetch-Mode": "same-origin",
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

  it("normalizes empty values without retaining a stale case-colliding value", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Normalized"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createToolWithHeaders({
      "X-Presence-Flag": " \t ",
      "X-Routing-Target": "staging",
      "x-routing-target": "東京",
    });

    await tool?.execute?.("call", { url: "https://example.com/normalized" });

    const headers = getRequestHeaders(fetchSpy);
    expect(headers["X-Presence-Flag"]).toBe("");
    expect(headers["X-Routing-Target"]).toBeUndefined();
    expect(headers["x-routing-target"]).toBeUndefined();
  });

  it("still fetches when every configured header is unusable, naming it in a warning", async () => {
    // The whole request must not fail because one config value is unsendable.
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Survives"));
    global.fetch = withFetchPreconnect(fetchSpy);
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});

    const invalidName = "X-Bad\n[forged]\u001b[31m";
    const tool = createToolWithHeaders({
      "X-Survives-Unicode": "東京",
      [invalidName]: "ignored",
    });

    const result = await tool?.execute?.("call", { url: "https://example.com/survives" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((result?.details as { status?: number } | undefined)?.status).toBe(200);
    const warned = warnSpy.mock.calls
      .map(([message]) => message)
      .filter((message) => message.includes("X-Survives-Unicode"));
    expect(warned).toHaveLength(1);
    // Names are safe to log; values are not.
    expect(warned[0]).not.toContain("東京");
    const invalidNameWarning = warnSpy.mock.calls
      .map(([message]) => message)
      .find((message) => message.includes("X-Bad"));
    expect(invalidNameWarning).toContain(JSON.stringify(invalidName));
    expect(invalidNameWarning).not.toContain("\n");
    expect(invalidNameWarning).not.toContain("\u001b");
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
