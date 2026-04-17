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

// Cross-account-leak defense-in-depth: the three adopt sites in oauth.ts
// now all call isSameOAuthIdentity before copying main-store credentials
// into the sub-agent store. This suite exercises each of those sites
// with a mismatched accountId on main vs. sub and asserts the adoption
// is refused (sub store keeps its own credential; main's creds do not
// leak through).

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

function oauthCred(params: {
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
}): OAuthCredential {
  return { type: "oauth", ...params };
}

function storeWith(profileId: string, cred: OAuthCredential): AuthProfileStore {
  return { version: 1, profiles: { [profileId]: cred } };
}

describe("OAuth credential adoption is identity-gated", () => {
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
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-adopt-identity-"));
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

  it("adoptNewerMainOAuthCredential refuses to adopt across accountId mismatch (pre-refresh path)", async () => {
    // Scenario: sub-agent starts with a still-valid OAuth cred (so no
    // refresh is triggered), but main holds an even fresher cred for a
    // different account. The pre-refresh adopt must refuse.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const subExpiry = Date.now() + 10 * 60 * 1000;
    const mainFresher = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-prerefresh", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "sub-own-access",
          refresh: "sub-own-refresh",
          expires: subExpiry,
          accountId: "acct-sub",
        }),
      ),
      subAgentDir,
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "main-foreign-access",
          refresh: "main-foreign-refresh",
          expires: mainFresher,
          accountId: "acct-other",
        }),
      ),
      mainAgentDir,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    // Sub-agent must keep using its own access token, not main's foreign one.
    expect(result?.apiKey).toBe("sub-own-access");

    // Sub-agent store must NOT have been overwritten with main's foreign cred.
    const subRaw = JSON.parse(
      await fs.readFile(path.join(subAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(subRaw.profiles[profileId]).toMatchObject({
      access: "sub-own-access",
      accountId: "acct-sub",
    });
  });

  it("inside-the-lock main adoption refuses across accountId mismatch and proceeds to own refresh", async () => {
    // Scenario: sub-agent's cred is expired, enters refreshOAuthTokenWithLock.
    // Inside the lock, main holds FRESH creds for a DIFFERENT account. The
    // inside-lock adopt branch must refuse and fall through to the HTTP
    // refresh path using the sub-agent's own refresh token.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-insidelock", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "sub-stale-access",
          refresh: "sub-refresh-token",
          expires: Date.now() - 60_000,
          accountId: "acct-sub",
        }),
      ),
      subAgentDir,
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "main-foreign-access",
          refresh: "main-foreign-refresh",
          expires: freshExpiry,
          accountId: "acct-other",
        }),
      ),
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

    // Sub-agent performed its own refresh (mock fired once) and got its
    // own new token, not main's foreign one.
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
    expect(result?.apiKey).toBe("sub-refreshed-access");

    // Main must still hold its foreign cred, untouched (mirror would also
    // refuse because of identity mismatch).
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "main-foreign-access",
      accountId: "acct-other",
    });
  });

  it("adoptNewerMainOAuthCredential still adopts when sub has no identity but main does (upgrade tolerance)", async () => {
    // Scenario: sub-agent stored its cred before accountId/email were
    // captured. Main has fresh cred with accountId. Under the STRICT rule
    // this would refuse (asymmetric). Under the relaxed rule used for
    // adoption it must allow — otherwise #26322 breaks for existing
    // installs on upgrade.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const subExpiry = Date.now() + 10 * 60 * 1000;
    const mainFresher = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-upgrade", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "sub-own-access",
          refresh: "sub-own-refresh",
          expires: subExpiry,
          // no accountId / email — pre-capture state
        }),
      ),
      subAgentDir,
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "main-fresher-access",
          refresh: "main-fresher-refresh",
          expires: mainFresher,
          accountId: "acct-main",
        }),
      ),
      mainAgentDir,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    // Sub must have adopted main's fresher credential.
    expect(result?.apiKey).toBe("main-fresher-access");

    const subRaw = JSON.parse(
      await fs.readFile(path.join(subAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(subRaw.profiles[profileId]).toMatchObject({
      access: "main-fresher-access",
      accountId: "acct-main",
    });
  });

  it("inside-the-lock adopt tolerates sub-no-identity / main-has-identity (upgrade case)", async () => {
    // Same upgrade scenario but entering via the inside-lock adopt path:
    // sub cred is EXPIRED (forces entry into refreshOAuthTokenWithLock),
    // main has FRESH cred with accountId, sub has no identity.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-insidelock-upgrade", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "sub-stale-access",
          refresh: "sub-stale-refresh",
          expires: Date.now() - 60_000,
          // no identity metadata
        }),
      ),
      subAgentDir,
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "main-fresh-access",
          refresh: "main-fresh-refresh",
          expires: freshExpiry,
          accountId: "acct-main",
        }),
      ),
      mainAgentDir,
    );

    // Plugin refresh must NOT be called — sub should adopt main's fresh
    // cred rather than performing its own refresh.
    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
    expect(result?.apiKey).toBe("main-fresh-access");
  });

  it("adoptNewerMainOAuthCredential refuses non-overlapping identity fields (sub has accountId, main has email)", async () => {
    // Reviewer-requested: with no COMPARABLE shared identity field there
    // is no positive-match evidence, so adoption must refuse.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const subExpiry = Date.now() + 10 * 60 * 1000;
    const mainFresher = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-nonoverlap-pre", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "sub-own-access",
          refresh: "sub-own-refresh",
          expires: subExpiry,
          accountId: "acct-sub",
          // NO email on sub
        }),
      ),
      subAgentDir,
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "main-fresher-access",
          refresh: "main-fresher-refresh",
          expires: mainFresher,
          email: "main@example.com",
          // NO accountId on main
        }),
      ),
      mainAgentDir,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    // Sub must keep its own credential; pre-refresh adopt is refused.
    expect(result?.apiKey).toBe("sub-own-access");

    const subRaw = JSON.parse(
      await fs.readFile(path.join(subAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(subRaw.profiles[profileId]).toMatchObject({
      access: "sub-own-access",
      accountId: "acct-sub",
    });
  });

  it("inside-the-lock adopt refuses non-overlapping identity fields (sub has accountId, main has email)", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-nonoverlap-inside", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "sub-stale-access",
          refresh: "sub-refresh-token",
          expires: Date.now() - 60_000,
          accountId: "acct-sub",
        }),
      ),
      subAgentDir,
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "main-fresh-access",
          refresh: "main-fresh-refresh",
          expires: freshExpiry,
          email: "main@example.com",
        }),
      ),
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

    // Sub performed its own refresh rather than adopting main's email-only cred.
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
    expect(result?.apiKey).toBe("sub-refreshed-access");
  });

  it("catch-block main-inherit refuses non-overlapping identity fields", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-nonoverlap-catch", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "sub-stale-access",
          refresh: "sub-refresh-token",
          expires: Date.now() - 60_000,
          accountId: "acct-sub",
        }),
      ),
      subAgentDir,
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "main-stale-access",
          refresh: "main-stale-refresh",
          expires: Date.now() - 60_000,
          email: "main@example.com",
        }),
      ),
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      // Another process writes a fresh email-only cred into main while
      // our refresh is in-flight, then we throw a generic upstream error.
      saveAuthProfileStore(
        storeWith(
          profileId,
          oauthCred({
            provider,
            access: "main-refreshed-access",
            refresh: "main-refreshed-refresh",
            expires: freshExpiry,
            email: "main@example.com",
          }),
        ),
        mainAgentDir,
      );
      throw new Error("upstream 503 service unavailable");
    });

    // Catch-block main-inherit must refuse the non-overlapping cred and
    // propagate the original error rather than leaking main's credential.
    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(subAgentDir),
        profileId,
        agentDir: subAgentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai-codex/);
  });

  it("catch-block main-inherit tolerates sub-no-identity / main-has-identity (upgrade case)", async () => {
    // Upgrade scenario hitting the catch-block fallback: sub refresh
    // throws, main later carries fresh cred with identity. Sub must
    // inherit rather than surface the error to the caller.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-catch-upgrade", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "sub-stale-access",
          refresh: "sub-stale-refresh",
          expires: Date.now() - 60_000,
          // no identity metadata
        }),
      ),
      subAgentDir,
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "main-stale-access",
          refresh: "main-stale-refresh",
          expires: Date.now() - 60_000,
          accountId: "acct-main",
        }),
      ),
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      // Another process refreshes main while our refresh is in flight.
      saveAuthProfileStore(
        storeWith(
          profileId,
          oauthCred({
            provider,
            access: "main-refreshed-access",
            refresh: "main-refreshed-refresh",
            expires: freshExpiry,
            accountId: "acct-main",
          }),
        ),
        mainAgentDir,
      );
      throw new Error("upstream 503 service unavailable");
    });

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    // Sub inherited main's fresh cred via the catch-block fallback.
    expect(result?.apiKey).toBe("main-refreshed-access");
  });

  it("catch-block main-inherit refuses across accountId mismatch and surfaces the original error", async () => {
    // Scenario: sub-agent refresh throws a non-refresh_token_reused error.
    // Main has fresh creds for a DIFFERENT account. The catch-block
    // main-inherit fallback must refuse to adopt and let the original
    // error propagate (wrapped).
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-catch-refuse", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "sub-stale",
          refresh: "sub-refresh-token",
          expires: Date.now() - 60_000,
          accountId: "acct-sub",
        }),
      ),
      subAgentDir,
    );
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider,
          access: "main-foreign-access",
          refresh: "main-foreign-refresh",
          expires: Date.now() - 60_000,
          accountId: "acct-other",
        }),
      ),
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      // Simulate another process writing fresh creds to main for a
      // DIFFERENT account while our refresh is in flight, then our
      // refresh throws a generic upstream error.
      saveAuthProfileStore(
        storeWith(
          profileId,
          oauthCred({
            provider,
            access: "main-foreign-refreshed",
            refresh: "main-foreign-refresh-new",
            expires: freshExpiry,
            accountId: "acct-other",
          }),
        ),
        mainAgentDir,
      );
      throw new Error("upstream 503 service unavailable");
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(subAgentDir),
        profileId,
        agentDir: subAgentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai-codex/);

    // Sub-agent store must still have its own stale cred \u2014 no leak.
    const subRaw = JSON.parse(
      await fs.readFile(path.join(subAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(subRaw.profiles[profileId]).toMatchObject({
      access: "sub-stale",
      accountId: "acct-sub",
    });
  });
});
