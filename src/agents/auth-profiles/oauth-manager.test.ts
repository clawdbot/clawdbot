/**
 * Tests OAuth manager store and refresh behavior.
 * Covers identity safety, main-store adoption, refresh persistence, fallback
 * recovery, and external profile overlays.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  connectUserModelAccount,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { createOAuthManager, OAuthManagerRefreshError } from "./oauth-manager.js";
import {
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
} from "./oauth-shared.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

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
  closeOpenClawStateDatabaseForTest();
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
      cause: Object.assign(
        new Error(
          "refresh rejected error-access error-refresh error-id-token store-access store-refresh store-id-token",
        ),
        {
          oauthRefreshFailure: {
            errorType: "invalid_request_error",
            reason: "refresh_token_reused",
            status: 401,
            summary: "refresh rejected error-access",
          },
        },
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
    expect(error.reason).toBe("refresh_token_reused");
    expect(error.status).toBe(401);
    expect(error.errorType).toBe("invalid_request_error");
    expect(error.summary).toBe("refresh rejected [redacted]");
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
  it.each([
    { provider: "openai", metadata: undefined },
    {
      provider: "xai",
      metadata: {
        tokenEndpoint: "https://auth.x.ai/oauth2/token",
        deviceAuthorizationEndpoint: "https://auth.x.ai/oauth2/device/authorize",
        issuer: "https://auth.x.ai",
        authFlow: "device-code",
      },
    },
  ])(
    "serializes $provider personal refreshes without CLI bootstrap or shared copies",
    async ({ provider, metadata }) => {
      await withOAuthAgentDirs("oauth-manager-personal-", async ({ mainAgentDir, agentDir }) => {
        const owner = ensureProfileForEmail("alice@example.test");
        const credential = createCredential({
          provider,
          ...metadata,
          expires: Date.now() - 60_000,
          accountId: "acct-personal",
        });
        const { authProfileId: profileId } = connectUserModelAccount({
          ownerProfileId: owner.id,
          credential,
          assertCurrent() {},
        });
        const refreshCredential = vi.fn(async (current: OAuthCredential) => {
          expect(current).toEqual(credential);
          return {
            access: "personal-rotated-access",
            refresh: "personal-rotated-refresh",
            expires: Date.now() + 600_000,
            accountId: "acct-personal",
            ...metadata,
          };
        });
        const readBootstrapCredential = vi.fn(() => createCredential());
        const manager = createOAuthManager({
          buildApiKey: async (_provider, value) => value.access,
          canRefreshCredential: async () => true,
          refreshCredential,
          readBootstrapCredential,
        });
        const results = await Promise.all(
          [mainAgentDir, agentDir].map((targetAgentDir) =>
            manager.resolveOAuthAccess({
              store: ensureAuthProfileStore(targetAgentDir, { profileId }),
              profileId,
              credential,
              agentDir: targetAgentDir,
            }),
          ),
        );

        expect(results.map((result) => result?.apiKey)).toEqual([
          "personal-rotated-access",
          "personal-rotated-access",
        ]);
        expect(refreshCredential).toHaveBeenCalledTimes(1);
        expect(readBootstrapCredential).not.toHaveBeenCalled();
        expect(readUserModelAuthProfile(profileId)?.credential).toMatchObject({
          access: "personal-rotated-access",
          refresh: "personal-rotated-refresh",
          ...metadata,
        });
        for (const targetAgentDir of [undefined, mainAgentDir, agentDir]) {
          expect(
            ensureAuthProfileStoreWithoutExternalProfiles(targetAgentDir).profiles[profileId],
          ).toBeUndefined();
        }
      });
    },
  );

  it("does not overwrite a personal reconnect while a refresh is in flight", async () => {
    await withOAuthAgentDirs("oauth-manager-personal-reconnect-", async ({ agentDir }) => {
      const owner = ensureProfileForEmail("alice@example.test");
      const credential = createCredential({ expires: Date.now() - 60_000, accountId: "workspace" });
      const { authProfileId: profileId } = connectUserModelAccount({
        ownerProfileId: owner.id,
        credential,
        assertCurrent() {},
      });
      const reconnected = createCredential({
        access: "reconnected-access",
        refresh: "reconnected-refresh",
        expires: Date.now() + 600_000,
        accountId: "workspace",
      });
      const manager = createOAuthManager({
        buildApiKey: async (_provider, value) => value.access,
        canRefreshCredential: async () => true,
        refreshCredential: async () => {
          connectUserModelAccount({
            ownerProfileId: owner.id,
            credential: reconnected,
            matchesCredential: () => true,
            assertCurrent() {},
          });
          return {
            access: "stale-refresh-access",
            refresh: "stale-refresh-token",
            expires: Date.now() + 600_000,
          };
        },
        readBootstrapCredential: () => null,
      });

      const resolved = await manager.resolveOAuthAccess({
        store: ensureAuthProfileStore(agentDir, { profileId }),
        profileId,
        credential,
        agentDir,
      });
      expect(resolved?.apiKey).toBe("reconnected-access");
      expect(readUserModelAuthProfile(profileId)?.credential).toEqual(reconnected);
    });
  });

  it("passes active config to OAuth API-key formatting", async () => {
    const profileId = "openai:oauth";
    const credential = createCredential({ expires: Date.now() + 10 * 60_000 });
    const cfg = {
      models: {
        providers: {
          openai: { auth: "oauth", baseUrl: "", models: [] },
        },
      },
    } satisfies OpenClawConfig;
    const buildApiKey = vi.fn(async (_provider, value: OAuthCredential) => value.access);
    const manager = createOAuthManager({
      buildApiKey,
      canRefreshCredential: async () => true,
      refreshCredential: vi.fn(async () => null),
      readBootstrapCredential: () => null,
    });

    const result = await manager.resolveOAuthAccess({
      store: {
        version: 1,
        profiles: {
          [profileId]: credential,
        },
      },
      profileId,
      credential,
      cfg,
    });
    if (!result) {
      throw new Error("Expected OAuth access result");
    }
    expect(result.apiKey).toBe("access-token");

    expect(buildApiKey).toHaveBeenCalledWith("openai", credential, {
      cfg,
      agentDir: undefined,
    });
  });

  it("does not overlay external auth while checking main-store adoption", async () => {
    await withOAuthAgentDirs("oauth-manager-main-adopt-", async ({ mainAgentDir, agentDir }) => {
      const profileId = "openai:oauth";
      const subCredential = createCredential({
        access: "expired-sub-access",
        refresh: "sub-refresh",
        expires: Date.now() - 60_000,
        accountId: "acct-main",
      });
      const mainCredential = createCredential({
        access: "expired-main-access",
        refresh: "main-refresh",
        expires: Date.now() - 30_000,
        accountId: "acct-main",
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
            accountId: "acct-main",
          }),
          persistence: "runtime-only",
        },
      ]);

      const refreshCredential = vi.fn(async (credential: OAuthCredential) => {
        expect(credential.access).toBe("expired-main-access");
        return {
          access: "rotated-main-access",
          refresh: "rotated-main-refresh",
          expires: Date.now() + 600_000,
          accountId: "acct-main",
        };
      });
      const manager = createOAuthManager({
        buildApiKey: async (_provider, credential) => credential.access,
        canRefreshCredential: async () => true,
        refreshCredential,
        readBootstrapCredential: () => null,
      });

      const result = await manager.resolveOAuthAccess({
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
      expect(result.apiKey).toBe("rotated-main-access");
      expect(result.credential.access).toBe("rotated-main-access");
      expect(result.credential.refresh).toBe("rotated-main-refresh");
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
        buildApiKey: async (_provider, credential) => credential.access,
        canRefreshCredential: async () => true,
        refreshCredential,
        readBootstrapCredential: () => null,
      });

      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          [profileId]: localCredential,
        },
      };
      const result = await manager.resolveOAuthAccess({
        store,
        profileId,
        credential: localCredential,
        agentDir,
      });

      expect(refreshCredential).not.toHaveBeenCalled();
      expect(result?.apiKey).toBe("main-access");
      expect(result?.credential.access).toBe("main-access");
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
        buildApiKey: async (_provider, credential) => credential.access,
        canRefreshCredential: async () => true,
        refreshCredential: vi.fn(async (credential) => {
          expect(credential.refresh).toBe("external-refresh");
          return {
            access: "rotated-access",
            refresh: "rotated-refresh",
            expires: Date.now() + 600_000,
          };
        }),
        readBootstrapCredential: () =>
          createCredential({
            provider: "minimax-portal",
            access: "expired-external-access",
            refresh: "external-refresh",
            expires: Date.now() - 30_000,
          }),
      });

      const result = await manager.resolveOAuthAccess({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        credential: localCredential,
        agentDir,
      });

      if (!result) {
        throw new Error("Expected refreshed external OAuth result");
      }
      expect(result.apiKey).toBe("rotated-access");
      expect(result.credential.provider).toBe("minimax-portal");
      expect(result.credential.access).toBe("rotated-access");
      expect(result.credential.refresh).toBe("rotated-refresh");
      expect(
        ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
      ).toMatchObject({
        type: "oauth",
        provider: "minimax-portal",
        access: "rotated-access",
        refresh: "rotated-refresh",
      });
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
        buildApiKey: async (_provider, value) => value.access,
        canRefreshCredential: async () => true,
        refreshCredential,
        readBootstrapCredential: () => null,
      });

      const result = await manager.resolveOAuthAccess({
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

  it("does not overwrite a newer same-identity credential after a refresh race", async () => {
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
        buildApiKey: async (_provider, credential) => credential.access,
        canRefreshCredential: async () => true,
        refreshCredential: vi.fn(async () => {
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
        }),
        readBootstrapCredential: () => null,
      });

      const result = await manager.resolveOAuthAccess({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
        }),
        profileId,
        credential: expired,
        agentDir,
      });

      expect(result?.apiKey).toBe("stale-race-access");
      const persisted = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
        allowKeychainPrompt: false,
      });
      expect(persisted.profiles[profileId]).toMatchObject({
        type: "oauth",
        access: "stale-race-access",
        refresh: "consumed-race-refresh",
        accountId: "acct-123",
      });
    });
  });

  it("does not use a different-identity stored credential after a CAS race", async () => {
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
        buildApiKey: async (_provider, credential) => credential.access,
        canRefreshCredential: async () => true,
        refreshCredential: vi.fn(async () => {
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
        }),
        readBootstrapCredential: () => null,
      });

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
            allowKeychainPrompt: false,
          }),
          profileId,
          credential: expired,
          agentDir,
        }),
      ).rejects.toThrow("OAuth token refresh failed");
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

  it("keeps invalid_grant primary when owner cleanup and recovery reload both fail", async () => {
    await withOAuthTempRoot("oauth-manager-cleanup-errors-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const expired = createCredential({
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
        accountId: "acct-123",
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: expired } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      const initiatingError = Object.assign(new Error("provider rejected invalid_grant"), {
        oauthRefreshFailure: {
          errorType: "invalid_grant_error",
          reason: "invalid_grant",
          status: 401,
          summary: "provider rejected invalid_grant",
        },
      });
      const manager = createOAuthManager({
        buildApiKey: async (_provider, credential) => credential.access,
        canRefreshCredential: async () => true,
        refreshCredential: vi.fn(async () => {
          clearRuntimeAuthProfileStoreSnapshots();
          closeOpenClawAgentDatabasesForTest(tempRoot);
          await fs.writeFile(resolveAuthProfileDatabasePath(agentDir), "not a sqlite database");
          throw initiatingError;
        }),
        readBootstrapCredential: () => null,
      });

      try {
        await manager.resolveOAuthAccess({
          store: { version: 1, profiles: { [profileId]: expired } },
          profileId,
          credential: expired,
          agentDir,
        });
        throw new Error("Expected refresh failure");
      } catch (caught) {
        if (!(caught instanceof OAuthManagerRefreshError)) {
          throw caught;
        }
        expect(caught.message).toContain("provider rejected invalid_grant");
        expect(caught.message).not.toContain("unreadable");
        expect(caught.errorType).toBe("invalid_grant_error");
        expect(caught.reason).toBe("invalid_grant");
        expect(caught.status).toBe(401);
        expect(caught.summary).toBe("provider rejected invalid_grant");
        expect(caught.cause).toBeInstanceOf(AggregateError);
        const aggregate = caught.cause as AggregateError;
        expect(aggregate.errors).toHaveLength(4);
        expect(aggregate.cause).toBe(aggregate.errors[0]);
        expect(formatErrorMessage(aggregate.errors[0])).toContain(
          "provider rejected invalid_grant",
        );
        expect(formatErrorMessage(aggregate.errors[1])).toContain("is unreadable");
        expect(formatErrorMessage(aggregate.errors[2])).toContain("file is not a database");
        expect(formatErrorMessage(aggregate.errors[3])).toContain("is unreadable");
      }
    });
  });

  it("fails closed after an undefined managed refresh rejection", async () => {
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
        buildApiKey: async (_provider, credential) => credential.access,
        canRefreshCredential: async () => true,
        // oxlint-disable-next-line prefer-promise-reject-errors -- providers can reject with unknown non-Error values.
        refreshCredential: vi.fn(() => Promise.reject(undefined)),
        readBootstrapCredential: () => null,
      });

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
            allowKeychainPrompt: false,
          }),
          profileId,
          credential: managedCredential,
          agentDir,
        }),
      ).rejects.toBeInstanceOf(OAuthManagerRefreshError);
      const fenced = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
        allowKeychainPrompt: false,
      }).profiles[profileId];
      expect(fenced).toMatchObject({
        type: "oauth",
        provider: "openai",
        expires: 1,
        accountId: "acct-123",
        email: "user@example.com",
      });
      if (fenced?.type !== "oauth") {
        throw new Error("expected durable OAuth refresh fence");
      }
      expect(fenced.access).toMatch(
        /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:failed:access:[a-f0-9]{64}$/,
      );
      expect(fenced.refresh).toMatch(
        /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:failed:refresh:[a-f0-9]{64}$/,
      );
      expect(JSON.stringify(fenced)).not.toContain("managed-expired-access");
      expect(JSON.stringify(fenced)).not.toContain("managed-refresh");
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
        expires: Date.now() + 60_000,
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
        buildApiKey: async (_provider, credential) => credential.access,
        canRefreshCredential: async () => true,
        refreshCredential: vi.fn(async () => {
          throw new Error(
            "refresh rejected external-attempt-access external-attempt-refresh external-attempt-id-token",
          );
        }),
        readBootstrapCredential: () => externalCredential,
      });

      try {
        await manager.resolveOAuthAccess({
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
});
