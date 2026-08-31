import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasEffectivePairedDeviceRole, type PairedDevice } from "../infra/device-pairing.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import { resolveOperatorRolePolicyForProfile } from "./operator-role-policy.js";

export type NotificationAuthority = {
  scopes: string[];
  userProfileId: string | null;
};

/** Resolve current paired-device, profile, and optional live-connection ceilings together. */
export function resolveNotificationAuthority(params: {
  device: PairedDevice | undefined;
  userProfileId: string | null;
  cfg: OpenClawConfig;
  requiredScopes: readonly string[];
  connectionScopes?: readonly string[];
}): NotificationAuthority | null {
  const { device, cfg } = params;
  if (!device || !hasEffectivePairedDeviceRole(device, "operator")) {
    return null;
  }
  const token = device.tokens?.operator;
  const approvedScopes = device.approvedScopes ?? device.scopes;
  if (
    !token ||
    token.revokedAtMs ||
    !approvedScopes ||
    !roleScopesAllow({
      role: "operator",
      requestedScopes: token.scopes,
      allowedScopes: approvedScopes,
    })
  ) {
    return null;
  }
  const userProfileId = params.userProfileId
    ? (resolveUserProfileId(params.userProfileId) ?? null)
    : null;
  if ((params.userProfileId && !userProfileId) || (cfg.gateway?.roles && !userProfileId)) {
    return null;
  }
  const rolePolicy = userProfileId
    ? resolveOperatorRolePolicyForProfile(userProfileId, cfg)
    : undefined;
  if (cfg.gateway?.roles && !rolePolicy) {
    return null;
  }
  const ceilings = [
    token.scopes,
    ...(rolePolicy ? [rolePolicy.scopes] : []),
    ...(params.connectionScopes ? [params.connectionScopes] : []),
  ];
  // Visibility owners need effective admin authority, not just delivery scopes.
  // Intersect by implication so no device, profile, or connection can elevate another.
  const scopes = [...new Set(ceilings.flat())].filter((scope) =>
    ceilings.every((allowedScopes) =>
      roleScopesAllow({ role: "operator", requestedScopes: [scope], allowedScopes }),
    ),
  );
  return roleScopesAllow({
    role: "operator",
    requestedScopes: params.requiredScopes,
    allowedScopes: scopes,
  })
    ? { scopes, userProfileId }
    : null;
}
