import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import { type FetchMock, withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { createWebFetchTool } from "./web-fetch.js";
import { makeFetchHeaders } from "./web-fetch.test-harness.js";
import "./web-fetch.test-mocks.js";

const lookupMock = vi.fn();
const resolvePinnedHostname = ssrf.resolvePinnedHostname;

function redirectResponse(location: string): Response {
  return {
    ok: false,
    status: 302,
    headers: makeFetchHeaders({ location }),
    body: { cancel: vi.fn() },
  } as unknown as Response;
}

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: makeFetchHeaders({ "content-type": "text/plain" }),
    text: async () => body,
  } as unknown as Response;
}

function setMockFetch(
  impl: FetchMock = async (_input: RequestInfo | URL, _init?: RequestInit) => textResponse(""),
) {
  const fetchSpy = vi.fn(impl);
  global.fetch = withFetchPreconnect(fetchSpy);
  return fetchSpy;
}

function expectRawFetchSuccessDetails(details: unknown) {
  const typedDetails = details as { status?: number; extractor?: string };
  expect(typedDetails.status).toBe(200);
  expect(typedDetails.extractor).toBe("raw");
}

function createWebFetchToolForTest(params?: {
  firecrawlApiKey?: string;
  useTrustedEnvProxy?: boolean;
  ssrfPolicy?: { allowRfc2544BenchmarkRange?: boolean; allowIpv6UniqueLocalRange?: boolean };
  cacheTtlMinutes?: number;
}) {
  return createWebFetchTool({
    config: {
      plugins: params?.firecrawlApiKey
        ? {
            entries: {
              firecrawl: {
                config: {
                  webFetch: {
                    apiKey: params.firecrawlApiKey,
                  },
                },
              },
            },
          }
        : undefined,
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: params?.cacheTtlMinutes ?? 0,
            useTrustedEnvProxy: params?.useTrustedEnvProxy,
            ssrfPolicy: params?.ssrfPolicy,
            ...(params?.firecrawlApiKey ? { provider: "firecrawl" } : {}),
          },
        },
      },
    },
    lookupFn: lookupMock,
  });
}

async function expectBlockedUrl(
  tool: ReturnType<typeof createWebFetchToolForTest>,
  url: string,
  expectedMessage: RegExp,
) {
  await expect(tool?.execute?.("call", { url })).rejects.toThrow(expectedMessage);
}

describe("web_fetch SSRF protection", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation((hostname) =>
      resolvePinnedHostname(hostname, lookupMock),
    );
  });

  afterEach(() => {
    global.fetch = priorFetch;
    lookupMock.mockClear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("blocks localhost hostnames before fetch/firecrawl", async () => {
    const fetchSpy = setMockFetch();
    const tool = createWebFetchToolForTest({
      firecrawlApiKey: "firecrawl-test", // pragma: allowlist secret
    });

    await expectBlockedUrl(tool, "http://localhost/test", /Blocked hostname/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks private IP literals without DNS", async () => {
    const fetchSpy = setMockFetch();
    const tool = createWebFetchToolForTest();

    const cases = ["http://127.0.0.1/test", "http://[::ffff:127.0.0.1]/"] as const;
    for (const url of cases) {
      await expectBlockedUrl(tool, url, /private|internal|blocked/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks when DNS resolves to private addresses", async () => {
    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === "public.test") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      return [{ address: "10.0.0.5", family: 4 }];
    });

    const fetchSpy = setMockFetch();
    const tool = createWebFetchToolForTest();

    await expectBlockedUrl(tool, "https://private.test/resource", /private|internal|blocked/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks redirects to private hosts", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const fetchSpy = setMockFetch().mockResolvedValueOnce(
      redirectResponse("http://127.0.0.1/secret"),
    );
    const tool = createWebFetchToolForTest({
      firecrawlApiKey: "firecrawl-test", // pragma: allowlist secret
    });

    await expectBlockedUrl(tool, "https://example.com", /private|internal|blocked/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("allows public hosts", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    setMockFetch().mockResolvedValue(textResponse("ok"));
    const tool = createWebFetchToolForTest();

    const result = await tool?.execute?.("call", { url: "https://example.com" });
    expectRawFetchSuccessDetails(result?.details);
  });

  it("allows RFC2544 benchmark-range URLs only when web_fetch ssrfPolicy opts in", async () => {
    const url = "http://198.18.0.153/file";
    lookupMock.mockResolvedValue([{ address: "198.18.0.153", family: 4 }]);

    const deniedTool = createWebFetchToolForTest({ cacheTtlMinutes: 1 });
    await expectBlockedUrl(deniedTool, url, /private|internal|blocked/i);

    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("benchmark ok"));
    const allowedTool = createWebFetchToolForTest({
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      cacheTtlMinutes: 1,
    });

    const allowed = await allowedTool?.execute?.("call", { url });
    expectRawFetchSuccessDetails(allowed?.details);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const stricterTool = createWebFetchToolForTest({ cacheTtlMinutes: 1 });
    await expectBlockedUrl(stricterTool, url, /private|internal|blocked/i);
  });

  it("allows IPv6 unique-local DNS answers only when web_fetch ssrfPolicy opts in", async () => {
    const url = "https://fake-ip.test/file";
    lookupMock.mockResolvedValue([{ address: "fc00::153", family: 6 }]);

    const deniedTool = createWebFetchToolForTest({ cacheTtlMinutes: 1 });
    await expectBlockedUrl(deniedTool, url, /private|internal|blocked/i);

    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("ipv6 ula ok"));
    const allowedTool = createWebFetchToolForTest({
      ssrfPolicy: { allowIpv6UniqueLocalRange: true },
      cacheTtlMinutes: 1,
    });

    const allowed = await allowedTool?.execute?.("call", { url });
    expectRawFetchSuccessDetails(allowed?.details);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const stricterTool = createWebFetchToolForTest({ cacheTtlMinutes: 1 });
    await expectBlockedUrl(stricterTool, url, /private|internal|blocked/i);
  });

  it("still blocks dangerous hostnames when trusted env proxy is explicitly enabled", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    vi.stubEnv("http_proxy", "http://127.0.0.1:7890");
    const fetchSpy = setMockFetch();
    const tool = createWebFetchToolForTest({
      useTrustedEnvProxy: true,
      cacheTtlMinutes: 1,
    });

    await expectBlockedUrl(tool, "http://localhost/test", /Blocked hostname/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
