// Shared web-search tests cover HTTP error ownership and module-local cache isolation.
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactToolPayloadText } from "../../logging/redact.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { postTrustedWebToolsJson, throwWebSearchApiError } from "./web-search-provider-common.js";

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
