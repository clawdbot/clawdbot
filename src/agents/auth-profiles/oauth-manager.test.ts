import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { captureEnv } from "../../test-utils/env.js";
import { __testing as externalAuthTesting } from "./external-auth.js";
import { legacyOAuthSidecarTestUtils } from "./legacy-oauth-sidecar.js";
import {
  createOAuthManager,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
  isSafeToOverwriteStoredOAuthIdentity,
  OAuthManagerRefreshError,
} from "./oauth-manager.js";
import { resolveAuthStorePath } from "./paths.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai-codex",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

const tempDirs: string[] = [];
const envSnapshot = captureEnv([
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "OPENCLAW_OAUTH_DIR",
  "OPENCLAW_AUTH_PROFILE_SECRET_KEY",
]);

beforeEach(() => {
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  clearRuntimeAuthProfileStoreSnapshots();
});

afterEach(async () => {
  envSnapshot.restore();
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("isSafeToOverwriteStoredOAuthIdentity", () => {
  it("refuses overwriting an existing identity-less credential with a different token", () => {
    expect(
      isSafeToOverwriteStoredOAuthIdentity(
        createCredential({}),
        createCredential({ access: "rotated-access", accountId: "acct-123" }),
      ),
    ).toBe(false);
  });

  it("refuses non-overlapping identity evidence", () => {
    expect(
      isSafeToOverwriteStoredOAuthIdentity(
        createCredential({ accountId: "acct-123" }),
        createCredential({ access: "rotated-access", email: "user@example.com" }),
      ),
    ).toBe(false);
  });

  it("still allows identity-less external bootstrap adoption", () => {
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

    expect(isSafeToOverwriteStoredOAuthIdentity(existing, incoming)).toBe(false);
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
  it.each([
    {
      name: "stored credential overwrite",
      check: () =>
        isSafeToOverwriteStoredOAuthIdentity(
          createCredential({ accountId: "acct-123" }),
          createCredential({ access: "rotated-access", accountId: "acct-123" }),
        ),
    },
    {
      name: "main-store adoption",
      check: () =>
        isSafeToAdoptMainStoreOAuthIdentity(
          createCredential({ accountId: "acct-123" }),
          createCredential({
            access: "main-access",
            refresh: "main-refresh",
            accountId: "acct-123",
          }),
        ),
    },
  ])("accepts matching account identities for $name", ({ check }) => {
    expect(check()).toBe(true);
  });
});

describe("OAuthManagerRefreshError", () => {
  it("serializes without leaking credential or store secrets", () => {
    const refreshedStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:default": createCredential({
          access: "store-access",
          refresh: "store-refresh",
        }),
      },
    };
    const error = new OAuthManagerRefreshError({
      credential: createCredential({ access: "error-access", refresh: "error-refresh" }),
      profileId: "openai-codex:default",
      refreshedStore,
      cause: new Error("boom"),
    });

    const serialized = JSON.stringify(error);
    expect(serialized).toContain("openai-codex");
    expect(serialized).toContain("openai-codex:default");
    expect(serialized).not.toContain("error-access");
    expect(serialized).not.toContain("error-refresh");
    expect(serialized).not.toContain("store-access");
    expect(serialized).not.toContain("store-refresh");
  });

  it("redacts credential secrets from the refresh error message", () => {
    const refreshedStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:default": createCredential({
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
      profileId: "openai-codex:default",
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
      profileId: "openai-codex:default",
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
        profileId: "openai-codex:default",
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
      profileId: "openai-codex:default",
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
  it("passes active config to OAuth API-key formatting", async () => {
    const profileId = "openai-codex:default";
    const credential = createCredential({ expires: Date.now() + 10 * 60_000 });
    const cfg = {
      models: {
        providers: {
          "openai-codex": { auth: "oauth", baseUrl: "", models: [] },
        },
      },
    } satisfies OpenClawConfig;
    const buildApiKey = vi.fn(async (_provider, value: OAuthCredential) => value.access);
    const manager = createOAuthManager({
      buildApiKey,
      refreshCredential: vi.fn(async () => null),
      readBootstrapCredential: () => null,
      isRefreshTokenReusedError: () => false,
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

    expect(buildApiKey).toHaveBeenCalledWith("openai-codex", credential, {
      cfg,
      agentDir: undefined,
    });
  });

  it("does not overlay external auth while checking main-store adoption", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-manager-main-adopt-"));
    tempDirs.push(tempRoot);
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    const mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    const agentDir = path.join(tempRoot, "agents", "sub", "agent");
    process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
    process.env.PI_CODING_AGENT_DIR = mainAgentDir;
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(mainAgentDir, { recursive: true });

    const profileId = "openai-codex:default";
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
      buildApiKey: async (_provider, credential) => credential.access,
      refreshCredential,
      readBootstrapCredential: () => null,
      isRefreshTokenReusedError: () => false,
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

  it("refreshes with the adopted external oauth credential", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-manager-refresh-"));
    tempDirs.push(tempRoot);
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    const mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    const agentDir = path.join(tempRoot, "agents", "sub", "agent");
    process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
    process.env.PI_CODING_AGENT_DIR = mainAgentDir;
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(mainAgentDir, { recursive: true });
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
      refreshCredential: vi.fn(async (credential) => {
        expect(credential.refresh).toBe("external-refresh");
        return {
          access: "rotated-access",
          refresh: "rotated-refresh",
          expires: Date.now() + 60_000,
        };
      }),
      readBootstrapCredential: () =>
        createCredential({
          provider: "minimax-portal",
          access: "expired-external-access",
          refresh: "external-refresh",
          expires: Date.now() - 30_000,
        }),
      isRefreshTokenReusedError: () => false,
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
  });

  it("refreshes legacy oauthRef sidecar credentials and writes rotated tokens inline", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-manager-legacy-ref-"));
    tempDirs.push(tempRoot);
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    process.env.OPENCLAW_OAUTH_DIR = path.join(tempRoot, "credentials");
    process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = "legacy-seed";
    const agentDir = path.join(tempRoot, "agents", "main", "agent");
    const profileId = "openai-codex:default";
    const ref = {
      source: "openclaw-credentials" as const,
      provider: "openai-codex" as const,
      id: "0123456789abcdef0123456789abcdef",
    };
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      resolveAuthStorePath(agentDir),
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              expires: Date.now() - 60_000,
              oauthRef: ref,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const sidecarPath = path.join(resolveOAuthDir(), "auth-profiles", `${ref.id}.json`);
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(
      sidecarPath,
      `${JSON.stringify(
        {
          version: 1,
          profileId,
          provider: "openai-codex",
          encrypted: legacyOAuthSidecarTestUtils.encryptLegacyOAuthMaterial({
            ref,
            profileId,
            provider: "openai-codex",
            seed: "legacy-seed",
            material: {
              access: "legacy-access",
              refresh: "legacy-refresh",
            },
          }),
        },
        null,
        2,
      )}\n`,
    );

    const store = ensureAuthProfileStore(agentDir);
    const credential = store.profiles[profileId];
    expect(credential?.type).toBe("oauth");
    expect(credential).toMatchObject({
      access: "legacy-access",
      refresh: "legacy-refresh",
    });
    const refreshCredential = vi.fn(async (input: OAuthCredential) => {
      expect(input.refresh).toBe("legacy-refresh");
      return {
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 60_000,
      };
    });
    const manager = createOAuthManager({
      buildApiKey: async (_provider, value) => value.access,
      refreshCredential,
      readBootstrapCredential: () => null,
      isRefreshTokenReusedError: () => false,
    });

    const result = await manager.resolveOAuthAccess({
      store,
      profileId,
      credential: credential as OAuthCredential,
      agentDir,
    });

    expect(refreshCredential).toHaveBeenCalledTimes(1);
    expect(result?.apiKey).toBe("rotated-access");
    const parsed = JSON.parse(await fs.readFile(resolveAuthStorePath(agentDir), "utf8")) as {
      profiles: Record<string, Record<string, unknown>>;
    };
    expect(parsed.profiles[profileId]).not.toHaveProperty("oauthRef");
    expect(parsed.profiles[profileId]).toMatchObject({
      access: "rotated-access",
      refresh: "rotated-refresh",
    });
  });

  it("redacts the external oauth credential attempted during refresh failures", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-manager-refresh-redact-"));
    tempDirs.push(tempRoot);
    process.env.OPENCLAW_STATE_DIR = tempRoot;
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
      refreshCredential: vi.fn(async () => {
        throw new Error(
          "refresh rejected external-attempt-access external-attempt-refresh external-attempt-id-token",
        );
      }),
      readBootstrapCredential: () => externalCredential,
      isRefreshTokenReusedError: () => false,
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
