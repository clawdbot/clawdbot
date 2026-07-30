import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withMcpOAuthBearer } from "./mcp-oauth-fetch.js";

const oauthMocks = vi.hoisted(() => ({
  recordAuthorizationRequired: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("./mcp-oauth.js", () =>
  Object.fromEntries([
    ["recordMcpOAuthAuthorizationRequired", oauthMocks.recordAuthorizationRequired],
    ["resolveMcpOAuthAccessToken", oauthMocks.resolve],
  ]),
);

function bearer(headers: HeadersInit | undefined): string | null {
  return new Headers(headers).get("authorization")?.replace(/^Bearer /u, "") ?? null;
}

function callHeaders(fetchFn: ReturnType<typeof vi.fn<FetchLike>>, index: number): HeadersInit {
  const call = fetchFn.mock.calls[index];
  const input = call?.[0];
  return input instanceof Request ? input.headers : (call?.[1]?.headers ?? {});
}

describe("MCP OAuth bearer fetch", () => {
  beforeEach(() => {
    oauthMocks.recordAuthorizationRequired.mockReset();
    oauthMocks.resolve.mockReset();
  });

  it("injects native OAuth only at the configured resource origin", async () => {
    oauthMocks.resolve.mockResolvedValue("test-token-placeholder");
    const fetchFn = vi.fn<FetchLike>(async () => new Response("ok"));
    const wrapped = withMcpOAuthBearer({
      fetchFn,
      authFetchFn: fetchFn,
      serverName: "docs",
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await wrapped("https://mcp.example.com/mcp", { headers: { "x-tenant": "docs" } });
    await wrapped("https://auth.example.com/token");

    expect(oauthMocks.resolve).toHaveBeenCalledOnce();
    expect(oauthMocks.resolve.mock.calls[0]?.[0]).toMatchObject({ acceptUnknownExpiry: true });
    expect(bearer(callHeaders(fetchFn, 0))).toBe("test-token-placeholder");
    expect(bearer(callHeaders(fetchFn, 1))).toBeNull();
  });

  it("refreshes once on 401 and retries with the replacement token", async () => {
    oauthMocks.resolve
      .mockResolvedValueOnce("decoy-token")
      .mockResolvedValueOnce("test-auth-token");
    const fetchFn = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="docs.read"',
          },
        }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    const wrapped = withMcpOAuthBearer({
      fetchFn,
      authFetchFn: fetchFn,
      serverName: "docs",
      resourceUrl: "https://mcp.example.com/mcp",
      config: { scope: "fallback" },
    });
    const controller = new AbortController();

    await expect(
      wrapped("https://mcp.example.com/mcp", { signal: controller.signal }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(bearer(callHeaders(fetchFn, 0))).toBe("decoy-token");
    expect(bearer(callHeaders(fetchFn, 1))).toBe("test-auth-token");
    expect(oauthMocks.resolve.mock.calls[1]?.[0]).toMatchObject({
      rejectedAccessToken: "decoy-token",
      resourceMetadataUrl: new URL("https://mcp.example.com/.well-known/oauth-protected-resource"),
      scope: "docs.read",
    });
    const firstSignal = oauthMocks.resolve.mock.calls[0]?.[0].signal;
    expect(oauthMocks.resolve.mock.calls[1]?.[0].signal).toBe(firstSignal);
    controller.abort();
    expect(firstSignal).toMatchObject({ aborted: true });
  });

  it("uses an unauthenticated challenge to bootstrap a missing token", async () => {
    oauthMocks.resolve.mockResolvedValueOnce(undefined).mockResolvedValueOnce("test-auth-token");
    const fetchFn = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="docs.read"',
          },
        }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    const wrapped = withMcpOAuthBearer({
      fetchFn,
      authFetchFn: fetchFn,
      serverName: "docs",
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await expect(wrapped("https://mcp.example.com/mcp")).resolves.toMatchObject({ status: 200 });
    expect(bearer(callHeaders(fetchFn, 0))).toBeNull();
    expect(bearer(callHeaders(fetchFn, 1))).toBe("test-auth-token");
    expect(oauthMocks.resolve.mock.calls[0]?.[0]).toMatchObject({ allowMissingToken: true });
    expect(oauthMocks.resolve.mock.calls[1]?.[0]).toMatchObject({
      authorizationChallenge: true,
      resourceMetadataUrl: new URL("https://mcp.example.com/.well-known/oauth-protected-resource"),
      scope: "docs.read",
    });
  });

  it("replays a body-bearing Request once after OAuth refresh", async () => {
    oauthMocks.resolve
      .mockResolvedValueOnce("decoy-token")
      .mockResolvedValueOnce("test-auth-token");
    const bodies: string[] = [];
    const fetchFn = vi.fn<FetchLike>(async (input, init) => {
      expect(init).not.toBeInstanceOf(Request);
      bodies.push(await new Request(input, init).text());
      return new Response(bodies.length === 1 ? "unauthorized" : "ok", {
        status: bodies.length === 1 ? 401 : 200,
      });
    });
    const wrapped = withMcpOAuthBearer({
      fetchFn,
      authFetchFn: fetchFn,
      serverName: "docs",
      resourceUrl: "https://mcp.example.com/mcp",
    });

    const response = await wrapped(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"jsonrpc":"2.0","method":"tools/list"}',
      }),
    );

    expect(response.status).toBe(200);
    expect(bodies).toEqual([
      '{"jsonrpc":"2.0","method":"tools/list"}',
      '{"jsonrpc":"2.0","method":"tools/list"}',
    ]);
    expect(bearer(callHeaders(fetchFn, 0))).toBe("decoy-token");
    expect(bearer(callHeaders(fetchFn, 1))).toBe("test-auth-token");
  });

  it("requires scope-bearing login on insufficient-scope 403 but leaves other 403s untouched", async () => {
    const loginRequired = new Error("additional OAuth authorization required");
    oauthMocks.resolve.mockResolvedValueOnce("decoy-token").mockRejectedValueOnce(loginRequired);
    const fetchFn = vi.fn<FetchLike>().mockResolvedValueOnce(
      new Response("forbidden", {
        status: 403,
        headers: {
          "www-authenticate": 'Bearer error="insufficient_scope", scope="docs.write"',
        },
      }),
    );
    const wrapped = withMcpOAuthBearer({
      fetchFn,
      authFetchFn: fetchFn,
      serverName: "docs",
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await expect(wrapped("https://mcp.example.com/mcp")).rejects.toBe(loginRequired);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(oauthMocks.resolve.mock.calls[1]?.[0]).toMatchObject({
      interactiveAuthorizationRequired: true,
      scope: "docs.write",
    });

    oauthMocks.resolve.mockReset().mockResolvedValue("test-token-placeholder");
    fetchFn.mockReset().mockResolvedValue(new Response("forbidden", { status: 403 }));
    await expect(wrapped("https://mcp.example.com/mcp")).resolves.toMatchObject({ status: 403 });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(oauthMocks.resolve).toHaveBeenCalledOnce();
  });

  it("returns the second rejection without an unbounded auth loop", async () => {
    oauthMocks.resolve
      .mockResolvedValueOnce("decoy-token")
      .mockResolvedValueOnce("test-auth-token");
    const fetchFn = vi.fn<FetchLike>(async () => new Response("no", { status: 401 }));
    const wrapped = withMcpOAuthBearer({
      fetchFn,
      authFetchFn: fetchFn,
      serverName: "docs",
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await expect(wrapped("https://mcp.example.com/mcp")).resolves.toMatchObject({ status: 401 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(oauthMocks.resolve).toHaveBeenCalledTimes(2);
    expect(oauthMocks.recordAuthorizationRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        rejectedAccessToken: "test-auth-token",
        serverName: "docs",
        serverUrl: "https://mcp.example.com/mcp",
      }),
    );
  });
});
