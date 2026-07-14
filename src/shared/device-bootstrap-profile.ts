// Device bootstrap profile helpers build profile claims for device onboarding.
import { normalizeDeviceAuthRole, normalizeDeviceAuthScopes } from "./device-auth.js";

/** Closed purpose codes carried by specialized bootstrap tokens. */
export type DeviceBootstrapPurpose = "control-ui" | "mobile-full";

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

/** Full native-mobile operator scopes allowed only by the closed mobile setup profile. */
const MOBILE_FULL_ACCESS_OPERATOR_SCOPES = [
  "operator.admin",
  ...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
] as const;

const MOBILE_FULL_ACCESS_OPERATOR_SCOPE_SET = new Set<string>(MOBILE_FULL_ACCESS_OPERATOR_SCOPES);

/** Existing least-privilege setup-code/QR profile. */
export const PAIRING_SETUP_BOOTSTRAP_PROFILE: DeviceBootstrapProfile = {
  // QR/setup-code bootstrap must hand off both tokens for native onboarding:
  // iOS/Android suppress the operator loop while bootstrap auth is active and
  // only start it after persisting this bounded operator token.
  roles: ["node", "operator"],
  scopes: [...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES],
};

/** Full native-mobile setup profile for explicitly authorized setup surfaces. */
export const FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE: DeviceBootstrapProfile = {
  roles: ["node", "operator"],
  scopes: [...MOBILE_FULL_ACCESS_OPERATOR_SCOPES],
  purpose: "mobile-full",
};

/** Node-only setup profile for companions that never act as operators. */
export const NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE: DeviceBootstrapProfile = {
  roles: ["node"],
  scopes: [],
};

/** Compare normalized bootstrap profiles, including their closed purpose. */
export function deviceBootstrapProfilesEqual(
  left: DeviceBootstrapProfileInput | undefined,
  right: DeviceBootstrapProfileInput | undefined,
): boolean {
  const profile = normalizeDeviceBootstrapProfile(left);
  const expected = normalizeDeviceBootstrapProfile(right);
  return (
    profile.purpose === expected.purpose &&
    profile.roles.length === expected.roles.length &&
    profile.scopes.length === expected.scopes.length &&
    profile.roles.every((role, index) => role === expected.roles[index]) &&
    profile.scopes.every((scope, index) => scope === expected.scopes[index])
  );
}

function matchesBootstrapProfile(
  input: DeviceBootstrapProfileInput | undefined,
  expected: DeviceBootstrapProfile,
): boolean {
  return deviceBootstrapProfilesEqual(input, expected);
}

/** Return whether an input matches either supported native-mobile setup profile. */
export function isMobilePairingSetupBootstrapProfile(
  input: DeviceBootstrapProfileInput | undefined,
): boolean {
  return (
    isPairingSetupBootstrapProfile(input) ||
    matchesBootstrapProfile(input, FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE)
  );
}

/** Return whether an input exactly matches the existing limited setup profile. */
function isPairingSetupBootstrapProfile(input: DeviceBootstrapProfileInput | undefined): boolean {
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
  purpose?: DeviceBootstrapPurpose,
): string[] {
  const normalizedRole = normalizeDeviceAuthRole(role);
  const normalizedScopes = normalizeDeviceAuthScopes(Array.from(scopes));
  if (normalizedRole === "operator") {
    const allowedScopes =
      purpose === "mobile-full"
        ? MOBILE_FULL_ACCESS_OPERATOR_SCOPE_SET
        : BOOTSTRAP_HANDOFF_OPERATOR_SCOPE_SET;
    return normalizedScopes.filter((scope) => allowedScopes.has(scope));
  }
  return [];
}

/** Resolve bounded bootstrap handoff scopes across a role set. */
export function resolveBootstrapProfileScopesForRoles(
  roles: readonly string[],
  scopes: readonly string[],
  purpose?: DeviceBootstrapPurpose,
): string[] {
  return normalizeDeviceAuthScopes(
    roles.flatMap((role) => resolveBootstrapProfileScopesForRole(role, scopes, purpose)),
  );
}

/** Resolve one role's scopes directly from a normalized bootstrap profile. */
export function resolveDeviceProfileRoleScopes(
  profile: DeviceBootstrapProfile,
  role: string,
  scopes: readonly string[] = profile.scopes,
): string[] {
  return resolveBootstrapProfileScopesForRole(role, scopes, profile.purpose);
}

/** Resolve role-set scopes directly from a normalized bootstrap profile. */
export function resolveDeviceProfileScopes(
  profile: DeviceBootstrapProfile,
  roles: readonly string[],
  scopes: readonly string[] = profile.scopes,
): string[] {
  return resolveBootstrapProfileScopesForRoles(roles, scopes, profile.purpose);
}

/** Normalize a requested bootstrap profile and strip scopes outside the handoff allowlist. */
export function normalizeDeviceBootstrapHandoffProfile(
  input: DeviceBootstrapProfileInput | undefined,
): DeviceBootstrapProfile {
  const profile = normalizeDeviceBootstrapProfile(input);
  // Bootstrap handoff profiles can only carry the documented handoff allowlist.
  return {
    roles: profile.roles,
    scopes: resolveBootstrapProfileScopesForRoles(profile.roles, profile.scopes, profile.purpose),
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
  const purpose =
    input?.purpose === "control-ui" || input?.purpose === "mobile-full" ? input.purpose : undefined;
  return {
    roles: normalizeBootstrapRoles(input?.roles),
    scopes: normalizeDeviceAuthScopes(input?.scopes ? [...input.scopes] : []),
    ...(purpose ? { purpose } : {}),
  };
}
