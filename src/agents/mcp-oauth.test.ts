// Covers MCP OAuth token persistence, isolation, and noninteractive behavior.
import fs from "node:fs/promises";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  clearMcpOAuthCredentials,
  createMcpOAuthClientProvider,
  resolveMcpOAuthAccessToken,
  runMcpOAuthLogin,
} from "./mcp-oauth.js";

const authMock = vi.hoisted(() => vi.fn());

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: authMock,
}));

describe("MCP OAuth provider", () => {
  beforeEach(() => {
    authMock.mockReset();
  });

  it("returns a fresh stored access token without refreshing it", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({
          access_token: "fresh-access",
          refresh_token: "refresh-token-must-not-project",
          token_type: "Bearer",
          expires_in: 3600,
        });

        await expect(
          resolveMcpOAuthAccessToken({
            serverName: "Remote Docs",
            serverUrl: "https://mcp.example.com/mcp",
          }),
        ).resolves.toBe("fresh-access");
        expect(authMock).not.toHaveBeenCalled();
      },
      {
        prefix: "openclaw-mcp-oauth-fresh-token-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("refreshes an expired stored access token before projecting it", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({
          access_token: "expired-access",
          refresh_token: "refresh-token-must-not-project",
          token_type: "Bearer",
          expires_in: -1,
        });
        authMock.mockImplementationOnce(async (refreshProvider) => {
          await refreshProvider.saveTokens({
            access_token: "refreshed-access",
            refresh_token: "rotated-refresh-token-must-not-project",
            token_type: "Bearer",
            expires_in: 3600,
          });
          return "AUTHORIZED";
        });

        await expect(
          resolveMcpOAuthAccessToken({
            serverName: "Remote Docs",
            serverUrl: "https://mcp.example.com/mcp",
            config: { scope: "docs.read" },
          }),
        ).resolves.toBe("refreshed-access");
        expect(authMock).toHaveBeenCalledOnce();
        expect(authMock.mock.calls[0]?.[1]).toMatchObject({
          serverUrl: "https://mcp.example.com/mcp",
          scope: "docs.read",
        });
      },
      {
        prefix: "openclaw-mcp-oauth-expired-token-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("serializes concurrent refreshes for the same OAuth credential store", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({
          access_token: "expired-access",
          refresh_token: "single-use-refresh-token",
          token_type: "Bearer",
          expires_in: -1,
        });

        let signalRefreshStarted: (() => void) | undefined;
        const refreshStarted = new Promise<void>((resolve) => {
          signalRefreshStarted = resolve;
        });
        let releaseRefresh: (() => void) | undefined;
        const refreshGate = new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        authMock.mockImplementationOnce(async (refreshProvider) => {
          signalRefreshStarted?.();
          await refreshGate;
          await refreshProvider.saveTokens({
            access_token: "shared-refreshed-access",
            refresh_token: "rotated-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
          return "AUTHORIZED";
        });

        const first = resolveMcpOAuthAccessToken({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await refreshStarted;
        const second = resolveMcpOAuthAccessToken({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        releaseRefresh?.();

        await expect(Promise.all([first, second])).resolves.toEqual([
          "shared-refreshed-access",
          "shared-refreshed-access",
        ]);
        expect(authMock).toHaveBeenCalledOnce();
      },
      {
        prefix: "openclaw-mcp-oauth-concurrent-refresh-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("refreshes pre-upgrade token stores that have no expiry timestamp", async () => {
    await withTempHome(
      async (home) => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({
          access_token: "legacy-access",
          refresh_token: "legacy-refresh-token-must-not-project",
          token_type: "Bearer",
          expires_in: 3600,
        });
        const tokenDir = `${home}/.openclaw/mcp-oauth`;
        const [entry] = await fs.readdir(tokenDir);
        const tokenPath = `${tokenDir}/${entry}`;
        const legacyStore = JSON.parse(await fs.readFile(tokenPath, "utf-8")) as Record<
          string,
          unknown
        >;
        delete legacyStore.tokenExpiresAt;
        await fs.writeFile(tokenPath, JSON.stringify(legacyStore, null, 2), "utf-8");
        authMock.mockImplementationOnce(async (refreshProvider) => {
          await refreshProvider.saveTokens({
            access_token: "refreshed-legacy-access",
            refresh_token: "rotated-refresh-token-must-not-project",
            token_type: "Bearer",
            expires_in: 3600,
          });
          return "AUTHORIZED";
        });

        await expect(
          resolveMcpOAuthAccessToken({
            serverName: "Remote Docs",
            serverUrl: "https://mcp.example.com/mcp",
          }),
        ).resolves.toBe("refreshed-legacy-access");
        expect(authMock).toHaveBeenCalledOnce();
      },
      {
        prefix: "openclaw-mcp-oauth-legacy-token-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("requires explicit login when no native OAuth credentials exist", async () => {
    await withTempHome(
      async () => {
        await expect(
          resolveMcpOAuthAccessToken({
            serverName: "Remote Docs",
            serverUrl: "https://mcp.example.com/mcp",
          }),
        ).rejects.toThrow("Run openclaw mcp login Remote Docs.");
        expect(authMock).not.toHaveBeenCalled();
      },
      {
        prefix: "openclaw-mcp-oauth-missing-token-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("stores token state under the OpenClaw state directory with restricted permissions", async () => {
    await withTempHome(
      async (home) => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({ access_token: "access", token_type: "Bearer" });

        await expect(provider.tokens()).resolves.toEqual({
          access_token: "access",
          token_type: "Bearer",
        });

        // Token files live under state, not workspace config, and are mode
        // 0600 because they contain bearer credentials.
        const tokenDir = `${home}/.openclaw/mcp-oauth`;
        const entries = await fs.readdir(tokenDir);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatch(/^Remote-Docs-[a-f0-9]{16}\.json$/);
        const tokenPath = `${tokenDir}/${entries[0]}`;
        const stat = await fs.stat(tokenPath);
        expect(stat.mode & 0o777).toBe(0o600);
      },
      {
        prefix: "openclaw-mcp-oauth-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("isolates token state by configured server URL", async () => {
    await withTempHome(
      async () => {
        const first = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        const second = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://other.example.com/mcp",
        });
        await first.saveTokens({ access_token: "access", token_type: "Bearer" });

        await expect(second.tokens()).resolves.toBeUndefined();
      },
      {
        prefix: "openclaw-mcp-oauth-url-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("keeps the legacy loopback redirect as the default for upgrade compatibility", () => {
    const provider = createMcpOAuthClientProvider({
      serverName: "Calendly",
      serverUrl: "https://mcp.calendly.com/",
    });

    expect(provider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:8989/oauth/callback"]);
    expect(provider.redirectUrl).toBe("http://127.0.0.1:8989/oauth/callback");
  });

  it("retries MCP OAuth login with localhost after redirect registration rejection", async () => {
    authMock.mockReset();
    authMock
      .mockRejectedValueOnce(new Error("invalid_client_metadata: redirect_uri rejected"))
      .mockResolvedValueOnce("AUTHORIZED");

    await expect(
      runMcpOAuthLogin({
        serverName: "Calendly",
        serverUrl: "https://mcp.calendly.com/",
      }),
    ).resolves.toBe("authorized");

    expect(authMock).toHaveBeenCalledTimes(2);
    expect(authMock.mock.calls[1]?.[0]?.clientMetadata.redirect_uris).toEqual([
      "http://localhost:8989/oauth/callback",
    ]);
  });

  it("does not retry a code exchange redirect mismatch", async () => {
    authMock.mockReset();
    authMock.mockRejectedValueOnce(new Error("invalid_grant: redirect_uri mismatch"));

    await expect(
      runMcpOAuthLogin({
        serverName: "Calendly",
        serverUrl: "https://mcp.calendly.com/",
        authorizationCode: "code-123",
      }),
    ).rejects.toThrow("redirect_uri mismatch");

    expect(authMock).toHaveBeenCalledOnce();
  });

  it("does not persist localhost when the fallback attempt fails", async () => {
    await withTempHome(
      async (home) => {
        authMock.mockReset();
        authMock
          .mockRejectedValueOnce(new Error("invalid_client_metadata: redirect_uri rejected"))
          .mockRejectedValueOnce(new Error("localhost redirect also rejected"));

        await expect(
          runMcpOAuthLogin({
            serverName: "Calendly",
            serverUrl: "https://mcp.calendly.com/",
          }),
        ).rejects.toThrow("localhost redirect also rejected");

        await expect(fs.readdir(`${home}/.openclaw/mcp-oauth`)).resolves.toEqual([]);
      },
      {
        prefix: "openclaw-mcp-oauth-localhost-failure-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("persists localhost redirect for a later code exchange login", async () => {
    await withTempHome(
      async (home) => {
        authMock.mockReset();
        authMock
          .mockRejectedValueOnce(new Error("invalid_client_metadata: redirect_uri rejected"))
          .mockImplementationOnce(async (provider) => {
            await provider.saveCodeVerifier?.("verifier");
            return "REDIRECT";
          });

        await expect(
          runMcpOAuthLogin({
            serverName: "Calendly",
            serverUrl: "https://mcp.calendly.com/",
            onAuthorizationUrl: () => {},
          }),
        ).resolves.toBe("redirect");

        const tokenDir = `${home}/.openclaw/mcp-oauth`;
        const entries = await fs.readdir(tokenDir);
        const store = JSON.parse(await fs.readFile(`${tokenDir}/${entries[0]}`, "utf-8")) as {
          codeVerifier?: string;
          redirectUrl?: string;
        };
        expect(store.redirectUrl).toBe("http://localhost:8989/oauth/callback");
        expect(store.codeVerifier).toBe("verifier");

        authMock.mockReset();
        authMock.mockResolvedValueOnce("AUTHORIZED");
        await runMcpOAuthLogin({
          serverName: "Calendly",
          serverUrl: "https://mcp.calendly.com/",
          authorizationCode: "code-123",
        });
        expect(authMock.mock.calls[0]?.[0]?.clientMetadata.redirect_uris).toEqual([
          "http://localhost:8989/oauth/callback",
        ]);
      },
      {
        prefix: "openclaw-mcp-oauth-localhost-persist-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("does not start hidden authorization flows without an authorization callback", async () => {
    // Normal agent/tool execution must not open browser auth flows implicitly;
    // operators use the explicit mcp login command instead.
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });

        await expect(provider.state?.()).rejects.toThrow("Run openclaw mcp login Remote Docs.");
        await expect(provider.saveCodeVerifier?.("verifier")).rejects.toThrow(
          "Run openclaw mcp login Remote Docs.",
        );
        await expect(
          provider.redirectToAuthorization?.(new URL("https://auth.example.com/authorize")),
        ).rejects.toThrow("Run openclaw mcp login Remote Docs.");
      },
      {
        prefix: "openclaw-mcp-oauth-noninteractive-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("clears stored credentials for a configured server URL", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({ access_token: "access", token_type: "Bearer" });

        await clearMcpOAuthCredentials({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });

        await expect(provider.tokens()).resolves.toBeUndefined();
      },
      {
        prefix: "openclaw-mcp-oauth-clear-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });
});
