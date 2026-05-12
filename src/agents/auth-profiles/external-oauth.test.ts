import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderExternalAuthProfile } from "../../plugins/types.js";
import {
  __testing,
  overlayExternalOAuthProfiles,
  shouldPersistExternalOAuthProfile,
} from "./external-auth.js";
import { readManagedExternalCliCredential } from "./external-cli-sync.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const resolveExternalAuthProfilesWithPluginsMock = vi.fn<
  (params: unknown) => ProviderExternalAuthProfile[]
>(() => []);
const readCodexCliCredentialsCachedMock = vi.hoisted(() =>
  vi.fn<(_options?: unknown) => OAuthCredential | null>(() => null),
);

vi.mock("../cli-credentials.js", () => ({
  readClaudeCliCredentialsCached: () => null,
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCached: () => null,
}));

function createStore(profiles: AuthProfileStore["profiles"] = {}): AuthProfileStore {
  return { version: 1, profiles };
}

function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai-codex",
    access: "access-token",
    refresh: "refresh-token",
    expires: 123,
    ...overrides,
  };
}

function createUsableOAuthExpiry(): number {
  // Keep fixtures comfortably outside the shared near-expiry refresh margin.
  return Date.now() + 30 * 60 * 1000;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireProfile(store: AuthProfileStore, profileId: string): Record<string, unknown> {
  return requireRecord(store.profiles[profileId], profileId);
}

describe("auth external oauth helpers", () => {
  beforeEach(() => {
    resolveExternalAuthProfilesWithPluginsMock.mockReset();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([]);
    readCodexCliCredentialsCachedMock.mockReset();
    readCodexCliCredentialsCachedMock.mockReturnValue(null);
    __testing.setResolveExternalAuthProfilesForTest(resolveExternalAuthProfilesWithPluginsMock);
  });

  afterEach(() => {
    __testing.resetResolveExternalAuthProfilesForTest();
  });

  it("overlays provider-managed runtime oauth profiles onto the store", () => {
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "openai-codex:default",
        credential: createCredential(),
      },
    ]);

    const store = overlayExternalOAuthProfiles(createStore());

    const profile = requireProfile(store, "openai-codex:default");
    expect(profile.type).toBe("oauth");
    expect(profile.provider).toBe("openai-codex");
    expect(profile.access).toBe("access-token");
  });

  it("passes config and CLI scope through overlay resolution", () => {
    const cfg = {
      models: {
        providers: { "openai-codex": { auth: "oauth" as const, baseUrl: "", models: [] } },
      },
    };
    readCodexCliCredentialsCachedMock.mockReturnValueOnce(createCredential());

    overlayExternalOAuthProfiles(createStore(), {
      allowKeychainPrompt: false,
      config: cfg,
      externalCliProviderIds: ["openai-codex"],
    });

    const resolveParams = requireRecord(
      resolveExternalAuthProfilesWithPluginsMock.mock.calls.at(0)?.[0],
      "resolve external auth params",
    );
    expect(resolveParams.config).toBe(cfg);
    expect(requireRecord(resolveParams.context, "resolve context").config).toBe(cfg);
    expect(readCodexCliCredentialsCachedMock).toHaveBeenCalledTimes(1);
  });

  it("omits exact runtime-only overlays from persisted store writes", () => {
    const credential = createCredential();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "openai-codex:default",
        credential,
      },
    ]);

    const shouldPersist = shouldPersistExternalOAuthProfile({
      store: createStore({ "openai-codex:default": credential }),
      profileId: "openai-codex:default",
      credential,
    });

    expect(shouldPersist).toBe(false);
  });

  it("keeps persisted copies when the external overlay is marked persisted", () => {
    const credential = createCredential();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "openai-codex:default",
        credential,
        persistence: "persisted",
      },
    ]);

    const shouldPersist = shouldPersistExternalOAuthProfile({
      store: createStore({ "openai-codex:default": credential }),
      profileId: "openai-codex:default",
      credential,
    });

    expect(shouldPersist).toBe(true);
  });

  it("keeps stale local copies when runtime overlay no longer matches", () => {
    const credential = createCredential();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "openai-codex:default",
        credential: createCredential({ access: "fresh-access-token" }),
      },
    ]);

    const shouldPersist = shouldPersistExternalOAuthProfile({
      store: createStore({ "openai-codex:default": credential }),
      profileId: "openai-codex:default",
      credential,
    });

    expect(shouldPersist).toBe(true);
  });

  it("keeps Codex CLI OAuth from replacing stored inline token material", () => {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      createCredential({
        access: "fresh-cli-access-token",
        refresh: "fresh-cli-refresh-token",
        expires: createUsableOAuthExpiry(),
        accountId: "acct-cli",
      }),
    );

    const overlaid = overlayExternalOAuthProfiles(
      createStore({
        "openai-codex:default": createCredential({
          access: "stale-store-access-token",
          refresh: "stale-store-refresh-token",
          expires: Date.now() - 60_000,
          accountId: "acct-cli",
        }),
      }),
    );

    const profile = requireProfile(overlaid, "openai-codex:default");
    expect(profile.access).toBe("stale-store-access-token");
    expect(profile.refresh).toBe("stale-store-refresh-token");
    expect(profile.accountId).toBe("acct-cli");
  });

  it("uses Codex CLI OAuth when the stored Codex profile has no inline token material", () => {
    const cliCredential = createCredential({
      access: "fresh-cli-access-token",
      refresh: "fresh-cli-refresh-token",
      expires: createUsableOAuthExpiry(),
      accountId: "acct-cli",
    });
    const tokenlessCredential = {
      type: "oauth",
      provider: "openai-codex",
      expires: Date.now() - 60_000,
      accountId: "acct-cli",
    } as OAuthCredential;
    readCodexCliCredentialsCachedMock.mockReturnValue(cliCredential);

    const overlaid = overlayExternalOAuthProfiles(
      createStore({
        "openai-codex:default": tokenlessCredential,
      }),
    );

    const overlaidProfile = overlaid.profiles["openai-codex:default"];
    expect(overlaidProfile?.type).toBe("oauth");
    if (!overlaidProfile || overlaidProfile.type !== "oauth") {
      throw new Error("expected overlaid OAuth profile");
    }
    expect(overlaidProfile.access).toBe("fresh-cli-access-token");
    expect(overlaidProfile.refresh).toBe("fresh-cli-refresh-token");
    expect(overlaidProfile.accountId).toBe("acct-cli");
    const managedCredential = readManagedExternalCliCredential({
      profileId: "openai-codex:default",
      credential: tokenlessCredential,
    });
    expect(managedCredential?.access).toBe("fresh-cli-access-token");
    expect(managedCredential?.refresh).toBe("fresh-cli-refresh-token");
    expect(managedCredential?.accountId).toBe("acct-cli");
  });

  it("keeps healthy local oauth even when external cli has a fresher token", () => {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      createCredential({
        access: "fresh-cli-access-token",
        refresh: "fresh-cli-refresh-token",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
      }),
    );

    const overlaid = overlayExternalOAuthProfiles(
      createStore({
        "openai-codex:default": createCredential({
          access: "healthy-local-access-token",
          refresh: "healthy-local-refresh-token",
          expires: createUsableOAuthExpiry(),
        }),
      }),
    );

    const profile = requireProfile(overlaid, "openai-codex:default");
    expect(profile.access).toBe("healthy-local-access-token");
    expect(profile.refresh).toBe("healthy-local-refresh-token");
  });

  it("keeps explicit local non-oauth auth over external cli oauth overlays", () => {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      createCredential({
        access: "fresh-cli-access-token",
        refresh: "fresh-cli-refresh-token",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
      }),
    );

    const overlaid = overlayExternalOAuthProfiles(
      createStore({
        "openai-codex:default": {
          type: "api_key",
          provider: "openai-codex",
          key: "sk-local",
        },
      }),
    );

    const profile = requireProfile(overlaid, "openai-codex:default");
    expect(profile.type).toBe("api_key");
    expect(profile.provider).toBe("openai-codex");
    expect(profile.key).toBe("sk-local");
  });

  it("keeps expired local oauth when external cli belongs to a different account", () => {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      createCredential({
        access: "fresh-cli-access-token",
        refresh: "fresh-cli-refresh-token",
        expires: createUsableOAuthExpiry(),
        accountId: "acct-external",
      }),
    );

    const overlaid = overlayExternalOAuthProfiles(
      createStore({
        "openai-codex:default": createCredential({
          access: "expired-local-access-token",
          refresh: "expired-local-refresh-token",
          expires: Date.now() - 60_000,
          accountId: "acct-local",
        }),
      }),
    );

    const profile = requireProfile(overlaid, "openai-codex:default");
    expect(profile.access).toBe("expired-local-access-token");
    expect(profile.refresh).toBe("expired-local-refresh-token");
    expect(profile.accountId).toBe("acct-local");
  });
});
