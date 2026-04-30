import { normalizeDeviceAuthRole, normalizeDeviceAuthScopes } from "./device-auth.js";

export type DeviceBootstrapProfile = {
  roles: string[];
  scopes: string[];
};

export type DeviceBootstrapProfileInput = {
  roles?: readonly string[];
  scopes?: readonly string[];
};

export const BOOTSTRAP_HANDOFF_OPERATOR_SCOPES = [
  "operator.approvals",
  "operator.read",
  "operator.talk.secrets",
  "operator.write",
] as const;

const BOOTSTRAP_HANDOFF_OPERATOR_SCOPE_SET = new Set<string>(BOOTSTRAP_HANDOFF_OPERATOR_SCOPES);

export const PAIRING_SETUP_BOOTSTRAP_PROFILE: DeviceBootstrapProfile = {
  roles: ["node", "operator"],
  scopes: [...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES],
};

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

export function resolveBootstrapProfileScopesForRoles(
  roles: readonly string[],
  scopes: readonly string[],
): string[] {
  return normalizeDeviceAuthScopes(
    roles.flatMap((role) => resolveBootstrapProfileScopesForRole(role, scopes)),
  );
}

export function normalizeDeviceBootstrapHandoffProfile(
  input: DeviceBootstrapProfileInput | undefined,
): DeviceBootstrapProfile {
  const profile = normalizeDeviceBootstrapProfile(input);
  // Bootstrap handoff profiles can only carry the documented handoff allowlist.
  return {
    roles: profile.roles,
    scopes: resolveBootstrapProfileScopesForRoles(profile.roles, profile.scopes),
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

export function normalizeDeviceBootstrapProfile(
  input: DeviceBootstrapProfileInput | undefined,
): DeviceBootstrapProfile {
  return {
    roles: normalizeBootstrapRoles(input?.roles),
    scopes: normalizeDeviceAuthScopes(input?.scopes ? [...input.scopes] : []),
  };
}
