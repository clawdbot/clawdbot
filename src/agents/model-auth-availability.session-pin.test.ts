import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LEGACY_OAUTH_REF_PROVIDER } from "./auth-profiles/legacy-oauth-ref.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import { dualRoutes, routeResolverFactory } from "./model-auth-availability.test-support.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";

describe.each(["acme", "openai"])("%s session account readiness", (provider) => {
  it.each(["api-key", "oauth"] as const)(
    "requires provider SecretRef %s auth instead of a shared profile",
    (mode) => {
      const config: OpenClawConfig = {
        models: {
          providers: {
            [provider]: {
              baseUrl: "",
              models: [],
              auth: mode,
              apiKey: { source: "env", provider: "default", id: "SYNTHETIC_PROVIDER_KEY" },
            },
          },
        },
      };
      const store: AuthProfileStore = {
        version: 1,
        profiles: { shared: { type: "api_key", provider, key: "synthetic-shared" } },
      };
      const env = { SYNTHETIC_PROVIDER_KEY: "synthetic-ref" };
      const runtime = prepareAgentRuntimeAuth({
        provider,
        modelId: "gpt-5.5",
        config,
        env,
        authProfileStore: store,
      });
      expect(runtime.attempts.map((attempt) => attempt.kind)).toEqual(["direct"]);
      expect(
        createModelAuthAvailabilityResolver({
          cfg: config,
          authStore: store,
          env,
          allowPreparedRuntimeAuth: false,
          routeResolverFactory: routeResolverFactory(provider === "openai" ? dualRoutes : null),
        }).evaluateModelAuth(provider, { modelId: "gpt-5.5" }),
      ).toMatchObject({ availability: true, evidence: "provider-config", selectedAuthMode: mode });
    },
  );

  it.each([
    { personal: false, state: "ready" },
    { personal: true, state: "ready" },
    { personal: false, state: "expired-oauth" },
    { personal: true, state: "refresh-needed" },
    { personal: false, state: "cooldown" },
    { personal: true, state: "cooldown" },
  ])("matches runtime shared failover for $state (personal=$personal)", ({ personal, state }) => {
    const pin = personal ? "personal:owner:account" : `${provider}:selected`;
    const shared = `${provider}:shared`;
    const config: OpenClawConfig = { auth: { order: { [provider]: [shared] } } };
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [pin]: {
          type: "oauth",
          provider,
          access: "synthetic-personal",
          refresh: state === "expired-oauth" ? "" : "synthetic-refresh",
          expires:
            state === "expired-oauth" || state === "refresh-needed" ? 1 : Date.now() + 600_000,
        },
        [shared]: { type: "api_key", provider, key: "synthetic-shared" },
      },
      ...(state === "cooldown"
        ? { usageStats: { [pin]: { cooldownUntil: Date.now() + 600_000 } } }
        : {}),
    };
    const expected = state === "ready" || state === "refresh-needed" ? [pin, shared] : [shared];
    const runtime = prepareAgentRuntimeAuth({
      provider,
      modelId: "gpt-5.5",
      config,
      env: {},
      authProfileStore: store,
      sessionAuthProfileId: pin,
      sessionAuthProfileSource: personal ? "user-link" : "user",
    });
    expect(runtime.attempts.map((attempt) => attempt.profileId)).toEqual(expected);
    const readiness = createModelAuthAvailabilityResolver({
      cfg: config,
      authStore: store,
      env: {},
      allowPreparedRuntimeAuth: false,
      routeResolverFactory: routeResolverFactory(provider === "openai" ? dualRoutes : null),
    }).evaluateModelAuth(provider, {
      modelId: "gpt-5.5",
      preferredProfileId: pin,
      pinnedProfileId: pin,
    });
    expect(readiness).toMatchObject({
      availability: true,
      selectedProfileId: state === "refresh-needed" && provider !== "openai" ? shared : expected[0],
    });
  });

  it.each(["expired-token", "missing", "wrong-provider", "unresolved-oauth"])(
    "rejects an invalid %s pin before considering shared credentials",
    (state) => {
      const pin = `${provider}:selected`;
      const shared = `${provider}:shared`;
      const config: OpenClawConfig = { auth: { order: { [provider]: [shared] } } };
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          ...(state === "missing"
            ? {}
            : {
                [pin]:
                  state === "unresolved-oauth"
                    ? {
                        type: "oauth" as const,
                        provider,
                        access: "",
                        refresh: "",
                        expires: 0,
                        oauthRef: {
                          source: "openclaw-credentials" as const,
                          provider: LEGACY_OAUTH_REF_PROVIDER,
                          id: "00000000000000000000000000000000",
                        },
                      }
                    : {
                        type: "token" as const,
                        provider: state === "wrong-provider" ? "other" : provider,
                        token: "synthetic-invalid",
                        expires: state === "expired-token" ? 1 : Date.now() + 600_000,
                      },
              }),
          [shared]: { type: "api_key", provider, key: "synthetic-shared" },
        },
      };
      expect(() =>
        prepareAgentRuntimeAuth({
          provider,
          modelId: "gpt-5.5",
          config,
          env: {},
          authProfileStore: store,
          sessionAuthProfileId: pin,
          sessionAuthProfileSource: "user",
        }),
      ).toThrow(
        state === "missing"
          ? expect.objectContaining({
              code: "selected_auth_profile_unavailable",
              reason: "auth",
              status: 401,
              provider,
              profileId: pin,
            })
          : "is not configured",
      );
      expect(
        createModelAuthAvailabilityResolver({
          cfg: config,
          authStore: store,
          env: {},
          allowPreparedRuntimeAuth: false,
          routeResolverFactory: routeResolverFactory(provider === "openai" ? dualRoutes : null),
        }).evaluateModelAuth(provider, { modelId: "gpt-5.5", pinnedProfileId: pin }),
      ).toMatchObject({ availability: false, unavailableReason: "auth-failed" });
    },
  );
});

describe("session account pin admission", () => {
  it.each(["absent", "wrong-provider", "wrong-mode", "expired-token"])(
    "validates an AWS SDK declaration with %s stored credentials",
    (state) => {
      const provider = "acme";
      const pin = "acme:sdk";
      const config: OpenClawConfig = {
        auth: {
          profiles: { [pin]: { provider, mode: "aws-sdk" } },
          order: { [provider]: ["acme:shared"] },
        },
        models: { providers: { [provider]: { baseUrl: "", models: [], auth: "aws-sdk" } } },
      };
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          ...(state === "absent"
            ? {}
            : {
                [pin]:
                  state === "wrong-mode"
                    ? { type: "api_key" as const, provider, key: "synthetic-key" }
                    : {
                        type: "token" as const,
                        provider: state === "wrong-provider" ? "other" : provider,
                        token: "synthetic-token",
                        expires: state === "expired-token" ? 1 : Date.now() + 600_000,
                      },
              }),
          "acme:shared": { type: "api_key", provider, key: "synthetic-shared" },
        },
      };
      const prepare = () =>
        prepareAgentRuntimeAuth({
          provider,
          modelId: "synthetic-model",
          config,
          env: {},
          authProfileStore: store,
          sessionAuthProfileId: pin,
          sessionAuthProfileSource: "user",
        });
      if (state === "absent") {
        expect(prepare().attempts[0]?.profileId).toBe(pin);
      } else {
        expect(prepare).toThrow("is not configured");
      }
      expect(
        createModelAuthAvailabilityResolver({
          cfg: config,
          authStore: store,
          env: {},
          allowPreparedRuntimeAuth: false,
          routeResolverFactory: routeResolverFactory(null),
        }).evaluateModelAuth(provider, { modelId: "synthetic-model", pinnedProfileId: pin }),
      ).toMatchObject(
        state === "absent"
          ? { availability: true, selectedProfileId: pin, selectedAuthMode: "aws-sdk" }
          : { availability: false, unavailableReason: "auth-failed" },
      );
    },
  );

  it("admits a pinned OAuth reference from its prepared runtime credential", () => {
    const provider = "acme";
    const pin = "acme:hydrated";
    const config: OpenClawConfig = {};
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [pin]: {
          type: "oauth",
          provider,
          access: "",
          refresh: "",
          expires: 0,
          oauthRef: {
            source: "openclaw-credentials",
            provider: LEGACY_OAUTH_REF_PROVIDER,
            id: "00000000000000000000000000000000",
          },
        },
      },
    };
    const runtimeStore: AuthProfileStore = {
      version: 1,
      profiles: {
        [pin]: {
          type: "oauth",
          provider,
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: Date.now() + 600_000,
        },
      },
    };
    expect(
      prepareAgentRuntimeAuth({
        provider,
        modelId: "synthetic-model",
        config,
        env: {},
        authProfileStore: runtimeStore,
        sessionAuthProfileId: pin,
        sessionAuthProfileSource: "user",
      }).attempts.map((attempt) => attempt.profileId),
    ).toEqual([pin]);
    expect(
      createModelAuthAvailabilityResolver({
        cfg: config,
        authStore: store,
        preparedRuntimeAuthStore: runtimeStore,
        env: {},
        routeResolverFactory: routeResolverFactory(null),
      }).evaluateModelAuth(provider, { modelId: "synthetic-model", pinnedProfileId: pin }),
    ).toMatchObject({ availability: true, selectedProfileId: pin });
  });
});
