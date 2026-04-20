import { normalizeDeviceAuthScopes } from "./device-auth.js";

export type DevicePairingAccessSummary = {
  roles: string[];
  scopes: string[];
};

export type PendingDeviceApprovalKind =
  | "new-pairing"
  | "role-upgrade"
  | "scope-upgrade"
  | "re-approval";

export type PendingDeviceApprovalState = {
  kind: PendingDeviceApprovalKind;
  requested: DevicePairingAccessSummary;
  approved: DevicePairingAccessSummary | null;
};

type PendingLike = {
  role?: string;
  roles?: string[];
  scopes?: string[];
};

type PairedLike = {
  role?: string;
  roles?: string[];
  scopes?: string[];
  tokens?:
    | Array<{
        role?: string;
        revokedAtMs?: number | null;
      }>
    | Record<
        string,
        {
          role?: string;
          revokedAtMs?: number | null;
        }
      >;
};

function normalizeRoleList(...items: Array<string | string[] | undefined>): string[] {
  const roles = new Set<string>();
  for (const item of items) {
    if (!item) {
      continue;
    }
    if (Array.isArray(item)) {
      for (const role of item) {
        const trimmed = role.trim();
        if (trimmed) {
          roles.add(trimmed);
        }
      }
      continue;
    }
    const trimmed = item.trim();
    if (trimmed) {
      roles.add(trimmed);
    }
  }
  return [...roles].toSorted();
}

function includesAll(allowed: readonly string[], requested: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return requested.every((value) => allowedSet.has(value));
}

export function summarizePendingDeviceAccess(request: PendingLike): DevicePairingAccessSummary {
  return {
    roles: normalizeRoleList(request.roles, request.role),
    scopes: normalizeDeviceAuthScopes(request.scopes),
  };
}

export function summarizeApprovedDeviceAccess(device: PairedLike): DevicePairingAccessSummary {
  const approvedRoles = normalizeRoleList(device.roles, device.role);
  const tokenList = Array.isArray(device.tokens)
    ? device.tokens
    : device.tokens
      ? Object.values(device.tokens)
      : undefined;
  const activeTokenRoles =
    tokenList === undefined
      ? approvedRoles
      : normalizeRoleList(
          tokenList.filter((token) => !token.revokedAtMs).flatMap((token) => token.role ?? []),
        ).filter((role) => approvedRoles.includes(role));
  return {
    roles: activeTokenRoles,
    scopes: normalizeDeviceAuthScopes(device.scopes),
  };
}

export function resolvePendingDeviceApprovalState(
  request: PendingLike,
  paired?: PairedLike,
): PendingDeviceApprovalState {
  const requested = summarizePendingDeviceAccess(request);
  const approved = paired ? summarizeApprovedDeviceAccess(paired) : null;
  if (!approved) {
    return { kind: "new-pairing", requested, approved: null };
  }
  if (!includesAll(approved.roles, requested.roles)) {
    return { kind: "role-upgrade", requested, approved };
  }
  if (!includesAll(approved.scopes, requested.scopes)) {
    return { kind: "scope-upgrade", requested, approved };
  }
  return { kind: "re-approval", requested, approved };
}
