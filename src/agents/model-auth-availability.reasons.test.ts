import { describe, expect, it } from "vitest";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import {
  authStore,
  dualRoutes,
  evaluate,
  routeResolverFactory,
} from "./model-auth-availability.test-support.js";

describe("model auth unavailability reasons", () => {
  it.each(["openai", "anthropic"])(
    "distinguishes missing, failed, unknown, and ready credentials for %s",
    (provider) => {
      const cases = [
        { label: "no evidence", profiles: {}, reason: "missing-auth" },
        {
          label: "expired without refresh",
          profiles: { test: { type: "token", provider, token: "expired-token", expires: 1 } },
          reason: "auth-failed",
        },
        {
          label: "invalid reference",
          profiles: {
            test: {
              type: "api_key",
              provider,
              keyRef: { source: "file", provider: "absent", id: "key" },
            },
          },
          reason: "auth-failed",
        },
        {
          label: "unread reference",
          profiles: {
            test: {
              type: "api_key",
              provider,
              keyRef: { source: "env", provider: "default", id: "UNREAD_KEY" },
            },
          },
          reason: undefined,
        },
        {
          label: "ready",
          profiles: { test: { type: "api_key", provider, key: "test-key" } },
          reason: undefined,
        },
      ];
      for (const { label, profiles, reason } of cases) {
        const result = createModelAuthAvailabilityResolver({
          cfg: {},
          authStore: authStore(profiles),
          env: {},
          routeResolverFactory: routeResolverFactory(dualRoutes),
        }).evaluateModelAuth(provider);
        expect.soft(result.unavailableReason, label).toBe(reason);
        expect.soft(result.unavailableUntil, label).toBeUndefined();
      }
    },
  );

  it("reports the earliest retry among viable cooling profiles, excluding invalid or permanently rejected profiles", () => {
    const until = Date.now() + 60_000;
    const store = authStore({
      first: { type: "api_key", provider: "openai", key: "first-key" },
      second: { type: "api_key", provider: "openai", key: "second-key" },
      invalid: { type: "token", provider: "openai", token: "expired-token", expires: 1 },
      rejected: { type: "api_key", provider: "openai", key: "rejected-key" },
    });
    store.usageStats = {
      first: { cooldownUntil: until + 60_000 },
      second: { cooldownUntil: until },
      invalid: { cooldownUntil: until - 30_000 },
      rejected: { disabledUntil: until - 45_000, disabledReason: "auth_permanent" },
    };
    expect(evaluate({ store, ref: { preferredProfileId: "first" } })).toMatchObject({
      availability: false,
      unavailableReason: "cooldown",
      unavailableUntil: until,
    });
    expect(evaluate({ store, ref: { lockedProfileId: "invalid" } })).toMatchObject({
      availability: false,
      unavailableReason: "auth-failed",
    });
  });

  it.each(["openai", "anthropic"])(
    "reports permanent auth rejection for %s without removing explicit profile retry",
    (provider) => {
      const store = authStore({ bound: { type: "api_key", provider, key: "rejected-key" } });
      store.usageStats = {
        bound: { disabledUntil: Date.now() + 60_000, disabledReason: "auth_permanent" },
      };
      const resolver = createModelAuthAvailabilityResolver({
        cfg: {},
        authStore: store,
        env: {},
        routeResolverFactory: routeResolverFactory(dualRoutes),
      });
      const result = resolver.evaluateModelAuth(provider);
      expect(result).toMatchObject({ availability: false, unavailableReason: "auth-failed" });
      expect(result.unavailableUntil).toBeUndefined();
      const locked = resolver.evaluateModelAuth(provider, { lockedProfileId: "bound" });
      expect(locked.availability).toBe(true);
      expect(locked.unavailableReason).toBeUndefined();
    },
  );

  it.each(["profile", "inline"] as const)(
    "distinguishes %s permanent auth rejection from active retry windows",
    (source) => {
      const until = Date.now() + 60_000;
      const cases = [
        { stats: { cooldownUntil: until }, reason: "cooldown", retryAt: until },
        {
          stats: { disabledUntil: until, disabledReason: "auth_permanent" },
          reason: "auth-failed",
          retryAt: undefined,
        },
        {
          stats: { disabledUntil: 1, disabledReason: "auth_permanent", cooldownUntil: until },
          reason: "cooldown",
          retryAt: until,
        },
        {
          stats: { disabledUntil: until, disabledReason: "billing" },
          reason: "cooldown",
          retryAt: until,
        },
      ] as const;
      for (const { stats, reason, retryAt } of cases) {
        const store = authStore({
          bound: { type: "api_key", provider: "anthropic", key: "test-key" },
        });
        store.usageStats = {
          [source === "profile" ? "bound" : "inline-api-key:anthropic"]: stats,
        };
        const result = createModelAuthAvailabilityResolver({
          cfg: {
            models: {
              providers: {
                anthropic: {
                  auth: "api-key",
                  apiKey: source === "profile" ? "bound" : "inline-key",
                  baseUrl: "https://api.anthropic.com",
                  models: [],
                },
              },
            },
          },
          authStore: store,
          env: {},
        }).evaluateModelAuth("anthropic");
        expect.soft(result, JSON.stringify(stats)).toMatchObject({
          availability: false,
          unavailableReason: reason,
        });
        expect.soft(result.unavailableUntil, JSON.stringify(stats)).toBe(retryAt);
      }
    },
  );
});
