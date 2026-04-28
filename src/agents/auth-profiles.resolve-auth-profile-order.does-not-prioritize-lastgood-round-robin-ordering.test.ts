import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_CFG,
  ANTHROPIC_STORE,
} from "./auth-profiles.resolve-auth-profile-order.fixtures.js";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) =>
    provider.trim().toLowerCase() === "z.ai" ? "zai" : provider.trim().toLowerCase(),
}));

function makeApiKeyStore(provider: string, profileIds: string[]): AuthProfileStore {
  return {
    version: 1,
    profiles: Object.fromEntries(
      profileIds.map((profileId) => [
        profileId,
        {
          type: "api_key",
          provider,
          key: profileId.endsWith(":work") ? "sk-work" : "sk-default",
        },
      ]),
    ),
  };
}

function makeApiKeyProfilesByProviderProvider(
  providerByProfileId: Record<string, string>,
): Record<string, { provider: string; mode: "api_key" }> {
  return Object.fromEntries(
    Object.entries(providerByProfileId).map(([profileId, provider]) => [
      profileId,
      { provider, mode: "api_key" },
    ]),
  );
}

describe("resolveAuthProfileOrder", () => {
  const store = ANTHROPIC_STORE;
  const cfg = ANTHROPIC_CFG;

  function resolveWithAnthropicOrderAndUsage(params: {
    orderSource: "store" | "config";
    usageStats: NonNullable<AuthProfileStore["usageStats"]>;
  }) {
    const configuredOrder = { anthropic: ["anthropic:default", "anthropic:work"] };
    return resolveAuthProfileOrder({
      cfg:
        params.orderSource === "config"
          ? {
              auth: {
                order: configuredOrder,
                profiles: cfg.auth?.profiles,
              },
            }
          : undefined,
      store:
        params.orderSource === "store"
          ? { ...store, order: configuredOrder, usageStats: params.usageStats }
          : { ...store, usageStats: params.usageStats },
      provider: "anthropic",
    });
  }

  function resolveMinimaxOrderWithProfile(profile: {
    type: "token";
    provider: "minimax";
    token?: string;
    tokenRef?: { source: "env" | "file" | "exec"; provider: string; id: string };
    expires?: number;
  }) {
    return resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            minimax: ["minimax:default"],
          },
        },
      },
      store: {
        version: 1,
        profiles: {
          "minimax:default": {
            ...profile,
          },
        },
      },
      provider: "minimax",
    });
  }

  it("does not prioritize lastGood over round-robin ordering", () => {
    const order = resolveAuthProfileOrder({
      cfg,
      store: {
        ...store,
        lastGood: { anthropic: "anthropic:work" },
        usageStats: {
          "anthropic:default": { lastUsed: 100 },
          "anthropic:work": { lastUsed: 200 },
        },
      },
      provider: "anthropic",
    });
    expect(order[0]).toBe("anthropic:default");
  });
  it("normalizes z.ai aliases in auth.order", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: { "z.ai": ["zai:work", "zai:default"] },
          profiles: makeApiKeyProfilesByProviderProvider({
            "zai:default": "zai",
            "zai:work": "zai",
          }),
        },
      },
      store: makeApiKeyStore("zai", ["zai:default", "zai:work"]),
      provider: "zai",
    });
    expect(order).toEqual(["zai:work", "zai:default"]);
  });
  it("normalizes provider casing in auth.order keys", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: { OpenAI: ["openai:work", "openai:default"] },
          profiles: makeApiKeyProfilesByProviderProvider({
            "openai:default": "openai",
            "openai:work": "openai",
          }),
        },
      },
      store: makeApiKeyStore("openai", ["openai:default", "openai:work"]),
      provider: "openai",
    });
    expect(order).toEqual(["openai:work", "openai:default"]);
  });
  it("normalizes z.ai aliases in auth.profiles", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          profiles: makeApiKeyProfilesByProviderProvider({
            "zai:default": "z.ai",
            "zai:work": "Z.AI",
          }),
        },
      },
      store: makeApiKeyStore("zai", ["zai:default", "zai:work"]),
      provider: "zai",
    });
    expect(order).toEqual(["zai:default", "zai:work"]);
  });
  it("prioritizes oauth profiles when order missing", () => {
    const mixedStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-default",
        },
        "anthropic:oauth": {
          type: "oauth",
          provider: "anthropic",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };
    const order = resolveAuthProfileOrder({
      store: mixedStore,
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:oauth", "anthropic:default"]);
  });
  it("uses explicit profiles when order is missing", () => {
    const order = resolveAuthProfileOrder({
      cfg,
      store,
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:default", "anthropic:work"]);
  });
  it("uses stored profiles when no config exists", () => {
    const order = resolveAuthProfileOrder({
      store,
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:default", "anthropic:work"]);
  });
  it("prioritizes preferred profiles", () => {
    const order = resolveAuthProfileOrder({
      cfg,
      store,
      provider: "anthropic",
      preferredProfile: "anthropic:work",
    });
    expect(order[0]).toBe("anthropic:work");
    expect(order).toContain("anthropic:default");
  });
  it("uses configured order when provided", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:work", "anthropic:default"] },
          profiles: cfg.auth?.profiles,
        },
      },
      store,
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:work", "anthropic:default"]);
  });
  it("drops explicit order entries that are missing from the store", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            minimax: ["minimax:default", "minimax:prod"],
          },
        },
      },
      store: {
        version: 1,
        profiles: {
          "minimax:prod": {
            type: "api_key",
            provider: "minimax",
            key: "sk-prod",
          },
        },
      },
      provider: "minimax",
    });
    expect(order).toEqual(["minimax:prod"]);
  });
  it("falls back to stored provider profiles when config profile ids drift", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          profiles: {
            "openai-codex:default": {
              provider: "openai-codex",
              mode: "oauth",
            },
          },
          order: {
            "openai-codex": ["openai-codex:default"],
          },
        },
      },
      store: {
        version: 1,
        profiles: {
          "openai-codex:user@example.com": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      },
      provider: "openai-codex",
    });
    expect(order).toEqual(["openai-codex:user@example.com"]);
  });
  it("does not bypass explicit ids when the configured profile exists but is invalid", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          profiles: {
            "openai-codex:default": {
              provider: "openai-codex",
              mode: "token",
            },
          },
          order: {
            "openai-codex": ["openai-codex:default"],
          },
        },
      },
      store: {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "token",
            provider: "openai-codex",
            token: "expired-token",
            expires: Date.now() - 1_000,
          },
          "openai-codex:user@example.com": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      },
      provider: "openai-codex",
    });
    expect(order).toEqual([]);
  });
  it("drops explicit order entries that belong to another provider", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            minimax: ["openai:default", "minimax:prod"],
          },
        },
      },
      store: {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-openai",
          },
          "minimax:prod": {
            type: "api_key",
            provider: "minimax",
            key: "sk-mini",
          },
        },
      },
      provider: "minimax",
    });
    expect(order).toEqual(["minimax:prod"]);
  });
  it("orders by lastUsed when no explicit order exists", () => {
    const order = resolveAuthProfileOrder({
      store: {
        version: 1,
        profiles: {
          "anthropic:a": {
            type: "oauth",
            provider: "anthropic",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
          "anthropic:b": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-b",
          },
          "anthropic:c": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-c",
          },
        },
        usageStats: {
          "anthropic:a": { lastUsed: 200 },
          "anthropic:b": { lastUsed: 100 },
          "anthropic:c": { lastUsed: 300 },
        },
      },
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:a", "anthropic:b", "anthropic:c"]);
  });
  it("pushes cooldown profiles to the end, ordered by cooldown expiry", () => {
    const now = Date.now();
    const order = resolveAuthProfileOrder({
      store: {
        version: 1,
        profiles: {
          "anthropic:ready": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-ready",
          },
          "anthropic:cool1": {
            type: "oauth",
            provider: "anthropic",
            access: "access-token",
            refresh: "refresh-token",
            expires: now + 60_000,
          },
          "anthropic:cool2": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-cool",
          },
        },
        usageStats: {
          "anthropic:ready": { lastUsed: 50 },
          "anthropic:cool1": { cooldownUntil: now + 120_000 },
          "anthropic:cool2": { cooldownUntil: now + 60_000 },
        },
      },
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:ready", "anthropic:cool2", "anthropic:cool1"]);
  });
  it("prefers store order over config order", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:default", "anthropic:work"] },
          profiles: cfg.auth?.profiles,
        },
      },
      store: {
        ...store,
        order: { anthropic: ["anthropic:work", "anthropic:default"] },
      },
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:work", "anthropic:default"]);
  });
  it.each(["store", "config"] as const)(
    "pushes cooldown profiles to the end even with %s order",
    (orderSource) => {
      const now = Date.now();
      const order = resolveWithAnthropicOrderAndUsage({
        orderSource,
        usageStats: {
          "anthropic:default": { cooldownUntil: now + 60_000 },
          "anthropic:work": { lastUsed: 1 },
        },
      });
      expect(order).toEqual(["anthropic:work", "anthropic:default"]);
    },
  );

  it.each(["store", "config"] as const)(
    "pushes disabled profiles to the end even with %s order",
    (orderSource) => {
      const now = Date.now();
      const order = resolveWithAnthropicOrderAndUsage({
        orderSource,
        usageStats: {
          "anthropic:default": {
            disabledUntil: now + 60_000,
            disabledReason: "billing",
          },
          "anthropic:work": { lastUsed: 1 },
        },
      });
      expect(order).toEqual(["anthropic:work", "anthropic:default"]);
    },
  );

  it.each(["store", "config"] as const)(
    "keeps OpenRouter explicit order even when cooldown fields exist (%s)",
    (orderSource) => {
      const now = Date.now();
      const explicitOrder = ["openrouter:default", "openrouter:work"];
      const order = resolveAuthProfileOrder({
        cfg:
          orderSource === "config"
            ? {
                auth: {
                  order: { openrouter: explicitOrder },
                },
              }
            : undefined,
        store: {
          version: 1,
          ...(orderSource === "store" ? { order: { openrouter: explicitOrder } } : {}),
          profiles: {
            "openrouter:default": {
              type: "api_key",
              provider: "openrouter",
              key: "sk-or-default",
            },
            "openrouter:work": {
              type: "api_key",
              provider: "openrouter",
              key: "sk-or-work",
            },
          },
          usageStats: {
            "openrouter:default": {
              cooldownUntil: now + 60_000,
              disabledUntil: now + 120_000,
              disabledReason: "billing",
            },
          },
        },
        provider: "openrouter",
      });

      expect(order).toEqual(explicitOrder);
    },
  );

  it("mode: oauth config accepts both oauth and token credentials (issue #559)", () => {
    const now = Date.now();
    const storeWithBothTypes: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:oauth-cred": {
          type: "oauth",
          provider: "anthropic",
          access: "access-token",
          refresh: "refresh-token",
          expires: now + 60_000,
        },
        "anthropic:token-cred": {
          type: "token",
          provider: "anthropic",
          token: "just-a-token",
          expires: now + 60_000,
        },
      },
    };

    const orderOauthCred = resolveAuthProfileOrder({
      store: storeWithBothTypes,
      provider: "anthropic",
      cfg: {
        auth: {
          profiles: {
            "anthropic:oauth-cred": { provider: "anthropic", mode: "oauth" },
          },
        },
      },
    });
    expect(orderOauthCred).toContain("anthropic:oauth-cred");

    const orderTokenCred = resolveAuthProfileOrder({
      store: storeWithBothTypes,
      provider: "anthropic",
      cfg: {
        auth: {
          profiles: {
            "anthropic:token-cred": { provider: "anthropic", mode: "oauth" },
          },
        },
      },
    });
    expect(orderTokenCred).toContain("anthropic:token-cred");
  });

  it("mode: token config rejects oauth credentials (issue #559 root cause)", () => {
    const now = Date.now();
    const storeWithOauth: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:oauth-cred": {
          type: "oauth",
          provider: "anthropic",
          access: "access-token",
          refresh: "refresh-token",
          expires: now + 60_000,
        },
      },
    };

    const order = resolveAuthProfileOrder({
      store: storeWithOauth,
      provider: "anthropic",
      cfg: {
        auth: {
          profiles: {
            "anthropic:oauth-cred": { provider: "anthropic", mode: "token" },
          },
        },
      },
    });
    expect(order).not.toContain("anthropic:oauth-cred");
  });
  it.each([
    {
      caseName: "drops token profiles with empty credentials",
      profile: {
        type: "token" as const,
        provider: "minimax" as const,
        token: "   ",
      },
    },
    {
      caseName: "drops token profiles that are already expired",
      profile: {
        type: "token" as const,
        provider: "minimax" as const,
        token: "sk-minimax",
        expires: Date.now() - 1000,
      },
    },
    {
      caseName: "drops token profiles with invalid expires metadata",
      profile: {
        type: "token" as const,
        provider: "minimax" as const,
        token: "sk-minimax",
        expires: 0,
      },
    },
  ])("$caseName", ({ profile }) => {
    const order = resolveMinimaxOrderWithProfile(profile);
    expect(order).toEqual([]);
  });
  it("keeps api_key profiles backed by keyRef when plaintext key is absent", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            anthropic: ["anthropic:default"],
          },
        },
      },
      store: {
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            keyRef: {
              source: "exec",
              provider: "vault_local",
              id: "anthropic/default",
            },
          },
        },
      },
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:default"]);
  });
  it("keeps token profiles backed by tokenRef when expires is absent", () => {
    const order = resolveMinimaxOrderWithProfile({
      type: "token",
      provider: "minimax",
      tokenRef: {
        source: "exec",
        provider: "keychain",
        id: "minimax/default",
      },
    });
    expect(order).toEqual(["minimax:default"]);
  });
  it("drops tokenRef profiles when expires is invalid", () => {
    const order = resolveMinimaxOrderWithProfile({
      type: "token",
      provider: "minimax",
      tokenRef: {
        source: "exec",
        provider: "keychain",
        id: "minimax/default",
      },
      expires: 0,
    });
    expect(order).toEqual([]);
  });
  it("keeps token profiles with inline token when no expires is set", () => {
    const order = resolveMinimaxOrderWithProfile({
      type: "token",
      provider: "minimax",
      token: "sk-minimax",
    });
    expect(order).toEqual(["minimax:default"]);
  });
  it("keeps oauth profiles that can refresh", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            anthropic: ["anthropic:oauth"],
          },
        },
      },
      store: {
        version: 1,
        profiles: {
          "anthropic:oauth": {
            type: "oauth",
            provider: "anthropic",
            access: "",
            refresh: "refresh-token",
            expires: Date.now() - 1000,
          },
        },
      },
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:oauth"]);
  });
});
