import { describe, expect, it } from "vitest";
import { createScopedAuthProfileStore, resolveAttemptDispatchApiKey } from "./auth-store.js";

const apiKeyInfo = {
  apiKey: "source-token",
  source: "profile:test",
  mode: "oauth" as const,
};

const runtimeAuthState = {
  generation: 1,
  sourceApiKey: "source-token",
  authMode: "oauth",
  profileId: "test:profile",
};

describe("resolveAttemptDispatchApiKey", () => {
  it("keeps provider-prepared runtime auth inside the core transport", () => {
    expect(
      resolveAttemptDispatchApiKey({
        apiKeyInfo,
        runtimeAuthState,
        pluginHarnessOwnsTransport: false,
      }),
    ).toBeUndefined();
  });

  it("forwards the resolved source credential to a transport-owning harness", () => {
    expect(
      resolveAttemptDispatchApiKey({
        apiKeyInfo,
        runtimeAuthState,
        pluginHarnessOwnsTransport: true,
      }),
    ).toBe("source-token");
  });

  it("keeps direct credentials available without provider runtime auth", () => {
    expect(
      resolveAttemptDispatchApiKey({
        apiKeyInfo,
        runtimeAuthState: null,
        pluginHarnessOwnsTransport: false,
      }),
    ).toBe("source-token");
  });
});

describe("createScopedAuthProfileStore", () => {
  const store = {
    version: 1 as const,
    runtimePersistedProfileIds: ["anthropic:work", "openai:other", "openai:work"],
    runtimeExternalProfileIds: ["openai:external", "xai:work"],
    runtimeExternalProfileIdsAuthoritative: true,
    profiles: {
      "openai:work": {
        type: "oauth" as const,
        provider: "openai",
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      },
      "openai:other": {
        type: "oauth" as const,
        provider: "openai",
        access: "other-access",
        refresh: "other-refresh",
        expires: Date.now() + 60_000,
      },
      "openai:external": {
        type: "oauth" as const,
        provider: "openai",
        access: "external-access",
        refresh: "external-refresh",
        expires: Date.now() + 60_000,
      },
      "anthropic:work": {
        type: "api_key" as const,
        provider: "anthropic",
        key: "sk-ant",
      },
      "xai:work": {
        type: "api_key" as const,
        provider: "xai",
        key: "xai-key",
      },
    },
  };

  it("forwards only the selected persisted profile to a transport-owning harness", () => {
    expect(createScopedAuthProfileStore(store, "openai:work")).toEqual({
      version: 1,
      profiles: { "openai:work": store.profiles["openai:work"] },
      runtimePersistedProfileIds: ["openai:work"],
      runtimeExternalProfileIds: [],
      runtimeExternalProfileIdsAuthoritative: true,
    });
  });

  it("preserves an authoritative external profile classification", () => {
    expect(createScopedAuthProfileStore(store, ["openai:external", "anthropic:work"])).toEqual({
      version: 1,
      profiles: {
        "openai:external": store.profiles["openai:external"],
        "anthropic:work": store.profiles["anthropic:work"],
      },
      runtimePersistedProfileIds: ["anthropic:work"],
      runtimeExternalProfileIds: ["openai:external"],
      runtimeExternalProfileIdsAuthoritative: true,
    });
  });

  it("returns an empty store when no requested profile exists", () => {
    expect(createScopedAuthProfileStore(store, "openai:missing")).toEqual({
      version: 1,
      profiles: {},
    });
  });
});
