import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore, OAuthCredential } from "./auth-profiles/types.js";
import type { ClaudeCliCredential } from "./cli-credentials.js";

const mocks = vi.hoisted(() => ({
  readClaudeCliCredentialsCached: vi.fn<(options?: unknown) => ClaudeCliCredential | null>(
    () => null,
  ),
  readCodexCliCredentialsCached: vi.fn<(options?: unknown) => OAuthCredential | null>(() => null),
  readMiniMaxCliCredentialsCached: vi.fn<(options?: unknown) => OAuthCredential | null>(() => null),
}));

let readManagedExternalCliCredential: typeof import("./auth-profiles/external-cli-sync.js").readManagedExternalCliCredential;
let resolveExternalCliAuthProfiles: typeof import("./auth-profiles/external-cli-sync.js").resolveExternalCliAuthProfiles;
let hasUsableOAuthCredential: typeof import("./auth-profiles/external-cli-sync.js").hasUsableOAuthCredential;
let isSafeToUseExternalCliCredential: typeof import("./auth-profiles/external-cli-sync.js").isSafeToUseExternalCliCredential;
let shouldBootstrapFromExternalCliCredential: typeof import("./auth-profiles/external-cli-sync.js").shouldBootstrapFromExternalCliCredential;
let shouldReplaceStoredOAuthCredential: typeof import("./auth-profiles/external-cli-sync.js").shouldReplaceStoredOAuthCredential;
let CLAUDE_CLI_PROFILE_ID: typeof import("./auth-profiles/constants.js").CLAUDE_CLI_PROFILE_ID;
let OPENAI_CODEX_DEFAULT_PROFILE_ID: typeof import("./auth-profiles/constants.js").OPENAI_CODEX_DEFAULT_PROFILE_ID;
let MINIMAX_CLI_PROFILE_ID: typeof import("./auth-profiles/constants.js").MINIMAX_CLI_PROFILE_ID;

function makeOAuthCredential(
  overrides: Partial<OAuthCredential> & Pick<OAuthCredential, "provider">,
) {
  return {
    type: "oauth" as const,
    provider: overrides.provider,
    access: overrides.access ?? `${overrides.provider}-access`,
    refresh: overrides.refresh ?? `${overrides.provider}-refresh`,
    expires: overrides.expires ?? Date.now() + 10 * 60_000,
    accountId: overrides.accountId,
    email: overrides.email,
    enterpriseUrl: overrides.enterpriseUrl,
    projectId: overrides.projectId,
  };
}

function makeStore(profileId?: string, credential?: OAuthCredential): AuthProfileStore {
  return {
    version: 1,
    profiles: profileId && credential ? { [profileId]: credential } : {},
  };
}

function expectSingleProfileCredential(
  profiles: ReturnType<typeof resolveExternalCliAuthProfiles>,
  profileId: string,
) {
  expect(profiles).toHaveLength(1);
  expect(profiles[0]?.profileId).toBe(profileId);
  expect(profiles[0]?.credential).toBeTruthy();
  return profiles[0]?.credential as Record<string, unknown>;
}

function expectCredentialFields(
  credential: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
) {
  expect(credential).toBeTruthy();
  for (const [key, value] of Object.entries(expected)) {
    expect(credential?.[key]).toBe(value);
  }
}

function expectReaderPolicyCall(mock: { mock: { calls: unknown[][] } }) {
  expect(mock.mock.calls).toHaveLength(1);
  const [arg] = mock.mock.calls[0] ?? [];
  expect(arg).toBeTruthy();
  if (!arg || typeof arg !== "object") {
    throw new Error("Expected CLI reader options");
  }
  expect((arg as { allowKeychainPrompt?: unknown }).allowKeychainPrompt).toBe(false);
}

describe("external cli oauth resolution", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("./cli-credentials.js", () => ({
      readClaudeCliCredentialsCached: mocks.readClaudeCliCredentialsCached,
      readCodexCliCredentialsCached: mocks.readCodexCliCredentialsCached,
      readMiniMaxCliCredentialsCached: mocks.readMiniMaxCliCredentialsCached,
    }));
    mocks.readClaudeCliCredentialsCached.mockReset().mockReturnValue(null);
    mocks.readCodexCliCredentialsCached.mockReset().mockReturnValue(null);
    mocks.readMiniMaxCliCredentialsCached.mockReset().mockReturnValue(null);
    ({
      hasUsableOAuthCredential,
      isSafeToUseExternalCliCredential,
      readManagedExternalCliCredential,
      resolveExternalCliAuthProfiles,
      shouldBootstrapFromExternalCliCredential,
      shouldReplaceStoredOAuthCredential,
    } = await import("./auth-profiles/external-cli-sync.js"));
    ({ CLAUDE_CLI_PROFILE_ID, OPENAI_CODEX_DEFAULT_PROFILE_ID, MINIMAX_CLI_PROFILE_ID } =
      await import("./auth-profiles/constants.js"));
  });

  describe("shouldReplaceStoredOAuthCredential", () => {
    it("keeps equivalent stored credentials", () => {
      const expires = Date.now() + 60_000;
      const stored = makeOAuthCredential({
        provider: "openai-codex",
        access: "a",
        refresh: "r",
        expires,
      });
      const incoming = makeOAuthCredential({
        provider: "openai-codex",
        access: "a",
        refresh: "r",
        expires,
      });

      expect(shouldReplaceStoredOAuthCredential(stored, incoming)).toBe(false);
    });

    it("keeps the newer stored credential", () => {
      const incoming = makeOAuthCredential({
        provider: "openai-codex",
        expires: Date.now() + 60_000,
      });
      const stored = makeOAuthCredential({
        provider: "openai-codex",
        access: "fresh-access",
        refresh: "fresh-refresh",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
      });

      expect(shouldReplaceStoredOAuthCredential(stored, incoming)).toBe(false);
    });

    it("replaces when incoming credentials are fresher", () => {
      const stored = makeOAuthCredential({
        provider: "openai-codex",
        expires: Date.now() + 60_000,
      });
      const incoming = makeOAuthCredential({
        provider: "openai-codex",
        access: "new-access",
        refresh: "new-refresh",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
      });

      expect(shouldReplaceStoredOAuthCredential(stored, incoming)).toBe(true);
      expect(shouldReplaceStoredOAuthCredential(undefined, incoming)).toBe(true);
    });
  });

  describe("external cli bootstrap policy", () => {
    it("treats only non-expired and non-near-expiry access tokens as usable local oauth", () => {
      expect(
        hasUsableOAuthCredential(
          makeOAuthCredential({
            provider: "openai-codex",
            access: "live-access",
            expires: Date.now() + 10 * 60_000,
          }),
        ),
      ).toBe(true);
      expect(
        hasUsableOAuthCredential(
          makeOAuthCredential({
            provider: "openai-codex",
            access: "expired-access",
            expires: Date.now() - 60_000,
          }),
        ),
      ).toBe(false);
      expect(
        hasUsableOAuthCredential(
          makeOAuthCredential({
            provider: "openai-codex",
            access: "near-expiry-access",
            expires: Date.now() + 60_000,
          }),
        ),
      ).toBe(false);
      expect(
        hasUsableOAuthCredential(
          makeOAuthCredential({
            provider: "openai-codex",
            access: "",
            expires: Date.now() + 60_000,
          }),
        ),
      ).toBe(false);
    });

    it("only bootstraps from external cli when the stored oauth is not usable", () => {
      const imported = makeOAuthCredential({
        provider: "openai-codex",
        access: "fresh-cli-access",
        refresh: "fresh-cli-refresh",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
        accountId: "acct-123",
      });

      expect(
        shouldBootstrapFromExternalCliCredential({
          existing: makeOAuthCredential({
            provider: "openai-codex",
            access: "healthy-local-access",
            refresh: "healthy-local-refresh",
            expires: Date.now() + 10 * 60_000,
          }),
          imported,
        }),
      ).toBe(false);
      expect(
        shouldBootstrapFromExternalCliCredential({
          existing: makeOAuthCredential({
            provider: "openai-codex",
            access: "expired-local-access",
            refresh: "expired-local-refresh",
            expires: Date.now() - 60_000,
            accountId: "acct-123",
          }),
          imported,
        }),
      ).toBe(true);
      expect(
        shouldBootstrapFromExternalCliCredential({
          existing: makeOAuthCredential({
            provider: "openai-codex",
            access: "near-expiry-local-access",
            refresh: "near-expiry-local-refresh",
            expires: Date.now() + 60_000,
          }),
          imported,
        }),
      ).toBe(true);
    });

    it("refuses external oauth usage across different known identities", () => {
      const imported = makeOAuthCredential({
        provider: "openai-codex",
        access: "fresh-cli-access",
        refresh: "fresh-cli-refresh",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
        accountId: "acct-external",
      });

      expect(
        isSafeToUseExternalCliCredential(
          makeOAuthCredential({
            provider: "openai-codex",
            access: "expired-local-access",
            refresh: "expired-local-refresh",
            expires: Date.now() - 60_000,
            accountId: "acct-local",
          }),
          imported,
        ),
      ).toBe(false);
    });
  });

  it("does not use codex as a runtime bootstrap source anymore", () => {
    mocks.readCodexCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({
        provider: "openai-codex",
        access: "codex-access-token",
        refresh: "codex-refresh-token",
      }),
    );

    const credential = readManagedExternalCliCredential({
      profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
      credential: makeOAuthCredential({ provider: "openai-codex" }),
    });

    expect(credential).toBeNull();
  });

  it("bootstraps the default codex profile from Codex CLI credentials when in scope", () => {
    mocks.readCodexCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({
        provider: "openai-codex",
        access: "codex-cli-access",
        refresh: "codex-cli-refresh",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
        accountId: "acct-codex",
      }),
    );

    const profiles = resolveExternalCliAuthProfiles(makeStore(), {
      providerIds: ["openai-codex"],
    });

    expectCredentialFields(
      expectSingleProfileCredential(profiles, OPENAI_CODEX_DEFAULT_PROFILE_ID),
      {
        provider: "openai-codex",
        access: "codex-cli-access",
        refresh: "codex-cli-refresh",
        accountId: "acct-codex",
      },
    );
  });

  it("keeps any existing default codex oauth over Codex CLI bootstrap credentials", () => {
    mocks.readCodexCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({
        provider: "openai-codex",
        access: "codex-cli-fresh-access",
        refresh: "codex-cli-fresh-refresh",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
        accountId: "acct-codex",
      }),
    );

    const profiles = resolveExternalCliAuthProfiles(
      makeStore(
        OPENAI_CODEX_DEFAULT_PROFILE_ID,
        makeOAuthCredential({
          provider: "openai-codex",
          access: "local-expired-access",
          refresh: "local-canonical-refresh",
          expires: Date.now() - 5_000,
          accountId: "acct-codex",
        }),
      ),
    );

    expect(profiles).toStrictEqual([]);
  });

  it("returns null when the profile id/provider do not map to the same external source", () => {
    mocks.readCodexCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({ provider: "openai-codex" }),
    );

    const credential = readManagedExternalCliCredential({
      profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
      credential: makeOAuthCredential({ provider: "anthropic" }),
    });

    expect(credential).toBeNull();
  });

  it("normalizes Claude CLI oauth credentials into the managed Claude profile", () => {
    mocks.readClaudeCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "claude-cli-access",
      refresh: "claude-cli-refresh",
      expires: Date.now() + 5 * 24 * 60 * 60_000,
    });

    const profiles = resolveExternalCliAuthProfiles(makeStore(), {
      providerIds: ["claude-cli"],
    });

    expectCredentialFields(expectSingleProfileCredential(profiles, CLAUDE_CLI_PROFILE_ID), {
      type: "oauth",
      provider: "claude-cli",
      access: "claude-cli-access",
      refresh: "claude-cli-refresh",
    });
  });

  it("skips external cli readers outside the scoped provider set", () => {
    const profiles = resolveExternalCliAuthProfiles(makeStore(), {
      providerIds: ["opencode-go"],
    });

    expect(profiles).toStrictEqual([]);
    expect(mocks.readCodexCliCredentialsCached).not.toHaveBeenCalled();
    expect(mocks.readClaudeCliCredentialsCached).not.toHaveBeenCalled();
    expect(mocks.readMiniMaxCliCredentialsCached).not.toHaveBeenCalled();
  });

  it("does not scan missing external CLI profiles without an explicit scope", () => {
    mocks.readClaudeCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "claude-cli-access",
      refresh: "claude-cli-refresh",
      expires: Date.now() + 5 * 24 * 60 * 60_000,
    });

    const profiles = resolveExternalCliAuthProfiles(makeStore());

    expect(profiles).toStrictEqual([]);
    expect(mocks.readClaudeCliCredentialsCached).not.toHaveBeenCalled();
  });

  it("refreshes a stored external CLI profile without an explicit scope", () => {
    mocks.readClaudeCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "claude-cli-fresh-access",
      refresh: "claude-cli-fresh-refresh",
      expires: Date.now() + 5 * 24 * 60 * 60_000,
    });

    const profiles = resolveExternalCliAuthProfiles(
      makeStore(CLAUDE_CLI_PROFILE_ID, {
        type: "oauth",
        provider: "claude-cli",
        access: "claude-cli-stale-access",
        refresh: "claude-cli-stale-refresh",
        expires: Date.now() - 5_000,
      }),
    );

    expectCredentialFields(expectSingleProfileCredential(profiles, CLAUDE_CLI_PROFILE_ID), {
      provider: "claude-cli",
      access: "claude-cli-fresh-access",
    });
  });

  it("passes non-prompting keychain policy to scoped Claude CLI credential reads", () => {
    mocks.readClaudeCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "claude-cli-access",
      refresh: "claude-cli-refresh",
      expires: Date.now() + 5 * 24 * 60 * 60_000,
    });

    const profiles = resolveExternalCliAuthProfiles(makeStore(), {
      providerIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });

    expectCredentialFields(expectSingleProfileCredential(profiles, CLAUDE_CLI_PROFILE_ID), {
      type: "oauth",
      provider: "claude-cli",
    });
    expectReaderPolicyCall(mocks.readClaudeCliCredentialsCached);
    expect(mocks.readCodexCliCredentialsCached).not.toHaveBeenCalled();
    expect(mocks.readMiniMaxCliCredentialsCached).not.toHaveBeenCalled();
  });

  it("passes non-prompting keychain policy to scoped Codex CLI credential reads", () => {
    mocks.readCodexCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({
        provider: "openai-codex",
        access: "codex-cli-access",
        refresh: "codex-cli-refresh",
      }),
    );

    const profiles = resolveExternalCliAuthProfiles(makeStore(), {
      providerIds: ["codex-app-server"],
      allowKeychainPrompt: false,
    });

    expectCredentialFields(
      expectSingleProfileCredential(profiles, OPENAI_CODEX_DEFAULT_PROFILE_ID),
      {
        type: "oauth",
        provider: "openai-codex",
      },
    );
    expectReaderPolicyCall(mocks.readCodexCliCredentialsCached);
    expect(mocks.readClaudeCliCredentialsCached).not.toHaveBeenCalled();
    expect(mocks.readMiniMaxCliCredentialsCached).not.toHaveBeenCalled();
  });

  it("ignores Claude CLI token credentials", () => {
    mocks.readClaudeCliCredentialsCached.mockReturnValue({
      type: "token",
      provider: "anthropic",
      token: "claude-cli-token",
      expires: Date.now() + 5 * 24 * 60 * 60_000,
    });

    const profiles = resolveExternalCliAuthProfiles(makeStore(), {
      providerIds: ["claude-cli"],
    });

    expect(profiles).toStrictEqual([]);
  });

  it("resolves fresher minimax external oauth profiles as runtime overlays", () => {
    mocks.readMiniMaxCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({
        provider: "minimax-portal",
        access: "minimax-fresh-access",
        refresh: "minimax-fresh-refresh",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
        email: "minimax@example.com",
      }),
    );

    const profiles = resolveExternalCliAuthProfiles({
      version: 1,
      profiles: {
        [MINIMAX_CLI_PROFILE_ID]: makeOAuthCredential({
          provider: "minimax-portal",
          access: "minimax-stale-access",
          refresh: "minimax-stale-refresh",
          expires: Date.now() - 5_000,
          email: "minimax@example.com",
        }),
      },
    });

    const profilesById = new Map(
      profiles.map((profile) => [profile.profileId, profile.credential]),
    );
    expectCredentialFields(profilesById.get(MINIMAX_CLI_PROFILE_ID) as Record<string, unknown>, {
      access: "minimax-fresh-access",
      refresh: "minimax-fresh-refresh",
    });
  });

  it("does not emit runtime overlays when the stored minimax credential is newer", () => {
    mocks.readMiniMaxCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({
        provider: "minimax-portal",
        access: "stale-external-access",
        refresh: "stale-external-refresh",
        expires: Date.now() - 5_000,
      }),
    );

    const profiles = resolveExternalCliAuthProfiles(
      makeStore(
        MINIMAX_CLI_PROFILE_ID,
        makeOAuthCredential({
          provider: "minimax-portal",
          access: "fresh-store-access",
          refresh: "fresh-store-refresh",
          expires: Date.now() + 5 * 24 * 60 * 60_000,
        }),
      ),
    );

    expect(profiles).toStrictEqual([]);
  });

  it("does not overlay fresh minimax oauth over a still-usable local credential", () => {
    mocks.readMiniMaxCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({
        provider: "minimax-portal",
        access: "fresh-cli-access",
        refresh: "fresh-cli-refresh",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
      }),
    );

    const profiles = resolveExternalCliAuthProfiles(
      makeStore(
        MINIMAX_CLI_PROFILE_ID,
        makeOAuthCredential({
          provider: "minimax-portal",
          access: "healthy-local-access",
          refresh: "healthy-local-refresh",
          expires: Date.now() + 10 * 60_000,
        }),
      ),
    );

    expect(profiles).toStrictEqual([]);
  });
});
