import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome as withBaseTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  operatorMcpOAuthIdentity,
  requesterMcpOAuthIdentity,
  type McpOAuthIdentity,
} from "./mcp-oauth-identity.js";
import { createMcpOAuthClientProvider } from "./mcp-oauth-provider.js";
import { readMcpOAuthStore, updateMcpOAuthStore } from "./mcp-oauth-store.js";
import {
  clearMcpOAuthCredentials,
  clearMcpOAuthServer,
  completeMcpOAuthAuthorization,
  countMcpOAuthPrincipals,
  readMcpOAuthCredentialsStatus,
  recordMcpOAuthAuthorizationRequired,
  resolveMcpOAuthAccessToken,
  startMcpOAuthAuthorization,
} from "./mcp-oauth.js";

const authMock = vi.hoisted(() => vi.fn());
const ROTATED_ACCESS = "gateway-token";
const LEGACY_ACCESS = "example";
const REMOTE_IDENTITY = operatorMcpOAuthIdentity("Remote Docs", "https://mcp.example.com/mcp");
const CALENDLY_IDENTITY = operatorMcpOAuthIdentity("Calendly", "https://mcp.calendly.com/");
const REQUESTER_SCOPE = { messageChannel: "telegram", agentAccountId: "bot" } as const;

function requesterIdentity(serverName: string, serverUrl: string, requesterSenderId: string) {
  return requesterMcpOAuthIdentity(serverName, serverUrl, {
    ...REQUESTER_SCOPE,
    requesterSenderId,
  });
}

async function saveAccessToken(identity: McpOAuthIdentity, accessToken: string): Promise<void> {
  await createMcpOAuthClientProvider({ identity }).saveTokens({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
  });
}

function resolvedOAuthConfig(identity: McpOAuthIdentity) {
  return {
    kind: "http" as const,
    transportType: "streamable-http" as const,
    url: identity.serverUrl,
    auth: "oauth" as const,
    description: identity.serverUrl,
    connectionTimeoutMs: 30_000,
    requestTimeoutMs: 60_000,
    supportsParallelToolCalls: false,
  };
}

async function persistRedirect(provider: ReturnType<typeof createMcpOAuthClientProvider>) {
  await provider.saveCodeVerifier("verifier");
  const authorizationUrl = new URL("https://auth.example.com/authorize");
  authorizationUrl.searchParams.set("redirect_uri", String(provider.redirectUrl));
  authorizationUrl.searchParams.set("state", "state-1234567890");
  await provider.redirectToAuthorization(authorizationUrl);
  return "REDIRECT" as const;
}

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

  it("reuses a valid stored session without persisting an authorization redirect", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({ identity: REMOTE_IDENTITY });
        await provider.saveTokens({
          access_token: "stored-access",
          refresh_token: "stored-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
        const before = readMcpOAuthStore(REMOTE_IDENTITY.storeKey);
        authMock.mockImplementationOnce(async (loginProvider) =>
          (await loginProvider.tokens()) ? "AUTHORIZED" : await persistRedirect(loginProvider),
        );

        await expect(
          startMcpOAuthAuthorization(REMOTE_IDENTITY, resolvedOAuthConfig(REMOTE_IDENTITY), {}),
        ).resolves.toEqual({ status: "authorized" });
        expect(readMcpOAuthStore(REMOTE_IDENTITY.storeKey)).toEqual(before);
      },
      {
        prefix: "openclaw-mcp-oauth-existing-session-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("preserves insufficient scope and forces the next login through authorization", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          identity: REMOTE_IDENTITY,
        });
        await provider.saveTokens({
          access_token: "decoy-token",
          refresh_token: "test-auth-token",
          token_type: "Bearer",
          expires_in: 3600,
        });

        await expect(
          resolveMcpOAuthAccessToken({
            identity: REMOTE_IDENTITY,
            authorizationChallenge: true,
            interactiveAuthorizationRequired: true,
            rejectedAccessToken: "decoy-token",
            scope: "docs.write",
          }),
        ).rejects.toThrow(
          'MCP server "Remote Docs" requires additional OAuth authorization. Run openclaw mcp login Remote Docs.',
        );
        expect(authMock).not.toHaveBeenCalled();
        expect(provider.tokens()).toMatchObject({
          access_token: "decoy-token",
          refresh_token: "test-auth-token",
        });
        expect(readMcpOAuthStore(REMOTE_IDENTITY.storeKey).pendingAuthorizationChallenge).toEqual({
          requiresAuthorization: true,
          scope: "docs.write",
        });
        await expect(readMcpOAuthCredentialsStatus(REMOTE_IDENTITY)).resolves.toMatchObject({
          state: "requires-authorization",
        });

        const storeKey = REMOTE_IDENTITY.storeKey;
        updateMcpOAuthStore(storeKey, (store) => ({ ...store, tokenExpiresAt: 0 }));
        await expect(
          resolveMcpOAuthAccessToken({
            identity: REMOTE_IDENTITY,
          }),
        ).rejects.toThrow("requires additional OAuth authorization");
        expect(authMock).not.toHaveBeenCalled();
        expect(readMcpOAuthStore(storeKey)).toMatchObject({
          tokens: { access_token: "decoy-token" },
          tokenExpiresAt: 0,
          pendingAuthorizationChallenge: {
            requiresAuthorization: true,
            scope: "docs.write",
          },
        });

        authMock.mockImplementationOnce(async (loginProvider, options) => {
          expect(await loginProvider.tokens()).toBeUndefined();
          expect(options.scope).toBe("docs.write");
          return await persistRedirect(loginProvider);
        });
        await expect(
          startMcpOAuthAuthorization(REMOTE_IDENTITY, resolvedOAuthConfig(REMOTE_IDENTITY), {}),
        ).resolves.toMatchObject({ status: "redirect", state: "state-1234567890" });
        expect(provider.tokens()).toMatchObject({ access_token: "decoy-token" });

        authMock.mockImplementationOnce(async (loginProvider) => {
          await loginProvider.invalidateCredentials?.("tokens");
          throw new Error("replacement authorization failed");
        });
        await expect(
          completeMcpOAuthAuthorization(REMOTE_IDENTITY, resolvedOAuthConfig(REMOTE_IDENTITY), {
            code: "expired-code",
          }),
        ).rejects.toThrow("replacement authorization failed");
        expect(readMcpOAuthStore(storeKey)).toMatchObject({
          tokens: { access_token: "decoy-token" },
          tokenExpiresAt: 0,
          pendingAuthorizationChallenge: { requiresAuthorization: true },
        });

        authMock.mockImplementationOnce(async (loginProvider) => {
          await loginProvider.saveTokens({
            access_token: "gateway-token",
            refresh_token: "secret-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
          return "AUTHORIZED";
        });
        await expect(
          completeMcpOAuthAuthorization(REMOTE_IDENTITY, resolvedOAuthConfig(REMOTE_IDENTITY), {
            code: "valid-code",
          }),
        ).resolves.toBe("authorized");
        expect(readMcpOAuthStore(storeKey)).toMatchObject({
          tokens: { access_token: ROTATED_ACCESS },
        });
        expect(readMcpOAuthStore(storeKey).pendingAuthorizationChallenge).toBeUndefined();
      },
      {
        prefix: "openclaw-mcp-oauth-insufficient-scope-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("stops refreshing after a replacement token is rejected twice", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({ identity: REMOTE_IDENTITY });
        await provider.saveTokens({
          access_token: "replacement-token",
          refresh_token: "replacement-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });

        await expect(
          recordMcpOAuthAuthorizationRequired({
            identity: REMOTE_IDENTITY,
            rejectedAccessToken: "replacement-token",
            scope: "docs.read",
          }),
        ).resolves.toBe(true);
        await expect(resolveMcpOAuthAccessToken({ identity: REMOTE_IDENTITY })).rejects.toThrow(
          "requires additional OAuth authorization",
        );
        expect(authMock).not.toHaveBeenCalled();
        expect(provider.tokens()).toMatchObject({ access_token: "replacement-token" });

        await provider.saveTokens({
          access_token: "newer-token",
          refresh_token: "newer-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
        await expect(
          recordMcpOAuthAuthorizationRequired({
            identity: REMOTE_IDENTITY,
            rejectedAccessToken: "replacement-token",
          }),
        ).resolves.toBe(false);
        expect(provider.tokens()).toMatchObject({ access_token: "newer-token" });
      },
      {
        prefix: "openclaw-mcp-oauth-terminal-rejection-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("keeps a rejected-token challenge for explicit reauthorization after refresh fails", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          identity: REMOTE_IDENTITY,
        });
        await provider.saveTokens({
          access_token: "decoy-token",
          refresh_token: "test-auth-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
        await provider.saveDiscoveryState?.({
          authorizationServerUrl: "https://old-auth.example.com",
          resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/old",
        });
        const resourceMetadataUrl = new URL(
          "https://mcp.example.com/.well-known/oauth-protected-resource",
        );
        authMock.mockRejectedValueOnce(new Error("scope refresh rejected"));

        await expect(
          resolveMcpOAuthAccessToken({
            identity: REMOTE_IDENTITY,
            authorizationChallenge: true,
            rejectedAccessToken: "decoy-token",
            resourceMetadataUrl,
            scope: "docs.write",
          }),
        ).rejects.toThrow("scope refresh rejected");
        expect(readMcpOAuthStore(REMOTE_IDENTITY.storeKey)).toMatchObject({
          pendingAuthorizationChallenge: {
            resourceMetadataUrl: resourceMetadataUrl.toString(),
            scope: "docs.write",
          },
        });
        expect(readMcpOAuthStore(REMOTE_IDENTITY.storeKey).discoveryState).toBeUndefined();

        authMock.mockImplementationOnce(persistRedirect);
        await expect(
          startMcpOAuthAuthorization(REMOTE_IDENTITY, resolvedOAuthConfig(REMOTE_IDENTITY), {}),
        ).resolves.toMatchObject({ state: "state-1234567890" });
        expect(authMock.mock.calls[1]?.[1]).toMatchObject({
          resourceMetadataUrl,
          scope: "docs.write",
        });
      },
      {
        prefix: "openclaw-mcp-oauth-rejected-token-challenge-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("uses a persisted challenge when refreshing after Doctor credential import", async () => {
    await withTempHome(
      async () => {
        const storeKey = REMOTE_IDENTITY.storeKey;
        const resourceMetadataUrl = new URL(
          "https://mcp.example.com/.well-known/oauth-protected-resource",
        );
        const provider = createMcpOAuthClientProvider({ identity: REMOTE_IDENTITY });
        await provider.saveTokens({
          access_token: "legacy-access",
          refresh_token: "legacy-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
        updateMcpOAuthStore(storeKey, (store) => ({
          ...store,
          tokenExpiresAt: 0,
          pendingAuthorizationChallenge: {
            resourceMetadataUrl: resourceMetadataUrl.toString(),
            scope: "docs.read",
          },
        }));
        authMock.mockImplementationOnce(async (refreshProvider, options) => {
          expect(options).toMatchObject({ resourceMetadataUrl, scope: "docs.read" });
          await refreshProvider.saveTokens({
            access_token: "gateway-token",
            refresh_token: "secret-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
          return "AUTHORIZED";
        });

        await expect(resolveMcpOAuthAccessToken({ identity: REMOTE_IDENTITY })).resolves.toBe(
          ROTATED_ACCESS,
        );
        expect(readMcpOAuthStore(storeKey).pendingAuthorizationChallenge).toBeUndefined();
      },
      {
        prefix: "openclaw-mcp-oauth-doctor-challenge-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("uses unknown-expiry tokens live but refreshes them before blind projection", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          identity: REMOTE_IDENTITY,
        });
        await provider.saveTokens({
          access_token: "example",
          refresh_token: "test-auth-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
        const storeKey = REMOTE_IDENTITY.storeKey;
        updateMcpOAuthStore(storeKey, (store) => {
          const next = { ...store };
          delete next.tokenExpiresAt;
          return next;
        });

        await expect(
          resolveMcpOAuthAccessToken({
            identity: REMOTE_IDENTITY,
            acceptUnknownExpiry: true,
          }),
        ).resolves.toBe(LEGACY_ACCESS);
        expect(authMock).not.toHaveBeenCalled();

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
            identity: REMOTE_IDENTITY,
          }),
        ).resolves.toBe(ROTATED_ACCESS);
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
            identity: REMOTE_IDENTITY,
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

  it("marks challenge-only bootstrap state as safe for Doctor credential import", async () => {
    await withTempHome(
      async () => {
        await expect(
          resolveMcpOAuthAccessToken({
            identity: REMOTE_IDENTITY,
            authorizationChallenge: true,
            scope: "docs.read",
          }),
        ).rejects.toThrow("Run openclaw mcp login Remote Docs.");
        expect(readMcpOAuthStore(REMOTE_IDENTITY.storeKey)).toMatchObject({
          credentialState: "uninitialized",
          pendingAuthorizationChallenge: { scope: "docs.read" },
        });
      },
      {
        prefix: "openclaw-mcp-oauth-challenge-provenance-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("persists challenge hints without mutating an in-flight PKCE login", async () => {
    await withTempHome(
      async () => {
        const resourceMetadataUrl = new URL(
          "https://mcp.example.com/.well-known/oauth-protected-resource",
        );
        const provider = createMcpOAuthClientProvider({
          identity: REMOTE_IDENTITY,
          allowAuthorizationRedirect: true,
        });
        await provider.saveCodeVerifier("existing-verifier");

        await expect(
          resolveMcpOAuthAccessToken({
            identity: REMOTE_IDENTITY,
            authorizationChallenge: true,
            resourceMetadataUrl,
            scope: "docs.read",
          }),
        ).rejects.toThrow("Run openclaw mcp login Remote Docs.");
        expect(authMock).not.toHaveBeenCalled();
        expect(readMcpOAuthStore(REMOTE_IDENTITY.storeKey)).toMatchObject({
          codeVerifier: "existing-verifier",
          pendingAuthorizationChallenge: {
            resourceMetadataUrl: resourceMetadataUrl.toString(),
            scope: "docs.read",
          },
        });

        authMock.mockImplementationOnce(persistRedirect);
        await expect(
          startMcpOAuthAuthorization(REMOTE_IDENTITY, resolvedOAuthConfig(REMOTE_IDENTITY), {}),
        ).resolves.toMatchObject({ state: "state-1234567890" });
        expect(authMock.mock.calls[0]?.[1]).toMatchObject({
          resourceMetadataUrl,
          scope: "docs.read",
        });
      },
      {
        prefix: "openclaw-mcp-oauth-challenge-bootstrap-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("stores token state only in shared SQLite with restricted permissions", async () => {
    await withTempHome(
      async (home) => {
        const provider = createMcpOAuthClientProvider({
          identity: REMOTE_IDENTITY,
        });
        await provider.saveTokens({ access_token: "access", token_type: "Bearer" });

        expect(provider.tokens()).toEqual({
          access_token: "access",
          token_type: "Bearer",
        });

        const databasePath = resolveOpenClawStateSqlitePath();
        const rows = openOpenClawStateDatabase()
          .db.prepare("SELECT store_key, format_version FROM mcp_oauth_stores")
          .all();
        expect(rows).toEqual([
          { store_key: expect.stringMatching(/^Remote-Docs-[a-f0-9]{16}$/), format_version: 1 },
        ]);
        await expect(fs.readdir(`${home}/.openclaw/mcp-oauth`)).rejects.toMatchObject({
          code: "ENOENT",
        });
        const stat = await fs.stat(databasePath);
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

  it("does not create shared state for a read-only credential status check", async () => {
    await withTempHome(
      async () => {
        await expect(readMcpOAuthCredentialsStatus(REMOTE_IDENTITY)).resolves.toEqual({
          state: "unauthenticated",
        });
        await expect(fs.stat(resolveOpenClawStateSqlitePath())).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      {
        prefix: "openclaw-mcp-oauth-status-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("updates provider fields atomically and clears token expiry on invalidation", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          identity: REMOTE_IDENTITY,
          allowAuthorizationRedirect: true,
        });
        await provider.saveClientInformation?.({ client_id: "client-id" });
        await provider.saveTokens({
          access_token: "access",
          refresh_token: "refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
        await provider.saveCodeVerifier("verifier");
        await provider.invalidateCredentials?.("tokens");

        const store = readMcpOAuthStore(REMOTE_IDENTITY.storeKey);
        expect(store.clientInformation).toEqual({ client_id: "client-id" });
        expect(store.codeVerifier).toBe("verifier");
        expect(store.tokens).toBeUndefined();
        expect(store.tokenExpiresAt).toBeUndefined();
        expect(store.credentialState).toBe("cleared");
      },
      {
        prefix: "openclaw-mcp-oauth-atomic-fields-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("fails closed when canonical SQLite JSON is malformed", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          identity: REMOTE_IDENTITY,
        });
        await provider.saveTokens({ access_token: "access", token_type: "Bearer" });
        const storeKey = REMOTE_IDENTITY.storeKey;
        openOpenClawStateDatabase()
          .db.prepare("UPDATE mcp_oauth_stores SET store_json = ? WHERE store_key = ?")
          .run("{", storeKey);

        expect(() => provider.tokens()).toThrow("store_json is not valid JSON");
      },
      {
        prefix: "openclaw-mcp-oauth-corrupt-row-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("fails closed when canonical token expiry has no token state", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          identity: REMOTE_IDENTITY,
        });
        await provider.saveTokens({ access_token: "access", token_type: "Bearer" });
        const storeKey = REMOTE_IDENTITY.storeKey;
        openOpenClawStateDatabase()
          .db.prepare("UPDATE mcp_oauth_stores SET store_json = ? WHERE store_key = ?")
          .run(JSON.stringify({ tokenExpiresAt: 10_000 }), storeKey);

        expect(() => provider.tokens()).toThrow("tokenExpiresAt requires tokens");
      },
      {
        prefix: "openclaw-mcp-oauth-orphan-expiry-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("isolates, counts, and clears requester credentials by configured server", async () => {
    await withTempHome(
      async () => {
        const serverUrl = "https://mcp.example.com/shared";
        const alice = requesterIdentity("Shared", serverUrl, "alice");
        const bob = requesterIdentity("Shared", serverUrl, "bob");
        const other = requesterIdentity("Shared", "https://other.example.com/mcp", "alice");
        await saveAccessToken(alice, "alice-token");
        await saveAccessToken(bob, "bob-token");
        await saveAccessToken(other, "other-token");

        closeOpenClawStateDatabaseForTest();
        await expect(resolveMcpOAuthAccessToken({ identity: alice })).resolves.toBe("alice-token");
        await expect(resolveMcpOAuthAccessToken({ identity: bob })).resolves.toBe("bob-token");
        expect(alice.storeKey).not.toBe(bob.storeKey);
        expect(countMcpOAuthPrincipals(operatorMcpOAuthIdentity("Shared", serverUrl))).toBe(2);

        await clearMcpOAuthServer(operatorMcpOAuthIdentity("Shared", serverUrl));
        for (const identity of [alice, bob]) {
          await expect(readMcpOAuthCredentialsStatus(identity)).resolves.toEqual({
            state: "unauthenticated",
          });
        }
        await expect(resolveMcpOAuthAccessToken({ identity: other })).resolves.toBe("other-token");
      },
      {
        prefix: "openclaw-mcp-oauth-requesters-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("keeps the legacy loopback redirect as the default for upgrade compatibility", () => {
    const provider = createMcpOAuthClientProvider({
      identity: CALENDLY_IDENTITY,
    });

    expect(provider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:8989/oauth/callback"]);
    expect(provider.redirectUrl).toBe("http://127.0.0.1:8989/oauth/callback");
  });

  it("persists the localhost retry for completion and then clears the session", async () => {
    await withTempHome(
      async () => {
        authMock
          .mockRejectedValueOnce(new Error("invalid_client_metadata: redirect_uri rejected"))
          .mockImplementationOnce(persistRedirect);

        const session = await startMcpOAuthAuthorization(
          CALENDLY_IDENTITY,
          resolvedOAuthConfig(CALENDLY_IDENTITY),
          {},
        );
        if (session.status !== "redirect") {
          throw new Error("expected MCP OAuth redirect");
        }

        expect(session.redirectUrl).toBe("http://localhost:8989/oauth/callback");
        expect(authMock.mock.calls[1]?.[0]?.clientMetadata.redirect_uris).toEqual([
          "http://localhost:8989/oauth/callback",
        ]);
        expect(readMcpOAuthStore(CALENDLY_IDENTITY.storeKey)).toMatchObject({
          codeVerifier: "verifier",
          redirectUrl: "http://localhost:8989/oauth/callback",
        });

        authMock.mockReset();
        authMock.mockImplementationOnce(async (provider, options) => {
          expect(options.authorizationCode).toBe("code-123");
          expect(provider.redirectUrl).toBe("http://localhost:8989/oauth/callback");
          expect(await provider.codeVerifier()).toBe("verifier");
          return "AUTHORIZED";
        });
        await expect(
          completeMcpOAuthAuthorization(CALENDLY_IDENTITY, resolvedOAuthConfig(CALENDLY_IDENTITY), {
            code: "code-123",
          }),
        ).resolves.toBe("authorized");
        expect(readMcpOAuthStore(CALENDLY_IDENTITY.storeKey)).not.toMatchObject({
          codeVerifier: expect.anything(),
          redirectUrl: expect.anything(),
        });
      },
      {
        prefix: "openclaw-mcp-oauth-localhost-persist-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("does not retry a code exchange redirect mismatch", async () => {
    await withTempHome(
      async () => {
        authMock.mockImplementationOnce(persistRedirect);
        await startMcpOAuthAuthorization(
          CALENDLY_IDENTITY,
          resolvedOAuthConfig(CALENDLY_IDENTITY),
          {},
        );
        authMock.mockReset();
        authMock.mockRejectedValueOnce(new Error("invalid_grant: redirect_uri mismatch"));

        await expect(
          completeMcpOAuthAuthorization(CALENDLY_IDENTITY, resolvedOAuthConfig(CALENDLY_IDENTITY), {
            code: "code-123",
          }),
        ).rejects.toThrow("redirect_uri mismatch");
        expect(authMock).toHaveBeenCalledOnce();
      },
      {
        prefix: "openclaw-mcp-oauth-code-mismatch-",
        skipSessionCleanup: true,
        env: { OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      },
    );
  });

  it("does not persist localhost when the fallback attempt fails", async () => {
    await withTempHome(
      async () => {
        authMock.mockReset();
        authMock
          .mockRejectedValueOnce(new Error("invalid_client_metadata: redirect_uri rejected"))
          .mockRejectedValueOnce(new Error("localhost redirect also rejected"));

        await expect(
          startMcpOAuthAuthorization(CALENDLY_IDENTITY, resolvedOAuthConfig(CALENDLY_IDENTITY), {}),
        ).rejects.toThrow("localhost redirect also rejected");

        expect(readMcpOAuthStore(CALENDLY_IDENTITY.storeKey)).toEqual({});
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

  it("does not start hidden authorization flows without an authorization callback", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          identity: REMOTE_IDENTITY,
        });

        expect(() => provider.state?.()).toThrow("Run openclaw mcp login Remote Docs.");
        expect(() => provider.saveCodeVerifier?.("verifier")).toThrow(
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
          identity: REMOTE_IDENTITY,
        });
        await provider.saveTokens({ access_token: "access", token_type: "Bearer" });

        await clearMcpOAuthCredentials(REMOTE_IDENTITY);

        expect(provider.tokens()).toBeUndefined();
        expect(readMcpOAuthStore(REMOTE_IDENTITY.storeKey).credentialState).toBe("cleared");
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
