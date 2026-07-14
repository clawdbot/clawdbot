/**
 * Tests persisted auth profile boundary normalization.
 * Covers malformed credential coercion, state merging, legacy OAuth refs, and
 * main/agent store drift repair.
 */
import { describe, expect, it } from "vitest";
import { AUTH_STORE_VERSION } from "./constants.js";
import { resolveAuthProfileOrder } from "./order.js";
import { coercePersistedAuthProfileStore, mergeAuthProfileStores } from "./persisted.js";

describe("persisted auth profile boundary", () => {
  it("normalizes malformed persisted credentials and state before runtime use", () => {
    const store = coercePersistedAuthProfileStore({
      version: "not-a-version",
      profiles: {
        "openai:default": {
          type: "apiKey",
          provider: " OpenAI ",
          apiKey: "demo-openai-key",
          keyRef: { source: "env", id: "OPENAI_API_KEY" },
          metadata: { account: "acct_123", bad: 123 },
          copyToAgents: "yes",
          email: ["wrong"],
          displayName: "Work",
        },
        "openai:legacy-api-key": {
          type: "apiKey",
          provider: "openai",
          apiKey: "legacy-openai-key",
        },
        "openai:legacy-malformed-ref": {
          type: "apiKey",
          provider: "openai",
          apiKey: "legacy-fallback-key",
          keyRef: { source: "env", id: "" },
        },
        "minimax:default": {
          type: "token",
          provider: "minimax",
          token: ["wrong"],
          tokenRef: { source: "env", provider: "default", id: "MINIMAX_TOKEN" },
          expires: "tomorrow",
        },
        "openai:oauth": {
          type: "oauth",
          provider: "openai",
          access: ["wrong"],
          refresh: "refresh-token",
          expires: "later",
          oauthRef: {
            source: "openclaw-credentials",
            provider: "openai",
            id: "not-a-secret-id",
          },
        },
        "broken:array": [],
      },
      order: {
        OpenAI: [" openai:default ", 5, ""],
        minimax: "wrong",
      },
      lastGood: {
        OpenAI: " openai:default ",
        minimax: 5,
      },
      usageStats: {
        "openai:default": {
          cooldownUntil: "later",
          disabledUntil: 123,
          disabledReason: "billing",
          failureCounts: {
            billing: 2,
            nope: 4,
          },
        },
        "minimax:default": "wrong",
      },
    });

    expect(store).toMatchObject({
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          metadata: { account: "acct_123" },
          displayName: "Work",
        },
        "openai:legacy-api-key": {
          type: "api_key",
          provider: "openai",
          key: "legacy-openai-key",
        },
        "openai:legacy-malformed-ref": {
          type: "api_key",
          provider: "openai",
          key: "legacy-fallback-key",
        },
        "minimax:default": {
          type: "token",
          provider: "minimax",
          tokenRef: { source: "env", provider: "default", id: "MINIMAX_TOKEN" },
          expires: 0,
        },
        "openai:oauth": {
          type: "oauth",
          provider: "openai",
          refresh: "refresh-token",
          expires: 0,
        },
      },
      order: {
        openai: ["openai:default"],
      },
      lastGood: {
        openai: "openai:default",
      },
      usageStats: {
        "openai:default": {
          disabledUntil: 123,
          disabledReason: "billing",
          failureCounts: { billing: 2 },
        },
      },
    });
    expect(store?.profiles["broken:array"]).toBeUndefined();
    expect(store?.profiles["openai:default"]).not.toHaveProperty("copyToAgents");
    expect(store?.profiles["openai:oauth"]).not.toHaveProperty("oauthRef");
  });

  it("lets authoritative runtime external metadata remove stale base profiles", () => {
    const merged = mergeAuthProfileStores(
      {
        version: AUTH_STORE_VERSION,
        runtimeExternalProfileIds: ["anthropic:claude-cli"],
        runtimeExternalProfileIdsAuthoritative: true,
        profiles: {
          "anthropic:claude-cli": {
            type: "oauth",
            provider: "anthropic",
            access: "stale-access",
            refresh: "stale-refresh",
            expires: 1,
          },
        },
        order: {
          anthropic: ["anthropic:claude-cli"],
        },
        lastGood: {
          anthropic: "anthropic:claude-cli",
        },
      },
      {
        version: AUTH_STORE_VERSION,
        runtimeExternalProfileIds: [],
        runtimeExternalProfileIdsAuthoritative: true,
        profiles: {},
      },
    );

    expect(merged.runtimeExternalProfileIds).toEqual([]);
    expect(merged.runtimeExternalProfileIdsAuthoritative).toBe(true);
    expect(merged.profiles["anthropic:claude-cli"]).toBeUndefined();
    expect(merged.order?.anthropic).toBeUndefined();
    expect(merged.lastGood?.anthropic).toBeUndefined();
  });

  it("keeps override profiles when authoritative metadata removes base runtime external state", () => {
    const profileId = "anthropic:claude-cli";
    const merged = mergeAuthProfileStores(
      {
        version: AUTH_STORE_VERSION,
        runtimeExternalProfileIds: [profileId],
        runtimeExternalProfileIdsAuthoritative: true,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "anthropic",
            access: "stale-access",
            refresh: "stale-refresh",
            expires: 1,
          },
        },
        order: {
          anthropic: [profileId],
        },
        lastGood: {
          anthropic: profileId,
        },
      },
      {
        version: AUTH_STORE_VERSION,
        runtimeExternalProfileIds: [],
        runtimeExternalProfileIdsAuthoritative: true,
        profiles: {
          [profileId]: {
            type: "api_key",
            provider: "anthropic",
            key: "sk-local",
          },
        },
        order: {
          anthropic: [profileId],
        },
        lastGood: {
          anthropic: profileId,
        },
      },
    );

    expect(merged.runtimeExternalProfileIds).toEqual([]);
    expect(merged.runtimeExternalProfileIdsAuthoritative).toBe(true);
    expect(merged.profiles[profileId]).toMatchObject({
      type: "api_key",
      provider: "anthropic",
      key: "sk-local",
    });
    expect(merged.order?.anthropic).toEqual([profileId]);
    expect(merged.lastGood?.anthropic).toBe(profileId);
  });

  it("tracks persisted profile provenance with override precedence", () => {
    const merged = mergeAuthProfileStores(
      {
        version: AUTH_STORE_VERSION,
        runtimePersistedProfileIds: ["openai:base", "openai:overridden"],
        profiles: {
          "openai:base": {
            type: "api_key",
            provider: "openai",
            key: "base-key",
          },
          "openai:overridden": {
            type: "api_key",
            provider: "openai",
            key: "old-key",
          },
        },
      },
      {
        version: AUTH_STORE_VERSION,
        runtimePersistedProfileIds: ["openai:added"],
        runtimeLocalProfileIds: ["openai:added"],
        profiles: {
          "openai:overridden": {
            type: "api_key",
            provider: "openai",
            key: "scoped-key",
          },
          "openai:added": {
            type: "api_key",
            provider: "openai",
            key: "added-key",
          },
        },
      },
    );

    expect(merged.runtimePersistedProfileIds).toEqual(["openai:added", "openai:base"]);
    expect(merged.runtimeLocalProfileIds).toEqual(["openai:added"]);
  });

  it("preserves config-only order fallbacks during agent-store merges", () => {
    const merged = mergeAuthProfileStores(
      {
        version: AUTH_STORE_VERSION,
        profiles: {},
        order: {
          openai: ["openai:aws-sdk"],
        },
      },
      {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:new-login": {
            type: "oauth",
            provider: "openai",
            access: "new-access",
            refresh: "new-refresh",
            expires: 1,
          },
        },
        order: {
          openai: ["openai:new-login", "openai:aws-sdk"],
        },
      },
      { preserveBaseRuntimeExternalProfiles: true },
    );

    expect(merged.order?.openai).toEqual(["openai:new-login", "openai:aws-sdk"]);
  });

  it("prefers agent-local provider profiles before inherited main profiles", () => {
    const expires = Date.now() + 60_000;
    const merged = mergeAuthProfileStores(
      {
        version: AUTH_STORE_VERSION,
        profiles: {
          "minimax-portal:cli": {
            type: "oauth",
            provider: "minimax-portal",
            access: "main-minimax-access",
            refresh: "main-minimax-refresh",
            expires,
          },
        },
        order: {
          "minimax-portal": ["minimax-portal:cli"],
        },
      },
      {
        version: AUTH_STORE_VERSION,
        profiles: {
          "minimax-portal:default": {
            type: "oauth",
            provider: "minimax-portal",
            access: "agent-minimax-access",
            refresh: "agent-minimax-refresh",
            expires,
          },
        },
      },
      { preserveBaseRuntimeExternalProfiles: true },
    );

    expect(Object.keys(merged.profiles)).toEqual(["minimax-portal:default", "minimax-portal:cli"]);
    expect(merged.order?.["minimax-portal"]).toEqual([
      "minimax-portal:default",
      "minimax-portal:cli",
    ]);
    expect(resolveAuthProfileOrder({ store: merged, provider: "minimax-portal" })).toEqual([
      "minimax-portal:default",
      "minimax-portal:cli",
    ]);
  });

  it("collapses normalized provider order keys without expanding explicit override order", () => {
    const merged = mergeAuthProfileStores(
      {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:main": {
            type: "api_key",
            provider: "OpenAI",
            key: "main-key",
          },
        },
        order: {
          OpenAI: ["openai:main"],
        },
      },
      {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:agent": {
            type: "api_key",
            provider: "openai",
            key: "agent-key",
          },
          "openai:other-agent": {
            type: "api_key",
            provider: "openai",
            key: "other-agent-key",
          },
        },
        order: {
          openai: ["openai:agent"],
        },
      },
      { preserveBaseRuntimeExternalProfiles: true },
    );

    expect(merged.order).toEqual({
      openai: ["openai:agent"],
    });
  });

  it("preserves inherited base runtime external profiles during agent-store merges", () => {
    const profileId = "anthropic:claude-cli";
    const merged = mergeAuthProfileStores(
      {
        version: AUTH_STORE_VERSION,
        runtimeExternalProfileIds: [profileId],
        runtimeExternalProfileIdsAuthoritative: true,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "anthropic",
            access: "main-access",
            refresh: "main-refresh",
            expires: 1,
          },
        },
        order: {
          anthropic: [profileId],
        },
        lastGood: {
          anthropic: profileId,
        },
      },
      {
        version: AUTH_STORE_VERSION,
        runtimeExternalProfileIds: [],
        runtimeExternalProfileIdsAuthoritative: true,
        profiles: {},
      },
      { preserveBaseRuntimeExternalProfiles: true },
    );

    expect(merged.runtimeExternalProfileIds).toEqual([profileId]);
    expect(merged.runtimeExternalProfileIdsAuthoritative).toBe(true);
    expect(merged.profiles[profileId]).toMatchObject({
      type: "oauth",
      provider: "anthropic",
      access: "main-access",
      refresh: "main-refresh",
    });
    expect(merged.order?.anthropic).toEqual([profileId]);
    expect(merged.lastGood?.anthropic).toBe(profileId);
  });
});
