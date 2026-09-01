/** Permanent-refresh tombstone adoption and identity-continuity policy. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const readCodexCliCredentialsCachedMock = vi.hoisted(() =>
  vi.fn<(options?: unknown) => OAuthCredential | null>(() => null),
);
const readClaudeCliCredentialsCachedMock = vi.hoisted(() =>
  vi.fn<(options?: unknown) => OAuthCredential | null>(() => null),
);
const readMiniMaxCliCredentialsCachedMock = vi.hoisted(() =>
  vi.fn<(options?: unknown) => OAuthCredential | null>(() => null),
);

vi.mock("../cli-credentials.js", async (importActual) => {
  const actual = await importActual<typeof import("../cli-credentials.js")>();
  return {
    ...actual,
    readClaudeCliCredentialsCached: readClaudeCliCredentialsCachedMock,
    readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
    readMiniMaxCliCredentialsCached: readMiniMaxCliCredentialsCachedMock,
  };
});

const { readExternalCliBootstrapCredential, resolveExternalCliAuthProfiles } =
  await import("./external-cli-sync.js");
const { OPENAI_CODEX_DEFAULT_PROFILE_ID } = await import("./constants.js");

function makeOAuthCredential(
  overrides: Partial<OAuthCredential> & Pick<OAuthCredential, "provider">,
): OAuthCredential {
  return {
    type: "oauth",
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
): Record<string, unknown> {
  expect(profiles).toStrictEqual([
    {
      credential: expect.any(Object),
      persistence: profileId === OPENAI_CODEX_DEFAULT_PROFILE_ID ? "runtime-only" : "persisted",
      profileId,
    },
  ]);
  const credential = profiles[0]?.credential;
  if (!credential) {
    throw new Error(`Expected credential for profile ${profileId}`);
  }
  return credential as Record<string, unknown>;
}

function expectCredentialFields(
  credential: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
) {
  if (!credential) {
    throw new Error("Expected credential");
  }
  for (const [key, value] of Object.entries(expected)) {
    expect(credential[key]).toBe(value);
  }
}

describe("external cli permanent-refresh tombstones", () => {
  beforeEach(() => {
    readClaudeCliCredentialsCachedMock.mockReset().mockReturnValue(null);
    readCodexCliCredentialsCachedMock.mockReset().mockReturnValue(null);
    readMiniMaxCliCredentialsCachedMock.mockReset().mockReturnValue(null);
  });

  it.each([
    {
      profileId: "anthropic:claude-cli",
      provider: "claude-cli",
      importedProvider: "anthropic",
      reader: readClaudeCliCredentialsCachedMock,
    },
    {
      profileId: "minimax-portal:minimax-cli",
      provider: "minimax-portal",
      importedProvider: "minimax-portal",
      reader: readMiniMaxCliCredentialsCachedMock,
    },
  ])(
    "re-seeds an identity-less dead $provider profile",
    ({ profileId, provider, importedProvider, reader }) => {
      const deadCredential: OAuthCredential = {
        ...makeOAuthCredential({
          provider,
          access: "dead-access",
          refresh: "dead-refresh",
          expires: Date.now() - 5_000,
        }),
        refreshDeadAt: Date.now() - 1_000,
      };
      reader.mockReturnValue(
        makeOAuthCredential({
          provider: importedProvider,
          access: "fresh-cli-access",
          refresh: "fresh-cli-refresh",
        }),
      );

      const profiles = resolveExternalCliAuthProfiles(makeStore(profileId, deadCredential), {
        providerIds: [provider],
      });

      expectCredentialFields(expectSingleProfileCredential(profiles, profileId), {
        access: "fresh-cli-access",
        refresh: "fresh-cli-refresh",
      });
    },
  );

  it("reads a fresh Codex CLI grant for a dead target beside a healthy OpenAI sibling", () => {
    const deadTarget: OAuthCredential = {
      ...makeOAuthCredential({
        provider: "openai",
        access: "dead-access",
        refresh: "dead-refresh",
        expires: Date.now() - 5_000,
        accountId: "acct-codex",
      }),
      refreshDeadAt: Date.now() - 1_000,
    };
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [OPENAI_CODEX_DEFAULT_PROFILE_ID]: deadTarget,
        "openai:user@example.com": makeOAuthCredential({
          provider: "openai",
          access: "healthy-sibling-access",
          refresh: "healthy-sibling-refresh",
          expires: Date.now() + 10 * 60_000,
          accountId: "acct-sibling",
        }),
      },
    };
    readCodexCliCredentialsCachedMock.mockReturnValue(
      makeOAuthCredential({
        provider: "openai",
        access: "codex-cli-fresh-access",
        refresh: "codex-cli-fresh-refresh",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
        accountId: "acct-codex",
      }),
    );

    const credential = readExternalCliBootstrapCredential({
      store,
      profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
      credential: deadTarget,
    });

    expectCredentialFields(credential as Record<string, unknown>, {
      access: "codex-cli-fresh-access",
      refresh: "codex-cli-fresh-refresh",
      accountId: "acct-codex",
    });
    expect(readCodexCliCredentialsCachedMock).toHaveBeenCalledOnce();
  });

  it("refuses a different-account Codex CLI grant for a dead target beside a healthy sibling", () => {
    const deadTarget: OAuthCredential = {
      ...makeOAuthCredential({
        provider: "openai",
        access: "dead-access",
        refresh: "dead-refresh",
        expires: Date.now() - 5_000,
        accountId: "acct-codex",
      }),
      refreshDeadAt: Date.now() - 1_000,
    };
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [OPENAI_CODEX_DEFAULT_PROFILE_ID]: deadTarget,
        "openai:user@example.com": makeOAuthCredential({
          provider: "openai",
          access: "healthy-sibling-access",
          refresh: "healthy-sibling-refresh",
          accountId: "acct-sibling",
        }),
      },
    };
    readCodexCliCredentialsCachedMock.mockReturnValue(
      makeOAuthCredential({
        provider: "openai",
        access: "other-account-access",
        refresh: "other-account-refresh",
        accountId: "acct-other",
      }),
    );

    expect(
      readExternalCliBootstrapCredential({
        store,
        profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
        credential: deadTarget,
      }),
    ).toBeNull();
  });

  it("refuses a fresh Codex CLI grant for an identity-less dead target", () => {
    const deadTarget: OAuthCredential = {
      ...makeOAuthCredential({
        provider: "openai",
        access: "dead-access",
        refresh: "dead-refresh",
        expires: Date.now() - 5_000,
      }),
      refreshDeadAt: Date.now() - 1_000,
    };
    readCodexCliCredentialsCachedMock.mockReturnValue(
      makeOAuthCredential({
        provider: "openai",
        access: "codex-cli-fresh-access",
        refresh: "codex-cli-fresh-refresh",
        accountId: "acct-codex",
      }),
    );

    expect(
      readExternalCliBootstrapCredential({
        store: makeStore(OPENAI_CODEX_DEFAULT_PROFILE_ID, deadTarget),
        profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
        credential: deadTarget,
      }),
    ).toBeNull();
    expect(
      resolveExternalCliAuthProfiles(makeStore(OPENAI_CODEX_DEFAULT_PROFILE_ID, deadTarget), {
        providerIds: ["openai"],
      }),
    ).toStrictEqual([]);
  });

  it("does not create an explicitly scoped default beside a named managed OpenAI profile", () => {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      makeOAuthCredential({
        provider: "openai",
        access: "codex-cli-access",
        refresh: "codex-cli-refresh",
      }),
    );

    const profiles = resolveExternalCliAuthProfiles(
      makeStore(
        "openai:user@example.com",
        makeOAuthCredential({
          provider: "openai",
          access: "managed-access",
          refresh: "managed-refresh",
          accountId: "acct-sibling",
        }),
      ),
      {
        providerIds: ["openai"],
        profileIds: [OPENAI_CODEX_DEFAULT_PROFILE_ID],
      },
    );

    expect(profiles).toStrictEqual([]);
    expect(readCodexCliCredentialsCachedMock).not.toHaveBeenCalled();
  });

  it.each(["absent", "empty"] as const)(
    "does not fill an %s default slot beside a dead non-target OpenAI profile",
    (defaultState) => {
      readCodexCliCredentialsCachedMock.mockReturnValue(
        makeOAuthCredential({
          provider: "openai",
          access: "codex-cli-access",
          refresh: "codex-cli-refresh",
          accountId: "acct-codex",
        }),
      );
      const profiles: AuthProfileStore["profiles"] = {
        "openai:user@example.com": {
          ...makeOAuthCredential({
            provider: "openai",
            access: "dead-sibling-access",
            refresh: "dead-sibling-refresh",
            expires: Date.now() - 5_000,
            accountId: "acct-sibling",
          }),
          refreshDeadAt: Date.now() - 1_000,
        },
      };
      if (defaultState === "empty") {
        profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID] = {
          type: "oauth",
          provider: "openai",
          access: "",
          refresh: "",
          expires: 0,
        };
      }

      expect(
        resolveExternalCliAuthProfiles(
          { version: 1, profiles },
          {
            providerIds: ["openai"],
            profileIds: [OPENAI_CODEX_DEFAULT_PROFILE_ID],
          },
        ),
      ).toStrictEqual([]);
      expect(readCodexCliCredentialsCachedMock).not.toHaveBeenCalled();
    },
  );

  it("re-seeds a dead-marked codex profile from a different Codex CLI grant", () => {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      makeOAuthCredential({
        provider: "openai",
        access: "codex-cli-access",
        refresh: "codex-cli-fresh-refresh",
        accountId: "acct-codex",
      }),
    );

    const profiles = resolveExternalCliAuthProfiles(
      makeStore(OPENAI_CODEX_DEFAULT_PROFILE_ID, {
        ...makeOAuthCredential({
          provider: "openai",
          access: "dead-access",
          refresh: "dead-refresh",
          expires: Date.now() - 5_000,
          accountId: "acct-codex",
        }),
        refreshDeadAt: Date.now() - 1_000,
      }),
      { providerIds: ["openai"] },
    );

    expectCredentialFields(
      expectSingleProfileCredential(profiles, OPENAI_CODEX_DEFAULT_PROFILE_ID),
      {
        provider: "openai",
        access: "codex-cli-access",
        refresh: "codex-cli-fresh-refresh",
        accountId: "acct-codex",
      },
    );
  });

  it("refuses an email-only Codex CLI grant for a dead profile", () => {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      makeOAuthCredential({
        provider: "openai",
        access: "codex-cli-access",
        refresh: "codex-cli-fresh-refresh",
        email: " user@example.com ",
      }),
    );

    expect(
      resolveExternalCliAuthProfiles(
        makeStore(OPENAI_CODEX_DEFAULT_PROFILE_ID, {
          ...makeOAuthCredential({
            provider: "openai",
            access: "dead-access",
            refresh: "dead-refresh",
            expires: Date.now() - 5_000,
            email: "User@Example.COM",
          }),
          refreshDeadAt: Date.now() - 1_000,
        }),
        { providerIds: ["openai"] },
      ),
    ).toStrictEqual([]);
  });

  it("re-seeds a dead codex target without disturbing a healthy OpenAI sibling", () => {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      makeOAuthCredential({
        provider: "openai",
        access: "codex-cli-fresh-access",
        refresh: "codex-cli-fresh-refresh",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
        accountId: "acct-codex",
      }),
    );
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
          ...makeOAuthCredential({
            provider: "openai",
            access: "dead-access",
            refresh: "dead-refresh",
            expires: Date.now() - 5_000,
            accountId: "acct-codex",
          }),
          refreshDeadAt: Date.now() - 1_000,
        },
        "openai:user@example.com": makeOAuthCredential({
          provider: "openai",
          access: "healthy-sibling-access",
          refresh: "healthy-sibling-refresh",
          expires: Date.now() + 10 * 60_000,
          accountId: "acct-sibling",
        }),
      },
    };

    const profiles = resolveExternalCliAuthProfiles(store, { providerIds: ["openai"] });

    expectCredentialFields(
      expectSingleProfileCredential(profiles, OPENAI_CODEX_DEFAULT_PROFILE_ID),
      {
        access: "codex-cli-fresh-access",
        refresh: "codex-cli-fresh-refresh",
        accountId: "acct-codex",
      },
    );
    expect(store.profiles["openai:user@example.com"]).toMatchObject({
      access: "healthy-sibling-access",
      refresh: "healthy-sibling-refresh",
      accountId: "acct-sibling",
    });
  });

  it("refuses a different-account grant for a dead codex target beside a healthy sibling", () => {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      makeOAuthCredential({
        provider: "openai",
        access: "other-account-access",
        refresh: "other-account-refresh",
        accountId: "acct-other",
      }),
    );
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
          ...makeOAuthCredential({
            provider: "openai",
            access: "dead-access",
            refresh: "dead-refresh",
            expires: Date.now() - 5_000,
            accountId: "acct-codex",
          }),
          refreshDeadAt: Date.now() - 1_000,
        },
        "openai:user@example.com": makeOAuthCredential({
          provider: "openai",
          access: "healthy-sibling-access",
          refresh: "healthy-sibling-refresh",
          accountId: "acct-sibling",
        }),
      },
    };

    expect(resolveExternalCliAuthProfiles(store, { providerIds: ["openai"] })).toStrictEqual([]);
  });

  it("keeps the gate closed for a corrupt zero refreshDeadAt tombstone", () => {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      makeOAuthCredential({
        provider: "openai",
        access: "codex-cli-access",
        refresh: "codex-cli-fresh-refresh",
        accountId: "acct-codex",
      }),
    );

    const profiles = resolveExternalCliAuthProfiles(
      makeStore(OPENAI_CODEX_DEFAULT_PROFILE_ID, {
        ...makeOAuthCredential({
          provider: "openai",
          access: "live-access",
          refresh: "live-refresh",
          accountId: "acct-codex",
        }),
        refreshDeadAt: 0,
      }),
      { providerIds: ["openai"] },
    );

    expect(profiles).toStrictEqual([]);
    expect(readCodexCliCredentialsCachedMock).not.toHaveBeenCalled();
  });

  it("does not re-seed a dead-marked codex profile from the same dead grant", () => {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      makeOAuthCredential({
        provider: "openai",
        access: "codex-cli-access",
        refresh: "dead-refresh",
        accountId: "acct-codex",
      }),
    );

    const profiles = resolveExternalCliAuthProfiles(
      makeStore(OPENAI_CODEX_DEFAULT_PROFILE_ID, {
        ...makeOAuthCredential({
          provider: "openai",
          access: "dead-access",
          refresh: "dead-refresh",
          expires: Date.now() - 5_000,
          accountId: "acct-codex",
        }),
        refreshDeadAt: Date.now() - 1_000,
      }),
      { providerIds: ["openai"] },
    );

    expect(profiles).toStrictEqual([]);
  });
});
