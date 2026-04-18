import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore, OAuthCredential } from "./auth-profiles/types.js";

const mocks = vi.hoisted(() => ({
  readCodexCliCredentialsCached: vi.fn<() => OAuthCredential | null>(() => null),
  readMiniMaxCliCredentialsCached: vi.fn<() => OAuthCredential | null>(() => null),
}));

let readManagedExternalCliCredential: typeof import("./auth-profiles/external-cli-sync.js").readManagedExternalCliCredential;
let resolveExternalCliAuthProfiles: typeof import("./auth-profiles/external-cli-sync.js").resolveExternalCliAuthProfiles;
let hasUsableOAuthCredential: typeof import("./auth-profiles/external-cli-sync.js").hasUsableOAuthCredential;
let shouldBootstrapFromExternalCliCredential: typeof import("./auth-profiles/external-cli-sync.js").shouldBootstrapFromExternalCliCredential;
let shouldReplaceStoredOAuthCredential: typeof import("./auth-profiles/external-cli-sync.js").shouldReplaceStoredOAuthCredential;
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

describe("external cli oauth resolution", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("./cli-credentials.js", () => ({
      readCodexCliCredentialsCached: mocks.readCodexCliCredentialsCached,
      readMiniMaxCliCredentialsCached: mocks.readMiniMaxCliCredentialsCached,
    }));
    mocks.readCodexCliCredentialsCached.mockReset().mockReturnValue(null);
    mocks.readMiniMaxCliCredentialsCached.mockReset().mockReturnValue(null);
    ({
      hasUsableOAuthCredential,
      readManagedExternalCliCredential,
      resolveExternalCliAuthProfiles,
      shouldBootstrapFromExternalCliCredential,
      shouldReplaceStoredOAuthCredential,
    } = await import("./auth-profiles/external-cli-sync.js"));
    ({ OPENAI_CODEX_DEFAULT_PROFILE_ID, MINIMAX_CLI_PROFILE_ID } =
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

    it("does not bootstrap across different known oauth identities", () => {
      const imported = makeOAuthCredential({
        provider: "openai-codex",
        access: "fresh-cli-access",
        refresh: "fresh-cli-refresh",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
        accountId: "acct-external",
      });

      expect(
        shouldBootstrapFromExternalCliCredential({
          existing: makeOAuthCredential({
            provider: "openai-codex",
            access: "expired-local-access",
            refresh: "expired-local-refresh",
            expires: Date.now() - 60_000,
            accountId: "acct-local",
          }),
          imported,
        }),
      ).toBe(false);
    });
  });

  it("reads codex external cli credentials by profile id", () => {
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

    expect(credential).toMatchObject({
      access: "codex-access-token",
      refresh: "codex-refresh-token",
    });
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

  it("resolves fresher codex and minimax external oauth profiles as runtime overlays", () => {
    mocks.readCodexCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({
        provider: "openai-codex",
        access: "codex-fresh-access",
        refresh: "codex-fresh-refresh",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
      }),
    );
    mocks.readMiniMaxCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({
        provider: "minimax-portal",
        access: "minimax-fresh-access",
        refresh: "minimax-fresh-refresh",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
      }),
    );

    const profiles = resolveExternalCliAuthProfiles({
      version: 1,
      profiles: {
        [OPENAI_CODEX_DEFAULT_PROFILE_ID]: makeOAuthCredential({
          provider: "openai-codex",
          access: "codex-stale-access",
          refresh: "codex-stale-refresh",
          expires: Date.now() - 5_000,
        }),
        [MINIMAX_CLI_PROFILE_ID]: makeOAuthCredential({
          provider: "minimax-portal",
          access: "minimax-stale-access",
          refresh: "minimax-stale-refresh",
          expires: Date.now() - 5_000,
        }),
      },
    });

    const profilesById = new Map(
      profiles.map((profile) => [profile.profileId, profile.credential]),
    );
    expect(profilesById.get(OPENAI_CODEX_DEFAULT_PROFILE_ID)).toMatchObject({
      access: "codex-fresh-access",
      refresh: "codex-fresh-refresh",
    });
    expect(profilesById.get(MINIMAX_CLI_PROFILE_ID)).toMatchObject({
      access: "minimax-fresh-access",
      refresh: "minimax-fresh-refresh",
    });
  });

  it("does not emit runtime overlays when the stored credential is newer", () => {
    mocks.readCodexCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({
        provider: "openai-codex",
        access: "stale-external-access",
        refresh: "stale-external-refresh",
        expires: Date.now() - 5_000,
      }),
    );

    const profiles = resolveExternalCliAuthProfiles(
      makeStore(
        OPENAI_CODEX_DEFAULT_PROFILE_ID,
        makeOAuthCredential({
          provider: "openai-codex",
          access: "fresh-store-access",
          refresh: "fresh-store-refresh",
          expires: Date.now() + 5 * 24 * 60 * 60_000,
        }),
      ),
    );

    expect(profiles).toEqual([]);
  });

  it("does not overlay fresh external cli oauth over a still-usable local credential", () => {
    mocks.readCodexCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({
        provider: "openai-codex",
        access: "fresh-cli-access",
        refresh: "fresh-cli-refresh",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
      }),
    );

    const profiles = resolveExternalCliAuthProfiles(
      makeStore(
        OPENAI_CODEX_DEFAULT_PROFILE_ID,
        makeOAuthCredential({
          provider: "openai-codex",
          access: "healthy-local-access",
          refresh: "healthy-local-refresh",
          expires: Date.now() + 10 * 60_000,
        }),
      ),
    );

    expect(profiles).toEqual([]);
  });
});
