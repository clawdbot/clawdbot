/** Tests auth-profile backed MCP bearer projection. */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMcpBearerBundleConfig, withMcpAuthProfileBearer } from "./mcp-auth-profile.js";
import * as mcpHttpFetch from "./mcp-http-fetch.js";

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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("projects existing MCP-native OAuth credentials without an auth profile", async () => {
    const buildMcpHttpFetch = vi.spyOn(mcpHttpFetch, "buildMcpHttpFetch");
    authMocks.resolveMcpOAuthAccessToken.mockResolvedValueOnce("native-access-token");

    const resolved = await resolveMcpBearerBundleConfig({
      config: {
        mcpServers: {
          docs: {
            url: "https://mcp.example.com/mcp",
            type: "http",
            auth: "oauth",
            oauth: { scope: "docs.read" },
            requestTimeoutMs: 25,
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
    expect(buildMcpHttpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceUrl: "https://mcp.example.com/mcp",
        timeoutMs: 25,
      }),
    );
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

    const server = expectDefined(
      resolved.config.mcpServers.ducktape,
      "resolved.config.mcpServers.ducktape test invariant",
    );
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

  it("projects top-level static token profiles into env-backed CLI bearer headers", async () => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValueOnce({
      version: 1,
      profiles: {
        "ducktape:static": {
          type: "token",
          provider: "ducktape",
          token: "static-token",
        },
      },
    });
    authMocks.resolveApiKeyForProfile.mockResolvedValueOnce({
      apiKey: "static-token",
      provider: "ducktape",
      profileId: "ducktape:static",
      profileType: "token",
    });

    const resolved = await resolveMcpBearerBundleConfig({
      config: {
        mcpServers: {
          ducktape: {
            url: "https://agents.ducktape.xyz/mcp",
            authProfileId: "ducktape:static",
            headers: {
              Authorization: "Bearer stale-access",
              "X-Trace": "keep",
            },
          },
        },
      },
    });

    const server = expectDefined(
      resolved.config.mcpServers.ducktape,
      "resolved.config.mcpServers.ducktape test invariant",
    );
    expect(server.authProfileId).toBeUndefined();
    expect(server.auth).toBeUndefined();
    expect(server.oauth).toBeUndefined();
    expect(server.headers).toEqual({
      Authorization: expect.stringMatching(/^Bearer \$\{OPENCLAW_MCP_AUTH_[A-F0-9]{12}_TOKEN}$/),
      "X-Trace": "keep",
    });
    expect(Object.values(resolved.env ?? {})).toEqual(["static-token"]);
    expect(JSON.stringify(resolved.config)).not.toContain("static-token");
  });

  it("keeps legacy oauth.authProfileId bindings compatible", async () => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValueOnce({
      version: 1,
      profiles: {
        "ducktape:static": {
          type: "token",
          provider: "ducktape",
          token: "static-token",
        },
      },
    });
    authMocks.resolveApiKeyForProfile.mockResolvedValueOnce({
      apiKey: "static-token",
      provider: "ducktape",
      profileId: "ducktape:static",
      profileType: "token",
    });

    const resolved = await resolveMcpBearerBundleConfig({
      config: {
        mcpServers: {
          ducktape: {
            url: "https://agents.ducktape.xyz/mcp",
            auth: "oauth",
            oauth: { authProfileId: "ducktape:static" },
          },
        },
      },
    });

    expect(resolved.config.mcpServers.ducktape?.auth).toBeUndefined();
    expect(resolved.config.mcpServers.ducktape?.oauth).toBeUndefined();
    expect(resolved.config.mcpServers.ducktape?.headers).toEqual({
      Authorization: expect.stringMatching(/^Bearer \$\{OPENCLAW_MCP_AUTH_[A-F0-9]{12}_TOKEN}$/),
    });
    expect(Object.values(resolved.env ?? {})).toEqual(["static-token"]);
  });

  it("accepts matching top-level and legacy auth profile selectors during migration", async () => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValueOnce({
      version: 1,
      profiles: {
        "ducktape:static": {
          type: "token",
          provider: "ducktape",
          token: "static-token",
        },
      },
    });
    authMocks.resolveApiKeyForProfile.mockResolvedValueOnce({
      apiKey: "static-token",
      provider: "ducktape",
      profileId: "ducktape:static",
      profileType: "token",
    });

    const resolved = await resolveMcpBearerBundleConfig({
      config: {
        mcpServers: {
          ducktape: {
            url: "https://agents.ducktape.xyz/mcp",
            authProfileId: "ducktape:static",
            auth: "oauth",
            oauth: { authProfileId: "ducktape:static" },
          },
        },
      },
    });

    expect(resolved.config.mcpServers.ducktape?.authProfileId).toBeUndefined();
    expect(resolved.config.mcpServers.ducktape?.auth).toBeUndefined();
    expect(resolved.config.mcpServers.ducktape?.oauth).toBeUndefined();
    expect(resolved.config.mcpServers.ducktape?.headers).toEqual({
      Authorization: expect.stringMatching(/^Bearer \$\{OPENCLAW_MCP_AUTH_[A-F0-9]{12}_TOKEN}$/),
    });
    expect(Object.values(resolved.env ?? {})).toEqual(["static-token"]);
  });

  it("rejects conflicting top-level and legacy auth profile selectors", async () => {
    await expect(
      resolveMcpBearerBundleConfig({
        config: {
          mcpServers: {
            ducktape: {
              url: "https://agents.ducktape.xyz/mcp",
              authProfileId: "ducktape:static",
              auth: "oauth",
              oauth: { authProfileId: "ducktape:legacy" },
            },
          },
        },
      }),
    ).rejects.toThrow(
      'conflicting auth profile selectors: authProfileId "ducktape:static" differs from legacy oauth.authProfileId "ducktape:legacy"',
    );
    expect(authMocks.loadAuthProfileStoreForSecretsRuntime).not.toHaveBeenCalled();
    expect(authMocks.resolveApiKeyForProfile).not.toHaveBeenCalled();
  });

  it("rejects expired token profiles instead of projecting stale bearer headers", async () => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValueOnce({
      version: 1,
      profiles: {
        "ducktape:expired": {
          type: "token",
          provider: "ducktape",
          token: "expired-static-token",
          expires: 1,
        },
      },
    });
    authMocks.resolveApiKeyForProfile.mockResolvedValueOnce(null);

    await expect(
      resolveMcpBearerBundleConfig({
        config: {
          mcpServers: {
            ducktape: {
              url: "https://agents.ducktape.xyz/mcp",
              authProfileId: "ducktape:expired",
            },
          },
        },
      }),
    ).rejects.toThrow('could not resolve bearer auth profile "ducktape:expired"');
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

  it("rejects OAuth profiles without raw access instead of projecting provider-formatted auth", async () => {
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
        token: "provider-formatted-token",
        projectId: "demo-project",
      }),
      provider: "google",
      profileId: "google:mcp",
      profileType: "oauth",
      credential: {
        type: "oauth",
        provider: "google",
        refresh: "refresh-token-must-not-project",
        expires: Date.now() + 60_000,
      },
    });

    await expect(
      resolveMcpBearerBundleConfig({
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
      }),
    ).rejects.toThrow('could not resolve raw OAuth access token for auth profile "google:mcp"');
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

  it("injects static token bearer headers for same-origin embedded MCP requests", async () => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "ducktape:static": {
          type: "token",
          provider: "ducktape",
          token: "static-token",
        },
      },
    });
    authMocks.resolveApiKeyForProfile.mockResolvedValue({
      apiKey: "static-token",
      provider: "ducktape",
      profileId: "ducktape:static",
      profileType: "token",
    });
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const wrapped = withMcpAuthProfileBearer({
      fetchFn: async (url, init) => {
        calls.push([url, init]);
        return new Response("ok");
      },
      serverName: "ducktape",
      resourceUrl: "https://agents.ducktape.xyz/mcp",
      authProfileId: "ducktape:static",
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
    expect(sameOriginHeaders.get("authorization")).toBe("Bearer static-token");
    expect(sameOriginHeaders.get("x-trace")).toBe("keep");
    expect(sameOriginHeaders.get("accept")).toBe("application/json");
    expect(calls[1]?.[1]?.headers).toEqual({ Authorization: "Bearer sdk-stale" });
  });
});
