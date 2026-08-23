import type { DeviceAuthToken } from "../../infra/device-pairing.js";
import type { GatewayClient } from "./types.js";

export type DeviceSessionAuthz = {
  callerDeviceId: string | null;
  callerScopes: string[];
  isAdminCaller: boolean;
  isDeviceAuthMigrationCaller: boolean;
  isDeviceAuthMigrationSession: boolean;
};

export type DeviceManagementAuthz = DeviceSessionAuthz & {
  normalizedTargetDeviceId: string;
};

export function resolveDeviceSessionAuthz(client: GatewayClient | null): DeviceSessionAuthz {
  const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const rawCallerDeviceId = client?.connect?.device?.id;
  const isDeviceAuthMigrationCaller = client?.isControlUiDeviceAuthMigration === true;
  const isDeviceAuthMigrationSession = client?.isControlUiDeviceAuthMigrationSession === true;
  const callerDeviceId =
    // Migration admission verifies this exact signed device before marking the
    // session. It gets self-service ownership, never cross-device admin power.
    (client?.isDeviceTokenAuth || isDeviceAuthMigrationCaller) &&
    typeof rawCallerDeviceId === "string" &&
    rawCallerDeviceId.trim()
      ? rawCallerDeviceId.trim()
      : null;
  return {
    callerDeviceId,
    callerScopes,
    isAdminCaller:
      !isDeviceAuthMigrationSession &&
      !isDeviceAuthMigrationCaller &&
      callerScopes.includes("operator.admin"),
    isDeviceAuthMigrationCaller,
    isDeviceAuthMigrationSession,
  };
}

export function resolveDeviceManagementAuthz(
  client: GatewayClient | null,
  targetDeviceId: string,
): DeviceManagementAuthz {
  return {
    ...resolveDeviceSessionAuthz(client),
    normalizedTargetDeviceId: targetDeviceId.trim(),
  };
}

export function deniesCrossDeviceManagement(authz: DeviceManagementAuthz): boolean {
  if (authz.isDeviceAuthMigrationSession && !authz.callerDeviceId) {
    return true;
  }
  return Boolean(
    authz.callerDeviceId &&
    authz.callerDeviceId !== authz.normalizedTargetDeviceId &&
    !authz.isAdminCaller,
  );
}

export function deniesDeviceTokenRoleManagement(
  authz: DeviceManagementAuthz,
  targetRole: string,
): boolean {
  const normalizedTargetRole = targetRole.trim();
  if (!normalizedTargetRole || authz.isAdminCaller) {
    return false;
  }
  return normalizedTargetRole !== "operator";
}

function hasNonOperatorDeviceRole(input: { role?: string; roles?: string[] }): boolean {
  const roles = new Set<string>();
  const role = input.role?.trim();
  if (role) {
    roles.add(role);
  }
  for (const entry of input.roles ?? []) {
    const normalized = entry.trim();
    if (normalized) {
      roles.add(normalized);
    }
  }
  return [...roles].some((entry) => entry !== "operator");
}

function hasNonOperatorDeviceTokenRole(
  tokens: Record<string, DeviceAuthToken> | undefined,
): boolean {
  for (const token of Object.values(tokens ?? {})) {
    const normalized = token.role.trim();
    if (normalized && normalized !== "operator") {
      return true;
    }
  }
  return false;
}

export function requestsNonOperatorDeviceRole(pending: {
  role?: string;
  roles?: string[];
}): boolean {
  return hasNonOperatorDeviceRole(pending);
}

export function pairedDeviceHasNonOperatorRole(device: {
  role?: string;
  roles?: string[];
  tokens?: Record<string, DeviceAuthToken>;
}): boolean {
  return hasNonOperatorDeviceRole(device) || hasNonOperatorDeviceTokenRole(device.tokens);
}
