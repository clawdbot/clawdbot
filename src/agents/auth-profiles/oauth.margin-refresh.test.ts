/**
 * Tests the built-in OAuth refresh margin-window fix (#103846).
 *
 * Once the manager's pre-expiry margin gate (`hasUsableOAuthCredential`, 5min)
 * decides a refresh is due, the built-in provider branch must rotate the token
 * directly instead of the previous no-op that handed back the same near-expiry
 * credential. A transient rotation failure inside the margin window must fail
 * open to the still-valid credential; a rotation failure after hard expiry must
 * still propagate.
 */
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import "./oauth-external-auth-passthrough.test-support.js";
import "./oauth-file-lock-passthrough.test-support.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  oauthCred,
  readAuthProfileStoreForTest,
  removeOAuthTestTempRoot,
  resetOAuthProviderRuntimeMocks,
  resolveApiKeyForProfileInTest,
  storeWith,
} from "./oauth-test-utils.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import { resetOAuthRefreshQueuesForTest } from "./oauth.test-support.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { OAuthCredential, OAuthCredentials } from "./types.js";

const { refreshTokenMock } = vi.hoisted(() => ({
  refreshTokenMock: vi.fn(async (_credential: OAuthCredential): Promise<OAuthCredentials> => {
    throw new Error("refreshToken not stubbed for this test");
  }),
}));

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

vi.mock("../../llm/oauth.js", () => ({
  // The fixed branch is generic across built-in providers; cover a second one
  // (github-copilot, which applies the same parse-time refresh skew) to prove
  // the behavior is not Anthropic-specific.
  getOAuthProviders: () => [
    { id: "anthropic", refreshToken: refreshTokenMock },
    { id: "github-copilot", refreshToken: refreshTokenMock },
  ],
}));

const PROFILE_ID = "anthropic:default";
const PROVIDER = "anthropic";

/** Expiry inside the 5min refresh margin: unusable to the manager, not raw-expired. */
function marginWindowExpiry(): number {
  return Date.now() + 2 * 60_000;
}

function seedMarginWindowStore(agentDir: string): void {
  saveAuthProfileStore(
    storeWith(
      PROFILE_ID,
      oauthCred({
        provider: PROVIDER,
        access: "stale-access-token",
        refresh: "stale-refresh-token",
        expires: marginWindowExpiry(),
        accountId: "acct-margin",
      }),
    ),
    agentDir,
  );
}

describe("built-in OAuth refresh inside the pre-expiry margin window (#103846)", () => {
  const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
  let tempRoot = "";
  let agentDir = "";
  let caseIndex = 0;

  beforeAll(async () => {
    tempRoot = await createOAuthTestTempRoot("openclaw-oauth-margin-");
  });

  beforeEach(async () => {
    resetFileLockStateForTest();
    resetOAuthProviderRuntimeMocks({
      refreshProviderOAuthCredentialWithPluginMock,
      formatProviderAuthProfileApiKeyWithPluginMock,
    });
    refreshTokenMock.mockReset();
    clearRuntimeAuthProfileStoreSnapshots();
    const caseRoot = path.join(tempRoot, `case-${++caseIndex}`);
    agentDir = await createOAuthMainAgentDir(caseRoot);
    resetOAuthRefreshQueuesForTest();
  });

  afterEach(async () => {
    envSnapshot.restore();
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    resetOAuthRefreshQueuesForTest();
  });

  afterAll(async () => {
    await removeOAuthTestTempRoot(tempRoot);
  });

  it("rotates the token when the manager enters the refresh margin (no silent no-op)", async () => {
    seedMarginWindowStore(agentDir);
    const rotatedExpiry = Date.now() + 60 * 60_000;
    refreshTokenMock.mockResolvedValueOnce({
      access: "rotated-access-token",
      refresh: "rotated-refresh-token",
      expires: rotatedExpiry,
    });

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(agentDir),
      profileId: PROFILE_ID,
      agentDir,
    });

    // The refresh actually contacted the provider instead of no-oping.
    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
    expect(result?.apiKey).toBe("rotated-access-token");

    // The rotated credential was persisted, not the stale near-expiry one.
    const persisted = readAuthProfileStoreForTest(agentDir).profiles[PROFILE_ID];
    if (persisted?.type !== "oauth") {
      throw new Error(`expected persisted OAuth credential for ${PROFILE_ID}`);
    }
    expect(persisted.access).toBe("rotated-access-token");
    expect(persisted.refresh).toBe("rotated-refresh-token");
    expect(persisted.expires).toBe(rotatedExpiry);
  });

  it("refreshes an identity-less in-window credential instead of hard-failing it", async () => {
    // Before the fix, an identity-less credential inside the margin window returned
    // stale, tripped the persist-miss path (no identity to recover), and hard-failed
    // even though the token was still valid (#103846 §Actual). A real refresh rotates
    // it and persists cleanly.
    saveAuthProfileStore(
      storeWith(
        PROFILE_ID,
        oauthCred({
          provider: PROVIDER,
          access: "stale-access-token",
          refresh: "stale-refresh-token",
          expires: marginWindowExpiry(),
          // no accountId: identity-less
        }),
      ),
      agentDir,
    );
    refreshTokenMock.mockResolvedValueOnce({
      access: "rotated-access-token",
      refresh: "rotated-refresh-token",
      expires: Date.now() + 60 * 60_000,
    });

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(agentDir),
      profileId: PROFILE_ID,
      agentDir,
    });

    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
    expect(result?.apiKey).toBe("rotated-access-token");
  });

  it("surfaces a margin-window refresh failure instead of hiding it behind the stale token", async () => {
    // A failed refresh must propagate so forced (doctor/CLI) and margin refreshes
    // alike report the failure rather than silently returning the stale token.
    seedMarginWindowStore(agentDir);
    refreshTokenMock.mockRejectedValueOnce(new Error("invalid_grant"));

    await expect(
      resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(agentDir),
        profileId: PROFILE_ID,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for anthropic/);
    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
  });

  it("propagates the refresh failure once the credential is hard-expired", async () => {
    saveAuthProfileStore(
      storeWith(
        PROFILE_ID,
        oauthCred({
          provider: PROVIDER,
          access: "expired-access-token",
          refresh: "expired-refresh-token",
          expires: Date.now() - 60_000,
        }),
      ),
      agentDir,
    );
    refreshTokenMock.mockRejectedValueOnce(new Error("invalid_grant"));

    await expect(
      resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(agentDir),
        profileId: PROFILE_ID,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for anthropic/);
    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
  });

  it("rotates an in-window github-copilot credential through the same generic branch", async () => {
    const profileId = "github-copilot:default";
    saveAuthProfileStore(
      storeWith(
        profileId,
        oauthCred({
          provider: "github-copilot",
          access: "stale-access-token",
          refresh: "stale-refresh-token",
          expires: marginWindowExpiry(),
          accountId: "acct-copilot",
        }),
      ),
      agentDir,
    );
    refreshTokenMock.mockResolvedValueOnce({
      access: "rotated-copilot-access",
      refresh: "rotated-copilot-refresh",
      expires: Date.now() + 60 * 60_000,
    });

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
    expect(result?.apiKey).toBe("rotated-copilot-access");
  });

  it("does not refresh a credential that is still comfortably before the margin", async () => {
    saveAuthProfileStore(
      storeWith(
        PROFILE_ID,
        oauthCred({
          provider: PROVIDER,
          access: "fresh-access-token",
          refresh: "fresh-refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
        }),
      ),
      agentDir,
    );

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(agentDir),
      profileId: PROFILE_ID,
      agentDir,
    });

    expect(refreshTokenMock).not.toHaveBeenCalled();
    expect(result?.apiKey).toBe("fresh-access-token");
  });
});
