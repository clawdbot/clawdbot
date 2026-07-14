import type { GatewayBindMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isLoopbackHost } from "../gateway/net.js";
import type { ReadinessCondition } from "../readiness/conditions.js";
import { WORKSPACE_WRITABLE_CRITERION_ID } from "../readiness/selection.js";

export const HOSTING_PROFILE_IDS = ["local", "container", "reverse-proxy"] as const;
export type HostingProfileId = (typeof HOSTING_PROFILE_IDS)[number];

export const DEFAULT_HOSTING_PROFILE: HostingProfileId = "local";
export const HOSTING_PROFILE_ENV = "OPENCLAW_HOSTING_PROFILE";

export type HostingProfileDescriptor = {
  id: HostingProfileId;
  description: string;
  requiredCriteria: readonly string[];
};

const STANDARD_HOSTING_PROFILES: Record<HostingProfileId, HostingProfileDescriptor> = {
  local: {
    id: "local",
    description: "Default local or foreground Gateway.",
    requiredCriteria: [WORKSPACE_WRITABLE_CRITERION_ID],
  },
  container: {
    id: "container",
    description: "Gateway directly reachable through a container listener.",
    requiredCriteria: [WORKSPACE_WRITABLE_CRITERION_ID],
  },
  "reverse-proxy": {
    id: "reverse-proxy",
    description: "Gateway behind a trusted identity proxy.",
    requiredCriteria: [WORKSPACE_WRITABLE_CRITERION_ID],
  },
};

export function listStandardHostingProfiles(): HostingProfileDescriptor[] {
  return HOSTING_PROFILE_IDS.map((id) => STANDARD_HOSTING_PROFILES[id]);
}

export function parseHostingProfileId(value: unknown): HostingProfileId | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return HOSTING_PROFILE_IDS.includes(normalized as HostingProfileId)
    ? (normalized as HostingProfileId)
    : null;
}

export function formatHostingProfileIds(): string {
  return HOSTING_PROFILE_IDS.map((profile) => `"${profile}"`).join(", ");
}

function resolveExplicitHostingProfile(
  value: unknown,
  source: string,
): HostingProfileId | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const profile = parseHostingProfileId(value);
  if (!profile) {
    throw new Error(
      `Invalid hosting profile from ${source}: ${JSON.stringify(value)}. Expected ${formatHostingProfileIds()}.`,
    );
  }
  return profile;
}

export function resolveHostingProfile(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    override?: unknown;
  } = {},
): HostingProfileId {
  return (
    resolveExplicitHostingProfile(params.override, "gateway startup override") ??
    resolveExplicitHostingProfile(params.env?.[HOSTING_PROFILE_ENV], HOSTING_PROFILE_ENV) ??
    resolveExplicitHostingProfile(params.config?.hosting?.profile, "hosting.profile") ??
    DEFAULT_HOSTING_PROFILE
  );
}

export type HostingRuntimeFacts = {
  bind: GatewayBindMode;
  bindHost: string;
  port: number;
  authMode: string;
  trustedProxyUserHeader?: string;
  trustedProxyCount: number;
};

function buildContainerCondition(facts: HostingRuntimeFacts): ReadinessCondition {
  if (facts.bind === "loopback" || isLoopbackHost(facts.bindHost)) {
    return {
      type: "ContainerStateReady",
      status: "False",
      requirement: "required",
      reason: "ContainerGatewayLoopback",
      message: "Container profile requires a non-loopback Gateway listener.",
    };
  }
  return {
    type: "ContainerStateReady",
    status: "True",
    requirement: "required",
    reason: "ContainerStateReady",
    message: `Gateway is listening at ${facts.bindHost}:${facts.port}.`,
  };
}

function buildTrustedProxyCondition(facts: HostingRuntimeFacts): ReadinessCondition {
  if (facts.authMode !== "trusted-proxy") {
    return {
      type: "TrustedProxyReady",
      status: "False",
      requirement: "required",
      reason: "TrustedProxyAuthMissing",
      message: "Reverse-proxy profile requires gateway.auth.mode=trusted-proxy.",
    };
  }
  if (!facts.trustedProxyUserHeader?.trim()) {
    return {
      type: "TrustedProxyReady",
      status: "False",
      requirement: "required",
      reason: "TrustedProxyHeaderMissing",
      message: "Trusted-proxy auth requires a non-empty userHeader.",
    };
  }
  if (facts.trustedProxyCount === 0) {
    return {
      type: "TrustedProxyReady",
      status: "False",
      requirement: "required",
      reason: "TrustedProxySourcesMissing",
      message: "Reverse-proxy profile requires at least one trusted proxy source.",
    };
  }
  return {
    type: "TrustedProxyReady",
    status: "True",
    requirement: "required",
    reason: "TrustedProxyReady",
    message: `Trusted-proxy auth accepts ${facts.trustedProxyUserHeader} from ${facts.trustedProxyCount} configured source${facts.trustedProxyCount === 1 ? "" : "s"}.`,
  };
}

export function buildHostingProfileConditions(
  profile: HostingProfileId,
  facts: HostingRuntimeFacts,
): ReadinessCondition[] {
  const conditions: ReadinessCondition[] = [
    {
      type: "ProfileSelected",
      status: "True",
      requirement: "required",
      reason: "ProfileSelected",
      message: `Runtime selected the ${profile} hosting profile.`,
    },
  ];
  if (profile === "container") {
    conditions.push(buildContainerCondition(facts));
  }
  if (profile === "reverse-proxy") {
    conditions.push(buildTrustedProxyCondition(facts));
  }
  return conditions;
}

export function requiredCriteriaForHostingProfile(profile: HostingProfileId): readonly string[] {
  return STANDARD_HOSTING_PROFILES[profile].requiredCriteria;
}
