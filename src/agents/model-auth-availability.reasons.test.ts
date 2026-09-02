import { describe, expect, it } from "vitest";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import {
  authStore,
  dualRoutes,
  evaluate,
  routeResolverFactory,
} from "./model-auth-availability.test-support.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";

describe("model auth unavailability reasons", () => {
  it.each([
    { name: "resolved profile collision", key: "bound", available: true },
    { name: "resolved malformed syntax", key: "$not-a-template", available: true },
    { name: "pending env provenance", key: "ollama-local", pending: true, available: true },
    { name: "literal profile binding", key: "bound", literal: true, available: false },
    { name: "literal local marker", key: "ollama-local", literal: true, available: undefined },
    { name: "literal env marker", key: "OPENAI_API_KEY", literal: true, available: false },
    { name: "literal malformed syntax", key: "$not-a-template", literal: true, available: false },
    { name: "missing snapshot", key: "ollama-local", snapshot: "absent", available: undefined },
    { name: "unresolved snapshot", snapshot: "unresolved", available: undefined },
    { name: "empty snapshot material", key: "", available: undefined },
    { name: "foreign source", key: "ollama-local", snapshot: "foreign", available: undefined },
    { name: "replaced source", key: "ollama-local", snapshot: "replaced", available: undefined },
    { name: "explicit order", key: "ollama-local", order: true, available: false },
    { name: "explicit lock", key: "ollama-local", locked: true, available: false },
  ])(
    "preserves source ownership for $name",
    ({ key, literal, pending, snapshot, order, locked, available }) => {
      const sourceConfig = {
        ...(order ? { auth: { order: { acme: [] } } } : {}),
        models: {
          providers: {
            acme: {
              baseUrl: "https://acme.example/v1",
              apiKey: literal
                ? key
                : pending
                  ? "${PENDING_KEY}"
                  : { source: "store", provider: "default", id: "CATALOG_KEY" },
              models: [],
            },
          },
        },
      } satisfies OpenClawConfig;
      if (pending) {
        setConfigResolutionFacts(
          sourceConfig,
          createConfigResolutionFacts(
            [],
            new Map([["models.providers.acme.apiKey", "PENDING_KEY"]]),
          ),
        );
      }
      const runtimeConfig = {
        ...sourceConfig,
        models: {
          providers: {
            acme: {
              ...sourceConfig.models.providers.acme,
              ...(snapshot === "unresolved" ? {} : { apiKey: key }),
            },
          },
        },
      } satisfies OpenClawConfig;
      const store = authStore({
        bound: { type: "api_key", provider: "other", key: "profile-key" },
      });
      if (snapshot !== "absent") {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
      }
      const cfg =
        snapshot === "absent" || snapshot === "foreign" || snapshot === "replaced"
          ? structuredClone(sourceConfig)
          : runtimeConfig;
      if (snapshot === "foreign") {
        cfg.models.providers.acme.baseUrl = "https://foreign.example/v1";
      }
      if (snapshot === "replaced") {
        const replacement = structuredClone(sourceConfig);
        replacement.models.providers.acme.apiKey = {
          source: "store",
          provider: "default",
          id: "REPLACEMENT_KEY",
        };
        setRuntimeConfigSnapshot(runtimeConfig, replacement);
      }
      try {
        const result = createModelAuthAvailabilityResolver({
          cfg,
          authStore: store,
          env: {},
        }).evaluateModelAuth("acme", locked ? { lockedProfileId: "bound" } : {});
        expect(result.availability).toBe(available);
        if (available === true) {
          expect(result.evidence).toBe("runtime");
          expect(result.selectedProfileId).toBeUndefined();
          const prepared = prepareAgentRuntimeAuth({
            provider: "acme",
            modelId: "discovered",
            config: cfg,
            authProfileStore: store,
            env: {},
          });
          expect(prepared.attempts[0]).toMatchObject({
            kind: "direct",
            allowAuthProfileFallback: false,
            plan: { credentialSource: { kind: "direct", authorization: "declared" } },
          });
        }
      } finally {
        clearRuntimeConfigSnapshot();
      }
    },
  );
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

  it.each(["profile", "inline", "hydrated-inline"] as const)(
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
        const cfg = {
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
        } satisfies OpenClawConfig;
        if (source === "hydrated-inline") {
          const sourceConfig: OpenClawConfig = {
            models: {
              providers: {
                anthropic: {
                  ...cfg.models.providers.anthropic,
                  apiKey: { source: "store", provider: "default", id: "CATALOG_KEY" },
                },
              },
            },
          };
          cfg.models.providers.anthropic.apiKey = "ollama-local";
          setRuntimeConfigSnapshot(cfg, sourceConfig);
        }
        try {
          const result = createModelAuthAvailabilityResolver({
            cfg,
            authStore: store,
            env: {},
          }).evaluateModelAuth("anthropic");
          expect.soft(result, JSON.stringify(stats)).toMatchObject({
            availability: false,
            unavailableReason: reason,
          });
          expect.soft(result.unavailableUntil, JSON.stringify(stats)).toBe(retryAt);
        } finally {
          clearRuntimeConfigSnapshot();
        }
      }
    },
  );
});
