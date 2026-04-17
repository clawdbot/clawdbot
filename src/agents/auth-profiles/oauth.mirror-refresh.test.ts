import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let resetOAuthRefreshQueuesForTest: typeof import("./oauth.js").resetOAuthRefreshQueuesForTest;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile, resetOAuthRefreshQueuesForTest } = await import("./oauth.js"));
}

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = vi.hoisted(() => ({
  refreshProviderOAuthCredentialWithPluginMock: vi.fn(
    async (_params?: { context?: unknown }) => undefined,
  ),
  formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
}));

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
  writeCodexCliCredentials: () => true,
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  formatProviderAuthProfileApiKeyWithPlugin: (params: { context?: { access?: string } }) =>
    formatProviderAuthProfileApiKeyWithPluginMock() ?? params?.context?.access,
  refreshProviderOAuthCredentialWithPlugin: refreshProviderOAuthCredentialWithPluginMock,
}));

vi.mock("./doctor.js", () => ({
  formatAuthDoctorHint: async () => undefined,
}));

vi.mock("./external-cli-sync.js", () => ({
  syncExternalCliCredentials: () => false,
  readManagedExternalCliCredential: () => null,
  areOAuthCredentialsEquivalent: (a: unknown, b: unknown) => a === b,
}));

function createExpiredOauthStore(params: {
  profileId: string;
  provider: string;
  access?: string;
  refresh?: string;
  accountId?: string;
  email?: string;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: params.provider,
        access: params.access ?? "cached-access-token",
        refresh: params.refresh ?? "refresh-token",
        expires: Date.now() - 60_000,
        accountId: params.accountId,
        email: params.email,
      } satisfies OAuthCredential,
    },
  };
}

describe("resolveApiKeyForProfile OAuth refresh mirror-to-main (#26322)", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempRoot = "";
  let mainAgentDir = "";

  beforeEach(async () => {
    resetFileLockStateForTest();
    refreshProviderOAuthCredentialWithPluginMock.mockReset();
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue(undefined);
    formatProviderAuthProfileApiKeyWithPluginMock.mockReset();
    formatProviderAuthProfileApiKeyWithPluginMock.mockReturnValue(undefined);
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-mirror-"));
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await loadOAuthModuleForTest();
    resetOAuthRefreshQueuesForTest();
  });

  afterEach(async () => {
    envSnapshot.restore();
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    if (resetOAuthRefreshQueuesForTest) {
      resetOAuthRefreshQueuesForTest();
    }
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("mirrors refreshed credentials into the main store so peers skip refresh", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const accountId = "acct-shared";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-mirror", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), subAgentDir);
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), mainAgentDir);

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "sub-refreshed-access",
          refresh: "sub-refreshed-refresh",
          expires: freshExpiry,
          accountId,
        }) as never,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("sub-refreshed-access");

    // Main store should now carry the refreshed credential, so a peer agent
    // starting fresh will adopt rather than race.
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "sub-refreshed-access",
      refresh: "sub-refreshed-refresh",
      expires: freshExpiry,
    });
  });

  it("does not mirror when refresh was performed from the main agent itself", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, access: "main-stale-access" }),
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "main-refreshed-access",
          refresh: "main-refreshed-refresh",
          expires: freshExpiry,
        }) as never,
    );

    // Main-agent refresh uses undefined agentDir; the mirror path is a no-op
    // (local == main). Just make sure the main store still reflects the refresh
    // and no double-write happens.
    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(undefined),
      profileId,
      agentDir: undefined,
    });

    expect(result?.apiKey).toBe("main-refreshed-access");
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "main-refreshed-access",
      refresh: "main-refreshed-refresh",
      expires: freshExpiry,
    });
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to mirror when main has a non-oauth entry for the same profileId", async () => {
    // Exercises the `existing.type !== "oauth"` early-return in the mirror
    // updater. If the operator has manually switched the main profile to
    // an api_key, a secondary-agent's OAuth refresh must not clobber it.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-non-oauth", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), subAgentDir);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "api_key",
            provider,
            key: "operator-key",
          },
        },
      },
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "sub-refreshed-access",
          refresh: "sub-refreshed-refresh",
          expires: freshExpiry,
        }) as never,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });
    expect(result?.apiKey).toBe("sub-refreshed-access");

    // Main must still hold the operator's api_key, untouched.
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      type: "api_key",
      key: "operator-key",
    });
  });

  it("refuses to mirror when identity (accountId) mismatches", async () => {
    // Exercises the CWE-284 identity gate: main carries acct-other, sub-agent
    // refreshes as acct-mine — mirror must be refused.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-bad-identity", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider,
        access: "sub-stale",
        accountId: "acct-mine",
      }),
      subAgentDir,
    );
    // Main has a different account for the same profileId — this is the
    // cross-account-leak scenario that the gate must block.
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-other-access",
            refresh: "main-other-refresh",
            expires: Date.now() - 60_000,
            accountId: "acct-other",
          },
        },
      },
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "sub-refreshed-access",
          refresh: "sub-refreshed-refresh",
          expires: freshExpiry,
          accountId: "acct-mine",
        }) as never,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });
    // Sub-agent gets its fresh token as usual.
    expect(result?.apiKey).toBe("sub-refreshed-access");

    // But main store must still hold acct-other's credential unchanged.
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "main-other-access",
      accountId: "acct-other",
    });
  });

  it("refuses to mirror when main already has a strictly-fresher credential", async () => {
    // Exercises the `existing.expires >= refreshed.expires` early-return.
    // Scenario: main already completed a refresh (with a later expiry) while
    // the sub-agent's refresh was in-flight; our mirror must not regress it.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const subFreshExpiry = Date.now() + 30 * 60 * 1000;
    const mainFresherExpiry = Date.now() + 90 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-older", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: "acct-shared" }),
      subAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-already-fresh",
            refresh: "main-already-fresh-refresh",
            expires: mainFresherExpiry,
            accountId: "acct-shared",
          },
        },
      },
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "sub-refreshed-older",
          refresh: "sub-refreshed-older-refresh",
          expires: subFreshExpiry,
          accountId: "acct-shared",
        }) as never,
    );

    // The sub-agent will actually adopt main's fresher creds via the inside-
    // lock recheck (that's the whole point of #26322), so refresh may not
    // even fire. We only care that the main store is not regressed.
    await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "main-already-fresh",
      expires: mainFresherExpiry,
    });
  });

  it("refuses to mirror when main has a different provider for the same profileId", async () => {
    // Exercises the `existing.provider !== params.refreshed.provider` branch
    // in the mirror updater. Main holds a credential under the same profileId
    // but for a different provider — mirror must refuse so we never silently
    // rewrite a provider.
    const profileId = "shared:default";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-provmismatch", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider: "openai-codex" }),
      subAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "anthropic", // deliberately different
            access: "main-anthropic-access",
            refresh: "main-anthropic-refresh",
            expires: Date.now() + 60 * 60 * 1000,
          },
        },
      },
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider: "openai-codex",
          access: "sub-refreshed-access",
          refresh: "sub-refreshed-refresh",
          expires: freshExpiry,
        }) as never,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });
    expect(result?.apiKey).toBe("sub-refreshed-access");

    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    // Main must still hold its anthropic entry, not the openai-codex one.
    expect(mainRaw.profiles[profileId]).toMatchObject({
      provider: "anthropic",
      access: "main-anthropic-access",
    });
  });

  it("mirrors when main's existing cred has a non-finite expires (treated as overwritable)", async () => {
    // Exercises the `Number.isFinite(existing.expires)` branch — when main
    // has a stored cred with NaN/missing expiry, we treat it as overwritable
    // rather than refusing to write a fresh one.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const accountId = "acct-shared";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-nanexp", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), subAgentDir);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-nan-access",
            refresh: "main-nan-refresh",
            expires: Number.NaN,
            accountId,
          },
        },
      },
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "sub-refreshed-access",
          refresh: "sub-refreshed-refresh",
          expires: freshExpiry,
          accountId,
        }) as never,
    );

    await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "sub-refreshed-access",
      expires: freshExpiry,
    });
  });

  it("inherits main-agent credentials via the pre-refresh adopt path when main is already fresher", async () => {
    // Exercises adoptNewerMainOAuthCredential at the top of
    // resolveApiKeyForProfile: main is fresher at flow start, so we adopt
    // BEFORE the refresh attempt. End-user outcome: sub transparently uses
    // main's creds.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-fail-inherit", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: "acct-shared" }),
      subAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-fresh-access",
            refresh: "main-fresh-refresh",
            expires: freshExpiry,
            accountId: "acct-shared",
          },
        },
      },
      mainAgentDir,
    );

    // Refresh mock intentionally left as default-undefined — it should not
    // be called, the pre-refresh adopt wins.
    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("main-fresh-access");
    expect(result?.provider).toBe(provider);
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
  });

  it("inherits main-agent credentials via the catch-block fallback when refresh throws after main becomes fresh", async () => {
    // Exercises the specific catch-block `if (params.agentDir) { mainStore … }`
    // branch (lines 826-848 in oauth.ts). Setup:
    //   1. sub + main BOTH expired at the start of resolveApiKeyForProfile,
    //      so adoptNewerMainOAuthCredential does not short-circuit.
    //   2. Inside refreshOAuthTokenWithLock, the plugin refresh mock writes
    //      fresh credentials into the main store and then throws a non-
    //      refresh_token_reused error. This simulates "another process
    //      completed a refresh just as ours failed".
    //   3. The catch block's loadFreshStoredOAuthCredential reads the sub
    //      store (still expired). Then the main-agent-inherit fallback
    //      kicks in, copies main's fresh creds into the sub store, and
    //      returns them.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-catch-inherit", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: "acct-shared" }),
      subAgentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: "acct-shared" }),
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      // Simulate another agent completing its refresh and writing fresh
      // creds to main, concurrent with our attempt.
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider,
              access: "main-side-refreshed-access",
              refresh: "main-side-refreshed-refresh",
              expires: freshExpiry,
              accountId: "acct-shared",
            },
          },
        },
        mainAgentDir,
      );
      // Now throw a non-refresh_token_reused error so we fall through the
      // recovery branches into the catch-block main-agent inherit.
      throw new Error("upstream 503 service unavailable");
    });

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("main-side-refreshed-access");
    expect(result?.provider).toBe(provider);

    // Sub-agent's store should now carry main's creds (inherited).
    const subRaw = JSON.parse(
      await fs.readFile(path.join(subAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(subRaw.profiles[profileId]).toMatchObject({
      access: "main-side-refreshed-access",
      expires: freshExpiry,
    });
  });

  it("mirrors an identity-carrying refresh into a main store that has no identity (upgrade)", async () => {
    // The Codex P1 scenario: main holds a pre-capture OAuth record (no
    // accountId), the fresh sub-agent refresh response carries accountId.
    // Mirror must accept so subsequent peers can adopt from main instead
    // of hitting refresh_token_reused.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-upgrade-mirror", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    // Sub has accountId (modern capture); stale.
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: "acct-sub" }),
      subAgentDir,
    );
    // Main is pre-capture — no accountId at all.
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-pre-capture-access",
            refresh: "main-pre-capture-refresh",
            expires: Date.now() - 60_000,
          },
        },
      },
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "sub-refreshed-access",
          refresh: "sub-refreshed-refresh",
          expires: freshExpiry,
          accountId: "acct-sub",
        }) as never,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });
    expect(result?.apiKey).toBe("sub-refreshed-access");

    // Main must have accepted the mirror, with the identity marker added.
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "sub-refreshed-access",
      accountId: "acct-sub",
    });
  });

  it("refuses to mirror when incoming drops an identity field present on main (regression guard)", async () => {
    // Inverse of the upgrade test: main has accountId, incoming refresh
    // response lacks it. Mirror must refuse so the identity marker is
    // preserved — dropping it would later let a different-account sub pass
    // the relaxed adoption gate.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-regression", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), subAgentDir);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-identity-access",
            refresh: "main-identity-refresh",
            expires: Date.now() + 30 * 60 * 1000,
            accountId: "acct-main",
          },
        },
      },
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "sub-refreshed-no-identity",
          refresh: "sub-refreshed-no-identity-refresh",
          expires: freshExpiry,
          // intentionally no accountId / no email — the regression case
        }) as never,
    );

    await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    // Main must still hold its accountId-bearing credential; mirror refused.
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "main-identity-access",
      accountId: "acct-main",
    });
  });

  it("mirrors refreshed credentials produced by the plugin-refresh path", async () => {
    // The plugin-refreshed branch in doRefreshOAuthTokenWithLock has its own
    // mirror call; cover it separately so the branch is not orphaned.
    const profileId = "anthropic:plugin";
    const provider = "anthropic";
    const accountId = "acct-plugin";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-plugin", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), subAgentDir);
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), mainAgentDir);

    // Plugin returns a truthy refreshed credential — this takes the plugin
    // branch instead of falling through to getOAuthApiKey.
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          access: "plugin-refreshed-access",
          refresh: "plugin-refreshed-refresh",
          expires: freshExpiry,
        }) as never,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });
    expect(result?.apiKey).toBe("plugin-refreshed-access");

    // Main store must have been mirrored from the plugin-refresh branch.
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "plugin-refreshed-access",
      refresh: "plugin-refreshed-refresh",
      expires: freshExpiry,
    });
  });
});
