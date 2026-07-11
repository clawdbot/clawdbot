import type {
  ProviderModelRouteAuthRequirement,
  ProviderModelRouteCandidate,
  ProviderModelRouteResolution,
  ProviderModelRouteRuntimePolicy,
  ProviderRouteOverridePresence,
} from "../plugin-sdk/provider-model-types.js";
import type {
  ProviderModelAuthDirectSource,
  ProviderModelAuthProfileSource,
  ProviderModelAuthSource,
  ProviderModelAuthSourcePlan,
} from "./provider-model-auth-source-plan.js";
import { buildProviderModelAuthSourcePlan } from "./provider-model-auth-source-plan.js";

export type ProviderModelAuthSourceSelection =
  | { kind: "selected"; source: ProviderModelAuthSource }
  | { kind: "unavailable"; source: ProviderModelAuthProfileSource }
  | { kind: "none" };

export type ProviderModelAuthLogicalAttempt =
  | { kind: "profile"; source: ProviderModelAuthProfileSource }
  | {
      kind: "direct";
      source: ProviderModelAuthDirectSource;
      allowAuthProfileFallback: false;
    };

export type ProviderModelRouteAuthAttempt =
  | {
      kind: "profile";
      source: ProviderModelAuthProfileSource;
      route: ProviderModelRouteCandidate;
      /** Remaining exact-route candidates for this physical attempt. */
      sameRouteProfileIds: readonly string[];
    }
  | {
      kind: "direct";
      source: ProviderModelAuthDirectSource;
      route: ProviderModelRouteCandidate;
      allowAuthProfileFallback: false;
    };

export type ProviderModelAuthSourceDecision =
  | {
      kind: "selected";
      selection: ProviderModelAuthSourceSelection;
      attempts: readonly ProviderModelAuthLogicalAttempt[];
    }
  | {
      kind: "rejected";
      reason: "all-cooldown" | "explicit-order";
      message: string;
      source?: ProviderModelAuthProfileSource;
    };

type ProviderModelRouteAuthDecision =
  | {
      kind: "selected";
      selection: ProviderModelAuthSourceSelection & { route: ProviderModelRouteCandidate };
      attempts: readonly ProviderModelRouteAuthAttempt[];
    }
  | {
      kind: "deferred";
      reason: "runtime-auth-owner";
      routeSupport: {
        requestTransportOverrides: ProviderRouteOverridePresence;
        runtimePolicy: ProviderModelRouteRuntimePolicy;
      };
    }
  | {
      kind: "rejected";
      reason: "all-cooldown" | "configured-auth" | "explicit-order" | "required-profile";
      message: string;
      source?: ProviderModelAuthProfileSource;
      route?: ProviderModelRouteCandidate;
    };

export type ProviderModelRouteMaterializationAuthMode = "api_key" | "aws-sdk" | "oauth" | "token";

/** Normalizes stored/runtime auth syntax for profile-scoped model lookup. */
export function resolveProviderModelMaterializationAuthMode(
  mode: string | undefined,
): ProviderModelRouteMaterializationAuthMode | undefined {
  switch (mode) {
    case "api-key":
    case "api_key":
      return "api_key";
    case "aws-sdk":
    case "oauth":
    case "token":
      return mode;
    default:
      return undefined;
  }
}

/** Maps runtime/stored credential modes onto the provider route contract. */
export function resolveProviderModelRouteAuthRequirement(
  mode: string | undefined,
): ProviderModelRouteAuthRequirement | undefined {
  switch (mode) {
    case "api-key":
    case "api_key":
    case "aws-sdk":
      return "api-key";
    case "oauth":
    case "token":
      return "subscription";
    default:
      return undefined;
  }
}

export function providerModelRouteAcceptsAuthMode(params: {
  requirement: ProviderModelRouteAuthRequirement;
  mode: string | undefined;
}): boolean {
  return resolveProviderModelRouteAuthRequirement(params.mode) === params.requirement;
}

/** Preserves an exact credential mode while normalizing authored api-key syntax. */
export function resolveProviderModelRouteMaterializationAuthMode(params: {
  mode?: string;
  requirement: ProviderModelRouteAuthRequirement;
}): ProviderModelRouteMaterializationAuthMode {
  return (
    resolveProviderModelMaterializationAuthMode(params.mode) ??
    (params.requirement === "api-key" ? "api_key" : "oauth")
  );
}

function directAttempt(source: ProviderModelAuthDirectSource): ProviderModelAuthLogicalAttempt {
  return { kind: "direct", source, allowAuthProfileFallback: false };
}

function selectReadyProfile(
  profiles: readonly ProviderModelAuthProfileSource[],
): ProviderModelAuthProfileSource | undefined {
  const first = profiles[0];
  if (!first || first.readiness !== "unknown") {
    return first;
  }
  return profiles.find((profile) => profile.readiness === "ready") ?? first;
}

/** Selects logical auth sources without resolving a provider-owned route. */
export function selectProviderModelAuthSources(params: {
  provider: string;
  plan: ProviderModelAuthSourcePlan;
}): ProviderModelAuthSourceDecision {
  if (params.plan.kind === "required") {
    const source = params.plan.source;
    return {
      kind: "selected",
      selection: { kind: "selected", source },
      attempts: [source.kind === "profile" ? { kind: "profile", source } : directAttempt(source)],
    };
  }

  const { fallback, profiles } = params.plan;
  if (profiles.kind === "all-cooldown") {
    return {
      kind: "rejected",
      reason: "all-cooldown",
      message: `Auth profile "${profiles.first.profileId}" is temporarily unavailable for ${params.provider}.`,
      source: profiles.first,
    };
  }
  if (
    profiles.explicitOrder &&
    (profiles.kind === "empty" || profiles.kind === "all-unavailable")
  ) {
    return {
      kind: "rejected",
      reason: "explicit-order",
      message: `Explicit auth order for ${params.provider} has no usable profiles.`,
      ...(profiles.kind === "all-unavailable" ? { source: profiles.first } : {}),
    };
  }
  if (profiles.kind === "usable") {
    const winner = selectReadyProfile(profiles.profiles);
    return {
      kind: "selected",
      selection: winner ? { kind: "selected", source: winner } : { kind: "none" },
      attempts: [
        ...profiles.profiles.map((source) => ({ kind: "profile" as const, source })),
        ...(fallback ? [directAttempt(fallback)] : []),
      ],
    };
  }
  if (fallback) {
    return {
      kind: "selected",
      selection: { kind: "selected", source: fallback },
      attempts: [directAttempt(fallback)],
    };
  }
  return {
    kind: "selected",
    selection:
      profiles.kind === "all-unavailable"
        ? { kind: "unavailable", source: profiles.first }
        : { kind: "none" },
    attempts: [],
  };
}

function reject(
  reason: Extract<ProviderModelRouteAuthDecision, { kind: "rejected" }>["reason"],
  message: string,
  source?: ProviderModelAuthProfileSource,
  route?: ProviderModelRouteCandidate,
): ProviderModelRouteAuthDecision {
  return {
    kind: "rejected",
    reason,
    message,
    ...(source ? { source } : {}),
    ...(route ? { route } : {}),
  };
}

function routeForMode(
  resolution: Extract<ProviderModelRouteResolution, { kind: "routes" }>,
  mode: string | undefined,
): ProviderModelRouteCandidate | undefined {
  const requirement = resolveProviderModelRouteAuthRequirement(mode);
  return requirement
    ? resolution.routes.find((candidate) => candidate.authRequirement === requirement)
    : undefined;
}

function resolveDeferredRouteSupport(
  resolution: Extract<ProviderModelRouteResolution, { kind: "routes" }>,
): Extract<ProviderModelRouteAuthDecision, { kind: "deferred" }>["routeSupport"] {
  const seenRuntimeIds = new Set<string>();
  const compatibleIds = (resolution.routes[0].runtimePolicy?.compatibleIds ?? []).flatMap((id) => {
    const normalizedId = id.trim().toLowerCase();
    if (
      !normalizedId ||
      seenRuntimeIds.has(normalizedId) ||
      !resolution.routes.every((route) =>
        route.runtimePolicy?.compatibleIds.some(
          (candidateId) => candidateId.trim().toLowerCase() === normalizedId,
        ),
      )
    ) {
      return [];
    }
    seenRuntimeIds.add(normalizedId);
    return [normalizedId];
  });
  return {
    requestTransportOverrides: resolution.routes.some(
      (route) => route.requestTransportOverrides === "present",
    )
      ? "present"
      : "none",
    runtimePolicy: { compatibleIds },
  };
}

/** Selects one route and emits source-distinct, exact-route physical attempts. */
export function selectProviderModelRouteAuth(params: {
  provider: string;
  resolution: Extract<ProviderModelRouteResolution, { kind: "routes" }>;
  sourcePlan: ProviderModelAuthSourcePlan;
  configuredAuthMode?: string;
  /** Explicit native auth owner allowed to defer an otherwise unowned route. */
  runtimeAuthOwner?: { id: string };
}): ProviderModelRouteAuthDecision {
  const requiredProfile =
    params.sourcePlan.kind === "required" && params.sourcePlan.source.kind === "profile"
      ? params.sourcePlan.source
      : undefined;
  const configuredMode =
    params.sourcePlan.kind === "required"
      ? params.sourcePlan.source.kind === "direct"
        ? params.sourcePlan.source.mode
        : undefined
      : params.configuredAuthMode;
  const configuredRoute = routeForMode(params.resolution, configuredMode);
  if (
    configuredMode &&
    resolveProviderModelRouteAuthRequirement(configuredMode) &&
    !configuredRoute
  ) {
    return reject(
      "configured-auth",
      `Configured ${params.provider} authentication is not compatible with the selected model route.`,
    );
  }

  const configuredRequirement =
    configuredRoute?.authRequirement ??
    (params.resolution.routes.length === 1
      ? params.resolution.routes[0]?.authRequirement
      : undefined);
  const effectiveSourcePlan =
    params.sourcePlan.kind === "automatic" && configuredRequirement
      ? buildProviderModelAuthSourcePlan({
          profiles: params.sourcePlan.orderedProfiles.filter(
            (profile) =>
              resolveProviderModelRouteAuthRequirement(profile.mode) === configuredRequirement,
          ),
          explicitOrder: params.sourcePlan.profiles.explicitOrder,
          allowCooldown: params.sourcePlan.allowCooldown,
          ...(params.sourcePlan.fallback ? { fallback: params.sourcePlan.fallback } : {}),
        })
      : params.sourcePlan;
  const sourceDecision = selectProviderModelAuthSources({
    provider: params.provider,
    plan: effectiveSourcePlan,
  });
  if (sourceDecision.kind === "rejected") {
    return reject(
      sourceDecision.reason,
      sourceDecision.message,
      sourceDecision.source,
      configuredRoute,
    );
  }

  const logicalProfiles = sourceDecision.attempts.flatMap((attempt) =>
    attempt.kind === "profile" ? [attempt.source] : [],
  );
  const routeProfileAttempts = logicalProfiles.flatMap((source) => {
    const route = routeForMode(params.resolution, source.mode);
    if (!route || (configuredRequirement && route.authRequirement !== configuredRequirement)) {
      return [];
    }
    return [{ source, route }];
  });
  if (requiredProfile && routeProfileAttempts.length === 0) {
    const accepted = params.resolution.routes
      .map((candidate) => candidate.authRequirement)
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(" or ");
    return reject(
      "required-profile",
      `Auth profile "${requiredProfile.profileId}" is not compatible with ${params.provider}; the selected model route requires ${accepted} authentication.`,
      requiredProfile,
    );
  }
  if (
    effectiveSourcePlan.kind === "automatic" &&
    effectiveSourcePlan.profiles.explicitOrder &&
    logicalProfiles.length > 0 &&
    routeProfileAttempts.length === 0
  ) {
    return reject(
      "explicit-order",
      `Explicit auth order has no route-compatible profiles for ${params.provider}.`,
    );
  }

  const winner = routeProfileAttempts[0];
  const directSource = sourceDecision.attempts.find(
    (attempt): attempt is Extract<ProviderModelAuthLogicalAttempt, { kind: "direct" }> =>
      attempt.kind === "direct",
  )?.source;
  const directSourceRoute = directSource
    ? routeForMode(params.resolution, directSource.mode)
    : undefined;
  const directRoute =
    directSourceRoute &&
    (!configuredRequirement || directSourceRoute.authRequirement === configuredRequirement)
      ? directSourceRoute
      : undefined;
  if (directSource && directSource.mode && !directRoute && !winner) {
    return reject(
      "configured-auth",
      `Configured ${params.provider} authentication is not compatible with the selected model route.`,
    );
  }
  let rejectedProfile: ProviderModelAuthProfileSource | undefined;
  if (sourceDecision.selection.kind === "unavailable") {
    rejectedProfile = sourceDecision.selection.source;
  } else if (
    sourceDecision.selection.kind === "selected" &&
    sourceDecision.selection.source.kind === "profile"
  ) {
    rejectedProfile = sourceDecision.selection.source;
  } else if (effectiveSourcePlan !== params.sourcePlan && params.sourcePlan.kind === "automatic") {
    rejectedProfile = params.sourcePlan.orderedProfiles[0];
  }
  const hasCompatibleAuthWinner = Boolean(winner || (directSource && directRoute));
  if (!hasCompatibleAuthWinner) {
    const routeSupport = resolveDeferredRouteSupport(params.resolution);
    const normalizedRuntimeAuthOwner = params.runtimeAuthOwner?.id.trim().toLowerCase();
    const runtimeAuthOwnerIsCompatible =
      Boolean(normalizedRuntimeAuthOwner) &&
      routeSupport.runtimePolicy.compatibleIds.includes(normalizedRuntimeAuthOwner ?? "");
    if (params.resolution.routes.length > 1 && runtimeAuthOwnerIsCompatible && !configuredRoute) {
      return { kind: "deferred", reason: "runtime-auth-owner", routeSupport };
    }
    return reject(
      "configured-auth",
      configuredRoute
        ? `Configured ${params.provider} authentication has no compatible credential source for the selected model route.`
        : `No route-compatible authentication source is configured for ${params.provider}.`,
      rejectedProfile,
      configuredRoute,
    );
  }
  const selectedRoute = winner?.route ?? directRoute;
  if (!selectedRoute) {
    return reject(
      "configured-auth",
      `No route-compatible authentication source is configured for ${params.provider}.`,
    );
  }

  const sameRouteAttempts = winner
    ? routeProfileAttempts.filter(
        (attempt) => attempt.route.authRequirement === winner.route.authRequirement,
      )
    : [];
  const crossRouteAttempts = winner
    ? routeProfileAttempts.filter(
        (attempt) => attempt.route.authRequirement !== winner.route.authRequirement,
      )
    : routeProfileAttempts;
  const orderedProfileAttempts = [...sameRouteAttempts, ...crossRouteAttempts];
  const attempts: ProviderModelRouteAuthAttempt[] = orderedProfileAttempts.map(
    (attempt, index) => ({
      kind: "profile",
      source: attempt.source,
      route: attempt.route,
      sameRouteProfileIds: orderedProfileAttempts
        .slice(index)
        .filter((candidate) => candidate.route.authRequirement === attempt.route.authRequirement)
        .map((candidate) => candidate.source.profileId),
    }),
  );
  if (directSource && directRoute) {
    attempts.push({
      kind: "direct",
      source: directSource,
      route: directRoute,
      allowAuthProfileFallback: false,
    });
  }

  const selection: ProviderModelAuthSourceSelection = winner
    ? { kind: "selected", source: winner.source }
    : directSource
      ? { kind: "selected", source: directSource }
      : sourceDecision.selection.kind === "unavailable"
        ? sourceDecision.selection
        : { kind: "none" };
  return {
    kind: "selected",
    selection: { ...selection, route: selectedRoute },
    attempts,
  };
}
