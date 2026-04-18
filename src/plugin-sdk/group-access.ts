import { resolveOpenProviderRuntimeGroupPolicy } from "../config/runtime-group-policy.js";
import type { GroupPolicy } from "../config/types.base.js";

export { resolveOpenProviderRuntimeGroupPolicy };
export type { GroupPolicy };

export type SenderGroupAccessReason =
  | "allowed"
  | "disabled"
  | "empty_allowlist"
  | "sender_not_allowlisted";

export type SenderGroupAccessDecision = {
  allowed: boolean;
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
  reason: SenderGroupAccessReason;
};

export type GroupRouteAccessReason =
  | "allowed"
  | "disabled"
  | "empty_allowlist"
  | "route_not_allowlisted"
  | "route_disabled";

export type GroupRouteAccessDecision = {
  allowed: boolean;
  groupPolicy: GroupPolicy;
  reason: GroupRouteAccessReason;
};

export type MatchedGroupAccessReason =
  | "allowed"
  | "disabled"
  | "missing_match_input"
  | "empty_allowlist"
  | "not_allowlisted";

export type MatchedGroupAccessDecision = {
  allowed: boolean;
  groupPolicy: GroupPolicy;
  reason: MatchedGroupAccessReason;
};

/** Downgrade sender-scoped group policy to open mode when no allowlist is configured. */
export function resolveSenderScopedGroupPolicy(params: {
  groupPolicy: GroupPolicy;
  groupAllowFrom: string[];
}): GroupPolicy {
  if (params.groupPolicy === "disabled") {
    return "disabled";
  }
  return params.groupAllowFrom.length > 0 ? "allowlist" : "open";
}

/** Evaluate route-level group access after policy, route match, and enablement checks. */
export function evaluateGroupRouteAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  routeAllowlistConfigured: boolean;
  routeMatched: boolean;
  routeEnabled?: boolean;
}): GroupRouteAccessDecision {
  if (params.groupPolicy === "disabled") {
    return {
      allowed: false,
      groupPolicy: params.groupPolicy,
      reason: "disabled",
    };
  }

  if (params.routeMatched && params.routeEnabled === false) {
    return {
      allowed: false,
      groupPolicy: params.groupPolicy,
      reason: "route_disabled",
    };
  }

  if (params.groupPolicy === "allowlist") {
    if (!params.routeAllowlistConfigured) {
      return {
        allowed: false,
        groupPolicy: params.groupPolicy,
        reason: "empty_allowlist",
      };
    }
    if (!params.routeMatched) {
      return {
        allowed: false,
        groupPolicy: params.groupPolicy,
        reason: "route_not_allowlisted",
      };
    }
  }

  return {
    allowed: true,
    groupPolicy: params.groupPolicy,
    reason: "allowed",
  };
}

/** Evaluate generic allowlist match state for channels that compare derived group identifiers. */
export function evaluateMatchedGroupAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  allowlistConfigured: boolean;
  allowlistMatched: boolean;
  requireMatchInput?: boolean;
  hasMatchInput?: boolean;
}): MatchedGroupAccessDecision {
  if (params.groupPolicy === "disabled") {
    return {
      allowed: false,
      groupPolicy: params.groupPolicy,
      reason: "disabled",
    };
  }

  if (params.groupPolicy === "allowlist") {
    if (params.requireMatchInput && !params.hasMatchInput) {
      return {
        allowed: false,
        groupPolicy: params.groupPolicy,
        reason: "missing_match_input",
      };
    }
    if (!params.allowlistConfigured) {
      return {
        allowed: false,
        groupPolicy: params.groupPolicy,
        reason: "empty_allowlist",
      };
    }
    if (!params.allowlistMatched) {
      return {
        allowed: false,
        groupPolicy: params.groupPolicy,
        reason: "not_allowlisted",
      };
    }
  }

  return {
    allowed: true,
    groupPolicy: params.groupPolicy,
    reason: "allowed",
  };
}

/** Evaluate sender access for an already-resolved group policy and allowlist. */
export function evaluateSenderGroupAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied?: boolean;
  groupAllowFrom: string[];
  senderId: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
}): SenderGroupAccessDecision {
  if (params.groupPolicy === "disabled") {
    return {
      allowed: false,
      groupPolicy: params.groupPolicy,
      providerMissingFallbackApplied: Boolean(params.providerMissingFallbackApplied),
      reason: "disabled",
    };
  }
  if (params.groupPolicy === "allowlist") {
    if (params.groupAllowFrom.length === 0) {
      return {
        allowed: false,
        groupPolicy: params.groupPolicy,
        providerMissingFallbackApplied: Boolean(params.providerMissingFallbackApplied),
        reason: "empty_allowlist",
      };
    }
    if (!params.isSenderAllowed(params.senderId, params.groupAllowFrom)) {
      return {
        allowed: false,
        groupPolicy: params.groupPolicy,
        providerMissingFallbackApplied: Boolean(params.providerMissingFallbackApplied),
        reason: "sender_not_allowlisted",
      };
    }
  }

  return {
    allowed: true,
    groupPolicy: params.groupPolicy,
    providerMissingFallbackApplied: Boolean(params.providerMissingFallbackApplied),
    reason: "allowed",
  };
}

/** Resolve provider fallback policy first, then evaluate sender access against that result. */
export function evaluateSenderGroupAccess(params: {
  providerConfigPresent: boolean;
  configuredGroupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
  groupAllowFrom: string[];
  senderId: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
}): SenderGroupAccessDecision {
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.configuredGroupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy,
  });

  return evaluateSenderGroupAccessForPolicy({
    groupPolicy,
    providerMissingFallbackApplied,
    groupAllowFrom: params.groupAllowFrom,
    senderId: params.senderId,
    isSenderAllowed: params.isSenderAllowed,
  });
}
