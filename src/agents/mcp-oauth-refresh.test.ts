// Covers MCP OAuth token refresh, lease cancellation, and concurrency.
import path from "node:path";
import { withTempHome as withBaseTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createMcpOAuthClientProvider, withMcpOAuthLeaseSignal } from "./mcp-oauth-provider.js";
import { readMcpOAuthStore, resolveMcpOAuthStoreKey } from "./mcp-oauth-store.js";
import { clearMcpOAuthCredentials, resolveMcpOAuthAccessToken } from "./mcp-oauth.js";

const authMock = vi.hoisted(() => vi.fn());
const FRESH_ACCESS = "test-token-placeholder";
const ROTATED_ACCESS = "gateway-token";

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: authMock,
}));

async function withTempHome<T>(
  run: (home: string) => T | Promise<T>,
  options: Parameters<typeof withBaseTempHome>[1],
): Promise<T> {
  return withBaseTempHome(async (home) => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
    closeOpenClawStateDatabaseForTest();
    try {
      return await run(home);
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  }, options);
}

describe("MCP OAuth provider", () => {
  beforeEach(() => {
    authMock.mockReset();
    closeOpenClawStateDatabaseForTest();
  });

  afterEach(() => closeOpenClawStateDatabaseForTest());

  it("aborts OAuth fetches when their owning lease signal is lost", async () => {
    const lease = new AbortController();
    const reason = new Error("lease lost");
    const fetchFn = vi.fn(
      async (_url: string | URL, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              const abortReason = init.signal?.reason;
              reject(abortReason instanceof Error ? abortReason : new Error("fetch aborted"));
            },
            { once: true },
          );
        }),
    );
    const guardedFetch = withMcpOAuthLeaseSignal(fetchFn, lease.signal);

    const pending = guardedFetch("https://auth.example.com/token");
    lease.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBe(lease.signal);
  });

  it("returns a fresh stored access token without refreshing it", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({
          access_token: "test-token-placeholder",
          refresh_token: "test-auth-token",
          token_type: "Bearer",
          expires_in: 3600,
        });

        await expect(
          resolveMcpOAuthAccessToken({
            serverName: "Remote Docs",
            serverUrl: "https://mcp.example.com/mcp",
          }),
        ).resolves.toBe(FRESH_ACCESS);
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

  it("aborts an in-flight refresh, preserves tokens, and releases its lease", async () => {
    await withTempHome(
      async () => {
        const serverName = "Remote Docs";
        const serverUrl = "https://mcp.example.com/mcp";
        const provider = createMcpOAuthClientProvider({ serverName, serverUrl });
        await provider.saveTokens({
          access_token: "decoy-token",
          refresh_token: "test-auth-token",
          token_type: "Bearer",
          expires_in: -1,
        });
        let signalStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
          signalStarted = resolve;
        });
        let refreshSignal: AbortSignal | undefined;
        const fetchFn = vi.fn(
          async (_url: string | URL, init?: RequestInit): Promise<Response> =>
            await new Promise<Response>((_resolve, reject) => {
              refreshSignal = init?.signal ?? undefined;
              const rejectAbort = () => {
                const abortReason = refreshSignal?.reason;
                reject(abortReason instanceof Error ? abortReason : new Error("refresh aborted"));
              };
              if (refreshSignal?.aborted) {
                rejectAbort();
              } else {
                refreshSignal?.addEventListener("abort", rejectAbort, { once: true });
              }
              signalStarted?.();
            }),
        );
        authMock.mockImplementationOnce(async (_refreshProvider, options) => {
          await options.fetchFn("https://auth.example.com/token");
          return "AUTHORIZED";
        });
        const controller = new AbortController();

        const refresh = resolveMcpOAuthAccessToken({
          serverName,
          serverUrl,
          fetchFn,
          signal: controller.signal,
        });
        await started;
        controller.abort(new Error("request stopped"));

        await expect(refresh).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
        expect(refreshSignal).toMatchObject({ aborted: true });
        expect(provider.tokens()).toMatchObject({
          access_token: "decoy-token",
          refresh_token: "test-auth-token",
        });
        const leaseCount = openOpenClawStateDatabase()
          .db.prepare("SELECT COUNT(*) AS count FROM state_leases WHERE scope = ?")
          .get("core:mcp-oauth") as { count: number };
        expect(leaseCount.count).toBe(0);
      },
      {
        prefix: "openclaw-mcp-oauth-aborted-refresh-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
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
          access_token: "decoy-token",
          refresh_token: "test-auth-token",
          token_type: "Bearer",
          expires_in: -1,
        });
        authMock.mockImplementationOnce(async (refreshProvider) => {
          await refreshProvider.saveTokens({
            access_token: "gateway-token",
            refresh_token: "secret-token",
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
        ).resolves.toBe(ROTATED_ACCESS);
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
          access_token: "decoy-token",
          refresh_token: "test-auth-token",
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
            access_token: "gateway-token",
            refresh_token: "secret-token",
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
          ROTATED_ACCESS,
          ROTATED_ACCESS,
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

  it("does not restore a stale challenge after a concurrent refresh rotates the token", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({
          access_token: "decoy-token",
          refresh_token: "test-auth-token",
          token_type: "Bearer",
          expires_in: 3600,
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
          await refreshProvider.saveTokens({
            access_token: "gateway-token",
            refresh_token: "secret-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
          signalRefreshStarted?.();
          await refreshGate;
          return "AUTHORIZED";
        });

        const first = resolveMcpOAuthAccessToken({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
          authorizationChallenge: true,
          rejectedAccessToken: "decoy-token",
          scope: "docs.read",
        });
        await refreshStarted;
        const second = resolveMcpOAuthAccessToken({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
          authorizationChallenge: true,
          rejectedAccessToken: "decoy-token",
          scope: "stale.scope",
        });
        releaseRefresh?.();

        await expect(Promise.all([first, second])).resolves.toEqual([
          ROTATED_ACCESS,
          ROTATED_ACCESS,
        ]);
        expect(authMock).toHaveBeenCalledOnce();
        expect(
          readMcpOAuthStore(resolveMcpOAuthStoreKey("Remote Docs", "https://mcp.example.com/mcp"))
            .pendingAuthorizationChallenge,
        ).toBeUndefined();
      },
      {
        prefix: "openclaw-mcp-oauth-concurrent-challenge-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("does not let a completed refresh resurrect a concurrent logout", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({
          access_token: "decoy-token",
          refresh_token: "test-auth-token",
          token_type: "Bearer",
          expires_in: -1,
        });
        let signalStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
          signalStarted = resolve;
        });
        let releaseRefresh: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        authMock.mockImplementationOnce(async (refreshProvider) => {
          signalStarted?.();
          await gate;
          await refreshProvider.saveTokens({
            access_token: "gateway-token",
            refresh_token: "secret-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
          return "AUTHORIZED";
        });

        const refresh = resolveMcpOAuthAccessToken({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await started;
        const logout = clearMcpOAuthCredentials({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        releaseRefresh?.();

        await expect(refresh).resolves.toBe(ROTATED_ACCESS);
        await logout;
        expect(provider.tokens()).toBeUndefined();
      },
      {
        prefix: "openclaw-mcp-oauth-refresh-logout-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("refreshes a resource-rejected token even while its expiry is fresh", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({
          access_token: "decoy-token",
          refresh_token: "test-auth-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
        authMock.mockImplementationOnce(async (refreshProvider) => {
          await refreshProvider.saveTokens({
            access_token: "gateway-token",
            refresh_token: "secret-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
          return "AUTHORIZED";
        });

        await expect(
          resolveMcpOAuthAccessToken({
            serverName: "Remote Docs",
            serverUrl: "https://mcp.example.com/mcp",
            authorizationChallenge: true,
            rejectedAccessToken: "decoy-token",
            resourceMetadataUrl: new URL(
              "https://mcp.example.com/.well-known/oauth-protected-resource",
            ),
            scope: "docs.write",
          }),
        ).resolves.toBe(ROTATED_ACCESS);
        expect(authMock).toHaveBeenCalledOnce();
        expect(
          readMcpOAuthStore(resolveMcpOAuthStoreKey("Remote Docs", "https://mcp.example.com/mcp"))
            .pendingAuthorizationChallenge,
        ).toBeUndefined();
      },
      {
        prefix: "openclaw-mcp-oauth-rejected-token-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });
});
