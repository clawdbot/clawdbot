import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_CFG,
  ANTHROPIC_STORE,
} from "./auth-profiles.resolve-auth-profile-order.fixtures.js";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

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
  it("uses explicit profiles when order is missing", () => {
    const order = resolveAuthProfileOrder({
      cfg,
      store,
      provider: "anthropic",
    });
    expect(order).toEqual(["anthropic:default", "anthropic:work"]);
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
});
