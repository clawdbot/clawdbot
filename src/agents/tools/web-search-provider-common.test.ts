// Shared web-search tests cover HTTP error ownership and module-local cache isolation.
import type { IncomingHttpHeaders } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SsrFBlockedError } from "../../infra/net/ssrf.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import {
  postPinnedTrustedHostWebToolsJson,
  postTrustedWebToolsJson,
  throwWebSearchApiError,
} from "./web-search-provider-common.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function postSearch(overrides: Partial<Parameters<typeof postTrustedWebToolsJson>[0]> = {}) {
  return postTrustedWebToolsJson(
    {
      url: "https://search.example.com/search",
      timeoutSeconds: 5,
      apiKey: "s7Key",
      body: { query: "test" },
      errorLabel: "Search",
      extraHeaders: { authorization: "Bearer synthetic-stale-key" },
      ...overrides,
    },
    (response) => response.json(),
  );
}

describe("web provider HTTP errors", () => {
  it.each([
    ["short body credential", "s7Key", "rejected $key", "", undefined, "rejected ***"],
    ["short reason credential", "s7Key", "", "rejected $key", undefined, "rejected ***"],
    ["bearer reflection", "synthetic-web-key-long", "Bearer $key", "", undefined, "Bearer ***"],
    ["truncated credential", "synthetic-web-key-long", "rejected $key", "", 15, "rejected ***"],
    ["ordinary detail", "s7Key", "quota exceeded", "", undefined, "quota exceeded"],
  ] as const)(
    "redacts %s without discarding diagnostics",
    async (_, apiKey, body, phrase, maxErrorBytes, expected) => {
      let authorization: string | undefined;
      await withServer(
        (request, response) => {
          authorization = request.headers.authorization;
          response.writeHead(401, phrase.replace("$key", apiKey));
          response.end(body.replace("$key", apiKey));
        },
        async (baseUrl) => {
          // Only routing is injected: the guarded owner consumes a real HTTP response body.
          vi.stubGlobal(
            "fetch",
            vi.fn((_input, init) => realFetch(baseUrl, init)),
          );
          const error = await postSearch({ apiKey, maxErrorBytes }).catch(
            (cause: unknown) => cause,
          );
          expect(authorization).toBe(`Bearer ${apiKey}`);
          expect(error).toEqual(new Error(`Search API error (401): ${expected}`));
        },
      );
    },
  );

  it("preserves caller cancellation after error headers arrive", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic caller cancellation");
    await withServer(
      (_request, response) => {
        response.writeHead(401);
        response.write("partial diagnostic");
      },
      async (baseUrl) => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async (_input, init) => {
            const response = await realFetch(baseUrl, init);
            controller.abort(reason);
            return response;
          }),
        );
        await expect(postSearch({ signal: controller.signal })).rejects.toBe(reason);
      },
    );
  });

  it("keeps successful responses and existing two-argument SDK calls usable", async () => {
    expect(redactToolPayloadText("Bearer tokens")).toBe("Bearer tokens");
    await withServer(
      (_request, response) => response.end('{"answer":"Bearer tokens"}'),
      async (baseUrl) => {
        vi.stubGlobal(
          "fetch",
          vi.fn((_input, init) => realFetch(baseUrl, init)),
        );
        await expect(postSearch()).resolves.toEqual({ answer: "Bearer tokens" });
      },
    );
    await expect(
      throwWebSearchApiError(new Response("quota exceeded", { status: 429 }), "Search"),
    ).rejects.toThrow("Search API error (429): quota exceeded");
  });
});

describe("pinned trusted-host web provider endpoints", () => {
  const PROXY_ENV_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ] as const;

  beforeEach(() => {
    // The loopback server must be reached directly, not through an env proxy.
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("honors an operator-configured loopback endpoint that the trusted helper refuses", async () => {
    // The operator typed the loopback address; the pinned helper delivers the same
    // request shape the trusted helper sends to the hosted API.
    const requests: Array<{ method?: string; headers: IncomingHttpHeaders; body: string }> = [];
    await withServer(
      (request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          requests.push({ method: request.method, headers: request.headers, body });
          response.setHeader("content-type", "application/json");
          response.end('{"results":[]}');
        });
      },
      async (baseUrl) => {
        const params = {
          url: `${baseUrl}/search`,
          timeoutSeconds: 5,
          apiKey: "s7Key",
          body: { query: "test" },
          errorLabel: "Search",
          extraHeaders: { "X-Client-Source": "openclaw" },
        };
        const parse = (response: Response) => response.json();

        await expect(postTrustedWebToolsJson(params, parse)).rejects.toBeInstanceOf(
          SsrFBlockedError,
        );
        expect(requests).toHaveLength(0);

        await expect(postPinnedTrustedHostWebToolsJson(params, parse)).resolves.toEqual({
          results: [],
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.method).toBe("POST");
        expect(requests[0]?.headers).toMatchObject({
          accept: "application/json",
          authorization: "Bearer s7Key",
          "content-type": "application/json",
          "x-client-source": "openclaw",
        });
        expect(requests[0]?.body).toBe('{"query":"test"}');
      },
    );
  });

  it("shares the redacted, bounded non-2xx error path", async () => {
    const apiKey = "synthetic-web-key-long";
    await withServer(
      (_request, response) => {
        response.writeHead(401);
        response.end(`rejected ${apiKey}`);
      },
      async (baseUrl) => {
        const error = await postPinnedTrustedHostWebToolsJson(
          {
            url: `${baseUrl}/search`,
            timeoutSeconds: 5,
            apiKey,
            body: { query: "test" },
            errorLabel: "Search",
            maxErrorBytes: 15,
          },
          (response) => response.json(),
        ).catch((cause: unknown) => cause);
        expect(error).toEqual(new Error("Search API error (401): rejected ***"));
      },
    );
  });
});

describe("web_search shared cache", () => {
  it("honors the reader TTL while preserving the shipped one-argument reader", async () => {
    const { readCachedSearchPayload, writeCachedSearchPayload } =
      await import("./web-search-provider-common.js");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const key = "query:reader-ttl";
    writeCachedSearchPayload(key, { text: "original" }, 900_000);
    expect(readCachedSearchPayload(key, 0)).toBeUndefined();
    writeCachedSearchPayload(key, { text: "disabled" }, 0);
    clock.mockReturnValue(61_000);
    expect(readCachedSearchPayload(key, 60_000)).toBeUndefined();
    expect(readCachedSearchPayload(key)).toEqual({ text: "original", cached: true });
    clock.mockReturnValue(901_001);
    expect(readCachedSearchPayload(key)).toBeUndefined();
  });

  it("keeps cache entries module-local instead of exposing them on a global symbol", async () => {
    // Cache state should die with the module instance; a global symbol would
    // leak search payloads across tests, sessions, and plugin reloads.
    vi.resetModules();
    delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.web-search.cache")];

    const module = await import("./web-search-provider-common.js");
    const cacheKey = "query:test";
    module.writeCachedSearchPayload(cacheKey, { ok: true }, 60_000);

    expect(module.readCachedSearchPayload(cacheKey)).toEqual({ ok: true, cached: true });
    expect(
      (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.web-search.cache")],
    ).toBeUndefined();
  });
});
