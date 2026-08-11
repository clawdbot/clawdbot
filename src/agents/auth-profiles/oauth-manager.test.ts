/**
 * Tests OAuth manager store and refresh behavior.
 * Covers identity safety, main-store adoption, refresh persistence, fallback
 * recovery, and external profile overlays.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { MAX_DATE_TIMESTAMP_MS } from "../../shared/number-coercion.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import {
  createOAuthManager,
  OAuthManagerRefreshError,
  runRetainedOAuthRefreshCall,
} from "./oauth-manager.js";
import {
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
} from "./oauth-shared.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential, OAuthCredentials } from "./types.js";

function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

const tempDirs: string[] = [];

async function withOAuthTempRoot(
  prefix: string,
  run: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempRoot);
  await withEnvAsync({ OPENCLAW_STATE_DIR: tempRoot }, async () => await run(tempRoot));
}

async function withOAuthAgentDirs(
  prefix: string,
  run: (dirs: { mainAgentDir: string; agentDir: string }) => Promise<void>,
): Promise<void> {
  await withOAuthTempRoot(prefix, async (tempRoot) => {
    const mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    const agentDir = path.join(tempRoot, "agents", "sub", "agent");
    await withEnvAsync({ OPENCLAW_AGENT_DIR: mainAgentDir }, async () => {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.mkdir(mainAgentDir, { recursive: true });
      await run({ mainAgentDir, agentDir });
    });
  });
}

beforeEach(() => {
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  clearRuntimeAuthProfileStoreSnapshots();
});

afterEach(async () => {
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("isSafeToAdoptBootstrapOAuthIdentity", () => {
  it("allows identity-less external bootstrap adoption", () => {
    const existing = createCredential({
      access: "expired-local-access",
      refresh: "expired-local-refresh",
      expires: Date.now() - 60_000,
    });
    const incoming = createCredential({
      access: "external-access",
      refresh: "external-refresh",
      expires: Date.now() + 60_000,
    });

    expect(isSafeToAdoptBootstrapOAuthIdentity(existing, incoming)).toBe(true);
  });
});

describe("isSafeToAdoptMainStoreOAuthIdentity", () => {
  it("allows identity-less credentials to adopt from the main store", () => {
    expect(
      isSafeToAdoptMainStoreOAuthIdentity(
        createCredential({
          access: "sub-access",
          refresh: "sub-refresh",
        }),
        createCredential({
          access: "main-access",
          refresh: "main-refresh",
          accountId: "acct-main",
        }),
      ),
    ).toBe(true);
  });
});

describe("matching account identity adoption", () => {
  it("accepts matching account identities for main-store adoption", () => {
    expect(
      isSafeToAdoptMainStoreOAuthIdentity(
        createCredential({ accountId: "acct-123" }),
        createCredential({
          access: "main-access",
          refresh: "main-refresh",
          accountId: "acct-123",
        }),
      ),
    ).toBe(true);
  });
});

describe("OAuthManagerRefreshError", () => {
  it("serializes without leaking credential or store secrets", () => {
    const refreshedStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:oauth": createCredential({
          access: "store-access",
          refresh: "store-refresh",
        }),
      },
    };
    const error = new OAuthManagerRefreshError({
      credential: createCredential({ access: "error-access", refresh: "error-refresh" }),
      profileId: "openai:oauth",
      refreshedStore,
      cause: new Error("boom"),
    });

    const serialized = JSON.stringify(error);
    expect(serialized).toContain("openai");
    expect(serialized).toContain("openai:oauth");
    expect(serialized).not.toContain("error-access");
    expect(serialized).not.toContain("error-refresh");
    expect(serialized).not.toContain("store-access");
    expect(serialized).not.toContain("store-refresh");
  });

  it("redacts credential secrets from the refresh error message", () => {
    const refreshedStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:oauth": createCredential({
          access: "store-access",
          refresh: "store-refresh",
          idToken: "store-id-token",
        }),
      },
    };
    const error = new OAuthManagerRefreshError({
      credential: createCredential({
        access: "error-access",
        refresh: "error-refresh",
        idToken: "error-id-token",
      }),
      profileId: "openai:oauth",
      refreshedStore,
      cause: new Error(
        "refresh rejected error-access error-refresh error-id-token store-access store-refresh store-id-token",
      ),
    });

    expect(error.message).toContain("refresh rejected");
    expect(error.message).not.toContain("error-access");
    expect(error.message).not.toContain("error-refresh");
    expect(error.message).not.toContain("error-id-token");
    expect(error.message).not.toContain("store-access");
    expect(error.message).not.toContain("store-refresh");
    expect(error.message).not.toContain("store-id-token");
    expect(error.message.match(/\[redacted\]/g)?.length).toBe(6);
    const surfacedCauseMessage = formatErrorMessage(error.cause);
    expect(surfacedCauseMessage).not.toContain("error-access");
    expect(surfacedCauseMessage).not.toContain("error-refresh");
    expect(surfacedCauseMessage).not.toContain("error-id-token");
    expect(surfacedCauseMessage).not.toContain("store-access");
    expect(surfacedCauseMessage).not.toContain("store-refresh");
    expect(surfacedCauseMessage).not.toContain("store-id-token");
    expect(surfacedCauseMessage.match(/\[redacted\]/g)?.length).toBe(6);
  });

  it("redacts token-shaped credential secrets before generic masking", () => {
    const access = "sk-oauthreviewredaction1234567890zzzz";
    const refresh = "ya29.oauthreviewredaction1234567890yyyy";
    const error = new OAuthManagerRefreshError({
      credential: createCredential({ access, refresh }),
      profileId: "openai:oauth",
      refreshedStore: { version: 1, profiles: {} },
      cause: new Error(`refresh rejected ${access} ${refresh}`, {
        cause: new Error(`nested failure ${access}`),
      }),
    });

    const surfacedCauseMessage = formatErrorMessage(error.cause);
    for (const message of [error.message, surfacedCauseMessage]) {
      expect(message).not.toContain(access);
      expect(message).not.toContain(refresh);
      expect(message).not.toContain("sk-oau");
      expect(message).not.toContain("zzzz");
      expect(message).not.toContain("ya29.o");
      expect(message).not.toContain("yyyy");
      expect(message.match(/\[redacted\]/g)?.length).toBe(3);
    }
  });

  it.each([undefined, Symbol("refresh-failed"), () => "refresh-failed"])(
    "formats non-json refresh failure values without throwing",
    (cause) => {
      const error = new OAuthManagerRefreshError({
        credential: createCredential({
          access: "sk-nonjsonredaction1234567890zzzz",
        }),
        profileId: "openai:oauth",
        refreshedStore: { version: 1, profiles: {} },
        cause,
      });

      expect(error.message).toContain("OAuth token refresh failed");
    },
  );

  it("redacts overlapping credential secrets longest first", () => {
    const error = new OAuthManagerRefreshError({
      credential: createCredential({
        access: "abc123",
        refresh: "abc123456",
      }),
      profileId: "openai:oauth",
      refreshedStore: { version: 1, profiles: {} },
      cause: new Error("refresh rejected abc123 abc123456"),
    });

    expect(error.message).toContain("refresh rejected");
    expect(error.message).not.toContain("abc123");
    expect(error.message).not.toContain("abc123456");
    expect(error.message).not.toContain("[redacted]456");
    expect(error.message.match(/\[redacted\]/g)?.length).toBe(2);
  });
});

describe("createOAuthManager", () => {
  it("clears the caller deadline when refresh I/O settles first", async () => {
    const onTimeout = vi.fn();

    await expect(
      runRetainedOAuthRefreshCall({
        timeoutMs: 10,
        onTimeout,
        run: async () => "fresh",
      }),
    ).resolves.toBe("fresh");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("returns a refreshed credential without provider formatting", async () => {
    await withOAuthAgentDirs("oauth-manager-raw-refresh-", async ({ agentDir }) => {
      const profileId = "openai:oauth";
      const credential = createCredential({
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
      });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: credential,
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );
      const manager = createOAuthManager({
        prepareRefresh: async () => async () => ({
          access: "refreshed-access",
          refresh: "refreshed-refresh",
          expires: Date.now() + 10 * 60_000,
        }),
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
      });

      const result = await manager.resolveOAuthCredential({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
        }),
        profileId,
        credential,
        agentDir,
      });

      expect(result).toMatchObject({
        access: "refreshed-access",
        refresh: "refreshed-refresh",
      });
    });
  });

  it("does not overlay external auth while checking main-store adoption", async () => {
    await withOAuthAgentDirs("oauth-manager-main-adopt-", async ({ mainAgentDir, agentDir }) => {
      const profileId = "openai:oauth";
      const subCredential = createCredential({
        access: "expired-sub-access",
        refresh: "sub-refresh",
        expires: Date.now() - 60_000,
      });
      const mainCredential = createCredential({
        access: "expired-main-access",
        refresh: "main-refresh",
        expires: Date.now() - 30_000,
      });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: subCredential,
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: mainCredential,
          },
        },
        mainAgentDir,
        { filterExternalAuthProfiles: false },
      );
      externalAuthTesting.setResolveExternalAuthProfilesForTest(() => [
        {
          profileId,
          credential: createCredential({
            access: "external-fresh-access",
            refresh: "external-fresh-refresh",
            expires: Date.now() + 60_000,
          }),
          persistence: "runtime-only",
        },
      ]);

      const refreshCredential = vi.fn(async (credential: OAuthCredential) => {
        expect(credential.access).toBe("expired-main-access");
        return {
          access: "rotated-main-access",
          refresh: "rotated-main-refresh",
          expires: Date.now() + 60_000,
        };
      });
      const manager = createOAuthManager({
        prepareRefresh: async () => refreshCredential,
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
      });

      const result = await manager.resolveOAuthCredential({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
        }),
        profileId,
        credential: subCredential,
        agentDir,
      });

      expect(refreshCredential).toHaveBeenCalledTimes(1);
      if (!result) {
        throw new Error("Expected refreshed main-store OAuth result");
      }
      expect(result.access).toBe("rotated-main-access");
      expect(result.refresh).toBe("rotated-main-refresh");
    });
  });

  it("adopts main-store OAuth when the local expiry is out of range", async () => {
    await withOAuthAgentDirs("oauth-manager-invalid-local-", async ({ mainAgentDir, agentDir }) => {
      const profileId = "openai-codex:default";
      const localCredential = createCredential({
        access: "poisoned-local-access",
        refresh: "local-refresh",
        expires: MAX_DATE_TIMESTAMP_MS + 1,
      });
      const mainCredential = createCredential({
        access: "main-access",
        refresh: "main-refresh",
        expires: Date.now() + 10 * 60_000,
      });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: mainCredential,
          },
        },
        mainAgentDir,
        { filterExternalAuthProfiles: false },
      );

      const refreshCredential = vi.fn(async () => {
        throw new Error("should not refresh poisoned local credential");
      });
      const manager = createOAuthManager({
        prepareRefresh: async () => refreshCredential,
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
      });

      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          [profileId]: localCredential,
        },
      };
      const result = await manager.resolveOAuthCredential({
        store,
        profileId,
        credential: localCredential,
        agentDir,
      });

      expect(refreshCredential).not.toHaveBeenCalled();
      expect(result?.access).toBe("main-access");
      expect(store.profiles[profileId]).toMatchObject({
        type: "oauth",
        access: "main-access",
        refresh: "main-refresh",
      });
    });
  });

  it("refreshes with the adopted external oauth credential", async () => {
    await withOAuthAgentDirs("oauth-manager-refresh-", async ({ agentDir }) => {
      const profileId = "minimax-portal:default";
      const localCredential = createCredential({
        provider: "minimax-portal",
        access: "stale-local-access",
        refresh: "stale-local-refresh",
        expires: Date.now() - 60_000,
      });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: localCredential,
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const manager = createOAuthManager({
        prepareRefresh: async () => async (credential) => {
          expect(credential.refresh).toBe("external-refresh");
          return {
            access: "rotated-access",
            refresh: "rotated-refresh",
            expires: Date.now() + 60_000,
          };
        },
        readBootstrapCredential: () =>
          createCredential({
            provider: "minimax-portal",
            access: "expired-external-access",
            refresh: "external-refresh",
            expires: Date.now() - 30_000,
          }),
        isRefreshTokenReusedError: () => false,
      });

      const result = await manager.resolveOAuthCredential({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        credential: localCredential,
        agentDir,
      });

      if (!result) {
        throw new Error("Expected refreshed external OAuth result");
      }
      expect(result.provider).toBe("minimax-portal");
      expect(result.access).toBe("rotated-access");
      expect(result.refresh).toBe("rotated-refresh");
    });
  });

  it("skips the refresh adapter when the credential has no refresh token", async () => {
    await withOAuthTempRoot("oauth-manager-no-refresh-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const credential = createCredential({
        access: "",
        refresh: "",
        expires: Date.now() - 60_000,
      });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: credential,
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );
      const refreshCredential = vi.fn(async () => null);
      const manager = createOAuthManager({
        prepareRefresh: async () => refreshCredential,
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
      });

      const result = await manager.resolveOAuthCredential({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
        }),
        profileId,
        credential,
        agentDir,
      });

      expect(result).toBeNull();
      expect(refreshCredential).not.toHaveBeenCalled();
    });
  });

  it("force-persists a refreshed credential after a same-identity CAS race", async () => {
    await withOAuthTempRoot("oauth-manager-cas-same-identity-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const expired = createCredential({
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
        accountId: "acct-123",
      });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: expired,
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const manager = createOAuthManager({
        prepareRefresh: async () => async () => {
          saveAuthProfileStore(
            {
              version: 1,
              profiles: {
                [profileId]: createCredential({
                  access: "stale-race-access",
                  refresh: "consumed-race-refresh",
                  expires: Date.now() + 10 * 60_000,
                  accountId: "acct-123",
                }),
              },
            },
            agentDir,
            { filterExternalAuthProfiles: false },
          );
          return {
            access: "rotated-access",
            refresh: "rotated-refresh",
            expires: Date.now() + 60_000,
          };
        },
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
      });

      const result = await manager.resolveOAuthCredential({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
        }),
        profileId,
        credential: expired,
        agentDir,
      });

      expect(result?.access).toBe("rotated-access");
      const persisted = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
        allowKeychainPrompt: false,
      });
      expect(persisted.profiles[profileId]).toMatchObject({
        type: "oauth",
        access: "rotated-access",
        refresh: "rotated-refresh",
        accountId: "acct-123",
      });
    });
  });

  it("uses a different-identity stored credential after a CAS race", async () => {
    await withOAuthTempRoot("oauth-manager-cas-different-identity-", async (tempRoot) => {
      const mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
      const agentDir = path.join(tempRoot, "agents", "sub", "agent");
      await fs.mkdir(mainAgentDir, { recursive: true });
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const expired = createCredential({
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
        accountId: "acct-123",
      });
      const relogged = createCredential({
        access: "relogged-access",
        refresh: "relogged-refresh",
        expires: Date.now() + 10 * 60_000,
        accountId: "acct-456",
      });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: expired,
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const manager = createOAuthManager({
        prepareRefresh: async () => async () => {
          saveAuthProfileStore(
            {
              version: 1,
              profiles: {
                [profileId]: relogged,
              },
            },
            agentDir,
            { filterExternalAuthProfiles: false },
          );
          return {
            access: "rotated-access",
            refresh: "rotated-refresh",
            expires: Date.now() + 60_000,
          };
        },
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
      });

      const result = await manager.resolveOAuthCredential({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
        }),
        profileId,
        credential: expired,
        agentDir,
      });

      expect(result?.access).toBe("relogged-access");
      const persisted = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
        allowKeychainPrompt: false,
      });
      expect(persisted.profiles[profileId]).toMatchObject({
        type: "oauth",
        access: "relogged-access",
        refresh: "relogged-refresh",
        accountId: "acct-456",
      });
    });
  });

  it("fails closed after managed refresh failure", async () => {
    await withOAuthAgentDirs("oauth-manager-refresh-fail-closed-", async ({ agentDir }) => {
      const profileId = "openai:user@example.com";
      const managedCredential = createCredential({
        access: "managed-expired-access",
        refresh: "managed-refresh",
        expires: Date.now() - 60_000,
        email: "user@example.com",
        accountId: "acct-123",
      });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: managedCredential,
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );
      const manager = createOAuthManager({
        prepareRefresh: async () => async () => {
          throw new Error("refresh rejected managed profile");
        },
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
      });

      await expect(
        manager.resolveOAuthCredential({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
            allowKeychainPrompt: false,
          }),
          profileId,
          credential: managedCredential,
          agentDir,
        }),
      ).rejects.toBeInstanceOf(OAuthManagerRefreshError);
    });
  });

  it("redacts the external oauth credential attempted during refresh failures", async () => {
    await withOAuthTempRoot("oauth-manager-refresh-redact-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "sub", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "minimax-portal:default";
      const localCredential = createCredential({
        provider: "minimax-portal",
        access: "fresh-local-access",
        refresh: "fresh-local-refresh",
        expires: Date.now() + 10 * 60_000,
      });
      const externalCredential = createCredential({
        provider: "minimax-portal",
        access: "external-attempt-access",
        refresh: "external-attempt-refresh",
        idToken: "external-attempt-id-token",
        expires: Date.now() - 30_000,
      });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: localCredential,
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const manager = createOAuthManager({
        prepareRefresh: async () => async () => {
          throw new Error(
            "refresh rejected external-attempt-access external-attempt-refresh external-attempt-id-token",
          );
        },
        readBootstrapCredential: () => externalCredential,
        isRefreshTokenReusedError: () => false,
      });

      try {
        await manager.resolveOAuthCredential({
          store: ensureAuthProfileStore(agentDir),
          profileId,
          credential: localCredential,
          agentDir,
          forceRefresh: true,
        });
        throw new Error("Expected refresh failure");
      } catch (caught) {
        if (!(caught instanceof OAuthManagerRefreshError)) {
          throw caught;
        }
        expect(caught.message).toContain("refresh rejected");
        expect(caught.message).not.toContain("external-attempt-access");
        expect(caught.message).not.toContain("external-attempt-refresh");
        expect(caught.message).not.toContain("external-attempt-id-token");
        const surfacedCauseMessage = formatErrorMessage(caught.cause);
        expect(surfacedCauseMessage).not.toContain("external-attempt-access");
        expect(surfacedCauseMessage).not.toContain("external-attempt-refresh");
        expect(surfacedCauseMessage).not.toContain("external-attempt-id-token");
      }
    });
  });

  it("prepares refreshes before entering the keyed queue", async () => {
    await withOAuthAgentDirs("oauth-manager-prepare-", async ({ agentDir }) => {
      const profileId = "openai:oauth";
      const credential = createCredential({ expires: Date.now() - 60_000 });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      const gate = createDeferred();
      const refresh = vi.fn(async () => ({
        access: "winner-access",
        refresh: "winner-refresh",
        expires: Date.now() + 10 * 60_000,
      }));
      let preparations = 0;
      const manager = createOAuthManager({
        prepareRefresh: async () => {
          if (++preparations === 1) {
            await gate.promise;
          }
          return refresh;
        },
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
      });
      const input = () => ({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
        profileId,
        credential,
        agentDir,
      });

      const blocked = manager.resolveOAuthCredential(input());
      await vi.waitFor(() => expect(preparations).toBe(1));
      await expect(manager.resolveOAuthCredential(input())).resolves.toMatchObject({
        access: "winner-access",
      });
      gate.resolve();
      await expect(blocked).resolves.toMatchObject({ access: "winner-access" });
      expect(refresh).toHaveBeenCalledOnce();
    });
  });

  it("recovers a fresher stored credential when preparation fails", async () => {
    await withOAuthAgentDirs("oauth-manager-prepare-recover-", async ({ agentDir }) => {
      const profileId = "openai:oauth";
      const credential = createCredential({ expires: Date.now() - 60_000 });
      const recovered = createCredential({
        access: "recovered-access",
        refresh: "recovered-refresh",
        expires: Date.now() + 10 * 60_000,
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      const manager = createOAuthManager({
        prepareRefresh: async () => {
          saveAuthProfileStore({ version: 1, profiles: { [profileId]: recovered } }, agentDir, {
            filterExternalAuthProfiles: false,
          });
          throw new Error("preparation failed");
        },
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
      });

      await expect(
        manager.resolveOAuthCredential({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential,
          agentDir,
        }),
      ).resolves.toEqual(recovered);
    });
  });

  it("redacts preparation failures through the normal refresh error boundary", async () => {
    await withOAuthAgentDirs("oauth-manager-prepare-redact-", async ({ agentDir }) => {
      const profileId = "openai:oauth";
      const credential = createCredential({
        access: "prepare-secret-access",
        refresh: "prepare-secret-refresh",
        expires: Date.now() - 60_000,
        idToken: "prepare-secret-id-token",
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      const manager = createOAuthManager({
        prepareRefresh: async () => {
          throw new Error(
            "prepare rejected prepare-secret-access prepare-secret-refresh prepare-secret-id-token",
          );
        },
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
      });

      const failure = await manager
        .resolveOAuthCredential({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential,
          agentDir,
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(OAuthManagerRefreshError);
      expect(formatErrorMessage(failure)).toContain("prepare rejected");
      expect(formatErrorMessage(failure)).not.toContain("prepare-secret");
      expect(formatErrorMessage((failure as OAuthManagerRefreshError).cause)).not.toContain(
        "prepare-secret",
      );
    });
  });

  it("aborts cooperative refresh I/O at the caller deadline", async () => {
    await withOAuthAgentDirs("oauth-manager-abort-", async ({ agentDir }) => {
      const profileId = "openai:oauth";
      const credential = createCredential({ expires: Date.now() - 60_000 });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      const aborted = vi.fn();
      const manager = createOAuthManager({
        prepareRefresh: async () => async (_credential, signal) =>
          await new Promise((_, reject) => {
            if (!signal) {
              reject(new Error("expected refresh timeout signal"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                aborted();
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error("OAuth refresh aborted"),
                );
              },
              { once: true },
            );
          }),
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
        refreshTimeoutMs: 10,
      });
      const result = manager.resolveOAuthCredential({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
        profileId,
        credential,
        agentDir,
      });
      const assertion = expect(result).rejects.toThrow("exceeded caller deadline");

      await assertion;
      expect(aborted).toHaveBeenCalledOnce();
    });
  });

  it("keeps the refresh lock until non-cooperative I/O settles", async () => {
    await withOAuthAgentDirs("oauth-manager-timeout-lock-", async ({ agentDir }) => {
      const profileId = "openai:oauth";
      const credential = createCredential({ expires: Date.now() - 60_000 });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      const stalled = createDeferred<never>();
      const secondRefresh = vi.fn(async () => ({
        access: "second-access",
        refresh: "second-refresh",
        expires: Date.now() + 60_000,
      }));
      let preparations = 0;
      const manager = createOAuthManager({
        prepareRefresh: async () => (++preparations === 1 ? () => stalled.promise : secondRefresh),
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
        refreshTimeoutMs: 10,
      });
      const input = () => ({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
        profileId,
        credential,
        agentDir,
      });
      const first = manager.resolveOAuthCredential(input());
      const firstAssertion = expect(first).rejects.toThrow("exceeded caller deadline");
      await firstAssertion;
      const second = manager.resolveOAuthCredential(input());

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      expect(secondRefresh).not.toHaveBeenCalled();
      stalled.reject(new Error("late refresh failure"));
      await expect(second).resolves.toMatchObject({ access: "second-access" });
      expect(secondRefresh).toHaveBeenCalledOnce();
    });
  });

  it("persists a refresh that succeeds after the timeout abort", async () => {
    await withOAuthAgentDirs("oauth-manager-timeout-success-", async ({ agentDir }) => {
      const profileId = "openai:oauth";
      const credential = createCredential({ expires: Date.now() - 60_000 });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      const stalled = createDeferred<OAuthCredentials>();
      const aborted = vi.fn();
      const manager = createOAuthManager({
        prepareRefresh: async () => async (_credential, signal) => {
          if (!signal) {
            throw new Error("expected refresh timeout signal");
          }
          signal.addEventListener("abort", aborted, { once: true });
          return await stalled.promise;
        },
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
        refreshTimeoutMs: 10,
      });
      const result = manager.resolveOAuthCredential({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
        profileId,
        credential,
        agentDir,
      });

      await expect(result).rejects.toThrow("exceeded caller deadline");
      await vi.waitFor(() => expect(aborted).toHaveBeenCalledOnce());
      stalled.resolve({
        access: "late-access",
        refresh: "late-refresh",
        expires: Date.now() + 60_000,
      });

      await vi.waitFor(() => {
        expect(
          ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        ).toMatchObject({
          access: "late-access",
          refresh: "late-refresh",
        });
      });
    });
  });
});
