// Device bootstrap profile helpers build profile claims for device onboarding.
import { normalizeDeviceAuthRole, normalizeDeviceAuthScopes } from "./device-auth.js";

/** Closed purpose codes carried by specialized bootstrap tokens. */
export type DeviceBootstrapPurpose = "control-ui";

/** Normalized roles/scopes carried by a bootstrap token during device handoff. */
export type DeviceBootstrapProfile = {
  roles: string[];
  scopes: string[];
  purpose?: DeviceBootstrapPurpose;
};

/** Caller-provided bootstrap profile before role/scope normalization and bounding. */
export type DeviceBootstrapProfileInput = {
  roles?: readonly string[];
  scopes?: readonly string[];
  purpose?: DeviceBootstrapPurpose;
};

/** Operator scopes allowed to cross the short-lived bootstrap handoff boundary. */
export const BOOTSTRAP_HANDOFF_OPERATOR_SCOPES = [
  "operator.approvals",
  "operator.read",
  "operator.talk.secrets",
  "operator.write",
] as const;

const BOOTSTRAP_HANDOFF_OPERATOR_SCOPE_SET = new Set<string>(BOOTSTRAP_HANDOFF_OPERATOR_SCOPES);

/** Default setup-code/QR bootstrap profile for native onboarding handoff. */
export const PAIRING_SETUP_BOOTSTRAP_PROFILE: DeviceBootstrapProfile = {
  // QR/setup-code bootstrap must hand off both tokens for native onboarding:
  // iOS/Android suppress the operator loop while bootstrap auth is active and
  // only start it after persisting this bounded operator token.
  roles: ["node", "operator"],
  scopes: [...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES],
};

/** Node-only setup profile for companions that never act as operators. */
export const NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE: DeviceBootstrapProfile = {
  roles: ["node"],
  scopes: [],
};

function matchesBootstrapProfile(
  input: DeviceBootstrapProfileInput | undefined,
  expected: DeviceBootstrapProfile,
): boolean {
  const profile = normalizeDeviceBootstrapProfile(input);
  return (
    profile.roles.length === expected.roles.length &&
    profile.scopes.length === expected.scopes.length &&
    profile.roles.every((role, index) => role === expected.roles[index]) &&
    profile.scopes.every((scope, index) => scope === expected.scopes[index])
  );
}

/** Return whether an input exactly matches the current setup-code bootstrap profile. */
export function isPairingSetupBootstrapProfile(
  input: DeviceBootstrapProfileInput | undefined,
): boolean {
  return matchesBootstrapProfile(input, PAIRING_SETUP_BOOTSTRAP_PROFILE);
}

/** Return whether an input exactly matches the node-only companion setup profile. */
export function isNodePairingSetupBootstrapProfile(
  input: DeviceBootstrapProfileInput | undefined,
): boolean {
  return matchesBootstrapProfile(input, NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE);
}

/** Resolve the subset of requested scopes a bootstrap profile may carry for one role. */
export function resolveBootstrapProfileScopesForRole(
  role: string,
  scopes: readonly string[],
): string[] {
  const normalizedRole = normalizeDeviceAuthRole(role);
  const normalizedScopes = normalizeDeviceAuthScopes(Array.from(scopes));
  if (normalizedRole === "operator") {
    return normalizedScopes.filter((scope) => BOOTSTRAP_HANDOFF_OPERATOR_SCOPE_SET.has(scope));
  }
  return [];
}

/** Resolve bounded bootstrap handoff scopes across a role set. */
export function resolveBootstrapProfileScopesForRoles(
  roles: readonly string[],
  scopes: readonly string[],
): string[] {
  return normalizeDeviceAuthScopes(
    roles.flatMap((role) => resolveBootstrapProfileScopesForRole(role, scopes)),
  );
}

/** Normalize a requested bootstrap profile and strip scopes outside the handoff allowlist. */
export function normalizeDeviceBootstrapHandoffProfile(
  input: DeviceBootstrapProfileInput | undefined,
): DeviceBootstrapProfile {
  const profile = normalizeDeviceBootstrapProfile(input);
  // Bootstrap handoff profiles can only carry the documented handoff allowlist.
  return {
    roles: profile.roles,
    scopes: resolveBootstrapProfileScopesForRoles(profile.roles, profile.scopes),
    ...(profile.purpose ? { purpose: profile.purpose } : {}),
  };
}

function normalizeBootstrapRoles(roles: readonly string[] | undefined): string[] {
  if (!Array.isArray(roles)) {
    return [];
  }
  const out = new Set<string>();
  for (const role of roles) {
    const normalized = normalizeDeviceAuthRole(role);
    if (normalized) {
      out.add(normalized);
    }
  }
  return [...out].toSorted();
}

/** Normalize caller-provided bootstrap roles/scopes without applying handoff bounds. */
export function normalizeDeviceBootstrapProfile(
  input: DeviceBootstrapProfileInput | undefined,
): DeviceBootstrapProfile {
  const purpose = input?.purpose === "control-ui" ? input.purpose : undefined;
  return {
    roles: normalizeBootstrapRoles(input?.roles),
    scopes: normalizeDeviceAuthScopes(input?.scopes ? [...input.scopes] : []),
    ...(purpose ? { purpose } : {}),
  };
}
