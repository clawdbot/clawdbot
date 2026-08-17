/**
 * Tests runtime external OAuth overlays.
 * Covers provider plugin profiles, external CLI scoped discovery, persistence
 * rules, and external CLI bootstrap policy.
 */
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderExternalAuthProfile } from "../../plugins/types.js";
import { resolveAgentCredentialMapFromStore } from "../agent-auth-credentials.js";
import { addEnvBackedAgentCredentials } from "../agent-auth-discovery-core.js";
import { overlayExternalAuthProfiles } from "./external-auth.js";
import { testing } from "./external-auth.test-support.js";
import { readExternalCliBootstrapCredential } from "./external-cli-sync.js";
import { getRuntimeExternalCliProfileIds } from "./runtime-external-profile-references.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  registerRuntimeAuthProfileStoreMutationListener,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./runtime-snapshots.js";
import { ensureAuthProfileStore, getRuntimeAuthProfileStoreSnapshot } from "./store.js";
import type { AuthProfileStore, OAuthCredential, RuntimeAuthProfileStore } from "./types.js";

const resolveExternalAuthProfilesWithPluginsMock = vi.fn<
  (params: unknown) => ProviderExternalAuthProfile[]
>(() => []);
const readCodexCliCredentialsCachedMock = vi.hoisted(() => {
  vi.resetModules();
  return vi.fn<(_options?: unknown) => OAuthCredential | null>(() => null);
});

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
    provider: "openai",
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

const requireRecord = createRequireRecord("object", "expected-label");

function requireProfile(store: AuthProfileStore, profileId: string): Record<string, unknown> {
  return requireRecord(store.profiles[profileId], profileId);
}

describe("auth external oauth helpers", () => {
  beforeEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    resolveExternalAuthProfilesWithPluginsMock.mockReset();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([]);
    readCodexCliCredentialsCachedMock.mockReset();
    readCodexCliCredentialsCachedMock.mockReturnValue(null);
    testing.setResolveExternalAuthProfilesForTest(resolveExternalAuthProfilesWithPluginsMock);
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    testing.resetResolveExternalAuthProfilesForTest();
  });

  it("overlays provider-managed runtime oauth profiles onto the store", () => {
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        profileId: "openai:default",
        credential: createCredential(),
      },
    ]);

    const store = overlayExternalAuthProfiles(createStore());

    const profile = requireProfile(store, "openai:default");
    expect(profile.type).toBe("oauth");
    expect(profile.provider).toBe("openai");
    expect(profile.access).toBe("access-token");
  });

  it("passes config and CLI scope through overlay resolution", () => {
    const cfg = {
      models: {
        providers: { openai: { auth: "oauth" as const, baseUrl: "", models: [] } },
      },
    };
    readCodexCliCredentialsCachedMock.mockReturnValueOnce(createCredential());

    overlayExternalAuthProfiles(createStore(), {
      allowKeychainPrompt: false,
      config: cfg,
      externalCliProviderIds: ["openai"],
    });

    const resolveParams = requireRecord(
      resolveExternalAuthProfilesWithPluginsMock.mock.calls.at(0)?.[0],
      "resolve external auth params",
    );
    expect(resolveParams.config).toBe(cfg);
    expect(requireRecord(resolveParams.context, "resolve context").config).toBe(cfg);
    expect(readCodexCliCredentialsCachedMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes and removes a prepared built-in CLI profile authoritatively", () => {
    const expires = createUsableOAuthExpiry();
    readCodexCliCredentialsCachedMock.mockReturnValueOnce(
      createCredential({ access: "startup-access", refresh: "startup-refresh", expires }),
    );
    const startup = overlayExternalAuthProfiles(
      {
        ...createStore(),
        order: { openai: ["openai:default"] },
        lastGood: { openai: "openai:default" },
        usageStats: { "openai:default": { lastUsed: 1 } },
      },
      {
        externalCliProviderIds: ["openai"],
      },
    );
    expect(getRuntimeExternalCliProfileIds(startup)).toEqual(["openai:default"]);

    const retained = overlayExternalAuthProfiles(startup);
    expect(retained.profiles["openai:default"]).toMatchObject({
      access: "startup-access",
      refresh: "startup-refresh",
    });
    expect(getRuntimeExternalCliProfileIds(retained)).toEqual(["openai:default"]);

    readCodexCliCredentialsCachedMock.mockReturnValueOnce(
      createCredential({ access: "rotated-access", refresh: "rotated-refresh", expires }),
    );
    const rotated = overlayExternalAuthProfiles(retained, {
      externalCliProfileIds: ["openai:default"],
    });
    expect(rotated.profiles["openai:default"]).toMatchObject({
      access: "rotated-access",
      refresh: "rotated-refresh",
    });
    expect(getRuntimeExternalCliProfileIds(rotated)).toEqual(["openai:default"]);

    readCodexCliCredentialsCachedMock.mockReturnValueOnce(null);
    const loggedOut = overlayExternalAuthProfiles(rotated, {
      externalCliProviderIds: ["openai"],
    });
    expect(loggedOut.profiles["openai:default"]).toBeUndefined();
    expect(loggedOut.order).toBeUndefined();
    expect(loggedOut.lastGood).toBeUndefined();
    expect(loggedOut.usageStats).toBeUndefined();
    expect(getRuntimeExternalCliProfileIds(loggedOut)).toEqual([]);
  });

  it("preserves a plugin winner that collides with a built-in CLI profile id", () => {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      createCredential({ access: "cli-access", refresh: "cli-refresh" }),
    );
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([
      {
        profileId: "openai:default",
        credential: createCredential({ access: "plugin-access", refresh: "plugin-refresh" }),
      },
    ]);
    const prepared = overlayExternalAuthProfiles(createStore(), {
      externalCliProviderIds: ["openai"],
    });
    expect(prepared.profiles["openai:default"]).toMatchObject({
      access: "plugin-access",
      refresh: "plugin-refresh",
    });
    expect(prepared.runtimeExternalProfileIds).toEqual(["openai:default"]);
    expect(getRuntimeExternalCliProfileIds(prepared)).toEqual([]);

    const refreshed = overlayExternalAuthProfiles(prepared, {
      externalCliProviderIds: ["openai"],
    });
    expect(refreshed.profiles["openai:default"]).toMatchObject({
      access: "plugin-access",
      refresh: "plugin-refresh",
    });
    expect(resolveExternalAuthProfilesWithPluginsMock).toHaveBeenCalledTimes(2);
  });

  it("replaces CLI provenance only inside the requested refresh scope", () => {
    const store: RuntimeAuthProfileStore = {
      ...createStore({
        "openai:default": createCredential(),
        "claude-cli:default": createCredential({
          provider: "claude-cli",
          access: "claude-access",
          refresh: "claude-refresh",
        }),
      }),
      runtimeExternalProfileIds: ["claude-cli:default", "openai:default"],
      runtimeExternalCliProfileIds: ["claude-cli:default", "openai:default"],
    };

    const refreshed = overlayExternalAuthProfiles(store, {
      externalCliProfileIds: ["openai:default"],
    });

    expect(refreshed.profiles["openai:default"]).toBeUndefined();
    expect(refreshed.profiles["claude-cli:default"]).toMatchObject({
      access: "claude-access",
    });
    expect(getRuntimeExternalCliProfileIds(refreshed)).toEqual(["claude-cli:default"]);
  });

  it("publishes a usable scoped CLI bootstrap into the runtime auth owner", () => {
    const agentDir = "/tmp/openclaw-external-oauth-publication";
    readCodexCliCredentialsCachedMock.mockReturnValue(
      createCredential({ expires: createUsableOAuthExpiry() }),
    );
    const listener = vi.fn();
    const unregister = registerRuntimeAuthProfileStoreMutationListener(listener);
    try {
      const scoped = ensureAuthProfileStore(agentDir, {
        externalCliProviderIds: ["openai"],
        allowKeychainPrompt: false,
        readOnly: true,
        syncExternalCli: false,
      });

      expect(scoped.profiles["openai:default"]?.type).toBe("oauth");
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"]?.type).toBe(
        "oauth",
      );
      expect(listener).toHaveBeenCalledWith({ agentDir, affectsInheritedStores: false });
    } finally {
      unregister();
    }
  });

  it("does not replace an explicit unresolved API-key profile with CLI OAuth", () => {
    const agentDir = "/tmp/openclaw-external-oauth-explicit-owner";
    const explicit = createStore({
      "openai:default": {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
    });
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: explicit }]);
    readCodexCliCredentialsCachedMock.mockReturnValue(
      createCredential({ expires: createUsableOAuthExpiry() }),
    );
    const listener = vi.fn();
    const unregister = registerRuntimeAuthProfileStoreMutationListener(listener);
    try {
      const scoped = ensureAuthProfileStore(agentDir, {
        externalCliProviderIds: ["openai"],
        allowKeychainPrompt: false,
        readOnly: true,
        syncExternalCli: false,
      });

      expect(scoped.profiles["openai:default"]).toEqual(explicit.profiles["openai:default"]);
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"]).toEqual(
        explicit.profiles["openai:default"],
      );
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("preserves resolved runtime refs when startup publishes scoped external auth", () => {
    const agentDir = "/tmp/openclaw-external-oauth-prepared-owner";
    const resolved = createStore({
      "openai:configured": {
        type: "api_key",
        provider: "openai",
        key: "resolved-runtime-key",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
    });
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: resolved }]);
    readCodexCliCredentialsCachedMock.mockReturnValue(
      createCredential({ expires: createUsableOAuthExpiry() }),
    );
    const listener = vi.fn();
    const unregister = registerRuntimeAuthProfileStoreMutationListener(listener);
    try {
      const hydrated = ensureAuthProfileStore(agentDir, {
        externalCliProviderIds: ["openai"],
        allowKeychainPrompt: false,
        readOnly: true,
        syncExternalCli: false,
      });

      expect(hydrated.profiles["openai:configured"]).toEqual(
        resolved.profiles["openai:configured"],
      );
      expect(hydrated.profiles["openai:default"]?.type).toBe("oauth");
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles).toEqual(hydrated.profiles);
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });

  it("keeps ambient Codex OAuth from outranking an env key under an api-key pin", () => {
    const cfg = {
      models: {
        providers: {
          openai: { auth: "api-key" as const, baseUrl: "https://api.openai.com/v1", models: [] },
        },
      },
    };
    readCodexCliCredentialsCachedMock.mockReturnValueOnce(
      createCredential({ expires: createUsableOAuthExpiry() }),
    );

    const store = overlayExternalAuthProfiles(createStore(), {
      config: cfg,
      externalCliProviderIds: ["openai"],
    });
    const ambientOnly = resolveAgentCredentialMapFromStore(store, { config: cfg });
    const credentials = addEnvBackedAgentCredentials(ambientOnly, {
      config: cfg,
      env: { OPENAI_API_KEY: "env-api-key" },
    });

    expect(readCodexCliCredentialsCachedMock).toHaveBeenCalledTimes(1);
    expect(store.profiles["openai:default"]).toBeUndefined();
    expect(ambientOnly.openai).toBeUndefined();
    expect(credentials.openai).toEqual({ type: "api_key", key: "env-api-key" });
  });

  it("keeps explicitly requested external profiles outside the ambient pin", () => {
    const cfg = {
      models: {
        providers: {
          openai: { auth: "api-key" as const, baseUrl: "https://api.openai.com/v1", models: [] },
        },
      },
    };
    readCodexCliCredentialsCachedMock.mockReturnValueOnce(
      createCredential({ expires: createUsableOAuthExpiry() }),
    );

    const store = overlayExternalAuthProfiles(createStore(), {
      config: cfg,
      externalCliProfileIds: ["openai:default"],
    });

    expect(store.profiles["openai:default"]?.type).toBe("oauth");
  });

  it("does not bootstrap arbitrary named OpenAI OAuth profiles from the Codex CLI account", () => {
    readCodexCliCredentialsCachedMock.mockReturnValueOnce(
      createCredential({
        provider: "openai",
        access: "codex-cli-access",
        refresh: "codex-cli-refresh",
        expires: createUsableOAuthExpiry(),
      }),
    );

    const store = createStore({
      "openai:work": createCredential({
        provider: "openai",
        access: undefined,
        refresh: undefined,
        expires: 0,
      }),
    });

    const overlaid = overlayExternalAuthProfiles(store);

    expect(readCodexCliCredentialsCachedMock).not.toHaveBeenCalled();
    expect(overlaid.profiles["openai:work"]).toEqual(store.profiles["openai:work"]);
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

    const overlaid = overlayExternalAuthProfiles(
      createStore({
        "openai:default": createCredential({
          access: "stale-store-access-token",
          refresh: "stale-store-refresh-token",
          expires: Date.now() - 60_000,
          accountId: "acct-cli",
        }),
      }),
    );

    const profile = requireProfile(overlaid, "openai:default");
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
      provider: "openai",
      expires: Date.now() - 60_000,
      accountId: "acct-cli",
    } as OAuthCredential;
    readCodexCliCredentialsCachedMock.mockReturnValue(cliCredential);

    const overlaid = overlayExternalAuthProfiles(
      createStore({
        "openai:default": tokenlessCredential,
      }),
      {
        config: {
          models: {
            providers: {
              openai: {
                auth: "api-key",
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
        },
      },
    );

    const overlaidProfile = overlaid.profiles["openai:default"];
    expect(overlaidProfile?.type).toBe("oauth");
    if (!overlaidProfile || overlaidProfile.type !== "oauth") {
      throw new Error("expected overlaid OAuth profile");
    }
    expect(overlaidProfile.access).toBe("fresh-cli-access-token");
    expect(overlaidProfile.refresh).toBe("fresh-cli-refresh-token");
    expect(overlaidProfile.accountId).toBe("acct-cli");
    const managedCredential = readExternalCliBootstrapCredential({
      store: createStore({
        "openai:default": tokenlessCredential,
      }),
      profileId: "openai:default",
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

    const overlaid = overlayExternalAuthProfiles(
      createStore({
        "openai:default": createCredential({
          access: "healthy-local-access-token",
          refresh: "healthy-local-refresh-token",
          expires: createUsableOAuthExpiry(),
        }),
      }),
    );

    const profile = requireProfile(overlaid, "openai:default");
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

    const overlaid = overlayExternalAuthProfiles(
      createStore({
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-local",
        },
      }),
    );

    const profile = requireProfile(overlaid, "openai:default");
    expect(profile.type).toBe("api_key");
    expect(profile.provider).toBe("openai");
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

    const overlaid = overlayExternalAuthProfiles(
      createStore({
        "openai:default": createCredential({
          access: "expired-local-access-token",
          refresh: "expired-local-refresh-token",
          expires: Date.now() - 60_000,
          accountId: "acct-local",
        }),
      }),
    );

    const profile = requireProfile(overlaid, "openai:default");
    expect(profile.access).toBe("expired-local-access-token");
    expect(profile.refresh).toBe("expired-local-refresh-token");
    expect(profile.accountId).toBe("acct-local");
  });
});
