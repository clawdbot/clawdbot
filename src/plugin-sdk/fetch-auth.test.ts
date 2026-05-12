import { describe, expect, it, vi } from "vitest";
import { fetchWithBearerAuthScopeFallback } from "./fetch-auth.js";
import { resolveRequestUrl } from "./request-url.js";

const asFetch = (fn: unknown): typeof fetch => fn as typeof fetch;

describe("fetchWithBearerAuthScopeFallback", () => {
  it("rejects non-https urls when https is required", async () => {
    await expect(
      fetchWithBearerAuthScopeFallback({
        url: "http://example.com/file",
        scopes: [],
        requireHttps: true,
      }),
    ).rejects.toThrow("URL must use HTTPS");
  });

  it.each([
    {
      name: "returns immediately when the first attempt succeeds",
      url: "https://example.com/file",
      scopes: ["https://graph.microsoft.com"],
      responses: [new Response("ok", { status: 200 })],
      shouldAttachAuth: undefined,
      expectedStatus: 200,
      expectedFetchCalls: 1,
      expectedTokenCalls: [] as string[],
      expectedAuthHeader: null,
    },
    {
      name: "retries with auth scopes after a 401 response",
      url: "https://graph.microsoft.com/v1.0/me",
      scopes: ["https://graph.microsoft.com", "https://api.botframework.com"],
      responses: [
        new Response("unauthorized", { status: 401 }),
        new Response("ok", { status: 200 }),
      ],
      shouldAttachAuth: undefined,
      expectedStatus: 200,
      expectedFetchCalls: 2,
      expectedTokenCalls: ["https://graph.microsoft.com"],
      expectedAuthHeader: "Bearer token-1",
    },
    {
      name: "does not attach auth when host predicate rejects url",
      url: "https://example.com/file",
      scopes: ["https://graph.microsoft.com"],
      responses: [new Response("unauthorized", { status: 401 })],
      shouldAttachAuth: () => false,
      expectedStatus: 401,
      expectedFetchCalls: 1,
      expectedTokenCalls: [] as string[],
      expectedAuthHeader: null,
    },
  ])(
    "$name",
    async ({
      url,
      scopes,
      responses,
      shouldAttachAuth,
      expectedStatus,
      expectedFetchCalls,
      expectedTokenCalls,
      expectedAuthHeader,
    }) => {
      const fetchFn = vi.fn();
      for (const response of responses) {
        fetchFn.mockResolvedValueOnce(response);
      }
      const tokenProvider = { getAccessToken: vi.fn(async () => "token-1") };

      const response = await fetchWithBearerAuthScopeFallback({
        url,
        scopes,
        fetchFn: asFetch(fetchFn),
        tokenProvider,
        shouldAttachAuth,
      });

      expect(response.status).toBe(expectedStatus);
      expect(fetchFn).toHaveBeenCalledTimes(expectedFetchCalls);
      const tokenCalls = tokenProvider.getAccessToken.mock.calls as unknown as Array<[string]>;
      expect(tokenCalls.map(([scope]) => scope)).toEqual(expectedTokenCalls);
      if (expectedAuthHeader === null) {
        return;
      }
      const secondCallInit = fetchFn.mock.calls.at(1)?.[1] as RequestInit | undefined;
      const secondHeaders = new Headers(secondCallInit?.headers);
      expect(secondHeaders.get("authorization")).toBe(expectedAuthHeader);
    },
  );

  it("continues across scopes when token retrieval fails", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const tokenProvider = {
      getAccessToken: vi
        .fn()
        .mockRejectedValueOnce(new Error("first scope failed"))
        .mockResolvedValueOnce("token-2"),
    };

    const response = await fetchWithBearerAuthScopeFallback({
      url: "https://graph.microsoft.com/v1.0/me",
      scopes: ["https://first.example", "https://second.example"],
      fetchFn: asFetch(fetchFn),
      tokenProvider,
    });

    expect(response.status).toBe(200);
    expect(tokenProvider.getAccessToken).toHaveBeenCalledTimes(2);
    expect(tokenProvider.getAccessToken).toHaveBeenNthCalledWith(1, "https://first.example");
    expect(tokenProvider.getAccessToken).toHaveBeenNthCalledWith(2, "https://second.example");
  });

  it("normalizes symbol-bearing request headers across unauthenticated and retry attempts", async () => {
    const headers = { Accept: "application/json" } as Record<string, string> & {
      [key: symbol]: unknown;
    };
    Object.defineProperty(headers, Symbol("sensitiveHeaders"), {
      value: new Set(["accept"]),
      enumerable: false,
    });
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const normalizedHeaders = new Headers(init?.headers);
      expect(normalizedHeaders.get("accept")).toBe("application/json");
      return fetchFn.mock.calls.length === 1
        ? new Response("unauthorized", { status: 401 })
        : new Response("ok", { status: 200 });
    });
    const tokenProvider = { getAccessToken: vi.fn(async () => "token-1") };

    const response = await fetchWithBearerAuthScopeFallback({
      url: "https://graph.microsoft.com/v1.0/me",
      scopes: ["https://graph.microsoft.com"],
      fetchFn: asFetch(fetchFn),
      tokenProvider,
      requestInit: { headers },
    });

    expect(response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(
      Object.getOwnPropertySymbols(fetchFn.mock.calls.at(0)?.[1]?.headers as object),
    ).toStrictEqual([]);
    expect(new Headers(fetchFn.mock.calls.at(1)?.[1]?.headers).get("authorization")).toBe(
      "Bearer token-1",
    );
    expect(Object.getOwnPropertySymbols(headers)).toHaveLength(1);
  });
});

describe("resolveRequestUrl", () => {
  it.each([
    {
      name: "resolves string input",
      input: "https://example.com/a",
      expected: "https://example.com/a",
    },
    {
      name: "resolves URL input",
      input: new URL("https://example.com/b"),
      expected: "https://example.com/b",
    },
    {
      name: "resolves object input with url field",
      input: { url: "https://example.com/c" } as unknown as RequestInfo,
      expected: "https://example.com/c",
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveRequestUrl(input)).toBe(expected);
  });
});
