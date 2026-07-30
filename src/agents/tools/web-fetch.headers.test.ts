// tools.web.fetch.headers tests cover operator header delivery, reserved and
// credential header refusal, unsendable-value rejection, and cache partitioning.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigEnvVars } from "../../config/env-substitution.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
      "X-Tokenizer-Version": "v2",
      "X-Trace-Token": "trace-context",
    });

    await tool?.execute?.("call", { url: "https://example.com/routed" });

    expect(getRequestHeaders(fetchSpy)["ATL-SG-SERVICE-INJECTION-URL"]).toBe(
      "http://host.docker.internal:9999",
    );
    expect(getRequestHeaders(fetchSpy)["X-Tokenizer-Version"]).toBe("v2");
    expect(getRequestHeaders(fetchSpy)["X-Trace-Token"]).toBe("trace-context");
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
      "Sec-Fetch-Mode": "same-origin",
    });

    await tool?.execute?.("call", { url: "https://example.com/precedence" });

    const headers = getRequestHeaders(fetchSpy);
    expect(headers.Accept).toBe("text/markdown, text/html;q=0.9, */*;q=0.1");
    expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9");
    // Positive assertion: a dropped User-Agent must fail this test too.
    expect(headers["User-Agent"]).toContain("Mozilla/5.0");
    expect(Object.keys(headers)).not.toContain("Sec-Fetch-Mode");
  });

  it("refuses credential headers, which would reach model-chosen hosts", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Credentials"));
    global.fetch = withFetchPreconnect(fetchSpy);
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    const credentialLogSentinel = "credential-log-sentinel";

    const tool = createToolWithHeaders({
      Authorization: `Bearer ${credentialLogSentinel}`,
      "X-Authorization": "Bearer operator-token",
      Cookie: "session=abc",
      Cookie2: "legacy=abc",
      "Set-Cookie": "session=forged",
      "Proxy-Authorization": "Basic abc",
      "X-Api-Key": "live-key",
      "X-Api-Token": "live-token",
      "Api-Token": "live-token",
      apikey: "live-key",
      "x-goog-api-key": "google-live-key",
      "Ocp-Apim-Subscription-Key": "azure-live-key",
      "Private-Token": "gitlab-live-key",
      "X-Vault-Token": "vault-live-key",
      "X-Amz-Security-Token": "aws-live-key",
      "X-GitHub-Token": "github-live-key",
      "X-APIKEY": "generic-live-key",
      "Fastly-Key": "fastly-live-key",
      "X-Auth-Key": "auth-live-key",
      "X-RapidAPI-Key": "rapidapi-live-key",
      "X-Akamai-ACS-Auth-Sign": "akamai-live-signature",
      "X-Plivo-Signature-V2": "plivo-live-signature",
      "Telnyx-Signature-Ed25519": "telnyx-live-signature",
      "X-XAI-Token-Auth": "xai-live-auth",
      "X-Routing-Target": "staging",
    });

    await tool?.execute?.("call", { url: "https://example.com/credentials" });

    const names = Object.keys(getRequestHeaders(fetchSpy));
    expect(names).toContain("X-Routing-Target");
    expect(names).not.toContain("Authorization");
    expect(names).not.toContain("X-Authorization");
    expect(names).not.toContain("Cookie");
    expect(names).not.toContain("Cookie2");
    expect(names).not.toContain("Set-Cookie");
    expect(names).not.toContain("Proxy-Authorization");
    expect(names).not.toContain("X-Api-Key");
    expect(names).not.toContain("X-Api-Token");
    expect(names).not.toContain("Api-Token");
    expect(names).not.toContain("apikey");
    expect(names).not.toContain("x-goog-api-key");
    expect(names).not.toContain("Ocp-Apim-Subscription-Key");
    expect(names).not.toContain("Private-Token");
    expect(names).not.toContain("X-Vault-Token");
    expect(names).not.toContain("X-Amz-Security-Token");
    expect(names).not.toContain("X-GitHub-Token");
    expect(names).not.toContain("X-APIKEY");
    expect(names).not.toContain("Fastly-Key");
    expect(names).not.toContain("X-Auth-Key");
    expect(names).not.toContain("X-RapidAPI-Key");
    expect(names).not.toContain("X-Akamai-ACS-Auth-Sign");
    expect(names).not.toContain("X-Plivo-Signature-V2");
    expect(names).not.toContain("Telnyx-Signature-Ed25519");
    expect(names).not.toContain("X-XAI-Token-Auth");
    const warnings = warnSpy.mock.calls.map(([message]) => message);
    expect(warnings.some((message) => message.includes("Authorization"))).toBe(true);
    expect(warnings.every((message) => !message.includes(credentialLogSentinel))).toBe(true);
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

  it("trims values and preserves valid empty values", async () => {
    // undici trims field values, so an untrimmed value would partition the cache
    // on bytes the request never sends.
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Trimmed"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createToolWithHeaders({ "X-Padded": "  staging  ", "X-Blank": "   " });

    await tool?.execute?.("call", { url: "https://example.com/trimmed" });

    const headers = getRequestHeaders(fetchSpy);
    expect(headers["X-Padded"]).toBe("staging");
    expect(headers["X-Blank"]).toBe("");
  });

  it("preserves valid obs-text at header boundaries", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Obs Text"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createToolWithHeaders({ "X-Routing-Target": "\u00a0staging\u00a0" });

    await tool?.execute?.("call", { url: "https://example.com/obs-text" });

    expect(getRequestHeaders(fetchSpy)["X-Routing-Target"]).toBe("\u00a0staging\u00a0");
  });

  it("preserves literal placeholder text produced by config escaping", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Template"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const config = resolveConfigEnvVars(
      {
        tools: {
          web: {
            fetch: {
              cacheTtlMinutes: 0,
              headers: { "X-Routing-Template": "$${TENANT}" },
            },
          },
        },
      },
      {},
    ) as OpenClawConfig;
    const tool = createWebFetchTool({
      lookupFn: lookupMock as unknown as LookupFn,
      config,
    });

    await tool?.execute?.("call", { url: "https://example.com/template" });

    expect(getRequestHeaders(fetchSpy)["X-Routing-Template"]).toBe("${TENANT}");
  });

  it("keeps one entry when configured names differ only in case", async () => {
    // A record carrying both would be comma-appended into "staging, prod".
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Collision"));
    global.fetch = withFetchPreconnect(fetchSpy);
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});

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
    expect(headers[routingNames[0] ?? ""]).toBe("prod");
    const collisionWarnings = warnSpy.mock.calls
      .map(([message]) => message)
      .filter((message) => message.includes("case-colliding"));
    expect(collisionWarnings).toEqual([
      expect.stringContaining(JSON.stringify("X-Routing-Target")),
    ]);
    expect(collisionWarnings[0]).not.toContain("staging");
    expect(collisionWarnings[0]).not.toContain("prod");
  });

  it("does not send an earlier value when a later case variant is unusable", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Rejected Collision"));
    global.fetch = withFetchPreconnect(fetchSpy);
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});

    const tool = createToolWithHeaders({
      "X-Routing-Target": "staging",
      "x-routing-target": "東京",
    });

    await tool?.execute?.("call", { url: "https://example.com/rejected-collision" });

    const headers = getRequestHeaders(fetchSpy);
    expect(Object.keys(headers).some((name) => name.toLowerCase() === "x-routing-target")).toBe(
      false,
    );
    const warnings = warnSpy.mock.calls.map(([message]) => message);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(JSON.stringify("X-Routing-Target")),
        expect.stringContaining(JSON.stringify("x-routing-target")),
      ]),
    );
    expect(warnings.join("\n")).not.toContain("staging");
    expect(warnings.join("\n")).not.toContain("東京");
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
      "  X-Trimmed  ": "trimmed",
    });

    await tool?.execute?.("call", { url: "https://example.com/normalized" });

    const headers = getRequestHeaders(fetchSpy);
    expect(headers["X-Trimmed"]).toBe("trimmed");
    const names = Object.keys(headers);
    expect(names).not.toContain("X Routing Target");
    expect(names).not.toContain("X-Injected");
    expect(names).not.toContain("X-Smuggled");
    expect(names).not.toContain("X-Unicode");
    expect(names).not.toContain("X-Em-Dash");
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

  it("partitions the cache for a valid empty-valued header", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Empty Header"));
    global.fetch = withFetchPreconnect(fetchSpy);
    const url = "https://example.com/cache-empty-header";
    const plain = createWebFetchTool({
      lookupFn: lookupMock as unknown as LookupFn,
      config: { tools: { web: { fetch: { cacheTtlMinutes: 15 } } } },
    });

    await plain?.execute?.("call", { url });
    await createToolWithHeaders({ "X-Presence-Flag": "" }, { cacheTtlMinutes: 15 })?.execute?.(
      "call",
      { url },
    );
    await createToolWithHeaders({ "X-Presence-Flag": "" }, { cacheTtlMinutes: 15 })?.execute?.(
      "call",
      { url },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(getRequestHeaders(fetchSpy, 1)["X-Presence-Flag"]).toBe("");
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
