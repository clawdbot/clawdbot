export type ProviderModelAuthReadiness = "ready" | "unknown" | "unavailable";

export type ProviderModelAuthEvidence =
  | "aws-sdk"
  | "environment"
  | "none"
  | "profile"
  | "provider-config"
  | "runtime"
  | "synthetic";

export type ProviderModelAuthProfileSource = {
  kind: "profile";
  profileId: string;
  provider?: string;
  mode?: string;
  readiness: ProviderModelAuthReadiness;
  cooldown: "active" | "clear";
};

export type ProviderModelAuthDirectSource = {
  kind: "direct";
  mode?: string;
  readiness: ProviderModelAuthReadiness;
  evidence: ProviderModelAuthEvidence;
};

export type ProviderModelAuthSource =
  | ProviderModelAuthProfileSource
  | ProviderModelAuthDirectSource;

export type ProviderModelAuthRequiredReason = "configured-auth" | "provider-binding" | "user-lock";

export type ProviderModelAuthAutomaticProfiles =
  | { kind: "empty"; explicitOrder: boolean }
  | {
      kind: "usable";
      explicitOrder: boolean;
      profiles: readonly ProviderModelAuthProfileSource[];
    }
  | {
      kind: "all-unavailable";
      explicitOrder: boolean;
      first: ProviderModelAuthProfileSource;
    }
  | {
      kind: "all-cooldown";
      explicitOrder: boolean;
      first: ProviderModelAuthProfileSource;
    };

export type ProviderModelAuthSourcePlan =
  | {
      kind: "required";
      reason: ProviderModelAuthRequiredReason;
      source: ProviderModelAuthSource;
    }
  | {
      kind: "automatic";
      profiles: ProviderModelAuthAutomaticProfiles;
      orderedProfiles: readonly ProviderModelAuthProfileSource[];
      allowCooldown: boolean;
      fallback?: ProviderModelAuthDirectSource;
    };

export function toProviderModelAuthReadiness(
  availability: boolean | undefined,
): ProviderModelAuthReadiness {
  return availability === true ? "ready" : availability === false ? "unavailable" : "unknown";
}

export function fromProviderModelAuthReadiness(
  readiness: ProviderModelAuthReadiness,
): boolean | undefined {
  return readiness === "ready" ? true : readiness === "unavailable" ? false : undefined;
}

/** Creates a source fact without retaining credential material. */
export function buildProviderModelAuthDirectSource(params: {
  mode?: string;
  availability?: boolean;
  evidence: ProviderModelAuthEvidence;
}): ProviderModelAuthDirectSource {
  return {
    kind: "direct",
    mode: params.mode,
    readiness: toProviderModelAuthReadiness(params.availability),
    evidence: params.evidence,
  };
}

function reorderPreferredProfile(
  profiles: readonly ProviderModelAuthProfileSource[],
  preferredProfileId: string | undefined,
): ProviderModelAuthProfileSource[] {
  if (!preferredProfileId) {
    return [...profiles];
  }
  const preferred = profiles.find((profile) => profile.profileId === preferredProfileId);
  return preferred
    ? [preferred, ...profiles.filter((profile) => profile.profileId !== preferredProfileId)]
    : [...profiles];
}

/** Applies source precedence and automatic-tier readiness/cooldown policy once. */
export function buildProviderModelAuthSourcePlan(params: {
  ownership?: {
    reason: ProviderModelAuthRequiredReason;
    source: ProviderModelAuthSource;
  };
  profiles: readonly ProviderModelAuthProfileSource[];
  preferredProfileId?: string;
  explicitOrder?: boolean;
  fallback?: ProviderModelAuthDirectSource;
  allowCooldown?: boolean;
}): ProviderModelAuthSourcePlan {
  if (params.ownership) {
    return { kind: "required", ...params.ownership };
  }
  const explicitOrder = params.explicitOrder === true;
  const ordered = reorderPreferredProfile(params.profiles, params.preferredProfileId);
  let profiles: ProviderModelAuthAutomaticProfiles;
  if (ordered.length === 0) {
    profiles = { kind: "empty", explicitOrder };
  } else {
    const available = ordered.filter((profile) => profile.readiness !== "unavailable");
    if (available.length === 0) {
      const [firstOrdered] = ordered;
      profiles = firstOrdered
        ? { kind: "all-unavailable", explicitOrder, first: firstOrdered }
        : { kind: "empty", explicitOrder };
    } else {
      const outsideCooldown = available.filter((profile) => profile.cooldown === "clear");
      if (outsideCooldown.length > 0) {
        profiles = { kind: "usable", explicitOrder, profiles: outsideCooldown };
      } else if (params.allowCooldown) {
        profiles = { kind: "usable", explicitOrder, profiles: available.slice(0, 1) };
      } else {
        const [firstAvailable] = available;
        profiles = firstAvailable
          ? { kind: "all-cooldown", explicitOrder, first: firstAvailable }
          : { kind: "empty", explicitOrder };
      }
    }
  }
  return {
    kind: "automatic",
    profiles,
    orderedProfiles: ordered,
    allowCooldown: params.allowCooldown === true,
    ...(params.fallback ? { fallback: params.fallback } : {}),
  };
}
