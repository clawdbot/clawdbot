import { describe, expect, it } from "vitest";
import {
  buildProviderModelAuthSourcePlan,
  type ProviderModelAuthDirectSource,
  type ProviderModelAuthProfileSource,
} from "./provider-model-auth-source-plan.js";
import {
  resolveProviderModelRouteMaterializationAuthMode,
  selectProviderModelRouteAuth,
} from "./provider-model-route-auth.js";

const routes = {
  kind: "routes",
  routes: [
    {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key",
      requestTransportOverrides: "none",
      runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
    },
    {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription",
      requestTransportOverrides: "none",
      runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
    },
  ],
} as const;

function profile(
  profileId: string,
  mode: string,
  readiness: ProviderModelAuthProfileSource["readiness"],
  cooldown: ProviderModelAuthProfileSource["cooldown"] = "clear",
): ProviderModelAuthProfileSource {
  return { kind: "profile", profileId, mode, readiness, cooldown };
}

function direct(mode: string): ProviderModelAuthDirectSource {
  return {
    kind: "direct",
    mode,
    readiness: "ready",
    evidence: "provider-config",
  };
}

describe("provider model route auth", () => {
  it.each([
    ["api-key", "api-key", "api_key"],
    ["api_key", "api-key", "api_key"],
    ["aws-sdk", "api-key", "aws-sdk"],
    ["oauth", "subscription", "oauth"],
    ["token", "subscription", "token"],
    [undefined, "api-key", "api_key"],
    [undefined, "subscription", "oauth"],
  ] as const)("materializes %s for a %s route as %s", (mode, requirement, expected) => {
    expect(resolveProviderModelRouteMaterializationAuthMode({ mode, requirement })).toBe(expected);
  });

  it.each([
    {
      label: "pins an unknown source before a ready sibling route",
      profiles: [
        profile("openai:unknown", "oauth", "unknown"),
        profile("openai:platform", "api_key", "ready"),
      ],
      expectedProfileId: "openai:unknown",
      expectedRoute: "subscription",
      expectedAttempts: ["openai:unknown", "openai:platform"],
    },
    {
      label: "keeps the first ordered source when a later same-route source is ready",
      profiles: [
        profile("openai:unknown", "oauth", "unknown"),
        profile("openai:platform", "api_key", "ready"),
        profile("openai:subscription", "token", "ready"),
      ],
      expectedProfileId: "openai:unknown",
      expectedRoute: "subscription",
      expectedAttempts: ["openai:unknown", "openai:subscription", "openai:platform"],
    },
    {
      label: "drops a proven-unavailable source before route selection",
      profiles: [
        profile("openai:invalid", "api_key", "unavailable"),
        profile("openai:subscription", "oauth", "ready"),
      ],
      expectedProfileId: "openai:subscription",
      expectedRoute: "subscription",
      expectedAttempts: ["openai:subscription"],
    },
  ])("$label", ({ expectedAttempts, expectedProfileId, expectedRoute, profiles }) => {
    const decision = selectProviderModelRouteAuth({
      provider: "openai",
      resolution: routes,
      sourcePlan: buildProviderModelAuthSourcePlan({ profiles }),
    });
    expect(decision).toMatchObject({
      kind: "selected",
      selection: {
        kind: "selected",
        source: { kind: "profile", profileId: expectedProfileId },
        route: { authRequirement: expectedRoute },
      },
    });
    if (decision.kind !== "selected") {
      throw new Error("expected selected route");
    }
    expect(
      decision.attempts.map((attempt) =>
        attempt.kind === "profile" ? attempt.source.profileId : "direct",
      ),
    ).toEqual(expectedAttempts);
  });

  it("keeps profile and direct fallback attempts distinct on one route", () => {
    const decision = selectProviderModelRouteAuth({
      provider: "openai",
      resolution: routes,
      configuredAuthMode: "api-key",
      sourcePlan: buildProviderModelAuthSourcePlan({
        profiles: [profile("openai:platform", "api_key", "unknown")],
        fallback: direct("api-key"),
      }),
    });
    expect(decision).toMatchObject({
      kind: "selected",
      attempts: [
        {
          kind: "profile",
          source: { profileId: "openai:platform" },
          sameRouteProfileIds: ["openai:platform"],
        },
        { kind: "direct", allowAuthProfileFallback: false },
      ],
    });
  });

  it("omits an incompatible direct fallback when a compatible profile exists", () => {
    const decision = selectProviderModelRouteAuth({
      provider: "openai",
      resolution: { ...routes, routes: [routes.routes[1]] },
      sourcePlan: buildProviderModelAuthSourcePlan({
        profiles: [profile("openai:chatgpt", "oauth", "ready")],
        fallback: direct("api-key"),
      }),
    });

    expect(decision).toMatchObject({
      kind: "selected",
      selection: {
        source: { kind: "profile", profileId: "openai:chatgpt" },
        route: { authRequirement: "subscription" },
      },
    });
    if (decision.kind !== "selected") {
      throw new Error("expected selected route");
    }
    expect(decision.attempts).toEqual([
      expect.objectContaining({
        kind: "profile",
        source: expect.objectContaining({ profileId: "openai:chatgpt" }),
      }),
    ]);
  });

  it("does not attach a direct API key to a configured subscription route", () => {
    const decision = selectProviderModelRouteAuth({
      provider: "openai",
      resolution: routes,
      configuredAuthMode: "oauth",
      sourcePlan: buildProviderModelAuthSourcePlan({
        profiles: [profile("openai:chatgpt", "oauth", "ready")],
        fallback: direct("api-key"),
      }),
    });

    expect(decision).toMatchObject({
      kind: "selected",
      selection: { route: { authRequirement: "subscription" } },
    });
    if (decision.kind !== "selected") {
      throw new Error("expected selected route");
    }
    expect(decision.attempts).toHaveLength(1);
    expect(decision.attempts[0]).toMatchObject({ kind: "profile" });
  });

  it("fails an all-cooldown tier closed before direct fallback", () => {
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: routes,
        sourcePlan: buildProviderModelAuthSourcePlan({
          profiles: [profile("openai:cooldown", "api_key", "ready", "active")],
          fallback: direct("api-key"),
        }),
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: "all-cooldown",
      source: { profileId: "openai:cooldown" },
    });
  });

  it.each([undefined, "api-key"] as const)(
    "does not let a clear wrong-route profile hide a cooldown compatible tier (%s)",
    (configuredAuthMode) => {
      expect(
        selectProviderModelRouteAuth({
          provider: "openai",
          resolution: { ...routes, routes: [routes.routes[0]] },
          configuredAuthMode,
          sourcePlan: buildProviderModelAuthSourcePlan({
            profiles: [
              profile("openai:chatgpt", "oauth", "ready"),
              profile("openai:platform", "api_key", "ready", "active"),
            ],
            fallback: direct("api-key"),
          }),
        }),
      ).toMatchObject({
        kind: "rejected",
        reason: "all-cooldown",
        source: { profileId: "openai:platform" },
      });
    },
  );

  it.each([
    { label: "empty", profiles: [] },
    {
      label: "all unavailable",
      profiles: [profile("openai:invalid", "api_key", "unavailable")],
    },
  ])("rejects an $label explicit order before direct fallback", ({ profiles }) => {
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: routes,
        sourcePlan: buildProviderModelAuthSourcePlan({
          profiles,
          explicitOrder: true,
          fallback: direct("api-key"),
        }),
      }),
    ).toMatchObject({ kind: "rejected", reason: "explicit-order" });
  });

  it("keeps a required profile authoritative over configured auth", () => {
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: routes,
        configuredAuthMode: "api-key",
        sourcePlan: buildProviderModelAuthSourcePlan({
          ownership: {
            reason: "provider-binding",
            source: profile("openai:bound", "token", "unknown"),
          },
          profiles: [],
        }),
      }),
    ).toMatchObject({
      kind: "selected",
      selection: {
        source: { profileId: "openai:bound" },
        route: { authRequirement: "subscription" },
      },
    });
  });

  it.each([
    { configuredAuthMode: "oauth", profileMode: "api_key", route: "subscription" },
    { configuredAuthMode: "api-key", profileMode: "oauth", route: "api-key" },
  ])(
    "rejects a $profileMode profile for a configured $configuredAuthMode route",
    ({ configuredAuthMode, profileMode, route }) => {
      expect(
        selectProviderModelRouteAuth({
          provider: "openai",
          resolution: routes,
          configuredAuthMode,
          sourcePlan: buildProviderModelAuthSourcePlan({
            profiles: [profile("openai:wrong-route", profileMode, "ready")],
          }),
        }),
      ).toMatchObject({
        kind: "rejected",
        reason: "configured-auth",
        source: { profileId: "openai:wrong-route" },
        route: { authRequirement: route },
      });
    },
  );

  it("rejects configured auth without a validated harness credential mode", () => {
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: routes,
        configuredAuthMode: "oauth",
        runtimeAuthOwner: { id: "codex" },
        sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [] }),
      }),
    ).toMatchObject({
      kind: "rejected",
      reason: "configured-auth",
      route: { authRequirement: "subscription" },
    });
  });

  it("defers an ambiguous no-profile route to an explicit harness auth owner", () => {
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: routes,
        runtimeAuthOwner: { id: "codex" },
        sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [] }),
      }),
    ).toEqual({
      kind: "deferred",
      reason: "runtime-auth-owner",
      routeSupport: {
        requestTransportOverrides: "none",
        runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
      },
    });
  });

  it.each([
    ["Platform", routes.routes[0], profile("openai:chatgpt", "oauth", "ready")],
    ["subscription", routes.routes[1], profile("openai:platform", "api_key", "ready")],
  ] as const)(
    "does not defer a concrete %s route to unvalidated native auth",
    (_label, route, source) => {
      expect(
        selectProviderModelRouteAuth({
          provider: "openai",
          resolution: { ...routes, routes: [route] },
          runtimeAuthOwner: { id: "codex" },
          sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [source] }),
        }),
      ).toMatchObject({
        kind: "rejected",
        reason: "configured-auth",
        source: { profileId: source.profileId },
      });
    },
  );

  it("rejects a runtime owner that cannot reproduce every candidate route", () => {
    const incompatibleRoutes = {
      ...routes,
      routes: [
        routes.routes[0],
        { ...routes.routes[1], runtimePolicy: { compatibleIds: ["openclaw"] } },
      ],
    } as const;
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: incompatibleRoutes,
        runtimeAuthOwner: { id: "codex" },
        sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [] }),
      }),
    ).toMatchObject({ kind: "rejected", reason: "configured-auth" });
  });

  it("fails closed when any deferred route omits runtime compatibility", () => {
    const undeclaredRoutes = {
      ...routes,
      routes: [routes.routes[0], { ...routes.routes[1], runtimePolicy: undefined }],
    } as const;
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: undeclaredRoutes,
        runtimeAuthOwner: { id: "codex" },
        sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [] }),
      }),
    ).toMatchObject({ kind: "rejected", reason: "configured-auth" });
  });

  it("aggregates request overrides across every deferred route", () => {
    const overrideRoutes = {
      ...routes,
      routes: [routes.routes[0], { ...routes.routes[1], requestTransportOverrides: "present" }],
    } as const;
    expect(
      selectProviderModelRouteAuth({
        provider: "openai",
        resolution: overrideRoutes,
        runtimeAuthOwner: { id: "openclaw" },
        sourcePlan: buildProviderModelAuthSourcePlan({ profiles: [] }),
      }),
    ).toMatchObject({
      kind: "deferred",
      routeSupport: {
        requestTransportOverrides: "present",
        runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
      },
    });
  });
});
