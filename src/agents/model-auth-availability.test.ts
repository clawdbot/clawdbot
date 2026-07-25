import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ProviderModelRouteCandidate,
  ProviderModelRouteResolution,
} from "../plugin-sdk/provider-model-types.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityRef,
} from "./model-auth-availability.js";
import type { createOpenAIModelRoutesResolver } from "./openai-model-routes.js";

const platformRoute = {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key",
  requestTransportOverrides: "none",
  runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
} satisfies ProviderModelRouteCandidate;

const subscriptionRoute = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authRequirement: "subscription",
  requestTransportOverrides: "none",
  runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
} satisfies ProviderModelRouteCandidate;

const dualRoutes = {
  kind: "routes",
  defaultRuntimeId: "codex",
  routes: [platformRoute, subscriptionRoute],
} satisfies ProviderModelRouteResolution;

function routeResolverFactory(resolution: ProviderModelRouteResolution | null) {
  return (() => () => resolution) as typeof createOpenAIModelRoutesResolver;
}

function authStore(
  profiles: Record<string, unknown> = {},
  order?: AuthProfileStore["order"],
): AuthProfileStore {
  return {
    version: 1,
    profiles: profiles as AuthProfileStore["profiles"],
    ...(order ? { order } : {}),
  };
}

function evaluate(params: {
  cfg?: OpenClawConfig | Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  ref?: ModelAuthAvailabilityRef;
  resolution?: ProviderModelRouteResolution | null;
  store?: AuthProfileStore;
  syntheticAuthProviderRefs?: readonly string[];
}) {
  return createModelAuthAvailabilityResolver({
    cfg: (params.cfg ?? {}) as OpenClawConfig,
    authStore: params.store ?? authStore(),
    env: params.env ?? {},
    routeResolverFactory: routeResolverFactory(params.resolution ?? dualRoutes),
    syntheticAuthProviderRefs: params.syntheticAuthProviderRefs,
  }).evaluateModelAuth("openai", params.ref);
}

describe("createModelAuthAvailabilityResolver", () => {
  it.each([
    {
      label: "Platform API key",
      profileId: "openai:platform",
      profile: {
        type: "api_key" as const,
        provider: "openai",
        key: "platform-key",
      },
      selectedRoute: platformRoute,
      selectedAuthMode: "api_key",
    },
    {
      label: "ChatGPT OAuth",
      profileId: "openai:chatgpt",
      profile: {
        type: "oauth" as const,
        provider: "openai",
        access: "oauth-access",
        refresh: "oauth-refresh",
        expires: Date.now() + 60_000,
      },
      selectedRoute: subscriptionRoute,
      selectedAuthMode: "oauth",
    },
  ])("selects a ready $label route", ({ profileId, profile, selectedAuthMode, selectedRoute }) => {
    expect(evaluate({ store: authStore({ [profileId]: profile }) })).toMatchObject({
      availability: true,
      evidence: "profile",
      selectedAuthMode,
      selectedProfileId: profileId,
      selectedRoute,
    });
  });

  it("keeps a selected profile with missing credential material unavailable", () => {
    expect(
      evaluate({
        store: authStore({
          "openai:missing": { type: "api_key", provider: "openai", key: "" },
        }),
      }),
    ).toMatchObject({
      availability: false,
      evidence: "profile",
      selectedProfileId: "openai:missing",
      selectedRoute: platformRoute,
    });
  });

  it("preserves the known physical route when an automatic tier is all cooldown", () => {
    const store = authStore({
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: "oauth-access",
        refresh: "oauth-refresh",
        expires: Date.now() + 60_000,
      },
    });
    store.usageStats = {
      "openai:chatgpt": { cooldownUntil: Date.now() + 60_000 },
    };

    expect(evaluate({ store })).toMatchObject({
      availability: false,
      evidence: "profile",
      selectedAuthMode: "oauth",
      selectedProfileId: "openai:chatgpt",
      selectedRoute: subscriptionRoute,
    });
  });

  it.each([
    {
      label: "incompatible",
      resolution: {
        kind: "incompatible" as const,
        code: "platform-only-model-on-chatgpt",
        message: "Platform-only model",
      },
      availability: false,
    },
    {
      label: "indeterminate",
      resolution: { kind: "indeterminate" as const, defaultRuntimeId: "codex" },
      availability: undefined,
    },
  ])("preserves an $label provider route decision", ({ availability, resolution }) => {
    expect(evaluate({ resolution })).toEqual({ availability, routeResolution: resolution });
  });

  it("projects route-independent auth-order failures for indeterminate routes", () => {
    const resolution = { kind: "indeterminate" as const, defaultRuntimeId: "codex" };
    const cooldownStore = authStore({
      "openai:cooldown": {
        type: "api_key",
        provider: "openai",
        key: "platform-key",
      },
    });
    cooldownStore.usageStats = {
      "openai:cooldown": { cooldownUntil: Date.now() + 60_000 },
    };

    expect(evaluate({ resolution, store: cooldownStore })).toMatchObject({
      availability: false,
      evidence: "profile",
      selectedProfileId: "openai:cooldown",
    });
    expect(
      evaluate({
        cfg: { auth: { order: { openai: [] } } },
        resolution,
      }),
    ).toMatchObject({ availability: false, evidence: "profile" });
  });

  it("does not let ChatGPT OAuth satisfy a custom API-key endpoint", () => {
    const customRoute = {
      ...platformRoute,
      baseUrl: "https://openai-compatible.example/v1",
    } satisfies ProviderModelRouteCandidate;
    const result = evaluate({
      resolution: { kind: "routes", defaultRuntimeId: "openclaw", routes: [customRoute] },
      store: authStore({
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      }),
    });

    expect(result).toMatchObject({ availability: false, selectedRoute: customRoute });
    expect(result.selectedProfileId).toBeUndefined();
  });

  it.each([
    {
      auth: "oauth" as const,
      profile: { type: "api_key" as const, provider: "openai", key: "platform-key" },
      route: subscriptionRoute,
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
      route: platformRoute,
    },
  ])(
    "does not pair a $profile.type profile with configured $auth auth",
    ({ auth, profile, route }) => {
      const result = evaluate({
        cfg: {
          models: { providers: { openai: { auth, baseUrl: "", models: [] } } },
        } as OpenClawConfig,
        store: authStore({ "openai:wrong-route": profile }),
      });

      expect(result).toMatchObject({ availability: false, selectedRoute: route });
      expect(result.selectedProfileId).toBeUndefined();
    },
  );

  it("uses explicit direct provider auth ahead of automatic profiles", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            auth: "api-key",
            apiKey: "configured-platform-key",
            baseUrl: platformRoute.baseUrl,
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      evaluate({
        cfg,
        store: authStore({
          "openai:chatgpt": {
            type: "oauth",
            provider: "openai",
            access: "oauth-access",
            refresh: "oauth-refresh",
            expires: Date.now() + 60_000,
          },
        }),
      }),
    ).toMatchObject({
      availability: true,
      evidence: "provider-config",
      selectedAuthMode: "api-key",
      selectedRoute: platformRoute,
    });
  });

  it.each([
    { provider: "anthropic", mode: "api_key" as const },
    { provider: "openai", mode: "oauth" as const },
  ])("rejects a bound profile with conflicting $provider/$mode metadata", ({ mode, provider }) => {
    expect(
      evaluate({
        cfg: {
          auth: {
            profiles: {
              "openai:bound": { provider, mode },
            },
          },
          models: {
            providers: {
              openai: { apiKey: "openai:bound", baseUrl: "", models: [] },
            },
          },
        } as OpenClawConfig,
        store: authStore({
          "openai:bound": {
            type: "api_key",
            provider: "openai",
            key: "bound-platform-key",
          },
        }),
      }),
    ).toMatchObject({
      availability: false,
      evidence: "profile",
      selectedAuthMode: "api_key",
      selectedProfileId: "openai:bound",
      selectedRoute: platformRoute,
    });
  });

  it("keeps an automatic Platform profile ahead of a non-explicit literal fallback", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            apiKey: "configured-platform-key",
            baseUrl: platformRoute.baseUrl,
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      evaluate({
        cfg,
        store: authStore({
          "openai:platform": {
            type: "api_key",
            provider: "openai",
            key: "profile-key",
          },
        }),
      }),
    ).toMatchObject({
      availability: true,
      evidence: "profile",
      selectedProfileId: "openai:platform",
      selectedRoute: platformRoute,
    });
  });

  it("uses explicit OAuth mode for literal provider material", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            auth: "oauth",
            apiKey: "configured-oauth-token",
            models: [],
          },
        },
      },
    };

    expect(evaluate({ cfg })).toMatchObject({
      availability: true,
      evidence: "provider-config",
      selectedAuthMode: "oauth",
      selectedRoute: subscriptionRoute,
    });
  });

  it("uses configured OAuth direct material after an unavailable API profile", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            auth: "oauth",
            apiKey: "configured-oauth-token",
            models: [],
          },
        },
      },
    };

    expect(
      evaluate({
        cfg,
        store: authStore({
          "openai:platform-missing": {
            type: "api_key",
            provider: "openai",
            key: "",
          },
        }),
      }),
    ).toMatchObject({
      availability: true,
      evidence: "provider-config",
      selectedAuthMode: "oauth",
      selectedRoute: subscriptionRoute,
    });
  });

  it("treats preferred and locked profiles as distinct source-order facts", () => {
    const store = authStore(
      {
        "openai:platform": { type: "api_key", provider: "openai", key: "platform-key" },
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      },
      { openai: ["openai:platform", "openai:chatgpt"] },
    );

    expect(evaluate({ store, ref: { preferredProfileId: "openai:chatgpt" } })).toMatchObject({
      selectedProfileId: "openai:chatgpt",
      selectedRoute: subscriptionRoute,
    });
    expect(
      evaluate({
        store,
        ref: {
          preferredProfileId: "openai:chatgpt",
          lockedProfileId: "openai:platform",
        },
      }),
    ).toMatchObject({
      selectedProfileId: "openai:platform",
      selectedRoute: platformRoute,
    });
  });

  it("falls through an unavailable preferred profile to the configured order", () => {
    const store = authStore({
      "openai:platform": { type: "api_key", provider: "openai", key: "platform-key" },
      "openai:expired": {
        type: "oauth",
        provider: "openai",
        access: "expired-access",
        expires: Date.now() - 60_000,
      },
    });

    expect(
      evaluate({
        cfg: { auth: { order: { openai: ["openai:platform", "openai:expired"] } } },
        store,
        ref: { preferredProfileId: "openai:expired" },
      }),
    ).toMatchObject({
      availability: true,
      selectedProfileId: "openai:platform",
      selectedRoute: platformRoute,
    });
  });

  it("classifies direct environment auth as Platform API-key evidence", () => {
    expect(evaluate({ env: { OPENAI_API_KEY: "environment-key" } })).toMatchObject({
      availability: true,
      evidence: "environment",
      selectedAuthMode: "api-key",
      selectedRoute: platformRoute,
    });
  });

  it("keeps ambient environment auth ahead of non-explicit provider material", () => {
    expect(
      evaluate({
        cfg: {
          models: {
            providers: {
              openai: { apiKey: "configured-platform-key", baseUrl: "", models: [] },
            },
          },
        } as OpenClawConfig,
        env: { OPENAI_API_KEY: "environment-key" },
      }),
    ).toMatchObject({
      availability: true,
      evidence: "environment",
      selectedAuthMode: "api-key",
      selectedRoute: platformRoute,
    });
  });

  it.each([
    {
      label: "Platform environment after unavailable OAuth",
      env: { OPENAI_API_KEY: "environment-key" },
      profileId: "openai:oauth-missing",
      profile: { type: "oauth" as const, provider: "openai", access: "", refresh: "" },
      route: platformRoute,
      mode: "api-key",
    },
    {
      label: "OAuth environment after unavailable Platform auth",
      cfg: {
        models: { providers: { openai: { auth: "oauth", baseUrl: "", models: [] } } },
      } as OpenClawConfig,
      env: { OPENAI_API_KEY: "environment-token" },
      profileId: "openai:platform-missing",
      profile: { type: "api_key" as const, provider: "openai", key: "" },
      route: subscriptionRoute,
      mode: "oauth",
    },
  ])("selects $label", ({ cfg, env, mode, profile, profileId, route }) => {
    expect(evaluate({ cfg, env, store: authStore({ [profileId]: profile }) })).toMatchObject({
      availability: true,
      evidence: "environment",
      selectedAuthMode: mode,
      selectedRoute: route,
    });
  });

  it.each([
    { env: { OPENAI_API_KEY: "resolved-key" }, availability: true },
    { env: {}, availability: undefined },
  ])("reports a SecretRef profile as $availability", ({ availability, env }) => {
    expect(
      evaluate({
        env,
        store: authStore({
          "openai:ref": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        }),
      }),
    ).toMatchObject({
      availability,
      evidence: "profile",
      selectedProfileId: "openai:ref",
      selectedRoute: platformRoute,
    });
  });

  it("keeps a ref-only OAuth profile indeterminate until runtime hydration", () => {
    expect(
      evaluate({
        store: authStore({
          "openai:legacy-ref": {
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
        }),
      }),
    ).toMatchObject({
      availability: undefined,
      evidence: "profile",
      selectedAuthMode: "oauth",
      selectedProfileId: "openai:legacy-ref",
      selectedRoute: subscriptionRoute,
    });
  });

  it("does not borrow usable auth from a later sibling route after an unresolved ordered profile", () => {
    const result = evaluate({
      cfg: { auth: { order: { openai: ["openai:unknown", "openai:chatgpt"] } } },
      store: authStore({
        "openai:unknown": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "MISSING_OPENAI_KEY" },
        },
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      }),
    });

    expect(result).toMatchObject({
      availability: undefined,
      evidence: "profile",
      selectedProfileId: "openai:unknown",
      selectedRoute: platformRoute,
    });
  });

  it("skips a definitively invalid profile before selecting a usable sibling route", () => {
    expect(
      evaluate({
        cfg: { auth: { order: { openai: ["openai:invalid", "openai:chatgpt"] } } },
        store: authStore({
          "openai:invalid": { type: "api_key", provider: "openai", key: "" },
          "openai:chatgpt": {
            type: "oauth",
            provider: "openai",
            access: "oauth-access",
            refresh: "oauth-refresh",
            expires: Date.now() + 60_000,
          },
        }),
      }),
    ).toMatchObject({
      availability: true,
      selectedProfileId: "openai:chatgpt",
      selectedRoute: subscriptionRoute,
    });
  });

  it("passes one physical route group to auth selection for an unknown model", () => {
    const resolveRoutes = vi.fn(() => dualRoutes);
    const resolver = createModelAuthAvailabilityResolver({
      cfg: { auth: { order: { openai: ["openai:chatgpt", "openai:platform"] } } },
      authStore: authStore({
        "openai:platform": { type: "api_key", provider: "openai", key: "platform-key" },
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      }),
      env: {},
      routeResolverFactory: (() => resolveRoutes) as typeof createOpenAIModelRoutesResolver,
    });
    const observedRoutes = [
      { api: "openai-chatgpt-responses" as const, baseUrl: subscriptionRoute.baseUrl },
      { api: "openai-responses" as const, baseUrl: platformRoute.baseUrl },
    ];

    expect(
      resolver.evaluateModelAuth("openai", {
        modelId: "gpt-future-observed",
        observedRoutes,
      }),
    ).toMatchObject({
      availability: true,
      selectedProfileId: "openai:chatgpt",
      selectedRoute: subscriptionRoute,
    });
    expect(resolveRoutes).toHaveBeenCalledOnce();
    expect(resolveRoutes).toHaveBeenCalledWith({
      modelId: "gpt-future-observed",
      observedRoutes,
    });
  });

  it("keeps Codex synthetic auth indeterminate until the native account is read", () => {
    const result = evaluate({ syntheticAuthProviderRefs: ["codex"] });
    expect(result).toMatchObject({
      availability: undefined,
      evidence: "synthetic",
      routeResolution: dualRoutes,
    });
    expect(result).not.toHaveProperty("selectedAuthMode");
    expect(result).not.toHaveProperty("selectedRoute");
  });

  it("does not let invalid automatic profile evidence block synthetic Codex ownership", () => {
    expect(
      evaluate({
        store: authStore({
          "openai:invalid": { type: "api_key", provider: "openai", key: "" },
        }),
        syntheticAuthProviderRefs: ["codex"],
      }),
    ).toMatchObject({
      availability: undefined,
      evidence: "synthetic",
      routeResolution: dualRoutes,
    });
  });

  it("does not let Codex synthetic auth own an OpenClaw-only route", () => {
    const openClawOnlyRoute = {
      ...platformRoute,
      runtimePolicy: { compatibleIds: ["openclaw"] },
    } satisfies ProviderModelRouteCandidate;
    expect(
      evaluate({
        resolution: {
          kind: "routes",
          defaultRuntimeId: "openclaw",
          routes: [openClawOnlyRoute],
        },
        syntheticAuthProviderRefs: ["codex"],
      }),
    ).toMatchObject({
      availability: false,
      selectedRoute: openClawOnlyRoute,
    });
  });

  it.each([
    {
      label: "explicit",
      cfg: {
        models: {
          providers: {
            "amazon-bedrock": {
              api: "bedrock-converse-stream",
              auth: "aws-sdk",
              baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
    },
    { label: "implicit", cfg: {} },
  ])("keeps an $label Bedrock AWS SDK route ready", ({ cfg }) => {
    const result = createModelAuthAvailabilityResolver({
      cfg,
      authStore: authStore(),
      env: {},
    }).evaluateModelAuth("amazon-bedrock", { api: "bedrock-converse-stream" });

    expect(result).toMatchObject({
      availability: true,
      evidence: "aws-sdk",
      routeResolution: null,
      selectedAuthMode: "aws-sdk",
    });
  });

  it("keeps a non-OpenAI provider SecretRef unresolved without reading it", () => {
    const result = createModelAuthAvailabilityResolver({
      cfg: {
        models: {
          providers: {
            anthropic: {
              api: "anthropic-messages",
              apiKey: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
              baseUrl: "https://api.anthropic.com",
              models: [],
            },
          },
        },
        secrets: { providers: { default: { source: "env" } } },
      },
      authStore: authStore(),
      env: {},
    }).evaluateModelAuth("anthropic", {
      modelId: "claude-sonnet-4-6",
      api: "anthropic-messages",
    });

    expect(result).toMatchObject({
      availability: undefined,
      evidence: "provider-config",
      routeResolution: null,
      selectedAuthMode: "api-key",
    });
  });
});
