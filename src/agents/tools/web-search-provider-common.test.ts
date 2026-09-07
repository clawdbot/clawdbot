// Shared web_search provider tests cover module-local cache isolation and
// reflected-credential redaction on the shared error surfaces.
import { createServer, type Server } from "node:http";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/net/fetch-guard.js")>();
  // Pass guarded fetch through to the real network so loopback proofs exercise
  // the same transport path production uses.
  return {
    ...actual,
    fetchWithSsrFGuard: vi.fn(
      async (params: { url: string; init?: RequestInit; signal?: AbortSignal }) => {
        const response = await fetch(params.url, {
          method: params.init?.method,
          headers: params.init?.headers,
          body: params.init?.body as string | undefined,
          signal: params.signal,
        });
        return { response, finalUrl: params.url, release: async () => {} };
      },
    ),
  };
});

const { postTrustedWebToolsJson, throwWebSearchApiError } =
  await import("./web-search-provider-common.js");

describe("web_search shared cache", () => {
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

function reflectedCredentialResponse(): Response {
  return new Response('{"error":"invalid key sk-live-abcdef123456"}', { status: 401 });
}

describe("throwWebSearchApiError credential redaction", () => {
  it("masks reflected bearer credentials in raw and scheme-stripped forms", async () => {
    const err = await throwWebSearchApiError(reflectedCredentialResponse(), "Perplexity", {
      Authorization: "Bearer sk-live-abcdef123456",
      "Content-Type": "application/json",
    }).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain("sk-live-abcdef123456");
    expect(String(err)).toContain("***");
  });

  it("masks non-Authorization header credentials like x-api-key values", async () => {
    const err = await throwWebSearchApiError(
      new Response("bad key: super-secret-key-42", { status: 403 }),
      "Tavily",
      { "x-api-key": "super-secret-key-42" },
    ).catch((error: unknown) => error);

    expect(String(err)).not.toContain("super-secret-key-42");
    expect(String(err)).toContain("***");
  });

  it("drops truncated error bodies instead of risking a half-redacted credential", async () => {
    const oversized = `${"padding".repeat(12_000)}sk-live-abcdef123456`;
    const err = await throwWebSearchApiError(new Response(oversized, { status: 429 }), "Xai").catch(
      (error: unknown) => error,
    );

    expect(String(err)).not.toContain("sk-live-abcdef123456");
    expect(String(err)).toMatch(/API error \(429\): $/u);
  });

  it("falls back to status text when the body is empty", async () => {
    const err = await throwWebSearchApiError(
      new Response("", { status: 500, statusText: "Internal Failure" }),
      "Brave",
    ).catch((error: unknown) => error);

    expect(String(err)).toContain("Brave API error (500): Internal Failure");
  });
});

describe("postTrustedWebToolsJson reflected credentials over real loopback", () => {
  let server: Server;
  let baseUrl: string;
  let seenAuthorization: string | undefined;

  const startServer = async (): Promise<void> => {
    server = createServer((req, res) => {
      seenAuthorization = req.headers.authorization;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: `rejected credential ${String(req.headers.authorization)}` }),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("no loopback port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  };

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it("masks the bearer credential a proxy echoes back in an error body", async () => {
    await startServer();
    const apiKey = "sk-tavily-loopback-9876543210";
    const err = await postTrustedWebToolsJson(
      {
        url: baseUrl,
        timeoutSeconds: 5,
        apiKey,
        body: { query: "test" },
        errorLabel: "Tavily",
      },
      async () => ({}),
    ).catch((error: unknown) => error);

    expect(seenAuthorization).toBe(`Bearer ${apiKey}`);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain(apiKey);
    expect(String(err)).toContain("rejected credential ***");
  });
});
