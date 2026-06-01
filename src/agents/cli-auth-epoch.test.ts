import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  resetCliAuthEpochTestDeps,
  resolveCliAuthEpoch,
  setCliAuthEpochTestDeps,
} from "./cli-auth-epoch.js";

describe("resolveCliAuthEpoch", () => {
  afterEach(() => {
    resetCliAuthEpochTestDeps();
  });

  function expectCliAuthEpoch(
    epoch: Awaited<ReturnType<typeof resolveCliAuthEpoch>>,
    label = "auth epoch",
  ): asserts epoch is string {
    expect(typeof epoch, label).toBe("string");
    expect(epoch, label).toMatch(/^[a-f0-9]{64}$/);
  }

  it("returns undefined when no local or auth-profile credentials exist", async () => {
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => null,
      readCodexCliCredentialsCached: () => null,
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {},
      }),
    });

    await expect(
      resolveCliAuthEpoch({
        provider: "claude-cli",
        authProfileId: "anthropic:work",
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveCliAuthEpoch({
        provider: "google-gemini-cli",
        authProfileId: "google:work",
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps identity-less claude cli oauth epochs stable across token changes", async () => {
    let access = "access-a";
    let refresh = "refresh-a";
    let expires = 1;
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "oauth",
        provider: "anthropic",
        access,
        refresh,
        expires,
      }),
    });

    const first = await resolveCliAuthEpoch({ provider: "claude-cli" });
    access = "access-b";
    refresh = "refresh-b";
    expires = 2;
    const second = await resolveCliAuthEpoch({ provider: "claude-cli" });

    expectCliAuthEpoch(first);
    expect(second).toBe(first);
  });

  it("keeps claude cli token epochs stable across token rotation", async () => {
    let token = "token-a";
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "token",
        provider: "anthropic",
        token,
        expires: 1,
      }),
    });

    const first = await resolveCliAuthEpoch({ provider: "claude-cli" });
    token = "token-b";
    const second = await resolveCliAuthEpoch({ provider: "claude-cli" });

    expectCliAuthEpoch(first);
    // Static-token rotation is an authorized credential refresh, not an
    // identity change. After #74312 the hash is identity-only for both
    // OAuth and token branches, so rotation does not invalidate the epoch.
    expect(second).toBe(first);
  });

  it("matches claude cli token and oauth epochs so partial keychain reads do not flip", async () => {
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "oauth",
        provider: "anthropic",
        access: "access",
        refresh: "refresh",
        expires: 1,
      }),
    });
    const oauthEpoch = await resolveCliAuthEpoch({ provider: "claude-cli" });

    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "token",
        provider: "anthropic",
        token: "access",
        expires: 1,
      }),
    });
    const tokenEpoch = await resolveCliAuthEpoch({ provider: "claude-cli" });

    expectCliAuthEpoch(oauthEpoch);
    expectCliAuthEpoch(tokenEpoch);
    // The macOS Claude keychain rewrite is not atomic. A transient read with
    // `refreshToken` missing falls into the parser's token branch; the OAuth
    // and token encodings must produce the same hash so the auth-epoch does
    // not flip during a token rotation. Regression for #74312.
    expect(tokenEpoch).toBe(oauthEpoch);
  });

  it("drops the claude cli epoch when the credential read is absent", async () => {
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "oauth",
        provider: "anthropic",
        access: "access",
        refresh: "refresh",
        expires: 1,
      }),
    });
    const successfulRead = await resolveCliAuthEpoch({ provider: "claude-cli" });

    // A null read can mean the credential was removed or logout left no
    // readable auth state. Keep that absence visible so reusable sessions do
    // not survive a true auth-state loss.
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => null,
    });
    const nullRead = await resolveCliAuthEpoch({ provider: "claude-cli" });

    expectCliAuthEpoch(successfulRead);
    expect(nullRead).toBeUndefined();
  });

  it("keeps gemini cli oauth epochs stable through token rotation and flips on account change", async () => {
    let access = "gemini-access-a";
    let refresh = "gemini-refresh-a";
    let expires = 1;
    let accountId: string | undefined = "google-account-1";
    let email: string | undefined = "user-a@example.com";
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => ({
        type: "oauth",
        provider: "google-gemini-cli",
        access,
        refresh,
        expires,
        ...(accountId ? { accountId } : {}),
        ...(email ? { email } : {}),
      }),
    });

    const first = await resolveCliAuthEpoch({ provider: "google-gemini-cli" });
    access = "gemini-access-b";
    refresh = "gemini-refresh-b";
    expires = 2;
    const second = await resolveCliAuthEpoch({ provider: "google-gemini-cli" });

    expectCliAuthEpoch(first);
    // Access and refresh rotation must not shift the epoch while the lifted
    // Google-account identity is stable.
    expect(second).toBe(first);

    email = "user-b@example.com";
    const third = await resolveCliAuthEpoch({ provider: "google-gemini-cli" });

    expectCliAuthEpoch(third);
    expect(third).not.toBe(second);

    accountId = "google-account-2";
    const fourth = await resolveCliAuthEpoch({ provider: "google-gemini-cli" });

    expectCliAuthEpoch(fourth);
    expect(fourth).not.toBe(third);
  });

  it("falls back to the identity-less oauth epoch when gemini id_token is absent", async () => {
    let refresh = "gemini-refresh-a";
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => ({
        type: "oauth",
        provider: "google-gemini-cli",
        access: "gemini-access",
        refresh,
        expires: 1,
      }),
    });

    const first = await resolveCliAuthEpoch({ provider: "google-gemini-cli" });
    refresh = "gemini-refresh-b";
    const second = await resolveCliAuthEpoch({ provider: "google-gemini-cli" });

    expectCliAuthEpoch(first);
    // Without lifted identity, the epoch is a provider-keyed constant that
    // survives token rotation — same fallback as the Claude CLI OAuth branch.
    expect(second).toBe(first);
  });

  it("keeps oauth auth-profile epochs stable across token refreshes", async () => {
    let store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-a",
          refresh: "refresh-a",
          expires: 1,
          email: "user@example.com",
        },
      },
    };
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => store,
    });

    const first = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });
    store = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-b",
          refresh: "refresh-b",
          expires: 2,
          email: "user@example.com",
        },
      },
    };
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });

    expectCliAuthEpoch(first);
    expect(second).toBe(first);
  });

  it("keeps oauth auth-profile epochs stable across profile id aliases for the same account", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-a",
          refresh: "refresh-a",
          expires: 1,
          email: "user@example.com",
        },
        "anthropic:work-alias": {
          type: "oauth",
          provider: "anthropic",
          access: "access-b",
          refresh: "refresh-b",
          expires: 2,
          email: "user@example.com",
        },
      },
    };
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => store,
    });

    const first = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work-alias",
    });

    expectCliAuthEpoch(first);
    expect(second).toBe(first);
  });

  it("keeps identity-less oauth auth-profile epochs scoped to the profile id", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-a",
          refresh: "refresh-a",
          expires: 1,
        },
        "anthropic:personal": {
          type: "oauth",
          provider: "anthropic",
          access: "access-b",
          refresh: "refresh-b",
          expires: 2,
        },
      },
    };
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => store,
    });

    const first = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:personal",
    });

    expectCliAuthEpoch(first);
    expectCliAuthEpoch(second);
    expect(second).not.toBe(first);
  });

  it("keeps token auth-profile epochs stable across credential.token rotation when identity is present", async () => {
    let store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "token",
          provider: "anthropic",
          token: "token-a",
          tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
          email: "user@example.com",
          displayName: "Work",
        },
      },
    };
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => store,
    });

    const first = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });
    store = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "token",
          provider: "anthropic",
          token: "token-b",
          tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
          email: "user@example.com",
          displayName: "Work",
        },
      },
    };
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });

    expectCliAuthEpoch(first);
    // Ref-backed token rotation must not flip the epoch; the token material is
    // only a refreshable secret when the profile has a stable secret owner.
    expect(second).toBe(first);
  });

  it("changes token auth-profile epochs when token-only credentials change", async () => {
    let store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:token-only": {
          type: "token",
          provider: "anthropic",
          token: "token-a",
          displayName: "Manual token",
        },
      },
    };
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => store,
    });

    const first = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:token-only",
    });
    store = {
      version: 1,
      profiles: {
        "anthropic:token-only": {
          type: "token",
          provider: "anthropic",
          token: "token-b",
          displayName: "Manual token",
        },
      },
    };
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:token-only",
    });

    expectCliAuthEpoch(first);
    expectCliAuthEpoch(second);
    // Token-only profiles have no stable account/ref identity, so the token
    // remains the session owner and manual replacement still invalidates.
    expect(second).not.toBe(first);
  });

  it("changes token auth-profile epochs when the email identity changes", async () => {
    let store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "token",
          provider: "anthropic",
          token: "token",
          email: "user-a@example.com",
          displayName: "Work",
        },
      },
    };
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => store,
    });

    const first = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });
    store = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "token",
          provider: "anthropic",
          token: "token",
          email: "user-b@example.com",
          displayName: "Work",
        },
      },
    };
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });

    expectCliAuthEpoch(first);
    expectCliAuthEpoch(second);
    // A real account switch on a static-token profile must still invalidate
    // the epoch so reusable CLI sessions don't outlive the identity change.
    expect(second).not.toBe(first);
  });

  it("changes oauth auth-profile epochs when the account identity changes", async () => {
    let store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: 1,
          email: "user-a@example.com",
        },
      },
    };
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => store,
    });

    const first = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });
    store = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: 1,
          email: "user-b@example.com",
        },
      },
    };
    const second = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });

    expectCliAuthEpoch(first);
    expectCliAuthEpoch(second);
    expect(second).not.toBe(first);
  });

  it("mixes local codex and auth-profile state", async () => {
    let access = "local-access-a";
    let localRefresh = "local-refresh-a";
    let refresh = "profile-refresh-a";
    let accountId = "acct-1";
    let email = "user-a@example.com";
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached: () => ({
        type: "oauth",
        provider: "openai",
        access,
        refresh: localRefresh,
        expires: 1,
        accountId,
      }),
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {
          "openai:work": {
            type: "oauth",
            provider: "openai",
            access: "profile-access",
            refresh,
            expires: 1,
            email,
          },
        },
      }),
    });

    const first = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    access = "local-access-b";
    const second = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    localRefresh = "local-refresh-b";
    const third = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    refresh = "profile-refresh-b";
    const fourth = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    accountId = "acct-2";
    const fifth = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    email = "user-b@example.com";
    const sixth = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });

    expectCliAuthEpoch(first);
    expect(second).toBe(first);
    expect(third).toBe(second);
    expect(fourth).toBe(third);
    expectCliAuthEpoch(fifth);
    expectCliAuthEpoch(sixth);
    expect(fifth).not.toBe(fourth);
    expect(sixth).not.toBe(fifth);
  });

  it("can ignore local codex state when the backend is profile-owned", async () => {
    let localAccess = "local-access-a";
    let profileRefresh = "profile-refresh-a";
    let profileAccountId = "acct-1";
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached: () => ({
        type: "oauth",
        provider: "openai",
        access: localAccess,
        refresh: "local-refresh",
        expires: 1,
        accountId: "acct-1",
      }),
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {
          "openai:default": {
            type: "oauth",
            provider: "openai",
            access: "profile-access",
            refresh: profileRefresh,
            expires: 1,
            accountId: profileAccountId,
          },
        },
      }),
    });

    const first = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:default",
      skipLocalCredential: true,
    });
    localAccess = "local-access-b";
    const second = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:default",
      skipLocalCredential: true,
    });
    profileRefresh = "profile-refresh-b";
    const third = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:default",
      skipLocalCredential: true,
    });
    profileAccountId = "acct-2";
    const fourth = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:default",
      skipLocalCredential: true,
    });

    expectCliAuthEpoch(first);
    expect(second).toBe(first);
    expect(third).toBe(second);
    expectCliAuthEpoch(fourth);
    expect(fourth).not.toBe(third);
  });

  it("uses non-prompting Codex CLI credential reads for epoch fingerprints", async () => {
    const readCodexCliCredentialsCached = vi.fn(() => ({
      type: "oauth" as const,
      provider: "openai" as const,
      access: "local-access",
      refresh: "local-refresh",
      expires: 1,
    }));
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached,
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {},
      }),
    });

    await resolveCliAuthEpoch({ provider: "codex-cli" });

    expect(readCodexCliCredentialsCached).toHaveBeenCalledWith({
      ttlMs: 5000,
      allowKeychainPrompt: false,
    });
  });
});
