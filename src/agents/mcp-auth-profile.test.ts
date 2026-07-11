/** Tests auth-profile backed MCP bearer projection. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMcpBearerBundleConfig, withMcpAuthProfileBearer } from "./mcp-auth-profile.js";

const authMocks = vi.hoisted(() => ({
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
  resolveMcpOAuthAccessToken: vi.fn(),
}));

vi.mock("./auth-profiles/store.js", () => ({
  loadAuthProfileStoreForSecretsRuntime: authMocks.loadAuthProfileStoreForSecretsRuntime,
}));

vi.mock("./auth-profiles/oauth.js", () => ({
  resolveApiKeyForProfile: authMocks.resolveApiKeyForProfile,
}));

vi.mock("./mcp-oauth.js", () => ({
  resolveMcpOAuthAccessToken: authMocks.resolveMcpOAuthAccessToken,
}));

describe("mcp auth profile bearer projection", () => {
  beforeEach(() => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReset();
    authMocks.resolveApiKeyForProfile.mockReset();
    authMocks.resolveMcpOAuthAccessToken.mockReset();
  });

  it("projects existing MCP-native OAuth credentials without an auth profile", async () => {
    authMocks.resolveMcpOAuthAccessToken.mockResolvedValueOnce("native-access-token");

    const resolved = await resolveMcpBearerBundleConfig({
      config: {
        mcpServers: {
          docs: {
            url: "https://mcp.example.com/mcp",
            type: "http",
            auth: "oauth",
            oauth: { scope: "docs.read" },
          },
        },
      },
    });

    expect(resolved.config.mcpServers.docs).toMatchObject({
      url: "https://mcp.example.com/mcp",
      headers: {
        Authorization: expect.stringMatching(/^Bearer \$\{OPENCLAW_MCP_AUTH_[A-F0-9]{12}_TOKEN}$/),
      },
    });
    expect(resolved.config.mcpServers.docs?.auth).toBeUndefined();
    expect(resolved.config.mcpServers.docs?.oauth).toBeUndefined();
    expect(Object.values(resolved.env ?? {})).toEqual(["native-access-token"]);
    expect(authMocks.resolveMcpOAuthAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "docs",
        serverUrl: "https://mcp.example.com/mcp",
        config: { scope: "docs.read" },
        fetchFn: expect.any(Function),
      }),
    );
  });

  it("omits unavailable OAuth servers when graceful degradation is requested", async () => {
    authMocks.resolveMcpOAuthAccessToken.mockRejectedValueOnce(
      new Error('MCP server "gbrain" requires OAuth authorization.'),
    );
    const onServerUnavailable = vi.fn();

    const resolved = await resolveMcpBearerBundleConfig({
      config: {
        mcpServers: {
          gbrain: {
            url: "https://gbrain.example.com/mcp",
            type: "http",
            auth: "oauth",
          },
          localTools: {
            command: "local-tools",
          },
        },
      },
      omitUnavailableOAuthServers: true,
      onServerUnavailable,
    });

    expect(resolved.config.mcpServers).toStrictEqual({
      localTools: { command: "local-tools" },
    });
    expect(onServerUnavailable).toHaveBeenCalledWith("gbrain", expect.any(Error));
  });

  it("resolves refreshable OAuth profiles into env-backed CLI bearer headers", async () => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValueOnce({
      version: 1,
      profiles: {
        "ducktape:mcp": {
          type: "oauth",
          provider: "ducktape",
          access: "expired-access",
          refresh: "refresh-token-must-not-project",
          expires: 1,
        },
      },
    });
    authMocks.resolveApiKeyForProfile.mockResolvedValueOnce({
      apiKey: "fresh-access-token",
      provider: "ducktape",
      profileId: "ducktape:mcp",
      profileType: "oauth",
      credential: {
        type: "oauth",
        provider: "ducktape",
        access: "fresh-access-token",
        refresh: "refresh-token-must-not-project",
        expires: Date.now() + 60_000,
      },
    });

    const resolved = await resolveMcpBearerBundleConfig({
      config: {
        mcpServers: {
          ducktape: {
            url: "https://agents.ducktape.xyz/mcp",
            type: "http",
            auth: "oauth",
            oauth: { authProfileId: "ducktape:mcp" },
            headers: {
              Authorization: "Bearer stale-access",
              "X-Trace": "keep",
            },
          },
        },
      },
    });

    const server = resolved.config.mcpServers.ducktape;
    expect(server.auth).toBeUndefined();
    expect(server.oauth).toBeUndefined();
    expect(server.headers).toEqual({
      Authorization: expect.stringMatching(/^Bearer \$\{OPENCLAW_MCP_AUTH_[A-F0-9]{12}_TOKEN}$/),
      "X-Trace": "keep",
    });
    expect(JSON.stringify(resolved.config)).not.toContain("refresh-token-must-not-project");
    expect(JSON.stringify(resolved.env)).not.toContain("refresh-token-must-not-project");
    expect(Object.values(resolved.env ?? {})).toEqual(["fresh-access-token"]);
    expect(authMocks.resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "ducktape:mcp",
      }),
    );
    expect(authMocks.resolveMcpOAuthAccessToken).not.toHaveBeenCalled();
  });

  it("rejects static token profiles instead of pretending they are refreshable", async () => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValueOnce({
      version: 1,
      profiles: {
        "ducktape:static": {
          type: "token",
          provider: "ducktape",
          token: "expired-static-token",
          expires: 1,
        },
      },
    });

    await expect(
      resolveMcpBearerBundleConfig({
        config: {
          mcpServers: {
            ducktape: {
              url: "https://agents.ducktape.xyz/mcp",
              auth: "oauth",
              oauth: { authProfileId: "ducktape:static" },
            },
          },
        },
      }),
    ).rejects.toThrow("profiles are not refreshable");
  });

  it("projects the raw OAuth access token even when provider formatting returns structured auth", async () => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValueOnce({
      version: 1,
      profiles: {
        "google:mcp": {
          type: "oauth",
          provider: "google",
          access: "expired-access",
          refresh: "refresh-token-must-not-project",
          expires: 1,
        },
      },
    });
    authMocks.resolveApiKeyForProfile.mockResolvedValueOnce({
      apiKey: JSON.stringify({
        token: "raw-google-access-token",
        projectId: "demo-project",
      }),
      provider: "google",
      profileId: "google:mcp",
      profileType: "oauth",
      credential: {
        type: "oauth",
        provider: "google",
        access: "raw-google-access-token",
        refresh: "refresh-token-must-not-project",
        expires: Date.now() + 60_000,
      },
    });

    const resolved = await resolveMcpBearerBundleConfig({
      config: {
        mcpServers: {
          google: {
            url: "https://mcp.google.test/mcp",
            type: "http",
            auth: "oauth",
            oauth: { authProfileId: "google:mcp" },
          },
        },
      },
      tokenProjection: "literal",
    });

    expect(resolved.config.mcpServers.google?.headers).toEqual({
      Authorization: "Bearer raw-google-access-token",
    });
    expect(resolved.env).toBeUndefined();
    expect(JSON.stringify(resolved.config)).not.toContain("demo-project");
    expect(JSON.stringify(resolved.config)).not.toContain('{"token"');
  });

  it("injects fresh bearer headers only for same-origin embedded MCP requests", async () => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "ducktape:mcp": {
          type: "oauth",
          provider: "ducktape",
          access: "expired-access",
          refresh: "refresh-token-must-not-project",
          expires: 1,
        },
      },
    });
    authMocks.resolveApiKeyForProfile.mockResolvedValue({
      apiKey: "fresh-access-token",
      provider: "ducktape",
      profileId: "ducktape:mcp",
      profileType: "oauth",
      credential: {
        type: "oauth",
        provider: "ducktape",
        access: "fresh-access-token",
        refresh: "refresh-token-must-not-project",
        expires: Date.now() + 60_000,
      },
    });
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const wrapped = withMcpAuthProfileBearer({
      fetchFn: async (url, init) => {
        calls.push([url, init]);
        return new Response("ok");
      },
      serverName: "ducktape",
      resourceUrl: "https://agents.ducktape.xyz/mcp",
      authProfileId: "ducktape:mcp",
      headers: {
        Authorization: "Bearer stale-access",
        "X-Trace": "keep",
      },
    });

    await wrapped("https://agents.ducktape.xyz/mcp", {
      headers: { Accept: "application/json", Authorization: "Bearer sdk-stale" },
    });
    await wrapped("https://redirect.example/mcp", {
      headers: { Authorization: "Bearer sdk-stale" },
    });

    const sameOriginHeaders = new Headers(calls[0]?.[1]?.headers);
    expect(sameOriginHeaders.get("authorization")).toBe("Bearer fresh-access-token");
    expect(sameOriginHeaders.get("x-trace")).toBe("keep");
    expect(sameOriginHeaders.get("accept")).toBe("application/json");
    expect(calls[1]?.[1]?.headers).toEqual({ Authorization: "Bearer sdk-stale" });
  });
});
