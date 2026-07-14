import type { GatewayBindMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isLoopbackHost } from "../gateway/net.js";
import type { ReadinessCondition } from "../readiness/conditions.js";
import { WORKSPACE_WRITABLE_CRITERION_ID } from "../readiness/selection.js";

export const HOSTING_PROFILE_IDS = ["local", "container", "reverse-proxy", "node-mode"] as const;
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
  "node-mode": {
    id: "node-mode",
    description: "Gateway controlling one or more paired execution targets.",
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

export type NodeModeReadinessEvidence = {
  pairing?: {
    pairedCount: number;
    pendingCount: number;
    error?: string;
    timedOut?: boolean;
  };
  targets?: { knownCount: number; connectedCount: number };
  commandApproval?: { configured: boolean; approvedCommandCount: number };
  controlChannel?: { connectedCount: number };
};

function buildNodeModeConditions(evidence?: NodeModeReadinessEvidence): ReadinessCondition[] {
  const pairing = evidence?.pairing;
  const pairingCondition: ReadinessCondition = pairing?.error
    ? {
        type: "NodePairingReady",
        status: "Unknown",
        requirement: "required",
        reason: pairing.timedOut ? "NodePairingTimedOut" : "NodePairingUnavailable",
        message: `Node pairing state could not be read: ${pairing.error}`,
      }
    : (pairing?.pairedCount ?? 0) > 0
      ? {
          type: "NodePairingReady",
          status: "True",
          requirement: "required",
          reason: "NodePairingReady",
          message: `Node pairing has ${pairing?.pairedCount} approved target${pairing?.pairedCount === 1 ? "" : "s"}.`,
        }
      : {
          type: "NodePairingReady",
          status: "False",
          requirement: "required",
          reason: (pairing?.pendingCount ?? 0) > 0 ? "NodePairingPending" : "NodePairingMissing",
          message: "Node-mode requires at least one approved node pairing.",
        };

  const connectedCount = evidence?.targets?.connectedCount ?? 0;
  const targetCondition: ReadinessCondition = {
    type: "ControlledTargetsReady",
    status: connectedCount > 0 ? "True" : "False",
    requirement: "required",
    reason: connectedCount > 0 ? "ControlledTargetsReady" : "ControlledTargetsDisconnected",
    message:
      connectedCount > 0
        ? `${connectedCount} controlled target${connectedCount === 1 ? " is" : "s are"} connected.`
        : "Node-mode requires at least one connected controlled target.",
  };

  const approvedCount = evidence?.commandApproval?.approvedCommandCount ?? 0;
  const commandCondition: ReadinessCondition = {
    type: "CommandApprovalReady",
    status: evidence?.commandApproval?.configured ? "True" : "False",
    requirement: "required",
    reason: evidence?.commandApproval?.configured
      ? "CommandApprovalReady"
      : "CommandApprovalMissing",
    message: evidence?.commandApproval?.configured
      ? `${approvedCount} executable command approval${approvedCount === 1 ? " is" : "s are"} available.`
      : "Node-mode requires an approved command exposed by a connected target.",
  };

  const controlCount = evidence?.controlChannel?.connectedCount ?? 0;
  const controlCondition: ReadinessCondition = {
    type: "ControlChannelReady",
    status: controlCount > 0 ? "True" : "False",
    requirement: "required",
    reason: controlCount > 0 ? "ControlChannelReady" : "ControlChannelUnavailable",
    message:
      controlCount > 0
        ? `${controlCount} node control channel${controlCount === 1 ? " is" : "s are"} connected.`
        : "No node control channel is connected.",
  };

  return [pairingCondition, targetCondition, commandCondition, controlCondition];
}

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
  nodeMode?: NodeModeReadinessEvidence,
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
  if (profile === "node-mode") {
    conditions.push(...buildNodeModeConditions(nodeMode));
  }
  return conditions;
}

export function requiredCriteriaForHostingProfile(profile: HostingProfileId): readonly string[] {
  return STANDARD_HOSTING_PROFILES[profile].requiredCriteria;
}
