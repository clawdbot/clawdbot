import { afterEach, describe, expect, it } from "vitest";
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

  it("returns undefined when no local or auth-profile credentials exist", async () => {
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => null,
      readCodexCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {},
      }),
    });

    await expect(resolveCliAuthEpoch({ provider: "claude-cli" })).resolves.toBeUndefined();
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

    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("changes claude cli token epochs when the static token changes", async () => {
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

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
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

    expect(first).toBeDefined();
    expect(second).toBe(first);
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

    expect(first).toBeDefined();
    expect(second).toBeDefined();
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
        provider: "openai-codex",
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

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(third).toBe(second);
    expect(fourth).toBe(third);
    expect(fifth).toBeDefined();
    expect(sixth).toBeDefined();
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
        provider: "openai-codex",
        access: localAccess,
        refresh: "local-refresh",
        expires: 1,
        accountId: "acct-1",
      }),
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
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
      authProfileId: "openai-codex:default",
      skipLocalCredential: true,
    });
    localAccess = "local-access-b";
    const second = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai-codex:default",
      skipLocalCredential: true,
    });
    profileRefresh = "profile-refresh-b";
    const third = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai-codex:default",
      skipLocalCredential: true,
    });
    profileAccountId = "acct-2";
    const fourth = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai-codex:default",
      skipLocalCredential: true,
    });

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(third).toBe(second);
    expect(fourth).toBeDefined();
    expect(fourth).not.toBe(third);
  });
});
