import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  createProviderApiKeyResolver,
  createProviderAuthResolver,
} from "./models-config.providers.secrets.js";

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({ "proof-alias": "openai" }),
  resolveProviderIdForAuth: (provider: string) => {
    const normalized = provider.trim().toLowerCase();
    return normalized === "proof-alias" ? "openai" : normalized;
  },
}));

vi.mock("./model-auth-env-vars.js", () => ({
  listKnownProviderEnvApiKeyNames: () => [],
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: { "proof-alias": "openai" },
    envCandidateMap: {},
    authEvidenceMap: {},
  }),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
}));

describe("provider catalog auth order", () => {
  it("uses configured, stored, cooldown, and alias ordering", () => {
    const profileA = "openai:profile-a";
    const profileB = "openai:profile-b";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileA]: {
          type: "api_key",
          provider: "openai",
          key: "key-a",
        },
        [profileB]: {
          type: "api_key",
          provider: "openai",
          key: "key-b",
        },
      },
    };
    const config: OpenClawConfig = {
      auth: {
        order: {
          openai: [profileB, profileA],
        },
      },
    };

    expect(createProviderAuthResolver({}, store, config)("openai")).toMatchObject({
      apiKey: "key-b",
      profileId: profileB,
    });
    expect(createProviderApiKeyResolver({}, store, config)("openai")).toMatchObject({
      apiKey: "key-b",
      profileId: profileB,
    });

    store.order = { openai: [profileA, profileB] };
    expect(createProviderAuthResolver({}, store, config)("openai")).toMatchObject({
      apiKey: "key-a",
      profileId: profileA,
    });

    delete store.order;
    store.usageStats = {
      [profileA]: {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
        cooldownModel: "gpt-5.5",
      },
    };
    const cooldownConfig: OpenClawConfig = {
      auth: {
        order: {
          openai: [profileA, profileB],
        },
      },
    };
    for (const resolve of [createProviderAuthResolver, createProviderApiKeyResolver]) {
      expect(resolve({}, store, cooldownConfig)("openai")).toMatchObject({
        apiKey: "key-a",
        profileId: profileA,
      });
    }

    store.usageStats = {
      [profileA]: {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
      },
    };
    for (const resolve of [createProviderAuthResolver, createProviderApiKeyResolver]) {
      expect(resolve({}, store, cooldownConfig)("openai")).toMatchObject({
        apiKey: "key-b",
        profileId: profileB,
      });
    }

    const aliasConfig: OpenClawConfig = {
      auth: {
        order: {
          "proof-alias": [profileB, profileA],
        },
      },
    };
    for (const resolve of [createProviderAuthResolver, createProviderApiKeyResolver]) {
      expect(resolve({}, store, aliasConfig)("proof-alias")).toMatchObject({
        apiKey: "key-b",
        profileId: profileB,
      });
    }
  });

  it("keeps unresolved OAuth refs selected for locked catalog resolution", () => {
    const profileId = "openai:oauth-ref";
    const auth = createProviderAuthResolver(
      {},
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai",
            access: "",
            refresh: "",
            expires: 0,
            oauthRef: {
              source: "openclaw-credentials",
              provider: "openai-codex",
              id: "00000000000000000000000000000000",
            },
          },
        },
      },
      { auth: { order: { openai: [profileId] } } },
    )("openai");

    expect(auth).toMatchObject({
      apiKey: undefined,
      mode: "oauth",
      profileId,
      source: "profile",
    });
  });

  it("supports owner-local exclusion of a failed canonical profile", () => {
    const profileA = "openai:oauth-a";
    const profileB = "openai:api-key-b";
    const resolveAuth = createProviderAuthResolver(
      {},
      {
        version: 1,
        profiles: {
          [profileA]: {
            type: "oauth",
            provider: "openai",
            access: "oauth-a",
            refresh: "refresh-a",
            expires: Date.now() + 60_000,
          },
          [profileB]: {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "file", provider: "vault", id: "/openai/profile-b" },
          },
        },
      },
      { auth: { order: { openai: [profileA, profileB] } } },
    );

    expect(resolveAuth("openai")).toMatchObject({
      mode: "oauth",
      profileId: profileA,
    });
    expect(resolveAuth("openai", { excludeProfileIds: [profileA] })).toMatchObject({
      mode: "api_key",
      profileId: profileB,
    });
  });
});
