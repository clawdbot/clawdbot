import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import { resolveAgentHarnessPreparedAuthSupport } from "../harness/support.js";
import { getApiKeyForModel } from "../model-auth.js";
import {
  agentRuntimeAuthPlanMatchesTarget,
  canRunPreparedAgentRuntimeAuthAttempt,
  prepareAgentRuntimeAuth,
  prepareAgentRuntimeAuthPlan,
  preparedAgentRuntimeProfileAttemptHasCandidate,
} from "./prepare-auth.js";

function authStore(
  profiles: AuthProfileStore["profiles"],
  order?: AuthProfileStore["order"],
): AuthProfileStore {
  return { version: 1, profiles, ...(order ? { order } : {}) };
}

function allCooldownOpenAIStore(): AuthProfileStore {
  const store = authStore(
    {
      "openai:cooldown": {
        type: "api_key",
        provider: "openai",
        key: "cooldown-key",
      },
    },
    { openai: ["openai:cooldown"] },
  );
  store.usageStats = {
    "openai:cooldown": { cooldownUntil: Date.now() + 60_000 },
  };
  return store;
}

describe("prepareAgentRuntimeAuthPlan", () => {
  it("keeps unknown no-observation models on the legacy auth plan", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.4-nano",
      env: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileStore: authStore({}),
    });

    expect(plan).toMatchObject({
      providerForAuth: "openai",
      harnessAuthProvider: "openai",
    });
    expect(plan.modelRoute).toBeUndefined();
    expect(plan.deferredRouteSupport).toBeUndefined();
  });

  it("keeps a generic provider-entry binding ahead of an automatic backup", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "xai",
      modelId: "grok-4",
      config: {
        models: {
          providers: {
            xai: { apiKey: "xai:bound", baseUrl: "", models: [] },
          },
        },
      } as OpenClawConfig,
      env: {},
      authProfileStore: authStore(
        {
          "xai:bound": {
            type: "api_key",
            provider: "xai",
            key: "bound-key",
          },
          "xai:backup": {
            type: "api_key",
            provider: "xai",
            key: "backup-key",
          },
        },
        { xai: ["xai:backup", "xai:bound"] },
      ),
      sessionAuthProfileId: "xai:backup",
      sessionAuthProfileSource: "auto",
    });

    expect(plan).toMatchObject({
      providerForAuth: "xai",
      forwardedAuthProfileId: "xai:bound",
      forwardedAuthProfileSource: "auto",
      forwardedAuthProfileCandidateIds: ["xai:bound"],
      selectedAuthMode: "api_key",
    });
    expect(plan.modelRoute).toBeUndefined();
  });

  it("rejects a cooldowned generic provider-entry binding instead of using a backup", () => {
    const store = authStore(
      {
        "xai:bound": {
          type: "api_key",
          provider: "xai",
          key: "bound-key",
        },
        "xai:backup": {
          type: "api_key",
          provider: "xai",
          key: "backup-key",
        },
      },
      { xai: ["xai:backup", "xai:bound"] },
    );
    store.usageStats = {
      "xai:bound": { cooldownUntil: Date.now() + 60_000 },
    };

    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "xai",
        modelId: "grok-4",
        config: {
          models: {
            providers: {
              xai: { apiKey: "xai:bound", baseUrl: "", models: [] },
            },
          },
        } as OpenClawConfig,
        env: {},
        authProfileStore: store,
        sessionAuthProfileId: "xai:backup",
        sessionAuthProfileSource: "auto",
      }),
    ).toThrow(/temporarily unavailable/u);
  });

  it("keeps generic AWS SDK auth ahead of provider bindings and automatic profiles", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "xai",
      modelId: "grok-4",
      config: {
        models: {
          providers: {
            xai: {
              auth: "aws-sdk",
              apiKey: "xai:bound",
              baseUrl: "",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      env: {},
      authProfileStore: authStore({
        "xai:bound": {
          type: "api_key",
          provider: "xai",
          key: "bound-key",
        },
        "xai:backup": {
          type: "api_key",
          provider: "xai",
          key: "backup-key",
        },
      }),
      sessionAuthProfileId: "xai:backup",
      sessionAuthProfileSource: "auto",
    });

    expect(plan.forwardedAuthProfileId).toBeUndefined();
    expect(plan.forwardedAuthProfileCandidateIds).toBeUndefined();
    expect(plan.selectedAuthMode).toBe("aws-sdk");
    expect(plan.modelRoute).toBeUndefined();
  });

  it("rotates a generic automatic profile past a model cooldown", () => {
    const store = authStore(
      {
        "xai:p1": {
          type: "api_key",
          provider: "xai",
          key: "p1-key",
        },
        "xai:p2": {
          type: "api_key",
          provider: "xai",
          key: "p2-key",
        },
        "xai:p3": {
          type: "api_key",
          provider: "xai",
          key: "p3-key",
        },
      },
      { xai: ["xai:p1", "xai:p2", "xai:p3"] },
    );
    store.usageStats = {
      "xai:p1": {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
        cooldownModel: "grok-4",
      },
    };

    const plan = prepareAgentRuntimeAuthPlan({
      provider: "xai",
      modelId: "grok-4",
      env: {},
      authProfileStore: store,
      sessionAuthProfileId: "xai:p1",
      sessionAuthProfileSource: "auto",
    });

    expect(plan).toMatchObject({
      forwardedAuthProfileId: "xai:p2",
      forwardedAuthProfileSource: "auto",
      forwardedAuthProfileCandidateIds: ["xai:p2", "xai:p3"],
      selectedAuthMode: "api_key",
    });
    expect(plan.modelRoute).toBeUndefined();
  });

  it("applies a provider-owned preferred profile without turning it into a lock", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "xai",
      modelId: "grok-4",
      env: {},
      authProfileStore: authStore(
        {
          "xai:p1": { type: "api_key", provider: "xai", key: "p1-key" },
          "xai:p2": { type: "api_key", provider: "xai", key: "p2-key" },
        },
        { xai: ["xai:p1", "xai:p2"] },
      ),
      resolveProviderPreferredProfileId: () => "xai:p2",
    });

    expect(plan).toMatchObject({
      forwardedAuthProfileId: "xai:p2",
      forwardedAuthProfileSource: "auto",
      forwardedAuthProfileCandidateIds: ["xai:p2", "xai:p1"],
    });
  });

  it("drops proven-unavailable generic candidates before forwarding fallbacks", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "xai",
      modelId: "grok-4",
      config: {
        secrets: {
          providers: {
            vault: { source: "file", path: "/tmp/secrets.json", mode: "json" },
          },
        },
      } as OpenClawConfig,
      env: {},
      authProfileStore: authStore(
        {
          "xai:missing": {
            type: "api_key",
            provider: "xai",
            keyRef: { source: "env", provider: "vault", id: "XAI_API_KEY" },
          },
          "xai:p2": {
            type: "api_key",
            provider: "xai",
            key: "p2-key",
          },
          "xai:p3": {
            type: "api_key",
            provider: "xai",
            key: "p3-key",
          },
        },
        { xai: ["xai:missing", "xai:p2", "xai:p3"] },
      ),
      sessionAuthProfileId: "xai:missing",
      sessionAuthProfileSource: "auto",
    });

    expect(plan).toMatchObject({
      forwardedAuthProfileId: "xai:p2",
      forwardedAuthProfileSource: "auto",
      forwardedAuthProfileCandidateIds: ["xai:p2", "xai:p3"],
    });
  });

  it("fails closed before resolving an all-cooldown generic order", () => {
    const store = authStore(
      {
        "xai:p1": {
          type: "api_key",
          provider: "xai",
          key: "p1-key",
        },
        "xai:p2": {
          type: "api_key",
          provider: "xai",
          key: "p2-key",
        },
      },
      { xai: ["xai:p1", "xai:p2"] },
    );
    store.usageStats = {
      "xai:p1": { cooldownUntil: Date.now() + 60_000 },
      "xai:p2": { cooldownUntil: Date.now() + 60_000 },
    };

    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "xai",
        modelId: "grok-4",
        env: {},
        authProfileStore: store,
        sessionAuthProfileId: "xai:p1",
        sessionAuthProfileSource: "auto",
      }),
    ).toThrow(/temporarily unavailable/u);
  });

  it("fails closed when an explicit generic order contains only missing profiles", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "xai",
        modelId: "grok-4",
        config: {
          auth: { order: { xai: ["xai:missing"] } },
        } as OpenClawConfig,
        env: {},
        authProfileStore: authStore({
          "xai:backup": {
            type: "api_key",
            provider: "xai",
            key: "backup-key",
          },
        }),
      }),
    ).toThrow(/explicit auth order.*no usable profiles/iu);
  });

  it("fails closed when an explicit generic order is empty", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "xai",
        modelId: "grok-4",
        config: {
          auth: { order: { xai: [] } },
        } as OpenClawConfig,
        env: {},
        authProfileStore: authStore({
          "xai:backup": {
            type: "api_key",
            provider: "xai",
            key: "backup-key",
          },
        }),
      }),
    ).toThrow(/explicit auth order.*no usable profiles/iu);
  });

  it("keeps a generic user lock as a singleton despite cooldown", () => {
    const store = authStore(
      {
        "xai:p1": {
          type: "api_key",
          provider: "xai",
          key: "p1-key",
        },
        "xai:p2": {
          type: "api_key",
          provider: "xai",
          key: "p2-key",
        },
      },
      { xai: ["xai:p1", "xai:p2"] },
    );
    store.usageStats = {
      "xai:p1": { cooldownUntil: Date.now() + 60_000 },
    };

    const plan = prepareAgentRuntimeAuthPlan({
      provider: "xai",
      modelId: "grok-4",
      env: {},
      authProfileStore: store,
      sessionAuthProfileId: "xai:p1",
      sessionAuthProfileSource: "user",
    });

    expect(plan).toMatchObject({
      forwardedAuthProfileId: "xai:p1",
      forwardedAuthProfileSource: "user",
      forwardedAuthProfileCandidateIds: ["xai:p1"],
      selectedAuthMode: "api_key",
    });
  });

  it("defers an ambiguous route when native Codex owns auth", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-chatgpt-responses",
      modelBaseUrl: "https://chatgpt.com/backend-api/codex",
      env: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      harnessAuthBootstrap: "harness",
      authProfileStore: authStore({}),
    });

    expect(plan.harnessAuthProvider).toBe("openai");
    expect(plan.modelRoute).toBeUndefined();
    expect(plan.deferredRouteSupport).toEqual({
      requestTransportOverrides: "none",
      runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
    });
    expect(resolveAgentHarnessPreparedAuthSupport({ plan })).toEqual({ source: "harness" });
  });

  it("falls through an unusable env marker to an ordered API-key profile", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      config: {
        models: {
          providers: {
            openai: { apiKey: "OPENAI_API_KEY", baseUrl: "", models: [] },
          },
        },
      } as OpenClawConfig,
      env: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileStore: authStore(
        {
          "openai:backup": {
            type: "api_key",
            provider: "openai",
            key: "backup-key",
          },
        },
        { openai: ["openai:backup"] },
      ),
    });

    expect(plan.forwardedAuthProfileId).toBe("openai:backup");
    expect(plan.modelRoute?.authRequirement).toBe("api-key");
  });

  it("rejects a concrete route when an env marker has no usable credential", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        config: {
          models: {
            providers: {
              openai: { apiKey: "OPENAI_API_KEY", baseUrl: "", models: [] },
            },
          },
        } as OpenClawConfig,
        env: {},
        harnessId: "codex",
        harnessRuntime: "codex",
        authProfileStore: authStore({}),
      }),
    ).toThrow(/No route-compatible authentication source/u);
  });

  it("skips cooldowned automatic profiles before selecting a healthy backup", () => {
    const store = authStore(
      {
        "openai:cooldown": {
          type: "api_key",
          provider: "openai",
          key: "cooldown-key",
        },
        "openai:backup": {
          type: "api_key",
          provider: "openai",
          key: "backup-key",
        },
      },
      { openai: ["openai:cooldown", "openai:backup"] },
    );
    store.usageStats = {
      "openai:cooldown": { cooldownUntil: Date.now() + 60_000 },
    };

    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      env: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileStore: store,
      sessionAuthProfileId: "openai:cooldown",
      sessionAuthProfileSource: "auto",
    });

    expect(plan.forwardedAuthProfileId).toBe("openai:backup");
    expect(plan.forwardedAuthProfileCandidateIds).toEqual(["openai:backup"]);
  });

  it("does not bypass an all-cooldown auth order through native Codex auth", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        env: {},
        harnessId: "codex",
        harnessRuntime: "codex",
        authProfileStore: allCooldownOpenAIStore(),
      }),
    ).toThrow(/temporarily unavailable/u);
  });

  it("does not bypass an all-cooldown auth order through direct provider auth", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        config: {
          models: {
            providers: {
              openai: {
                apiKey: { source: "env", provider: "default", id: "DIRECT_OPENAI_KEY" },
                baseUrl: "",
                models: [],
              },
            },
          },
          secrets: { providers: { default: { source: "env" } } },
        } as OpenClawConfig,
        env: { DIRECT_OPENAI_KEY: "sk-direct" },
        harnessId: "codex",
        harnessRuntime: "codex",
        authProfileStore: allCooldownOpenAIStore(),
      }),
    ).toThrow(/temporarily unavailable/u);
  });

  it("does not let clear OAuth auth hide a cooldown Platform tier before literal fallback", () => {
    const store = authStore(
      {
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
        "openai:platform": {
          type: "api_key",
          provider: "openai",
          key: "platform-key",
        },
      },
      { openai: ["openai:chatgpt", "openai:platform"] },
    );
    store.usageStats = {
      "openai:platform": { cooldownUntil: Date.now() + 60_000 },
    };

    expect(() =>
      prepareAgentRuntimeAuth({
        provider: "openai",
        modelId: "gpt-5.5",
        config: {
          models: {
            providers: {
              openai: { apiKey: "configured-platform-key", baseUrl: "", models: [] },
            },
          },
        } as OpenClawConfig,
        env: {},
        authProfileStore: store,
      }),
    ).toThrow(/temporarily unavailable/u);
  });

  it("rejects an incompatible provider-bound profile before Codex forwarding", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-responses",
        modelBaseUrl: "https://relay.example/v1",
        config: {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                apiKey: "relay:key",
                baseUrl: "https://relay.example/v1",
                models: [],
              },
              relay: {
                api: "openai-responses",
                baseUrl: "https://relay.example/v1",
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        harnessId: "codex",
        harnessRuntime: "codex",
        authProfileStore: authStore({
          "relay:key": {
            type: "api_key",
            provider: "relay",
            key: "relay-secret",
          },
        }),
      }),
    ).toThrow(/has no usable credentials/u);
  });

  it("rejects an incompatible provider binding on a generic Codex plan", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "codex",
        modelId: "gpt-5.4",
        config: {
          models: {
            providers: {
              codex: {
                apiKey: "relay:key",
                baseUrl: "https://relay.example/v1",
                models: [],
              },
              relay: {
                baseUrl: "https://relay.example/v1",
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        harnessId: "codex",
        harnessRuntime: "codex",
        authProfileStore: authStore({
          "relay:key": {
            type: "api_key",
            provider: "relay",
            key: "relay-secret",
          },
        }),
      }),
    ).toThrow(/has no usable credentials/u);
  });

  it("selects the first compatible auth.order profile with its exact route", () => {
    const preparation = prepareAgentRuntimeAuth({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      env: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileStore: authStore(
        {
          "openai:chatgpt": {
            type: "token",
            provider: "openai",
            token: "subscription-token",
            expires: Date.now() + 60_000,
          },
          "openai:platform": {
            type: "api_key",
            provider: "openai",
            key: "platform-key",
          },
        },
        { openai: ["openai:chatgpt", "openai:platform"] },
      ),
    });
    const plan = preparation.plan;

    expect(plan).toMatchObject({
      forwardedAuthProfileId: "openai:chatgpt",
      forwardedAuthProfileSource: "auto",
      forwardedAuthProfileCandidateIds: ["openai:chatgpt"],
      selectedAuthMode: "token",
      modelRoute: {
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authRequirement: "subscription",
      },
    });
    expect(
      preparation.attempts.map((attempt) => ({
        profileId: attempt.profileId,
        authRequirement: attempt.plan.modelRoute?.authRequirement,
      })),
    ).toEqual([
      { profileId: "openai:chatgpt", authRequirement: "subscription" },
      { profileId: "openai:platform", authRequirement: "api-key" },
    ]);
  });

  it("prepares every ordered same-route profile as an exhaustive fallback set", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      config: {
        models: {
          providers: {
            openai: { baseUrl: "https://api.openai.com/v1", models: [] },
          },
        },
      } as OpenClawConfig,
      env: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileStore: authStore(
        {
          "openai:missing": {
            type: "api_key",
            provider: "openai",
            keyRef: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_TEST_MISSING_PREPARED_AUTH",
            },
          },
          "openai:backup": {
            type: "api_key",
            provider: "openai",
            key: "backup-key",
          },
        },
        { openai: ["openai:missing", "openai:backup"] },
      ),
    });

    expect(plan).toMatchObject({
      forwardedAuthProfileId: "openai:missing",
      forwardedAuthProfileSource: "auto",
      forwardedAuthProfileCandidateIds: ["openai:missing", "openai:backup"],
      selectedAuthMode: "api_key",
      modelRoute: { authRequirement: "api-key" },
    });
  });

  it("keeps same-route native candidates ahead of interleaved route fallbacks", () => {
    const preparation = prepareAgentRuntimeAuth({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      config: {
        secrets: {
          providers: {
            vault: { source: "file", path: "/tmp/secrets.json", mode: "json" },
          },
        },
      } as OpenClawConfig,
      env: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileStore: authStore(
        {
          "openai:subscription-missing": {
            type: "token",
            provider: "openai",
            tokenRef: { source: "file", provider: "vault", id: "/chatgpt/token" },
          },
          "openai:platform": {
            type: "api_key",
            provider: "openai",
            key: "platform-key",
          },
          "openai:subscription-backup": {
            type: "token",
            provider: "openai",
            token: "subscription-token",
          },
        },
        {
          openai: ["openai:subscription-missing", "openai:platform", "openai:subscription-backup"],
        },
      ),
    });

    expect(preparation.plan.forwardedAuthProfileCandidateIds).toEqual([
      "openai:subscription-missing",
      "openai:subscription-backup",
    ]);
    expect(
      preparation.attempts.map((attempt) => ({
        profileId: attempt.profileId,
        authRequirement: attempt.plan.modelRoute?.authRequirement,
      })),
    ).toEqual([
      { profileId: "openai:subscription-missing", authRequirement: "subscription" },
      { profileId: "openai:subscription-backup", authRequirement: "subscription" },
      { profileId: "openai:platform", authRequirement: "api-key" },
    ]);
  });

  it("skips a definitively invalid ordered profile before selecting a sibling route", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      config: {
        auth: { order: { openai: ["openai:bad-key", "openai:chatgpt"] } },
        secrets: {
          providers: {
            vault: { source: "file", path: "/tmp/secrets.json", mode: "json" },
          },
        },
      } as OpenClawConfig,
      env: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileStore: authStore(
        {
          "openai:bad-key": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "vault", id: "OPENAI_API_KEY" },
          },
          "openai:chatgpt": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 10 * 60_000,
          },
        },
        { openai: ["openai:bad-key", "openai:chatgpt"] },
      ),
    });

    expect(plan).toMatchObject({
      forwardedAuthProfileId: "openai:chatgpt",
      forwardedAuthProfileCandidateIds: ["openai:chatgpt"],
      selectedAuthMode: "oauth",
      modelRoute: { authRequirement: "subscription" },
    });
  });

  it("rejects an all-invalid auth order before configured direct auth", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        config: {
          auth: { order: { openai: ["openai:ordered"] } },
          secrets: {
            providers: {
              default: { source: "env" },
              vault: { source: "file", path: "/tmp/secrets.json", mode: "json" },
            },
          },
          models: {
            providers: {
              openai: {
                apiKey: { source: "env", provider: "default", id: "DIRECT_OPENAI_KEY" },
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        env: { DIRECT_OPENAI_KEY: "sk-direct" },
        harnessId: "codex",
        harnessRuntime: "codex",
        authProfileStore: authStore(
          {
            "openai:ordered": {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", provider: "vault", id: "ORDERED_OPENAI_KEY" },
            },
          },
          { openai: ["openai:ordered"] },
        ),
      }),
    ).toThrow(/explicit auth order.*no usable profiles/iu);
  });

  it("keeps a user-locked profile authoritative and rejects the wrong route class", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-chatgpt-responses",
        modelBaseUrl: "https://chatgpt.com/backend-api/codex",
        env: {},
        config: {
          models: {
            providers: {
              openai: {
                api: "openai-chatgpt-responses",
                baseUrl: "https://chatgpt.com/backend-api/codex",
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        sessionAuthProfileId: "openai:platform",
        sessionAuthProfileSource: "user",
        authProfileStore: authStore({
          "openai:platform": {
            type: "api_key",
            provider: "openai",
            key: "platform-key",
          },
        }),
      }),
    ).toThrow(/requires subscription authentication/u);
  });

  it("lets an explicit provider API key outrank automatic subscription profiles", () => {
    const config = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            auth: "api-key",
            apiKey: "configured-platform-key",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-chatgpt-responses",
      modelBaseUrl: "https://chatgpt.com/backend-api/codex",
      config,
      env: {},
      authProfileStore: authStore({
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "subscription-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      }),
    });

    expect(plan.forwardedAuthProfileId).toBeUndefined();
    expect(plan.modelRoute).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key",
    });
  });

  it("rejects an official authored route with unvalidated native auth", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        config: {
          models: {
            providers: {
              openai: {
                auth: "api-key",
                apiKey: "configured-platform-key",
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        env: { OPENAI_API_KEY: "ambient-platform-key" },
        authProfileStore: authStore(
          {
            "openai:chatgpt": {
              type: "oauth",
              provider: "openai",
              access: "subscription-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
          { openai: ["openai:chatgpt"] },
        ),
        sessionAuthProfileId: "openai:chatgpt",
        sessionAuthProfileSource: "auto",
        harnessId: "codex",
        harnessRuntime: "codex",
        harnessAuthBootstrap: "harness",
        allowHarnessAuthProfileForwarding: false,
      }),
    ).toThrow(/route-compatible authentication source/u);
  });

  it("rejects a user-locked profile when the harness cannot accept host auth", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        env: {},
        authProfileStore: authStore({
          "openai:work": {
            type: "api_key",
            provider: "openai",
            key: "platform-key",
          },
        }),
        sessionAuthProfileId: "openai:work",
        sessionAuthProfileSource: "user",
        harnessId: "codex",
        harnessRuntime: "codex",
        allowHarnessAuthProfileForwarding: false,
      }),
    ).toThrow(/native account instead/u);
  });

  it("honors the no-host-auth policy for non-Codex harnesses", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "xai",
      modelId: "grok-4",
      config: {
        models: {
          providers: {
            xai: { auth: "api-key", apiKey: "xai-key", baseUrl: "", models: [] },
          },
        },
      } as OpenClawConfig,
      env: {},
      authProfileStore: authStore({
        "xai:auto": { type: "api_key", provider: "xai", key: "profile-key" },
      }),
      sessionAuthProfileId: "xai:auto",
      sessionAuthProfileSource: "auto",
      harnessId: "native-remote",
      harnessRuntime: "native-remote",
      allowHarnessAuthProfileForwarding: false,
    });

    expect(plan.forwardedAuthProfileId).toBeUndefined();
    expect(plan.selectedAuthMode).toBeUndefined();
  });

  it("lets a provider-entry token profile binding outrank configured auth and auth.order", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      config: {
        models: {
          providers: {
            openai: {
              auth: "api-key",
              apiKey: "openai:bound",
              baseUrl: "",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      env: {},
      authProfileStore: authStore(
        {
          "openai:bound": {
            type: "token",
            provider: "openai",
            token: "subscription-token",
            expires: Date.now() + 60_000,
          },
          "openai:platform": {
            type: "api_key",
            provider: "openai",
            key: "platform-key",
          },
        },
        { openai: ["openai:platform", "openai:bound"] },
      ),
    });

    expect(plan).toMatchObject({
      forwardedAuthProfileId: "openai:bound",
      forwardedAuthProfileSource: "auto",
      forwardedAuthProfileCandidateIds: ["openai:bound"],
      selectedAuthMode: "token",
      modelRoute: {
        api: "openai-chatgpt-responses",
        authRequirement: "subscription",
      },
    });
  });

  it.each([
    { provider: "anthropic", mode: "api_key" as const },
    { provider: "openai", mode: "oauth" as const },
  ])("rejects a bound profile with conflicting $provider/$mode metadata", ({ mode, provider }) => {
    expect(() =>
      prepareAgentRuntimeAuth({
        provider: "openai",
        modelId: "gpt-5.5",
        config: {
          auth: { profiles: { "openai:bound": { provider, mode } } },
          models: {
            providers: {
              openai: { apiKey: "openai:bound", baseUrl: "", models: [] },
            },
          },
        } as OpenClawConfig,
        env: {},
        authProfileStore: authStore({
          "openai:bound": {
            type: "api_key",
            provider: "openai",
            key: "bound-platform-key",
          },
        }),
      }),
    ).toThrow(/no usable credentials/u);
  });

  it("rejects an incompatible provider-entry profile without borrowing auth.order", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        config: {
          models: {
            providers: {
              openai: {
                apiKey: "openai:oauth",
                baseUrl: "",
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        authProfileStore: authStore(
          {
            "openai:oauth": {
              type: "oauth",
              provider: "openai",
              access: "subscription-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
            "openai:platform": {
              type: "api_key",
              provider: "openai",
              key: "platform-key",
            },
          },
          { openai: ["openai:platform"] },
        ),
      }),
    ).toThrow(/not a compatible bearer profile/u);
  });

  it("does not forward a cooldowned provider-entry profile", () => {
    const store = authStore({
      "openai:bound": {
        type: "token",
        provider: "openai",
        token: "subscription-token",
        expires: Date.now() + 60_000,
      },
    });
    store.usageStats = {
      "openai:bound": { cooldownUntil: Date.now() + 60_000 },
    };

    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        config: {
          models: {
            providers: {
              openai: { apiKey: "openai:bound", baseUrl: "", models: [] },
            },
          },
        } as OpenClawConfig,
        env: {},
        authProfileStore: store,
      }),
    ).toThrow(/temporarily unavailable/u);
  });

  it("keeps an explicit AWS SDK auth mode ahead of provider-entry profile bindings", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      config: {
        models: {
          providers: {
            openai: {
              auth: "aws-sdk",
              apiKey: "openai:bound",
              baseUrl: "",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      env: {},
      authProfileStore: authStore({
        "openai:bound": {
          type: "token",
          provider: "openai",
          token: "subscription-token",
          expires: Date.now() + 60_000,
        },
      }),
    });

    expect(plan.forwardedAuthProfileId).toBeUndefined();
    expect(plan.selectedAuthMode).toBe("aws-sdk");
    expect(plan.modelRoute).toMatchObject({
      api: "openai-responses",
      authRequirement: "api-key",
    });
  });

  it("keeps AWS SDK auth terminal when an API-key SecretRef and ordered profile also exist", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      config: {
        models: {
          providers: {
            openai: {
              auth: "aws-sdk",
              apiKey: { source: "file", provider: "vault", id: "/openai/api-key" },
              baseUrl: "",
              models: [],
            },
          },
        },
        secrets: {
          providers: {
            vault: { source: "file", path: "/tmp/openai-secrets.json", mode: "json" },
          },
        },
      } as OpenClawConfig,
      env: {},
      authProfileStore: authStore(
        {
          "openai:platform": {
            type: "api_key",
            provider: "openai",
            key: "platform-key",
          },
        },
        { openai: ["openai:platform"] },
      ),
    });

    expect(plan.forwardedAuthProfileId).toBeUndefined();
    expect(plan.forwardedAuthProfileCandidateIds).toBeUndefined();
    expect(plan.selectedAuthMode).toBe("aws-sdk");
    expect(plan.modelRoute).toMatchObject({
      api: "openai-responses",
      authRequirement: "api-key",
    });
  });

  it("keeps an explicit SecretRef API key ahead of ordered API-key profiles", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-chatgpt-responses",
      modelBaseUrl: "https://chatgpt.com/backend-api/codex",
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "",
              models: [],
            },
            " openai ": {
              auth: "api-key",
              apiKey: { source: "file", provider: "vault", id: "/openai/api-key" },
              baseUrl: "",
              models: [],
            },
          },
        },
        secrets: {
          providers: {
            vault: { source: "file", path: "/tmp/openai-secrets.json", mode: "json" },
          },
        },
      } as OpenClawConfig,
      env: {},
      authProfileStore: authStore(
        {
          "openai:chatgpt": {
            type: "oauth",
            provider: "openai",
            access: "subscription-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
          "openai:platform": {
            type: "api_key",
            provider: "openai",
            key: "platform-key",
          },
        },
        { openai: ["openai:chatgpt", "openai:platform"] },
      ),
    });

    expect(plan.forwardedAuthProfileId).toBeUndefined();
    expect(plan.forwardedAuthProfileCandidateIds).toBeUndefined();
    expect(plan.selectedAuthMode).toBe("api-key");
    expect(plan.modelRoute).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key",
    });
  });

  it("keeps profile auth ahead of a literal provider apiKey fallback", async () => {
    const config = {
      models: {
        providers: {
          openai: {
            apiKey: "configured-platform-key",
            baseUrl: "",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    const store = authStore(
      {
        "openai:platform-backup": {
          type: "api_key",
          provider: "openai",
          key: "profile-platform-key",
        },
      },
      { openai: ["openai:platform-backup"] },
    );
    const prepared = prepareAgentRuntimeAuth({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-chatgpt-responses",
      modelBaseUrl: "https://chatgpt.com/backend-api/codex",
      config,
      env: {},
      authProfileStore: store,
    });
    const plan = prepared.plan;

    expect(plan.forwardedAuthProfileId).toBe("openai:platform-backup");
    expect(plan.forwardedAuthProfileCandidateIds).toEqual(["openai:platform-backup"]);
    expect(plan.selectedAuthMode).toBe("api_key");
    expect(plan.modelRoute).toMatchObject({
      api: "openai-responses",
      authRequirement: "api-key",
    });
    expect(
      prepared.attempts.map((attempt) => ({
        kind: attempt.kind,
        profileId: attempt.profileId,
        allowAuthProfileFallback: attempt.allowAuthProfileFallback,
        requiresPriorProfileAttempt: attempt.requiresPriorProfileAttempt,
        forwardedAuthProfileId: attempt.plan.forwardedAuthProfileId,
      })),
    ).toEqual([
      {
        kind: "profile",
        profileId: "openai:platform-backup",
        allowAuthProfileFallback: undefined,
        requiresPriorProfileAttempt: undefined,
        forwardedAuthProfileId: "openai:platform-backup",
      },
      {
        kind: "direct",
        profileId: undefined,
        allowAuthProfileFallback: false,
        requiresPriorProfileAttempt: true,
        forwardedAuthProfileId: undefined,
      },
    ]);
    expect(prepared.attempts[1]?.plan).toMatchObject({
      selectedAuthMode: "api-key",
      modelRoute: {
        api: "openai-responses",
        authRequirement: "api-key",
      },
    });

    const model = {
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "openai",
      api: plan.modelRoute?.api ?? "openai-responses",
      baseUrl: plan.modelRoute?.baseUrl ?? "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272_000,
      maxTokens: 128_000,
    } as Model;
    const profileAttempt = prepared.attempts[0];
    const profileResolved = await getApiKeyForModel({
      model,
      cfg: config,
      profileId: profileAttempt?.profileId,
      allowAuthProfileFallback: profileAttempt?.allowAuthProfileFallback,
      store,
    });

    expect(profileResolved).toMatchObject({
      apiKey: "profile-platform-key",
      profileId: "openai:platform-backup",
      source: "profile:openai:platform-backup",
      mode: "api-key",
    });
  });

  it("does not unlock direct fallback when every prepared profile cools down before dispatch", () => {
    const store = authStore(
      {
        "openai:platform": {
          type: "api_key",
          provider: "openai",
          key: "profile-platform-key",
        },
      },
      { openai: ["openai:platform"] },
    );
    const prepared = prepareAgentRuntimeAuth({
      provider: "openai",
      modelId: "gpt-5.5",
      config: {
        models: {
          providers: {
            openai: { apiKey: "configured-platform-key", baseUrl: "", models: [] },
          },
        },
      } as OpenClawConfig,
      env: {},
      authProfileStore: store,
    });
    const profileAttempt = prepared.attempts[0];
    const directAttempt = prepared.attempts[1];
    if (profileAttempt?.kind !== "profile" || directAttempt?.kind !== "direct") {
      throw new Error("expected profile and direct attempts");
    }
    store.usageStats = {
      "openai:platform": { cooldownUntil: Date.now() + 60_000 },
    };

    expect(
      preparedAgentRuntimeProfileAttemptHasCandidate({
        attempt: profileAttempt,
        store,
        modelId: "gpt-5.5",
      }),
    ).toBe(false);
    expect(
      canRunPreparedAgentRuntimeAuthAttempt({
        attempt: directAttempt,
        priorProfileAttempted: false,
      }),
    ).toBe(false);
    expect(
      canRunPreparedAgentRuntimeAuthAttempt({
        attempt: directAttempt,
        priorProfileAttempted: true,
      }),
    ).toBe(true);
  });

  it.each([
    {
      label: "OAuth profile then ambient Platform key",
      env: { OPENAI_API_KEY: "ambient-platform-key" },
      profileId: "openai:chatgpt",
      profile: {
        type: "oauth" as const,
        provider: "openai",
        access: "subscription-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
      requirements: ["subscription", "api-key"],
    },
    {
      label: "Platform profile then ambient OAuth token",
      config: {
        models: { providers: { openai: { auth: "oauth", baseUrl: "", models: [] } } },
      } as OpenClawConfig,
      env: { OPENAI_API_KEY: "ambient-oauth-token" },
      profileId: "openai:platform",
      profile: {
        type: "api_key" as const,
        provider: "openai",
        key: "profile-platform-key",
      },
      requirements: ["api-key", "subscription"],
    },
  ])(
    "prepares $label as distinct physical attempts",
    ({ config, env, profile, profileId, requirements }) => {
      const prepared = prepareAgentRuntimeAuth({
        provider: "openai",
        modelId: "gpt-5.5",
        config,
        env,
        authProfileStore: authStore({ [profileId]: profile }, { openai: [profileId] }),
      });

      expect(prepared.attempts.map((attempt) => attempt.plan.modelRoute?.authRequirement)).toEqual(
        requirements,
      );
      expect(prepared.attempts).toMatchObject([
        { kind: "profile", profileId },
        {
          kind: "direct",
          allowAuthProfileFallback: false,
          requiresPriorProfileAttempt: true,
        },
      ]);
    },
  );

  it("resolves an env SecretRef on its prepared Platform route", async () => {
    vi.stubEnv("OPENAI_PLATFORM_KEY", "secret-ref-platform-key");
    try {
      const config = {
        models: {
          providers: {
            openai: {
              apiKey: { source: "env", provider: "default", id: "OPENAI_PLATFORM_KEY" },
              baseUrl: "",
              models: [],
            },
          },
        },
      } as OpenClawConfig;
      const store = authStore({});
      const prepared = prepareAgentRuntimeAuth({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-chatgpt-responses",
        modelBaseUrl: "https://chatgpt.com/backend-api/codex",
        config,
        env: process.env,
        authProfileStore: store,
      });

      expect(prepared.attempts).toEqual([
        {
          kind: "direct",
          plan: prepared.plan,
          allowAuthProfileFallback: false,
          requiresPriorProfileAttempt: false,
        },
      ]);
      expect(prepared.plan).toMatchObject({
        forwardedAuthProfileId: undefined,
        selectedAuthMode: "api-key",
        modelRoute: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
        },
      });

      const resolved = await getApiKeyForModel({
        model: {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          api: prepared.plan.modelRoute?.api ?? "openai-responses",
          baseUrl: prepared.plan.modelRoute?.baseUrl ?? "https://api.openai.com/v1",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 272_000,
          maxTokens: 128_000,
        } as Model,
        cfg: config,
        profileId: prepared.attempts[0]?.profileId,
        allowAuthProfileFallback: prepared.attempts[0]?.allowAuthProfileFallback,
        store,
      });

      expect(resolved).toMatchObject({
        apiKey: "secret-ref-platform-key",
        source: "env: OPENAI_PLATFORM_KEY (models.json secretref)",
        mode: "api-key",
      });
      expect(resolved.profileId).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps a provider apiKey SecretRef after API-key-compatible profiles", () => {
    const prepared = prepareAgentRuntimeAuth({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-chatgpt-responses",
      modelBaseUrl: "https://chatgpt.com/backend-api/codex",
      config: {
        models: {
          providers: {
            openai: {
              apiKey: { source: "file", provider: "vault", id: "/openai/api-key" },
              baseUrl: "",
              models: [],
            },
          },
        },
        secrets: {
          providers: {
            vault: { source: "file", path: "/tmp/openai-secrets.json", mode: "json" },
          },
        },
      } as OpenClawConfig,
      env: {},
      authProfileStore: authStore(
        {
          "openai:chatgpt": {
            type: "oauth",
            provider: "openai",
            access: "subscription-token",
            refresh: "refresh-token",
            expires: Date.now() + 10 * 60_000,
          },
          "openai:platform": {
            type: "api_key",
            provider: "openai",
            key: "platform-key",
          },
        },
        { openai: ["openai:chatgpt", "openai:platform"] },
      ),
    });

    expect(prepared.plan).toMatchObject({
      forwardedAuthProfileId: "openai:platform",
      selectedAuthMode: "api_key",
      modelRoute: {
        api: "openai-responses",
        authRequirement: "api-key",
      },
    });
    expect(prepared.attempts).toMatchObject([
      { kind: "profile", profileId: "openai:platform" },
      {
        kind: "direct",
        allowAuthProfileFallback: false,
        requiresPriorProfileAttempt: true,
      },
    ]);
  });

  it("uses explicit OAuth mode for literal provider material", () => {
    const prepared = prepareAgentRuntimeAuth({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      config: {
        models: {
          providers: {
            openai: {
              auth: "oauth",
              apiKey: "configured-oauth-token",
              baseUrl: "",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      env: {},
      authProfileStore: authStore({}),
    });

    expect(prepared.plan).toMatchObject({
      selectedAuthMode: "oauth",
      modelRoute: {
        api: "openai-chatgpt-responses",
        authRequirement: "subscription",
      },
    });
    expect(prepared.attempts).toMatchObject([
      {
        kind: "direct",
        allowAuthProfileFallback: false,
        requiresPriorProfileAttempt: false,
      },
    ]);
  });

  it("keeps an API profile ahead of configured OAuth direct material", () => {
    const prepared = prepareAgentRuntimeAuth({
      provider: "openai",
      modelId: "gpt-5.5",
      config: {
        models: {
          providers: {
            openai: {
              auth: "oauth",
              apiKey: "configured-oauth-token",
              baseUrl: "",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      env: {},
      authProfileStore: authStore({
        "openai:platform": {
          type: "api_key",
          provider: "openai",
          key: "profile-platform-key",
        },
      }),
    });

    expect(prepared.attempts.map((attempt) => attempt.plan.modelRoute?.authRequirement)).toEqual([
      "api-key",
      "subscription",
    ]);
    expect(prepared.attempts).toMatchObject([
      { kind: "profile", profileId: "openai:platform" },
      {
        kind: "direct",
        allowAuthProfileFallback: false,
        requiresPriorProfileAttempt: true,
        plan: { selectedAuthMode: "oauth" },
      },
    ]);
  });

  it("preserves explicit provider token auth before auth.order or route defaults", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      config: {
        models: {
          providers: {
            openai: {
              auth: "token",
              apiKey: "configured-subscription-token",
              baseUrl: "",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      env: {},
      authProfileStore: authStore({}),
    });

    expect(plan.forwardedAuthProfileId).toBeUndefined();
    expect(plan.selectedAuthMode).toBe("token");
    expect(plan.modelRoute).toMatchObject({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription",
    });
  });

  it.each([
    {
      auth: "oauth" as const,
      profile: { type: "api_key" as const, provider: "openai", key: "platform-key" },
      requirement: "subscription",
    },
    {
      auth: "api-key" as const,
      profile: {
        type: "oauth" as const,
        provider: "openai",
        access: "oauth-access",
        refresh: "oauth-refresh",
        expires: Date.now() + 60_000,
      },
      requirement: "api-key",
    },
  ])("rejects a $profile.type profile for configured $auth auth", ({ auth, profile }) => {
    expect(() =>
      prepareAgentRuntimeAuth({
        provider: "openai",
        modelId: "gpt-5.5",
        config: {
          models: { providers: { openai: { auth, baseUrl: "", models: [] } } },
        } as OpenClawConfig,
        env: {},
        authProfileStore: authStore({ "openai:wrong-route": profile }),
      }),
    ).toThrow(/no compatible credential source/u);
  });

  it("rejects configured harness-native auth without a compatible host source", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "openai",
        modelId: "gpt-5.5",
        config: {
          models: { providers: { openai: { auth: "oauth", baseUrl: "", models: [] } } },
        } as OpenClawConfig,
        env: {},
        authProfileStore: authStore({}),
        harnessId: "codex",
        harnessRuntime: "codex",
        harnessAuthBootstrap: "harness",
      }),
    ).toThrow(/no compatible credential source/u);
  });

  it("rejects configured provider auth that contradicts an authored route", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        config: {
          models: {
            providers: {
              openai: {
                auth: "oauth",
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        authProfileStore: authStore({}),
      }),
    ).toThrow(/not compatible/u);
  });

  it("preserves an explicit environment endpoint in the selected route", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      env: {
        OPENAI_API_KEY: "platform-key",
        OPENAI_BASE_URL: "https://relay.example.test/v1",
      },
      authProfileStore: authStore({}),
    });

    expect(plan.modelRoute).toEqual({
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://relay.example.test/v1",
      authRequirement: "api-key",
      requestTransportOverrides: "none",
      runtimePolicy: { compatibleIds: ["openclaw"] },
    });
  });

  it("keeps the live codex virtual provider on a generic either-auth plan", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "codex",
      modelId: "gpt-5.4",
      env: {},
      authProfileStore: authStore({
        "openai:account": {
          type: "oauth",
          provider: "openai",
          access: "subscription-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      }),
      sessionAuthProfileId: "openai:account",
      sessionAuthProfileSource: "user",
      harnessId: "codex",
      harnessRuntime: "codex",
    });

    expect(plan).toMatchObject({
      providerForAuth: "codex",
      harnessAuthProvider: "openai",
      forwardedAuthProfileId: "openai:account",
      forwardedAuthProfileSource: "user",
    });
    expect(plan.modelRoute).toBeUndefined();
  });

  it("resolves automatic virtual Codex profiles from the OpenAI auth order", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "codex",
      modelId: "gpt-5.4",
      env: {},
      authProfileStore: authStore(
        {
          "openai:p1": {
            type: "token",
            provider: "openai",
            token: "p1-token",
          },
          "openai:p2": {
            type: "api_key",
            provider: "openai",
            key: "p2-key",
          },
        },
        { openai: ["openai:p1", "openai:p2"] },
      ),
      sessionAuthProfileId: "openai:p1",
      sessionAuthProfileSource: "auto",
      harnessId: "codex",
      harnessRuntime: "codex",
    });

    expect(plan).toMatchObject({
      providerForAuth: "codex",
      harnessAuthProvider: "openai",
      forwardedAuthProfileId: "openai:p1",
      forwardedAuthProfileSource: "auto",
      forwardedAuthProfileCandidateIds: ["openai:p1", "openai:p2"],
      selectedAuthMode: "token",
    });
    expect(plan.modelRoute).toBeUndefined();
  });

  it("rejects a user-locked non-OpenAI profile on the virtual Codex provider", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "codex",
        modelId: "gpt-5.4",
        env: {},
        authProfileStore: authStore({
          "anthropic:work": {
            type: "api_key",
            provider: "anthropic",
            key: "anthropic-key",
          },
        }),
        sessionAuthProfileId: "anthropic:work",
        sessionAuthProfileSource: "user",
        harnessId: "codex",
        harnessRuntime: "codex",
      }),
    ).toThrow(/not configured for openai/u);
  });

  it("rejects unavailable user-locked OpenAI profiles on the virtual Codex provider", () => {
    expect(() =>
      prepareAgentRuntimeAuthPlan({
        provider: "codex",
        modelId: "gpt-5.4",
        env: {},
        config: {
          auth: {
            profiles: {
              "openai:missing": { provider: "openai", mode: "oauth" },
            },
          },
        } as OpenClawConfig,
        authProfileStore: authStore({}),
        sessionAuthProfileId: "openai:missing",
        sessionAuthProfileSource: "user",
        harnessId: "codex",
        harnessRuntime: "codex",
      }),
    ).toThrow(/not configured for openai/u);
  });

  it("does not reuse a routed plan across compaction model overrides", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.5",
      env: { OPENAI_API_KEY: "platform-key" },
      authProfileStore: authStore({}),
    });

    expect(
      agentRuntimeAuthPlanMatchesTarget(plan, { provider: "openai", modelId: "gpt-5.5" }),
    ).toBe(true);
    expect(
      agentRuntimeAuthPlanMatchesTarget(plan, { provider: "openai", modelId: "gpt-5.6" }),
    ).toBe(false);
  });

  it("does not reuse a generic plan across model-scoped auth decisions", () => {
    const plan = prepareAgentRuntimeAuthPlan({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      env: {},
      authProfileStore: authStore({}),
    });

    expect(
      agentRuntimeAuthPlanMatchesTarget(plan, {
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      }),
    ).toBe(true);
    expect(
      agentRuntimeAuthPlanMatchesTarget(plan, {
        provider: "anthropic",
        modelId: "claude-opus-4-6",
      }),
    ).toBe(false);
  });
});
