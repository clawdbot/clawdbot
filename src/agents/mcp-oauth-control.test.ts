import path from "node:path";
import { withTempHome as withBaseTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { createMcpOAuthClientProvider } from "./mcp-oauth-provider.js";
import {
  MCP_OAUTH_PENDING_STATE_TTL_MS,
  readMcpOAuthPendingAuthorization as readPending,
  readMcpOAuthStore,
} from "./mcp-oauth-store.js";
import {
  cancelMcpOAuthAuthorization,
  readMcpOAuthControlStatus,
  settleExpiredMcpOAuthAuthorization,
  settleMcpOAuthCallback,
  startMcpOAuthAuthorization,
} from "./mcp-oauth.js";

const authMock = vi.hoisted(() => vi.fn());
const IDENTITY = operatorMcpOAuthIdentity("Remote Docs", "https://mcp.example.com/mcp");
const REDIRECT_URL = "https://gateway.example.com/oauth/mcp/callback";

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({ auth: authMock }));

function resolvedOAuthConfig() {
  return {
    kind: "http" as const,
    transportType: "streamable-http" as const,
    url: IDENTITY.serverUrl,
    auth: "oauth" as const,
    description: IDENTITY.serverUrl,
    connectionTimeoutMs: 30_000,
    requestTimeoutMs: 60_000,
    supportsParallelToolCalls: false,
  };
}

async function persistRedirect(
  provider: ReturnType<typeof createMcpOAuthClientProvider>,
  state: string,
) {
  await provider.saveCodeVerifier("synthetic-verifier");
  const authorizationUrl = new URL("https://accounts.example.com/authorize");
  authorizationUrl.searchParams.set("state", state);
  await provider.redirectToAuthorization(authorizationUrl);
  return "REDIRECT" as const;
}

async function withTempHome(run: () => Promise<void>): Promise<void> {
  await withBaseTempHome(
    async (home) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
      closeOpenClawStateDatabaseForTest();
      try {
        await run();
      } finally {
        closeOpenClawStateDatabaseForTest();
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    },
    {
      prefix: "openclaw-mcp-oauth-control-",
      skipSessionCleanup: true,
      env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
    },
  );
}

async function saveExistingCredential(): Promise<void> {
  await createMcpOAuthClientProvider({ identity: IDENTITY }).saveTokens({
    access_token: "synthetic-access",
    token_type: "Bearer",
    expires_in: 3600,
  });
}

describe("MCP OAuth Control UI coordinator state", () => {
  beforeEach(() => {
    authMock.mockReset();
    closeOpenClawStateDatabaseForTest();
  });

  afterEach(() => closeOpenClawStateDatabaseForTest());

  it("preserves a usable credential while reauthorizing and cancels only the exact attempt", async () => {
    await withTempHome(async () => {
      await saveExistingCredential();
      authMock.mockImplementationOnce(async (provider) => {
        expect(await provider.tokens()).toBeUndefined();
        return await persistRedirect(provider, "reauthorize-state");
      });

      const started = await startMcpOAuthAuthorization(IDENTITY, resolvedOAuthConfig(), {
        forceAuthorization: true,
        redirectUrl: REDIRECT_URL,
      });
      if (started.status !== "redirect") {
        throw new Error("expected MCP OAuth redirect");
      }
      expect(readMcpOAuthControlStatus(IDENTITY)).toEqual({
        state: "authorizing",
        credentialPresent: true,
        authorizationId: started.authorizationId,
        startedAt: expect.any(Number),
      });
      await expect(cancelMcpOAuthAuthorization(IDENTITY, "stale-attempt")).resolves.toBe(false);
      expect(readPending(started.state)).toBe(IDENTITY.storeKey);

      await expect(cancelMcpOAuthAuthorization(IDENTITY, started.authorizationId)).resolves.toBe(
        true,
      );
      expect(readPending(started.state)).toBeUndefined();
      expect(readMcpOAuthControlStatus(IDENTITY)).toEqual({
        state: "ready",
        credentialPresent: true,
      });
      expect(readMcpOAuthStore(IDENTITY.storeKey).tokens?.access_token).toBe("synthetic-access");
    });
  });

  it("supersedes pending callbacks and settles failures without replacing the old credential", async () => {
    await withTempHome(async () => {
      await saveExistingCredential();
      authMock
        .mockImplementationOnce((provider) => persistRedirect(provider, "first-state"))
        .mockImplementationOnce((provider) => persistRedirect(provider, "second-state"));

      const first = await startMcpOAuthAuthorization(IDENTITY, resolvedOAuthConfig(), {
        forceAuthorization: true,
        redirectUrl: REDIRECT_URL,
      });
      const second = await startMcpOAuthAuthorization(IDENTITY, resolvedOAuthConfig(), {
        forceAuthorization: true,
        redirectUrl: REDIRECT_URL,
      });
      if (first.status !== "redirect" || second.status !== "redirect") {
        throw new Error("expected MCP OAuth redirects");
      }
      expect(readPending(first.state)).toBeUndefined();
      expect(readPending(second.state)).toBe(IDENTITY.storeKey);
      await expect(
        settleMcpOAuthCallback(IDENTITY, {
          state: first.state,
          category: "authorization-denied",
        }),
      ).resolves.toBe(false);
      await expect(
        settleMcpOAuthCallback(IDENTITY, {
          state: second.state,
          category: "exchange-failed",
        }),
      ).resolves.toBe(true);
      await expect(
        settleMcpOAuthCallback(IDENTITY, {
          state: second.state,
          category: "exchange-failed",
        }),
      ).resolves.toBe(false);
      expect(readPending(second.state)).toBeUndefined();
      expect(readMcpOAuthControlStatus(IDENTITY)).toEqual({
        state: "error",
        credentialPresent: true,
        category: "exchange-failed",
      });
      expect(readMcpOAuthStore(IDENTITY.storeKey).tokens?.access_token).toBe("synthetic-access");
    });
  });

  it("settles timeout and deletes pending state without deleting the old credential", async () => {
    await withTempHome(async () => {
      await saveExistingCredential();
      authMock.mockImplementationOnce((provider) => persistRedirect(provider, "timeout-state"));

      const started = await startMcpOAuthAuthorization(IDENTITY, resolvedOAuthConfig(), {
        forceAuthorization: true,
        redirectUrl: REDIRECT_URL,
      });
      if (started.status !== "redirect") {
        throw new Error("expected MCP OAuth redirect");
      }
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + MCP_OAUTH_PENDING_STATE_TTL_MS + 1);
      try {
        await expect(settleExpiredMcpOAuthAuthorization(IDENTITY)).resolves.toBe(true);
      } finally {
        clock.mockRestore();
      }

      expect(readPending(started.state)).toBeUndefined();
      expect(readMcpOAuthControlStatus(IDENTITY)).toEqual({
        state: "error",
        credentialPresent: true,
        category: "timed-out",
      });
      const store = readMcpOAuthStore(IDENTITY.storeKey);
      expect(store.tokens?.access_token).toBe("synthetic-access");
      expect(store.codeVerifier).toBeUndefined();
      expect(store.lastAuthorizationUrl).toBeUndefined();
      expect(store.redirectUrl).toBeUndefined();
    });
  });
});
