// Owner and bootstrap approval flows for pending device pairing requests.
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import {
  resolveDeviceProfileRoleScopes,
  resolveDeviceProfileScopes,
  type DeviceBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
import {
  resolveMissingRequestedScope,
  resolveScopeOutsideRequestedRoles,
} from "../shared/operator-scope-compat.js";
import {
  loadDevicePairingState,
  mergeDevicePairingRoles,
  mergeDevicePairingScopes,
  preserveDeviceRoleScopes,
  resolveRequestedDeviceRoles,
  sameDevicePairingStringSet,
  withDevicePairingLock,
} from "./device-pairing-state.js";
import { persistDevicePairingStoreState as persistState } from "./device-pairing-store.js";
import { createDeviceAuthToken, resolveRoleTokenScopes } from "./device-pairing-tokens.js";
import { clearNodePairingGenerationBins, resolveNodePairingGeneration } from "./device-pairing.js";
import type {
  DeviceAuthToken,
  DevicePairingPendingRequest,
  PairedDevice,
  PairedDeviceApprovalKind,
} from "./device-pairing.types.js";
import { generatePairingToken } from "./pairing-token.js";

const OPERATOR_ROLE = "operator";
const OPERATOR_SCOPE_PREFIX = "operator.";

/** Paired-device access metadata refreshed when an existing device reconnects. */
type DevicePairingAccessMetadata = Pick<
  PairedDevice,
  "displayName" | "remoteIp" | "lastSeenAtMs" | "lastSeenReason"
>;

/** Authorization failure categories for owner approval and bootstrap approval flows. */
type DevicePairingForbiddenReason =
  | "caller-scopes-required"
  | "caller-missing-scope"
  | "scope-outside-requested-roles"
  | "bootstrap-role-not-allowed"
  | "bootstrap-scope-not-allowed";

/** Structured forbidden result with the missing/disallowed role or scope when known. */
type DevicePairingForbiddenResult = {
  status: "forbidden";
  reason: DevicePairingForbiddenReason;
  scope?: string;
  role?: string;
};

/** Pairing approval outcome: approved, forbidden with reason, or request not found. */
type ApproveDevicePairingResult =
  | {
      status: "approved";
      requestId: string;
      device: PairedDevice;
      /** Existing connected node transports must be retired before success is returned. */
      nodePairingGenerationChanged?: true;
    }
  | DevicePairingForbiddenResult
  | null;

/** Format a device-pairing authorization failure for CLI/API callers. */
export function formatDevicePairingForbiddenMessage(result: DevicePairingForbiddenResult): string {
  switch (result.reason) {
    case "caller-scopes-required":
      return `missing scope: ${result.scope ?? "callerScopes-required"}`;
    case "caller-missing-scope":
      return `missing scope: ${result.scope ?? "unknown"}`;
    case "scope-outside-requested-roles":
      return `invalid scope for requested roles: ${result.scope ?? "unknown"}`;
    case "bootstrap-role-not-allowed":
      return `bootstrap profile does not allow role: ${result.role ?? "unknown"}`;
    case "bootstrap-scope-not-allowed":
      return `bootstrap profile does not allow scope: ${result.scope ?? "unknown"}`;
  }
  throw new Error("Unsupported device pairing forbidden reason");
}

// Interactive approvals must stay sticky: a later silent repair/re-approve of the
// same device id cannot downgrade an owner/bootstrap record into prune-eligible
// state. Pre-provenance records (approvedVia undefined) may have been approved by
// an owner, so a non-interactive re-approve must keep them protected (undefined).
function mergeApprovalKind(
  existing: PairedDevice | undefined,
  incoming: PairedDeviceApprovalKind,
): PairedDeviceApprovalKind | undefined {
  if (incoming === "owner" || !existing) {
    return incoming;
  }
  if (existing.approvedVia === undefined) {
    return incoming === "bootstrap" ? "bootstrap" : undefined;
  }
  if (existing.approvedVia === "owner" || existing.approvedVia === "bootstrap") {
    return existing.approvedVia;
  }
  return incoming;
}

function buildApprovedPairedDevice(params: {
  pending: DevicePairingPendingRequest;
  existing: PairedDevice | undefined;
  roles: string[] | undefined;
  approvedScopes: string[] | undefined;
  tokens: Record<string, DeviceAuthToken>;
  now: number;
  approvedVia: PairedDeviceApprovalKind;
  accessMetadata?: DevicePairingAccessMetadata;
}): PairedDevice {
  return {
    deviceId: params.pending.deviceId,
    publicKey: params.pending.publicKey,
    displayName: params.accessMetadata?.displayName ?? params.pending.displayName,
    platform: params.pending.platform,
    deviceFamily: params.pending.deviceFamily,
    clientId: params.pending.clientId,
    clientMode: params.pending.clientMode,
    browserOrigin: params.pending.browserOrigin,
    role: params.pending.role,
    roles: params.roles,
    scopes: params.approvedScopes,
    approvedScopes: params.approvedScopes,
    remoteIp: params.accessMetadata?.remoteIp ?? params.pending.remoteIp,
    tokens: params.tokens,
    approvedVia: mergeApprovalKind(params.existing, params.approvedVia),
    // Node capability approvals ride on the device record; device repair or
    // role re-approval must not silently revoke an approved node surface.
    ...(params.existing?.nodeSurface ? { nodeSurface: params.existing.nodeSurface } : {}),
    ...(params.existing?.pendingNodeSurface
      ? { pendingNodeSurface: params.existing.pendingNodeSurface }
      : {}),
    // Operator-assigned label is owner-side state; device repair or role
    // re-approval must not silently drop it.
    ...(params.existing?.operatorLabel ? { operatorLabel: params.existing.operatorLabel } : {}),
    createdAtMs: params.existing?.createdAtMs ?? params.now,
    approvedAtMs: params.now,
    lastSeenAtMs: params.accessMetadata?.lastSeenAtMs ?? params.existing?.lastSeenAtMs,
    lastSeenReason: params.accessMetadata?.lastSeenReason ?? params.existing?.lastSeenReason,
  };
}

function resolveApprovedTokenScopes(params: {
  role: string;
  pending: DevicePairingPendingRequest;
  existingToken?: DeviceAuthToken;
  approvedScopes?: string[];
  existing?: PairedDevice;
}): string[] {
  const pendingScopes = resolveRoleTokenScopes(params.role, params.pending.scopes);
  if (pendingScopes.length > 0) {
    const approvedBaseline = resolveRoleTokenScopes(
      params.role,
      params.existing?.approvedScopes ?? params.existing?.scopes,
    );
    const requestedScopeDelta =
      params.existingToken && approvedBaseline.length > 0
        ? pendingScopes.filter((scope) => !approvedBaseline.includes(scope))
        : pendingScopes;
    if (requestedScopeDelta.length === 0 && params.existingToken) {
      return resolveRoleTokenScopes(params.role, params.existingToken.scopes);
    }
    return resolveRoleTokenScopes(
      params.role,
      mergeDevicePairingScopes(params.existingToken?.scopes, requestedScopeDelta),
    );
  }
  return resolveRoleTokenScopes(
    params.role,
    params.existingToken?.scopes ??
      params.approvedScopes ??
      params.existing?.approvedScopes ??
      params.existing?.scopes,
  );
}

/** Approve a pending request with optional caller-scope checks for operator grants. */
export async function approveDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveDevicePairing(
  requestId: string,
  options: {
    callerScopes?: readonly string[];
    accessMetadata?: DevicePairingAccessMetadata;
    approvedVia?: Extract<
      PairedDeviceApprovalKind,
      "owner" | "silent" | "trusted-cidr" | "trusted-proxy" | "ssh-verified"
    >;
    /**
     * Replace the pending scopes only for a brand-new operator device, or — under
     * trusted-proxy approval — for a known operator device re-requesting with its
     * already-paired public key. The live role set is rechecked under the pairing
     * lock so a merged request cannot inherit non-operator access through browser
     * auto-approval.
     */
    autoApproveNewDeviceScopes?: readonly string[];
  },
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveDevicePairing(
  requestId: string,
  optionsOrBaseDir?:
    | {
        callerScopes?: readonly string[];
        accessMetadata?: DevicePairingAccessMetadata;
        approvedVia?: Extract<
          PairedDeviceApprovalKind,
          "owner" | "silent" | "trusted-cidr" | "trusted-proxy" | "ssh-verified"
        >;
        autoApproveNewDeviceScopes?: readonly string[];
      }
    | string,
  maybeBaseDir?: string,
): Promise<ApproveDevicePairingResult> {
  const options =
    typeof optionsOrBaseDir === "string" || optionsOrBaseDir === undefined
      ? undefined
      : optionsOrBaseDir;
  const baseDir = typeof optionsOrBaseDir === "string" ? optionsOrBaseDir : maybeBaseDir;
  return await approveDevicePairingWithOptions(requestId, options, baseDir);
}

async function approveDevicePairingWithOptions(
  requestId: string,
  options:
    | {
        callerScopes?: readonly string[];
        accessMetadata?: DevicePairingAccessMetadata;
        approvedVia?: Extract<
          PairedDeviceApprovalKind,
          "owner" | "silent" | "trusted-cidr" | "trusted-proxy" | "ssh-verified"
        >;
        autoApproveNewDeviceScopes?: readonly string[];
      }
    | undefined,
  baseDir?: string,
): Promise<ApproveDevicePairingResult> {
  return await withDevicePairingLock(async () => {
    const state = await loadDevicePairingState(baseDir);
    const pendingRecord = state.pendingById[requestId];
    if (!pendingRecord) {
      return null;
    }
    const autoApproveScopes = options?.autoApproveNewDeviceScopes;
    const requestedRoles = resolveRequestedDeviceRoles(pendingRecord);
    const knownDevice = state.pairedByDeviceId[pendingRecord.deviceId];
    // Trusted-proxy connects carry an SSO-authenticated user, and the connect
    // handshake has already proven possession of the pending public key. A
    // matching key on the paired record is therefore the same physical device
    // re-requesting (typically a scope upgrade) and may auto-approve; a key
    // mismatch is a real repair — possibly a deviceId squat — and stays a
    // manual owner decision.
    const trustedProxySameKeyDevice =
      options?.approvedVia === "trusted-proxy" &&
      knownDevice !== undefined &&
      knownDevice.publicKey === pendingRecord.publicKey;
    if (
      autoApproveScopes &&
      (((pendingRecord.isRepair || knownDevice) && !trustedProxySameKeyDevice) ||
        !sameDevicePairingStringSet(requestedRoles, [OPERATOR_ROLE]))
    ) {
      return null;
    }
    const pending = autoApproveScopes
      ? { ...pendingRecord, scopes: [...autoApproveScopes] }
      : pendingRecord;
    const requestedScopes = normalizeDeviceAuthScopes(pending.scopes);
    const roleMismatchScope = resolveScopeOutsideRequestedRoles({
      requestedRoles,
      requestedScopes,
    });
    if (roleMismatchScope) {
      return {
        status: "forbidden",
        reason: "scope-outside-requested-roles",
        scope: roleMismatchScope,
      };
    }
    const now = Date.now();
    const existing = state.pairedByDeviceId[pending.deviceId];
    const roles = mergeDevicePairingRoles(
      existing?.roles,
      existing?.role,
      pending.roles,
      pending.role,
    );
    const approvedScopes = mergeDevicePairingScopes(
      existing?.approvedScopes ?? existing?.scopes,
      pending.scopes,
    );
    const previousNodeGeneration = resolveNodePairingGeneration(existing ?? null);
    const tokens = existing?.tokens ? { ...existing.tokens } : {};
    const nextTokenScopesByRole = new Map<string, string[]>();
    for (const roleForToken of requestedRoles) {
      const existingToken = tokens[roleForToken];
      const nextScopes = resolveApprovedTokenScopes({
        role: roleForToken,
        pending,
        existingToken,
        approvedScopes,
        existing,
      });
      nextTokenScopesByRole.set(roleForToken, nextScopes);
      if (roleForToken === OPERATOR_ROLE && nextScopes.length > 0) {
        const callerRequiredScopes =
          mergeDevicePairingScopes(
            resolveRoleTokenScopes(roleForToken, pending.scopes),
            nextScopes,
          ) ?? nextScopes;
        if (!options?.callerScopes) {
          return {
            status: "forbidden",
            reason: "caller-scopes-required",
            scope: callerRequiredScopes[0],
          };
        }
        const missingScope = resolveMissingRequestedScope({
          role: OPERATOR_ROLE,
          requestedScopes: callerRequiredScopes,
          allowedScopes: options.callerScopes,
        });
        if (missingScope) {
          return { status: "forbidden", reason: "caller-missing-scope", scope: missingScope };
        }
      }
    }
    for (const [roleForToken, nextScopes] of nextTokenScopesByRole) {
      const existingToken = tokens[roleForToken];
      const tokenNow = Date.now();
      tokens[roleForToken] = {
        token: generatePairingToken(),
        role: roleForToken,
        scopes: nextScopes,
        createdAtMs: existingToken?.createdAtMs ?? tokenNow,
        rotatedAtMs: existingToken ? tokenNow : undefined,
        revokedAtMs: undefined,
        lastUsedAtMs: existingToken?.lastUsedAtMs,
      };
    }
    const device = buildApprovedPairedDevice({
      pending,
      existing,
      roles,
      approvedScopes,
      tokens,
      now,
      approvedVia: options?.approvedVia ?? "owner",
      accessMetadata: options?.accessMetadata,
    });
    const nextNodeGeneration = resolveNodePairingGeneration(device);
    const nodePairingGenerationChanged = Boolean(
      previousNodeGeneration && previousNodeGeneration.key !== nextNodeGeneration?.key,
    );
    clearNodePairingGenerationBins(device, previousNodeGeneration);
    const installationIdentityChanged = Boolean(
      existing && existing.publicKey !== device.publicKey,
    );
    delete state.pendingById[requestId];
    state.pairedByDeviceId[device.deviceId] = device;
    persistState(
      state,
      baseDir,
      "both",
      installationIdentityChanged ? { clearApnsNodeIds: [device.deviceId] } : undefined,
    );
    return {
      status: "approved",
      requestId,
      device,
      ...(nodePairingGenerationChanged ? { nodePairingGenerationChanged: true as const } : {}),
    };
  });
}

/** Approve a pending request through a bounded bootstrap profile handoff. */
export async function approveBootstrapDevicePairing(
  requestId: string,
  bootstrapProfile: DeviceBootstrapProfile,
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveBootstrapDevicePairing(
  requestId: string,
  bootstrapProfile: DeviceBootstrapProfile,
  options: { accessMetadata?: DevicePairingAccessMetadata },
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveBootstrapDevicePairing(
  requestId: string,
  bootstrapProfile: DeviceBootstrapProfile,
  optionsOrBaseDir?: { accessMetadata?: DevicePairingAccessMetadata } | string,
  maybeBaseDir?: string,
): Promise<ApproveDevicePairingResult> {
  const options =
    typeof optionsOrBaseDir === "string" || optionsOrBaseDir === undefined
      ? undefined
      : optionsOrBaseDir;
  const baseDir = typeof optionsOrBaseDir === "string" ? optionsOrBaseDir : maybeBaseDir;
  const approvedRoles = mergeDevicePairingRoles(bootstrapProfile.roles) ?? [];
  const approvedScopes = resolveDeviceProfileScopes(bootstrapProfile, approvedRoles);
  return await withDevicePairingLock(async () => {
    const state = await loadDevicePairingState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) {
      return null;
    }
    const requestedRoles = resolveRequestedDeviceRoles(pending);
    const missingRole = requestedRoles.find((role) => !approvedRoles.includes(role));
    if (missingRole) {
      return { status: "forbidden", reason: "bootstrap-role-not-allowed", role: missingRole };
    }
    const requestedOperatorScopes = normalizeDeviceAuthScopes(pending.scopes).filter((scope) =>
      scope.startsWith(OPERATOR_SCOPE_PREFIX),
    );
    const missingScope = resolveMissingRequestedScope({
      role: OPERATOR_ROLE,
      requestedScopes: requestedOperatorScopes,
      allowedScopes: approvedScopes,
    });
    if (missingScope) {
      return { status: "forbidden", reason: "bootstrap-scope-not-allowed", scope: missingScope };
    }

    const now = Date.now();
    const existing = state.pairedByDeviceId[pending.deviceId];
    const grantedRoles = requestedRoles;
    const grantedScopes = resolveDeviceProfileScopes(
      bootstrapProfile,
      grantedRoles,
      pending.scopes ?? [],
    );
    const grantedRoleSet = new Set(grantedRoles);
    const preservedExistingScopes = (
      mergeDevicePairingRoles(existing?.roles, existing?.role) ?? []
    ).flatMap((existingRole) =>
      grantedRoleSet.has(existingRole)
        ? []
        : preserveDeviceRoleScopes(existingRole, existing?.approvedScopes ?? existing?.scopes),
    );
    const roles = mergeDevicePairingRoles(
      existing?.roles,
      existing?.role,
      pending.roles,
      pending.role,
    );
    const nextApprovedScopes = mergeDevicePairingScopes(preservedExistingScopes, grantedScopes);
    const previousNodeGeneration = resolveNodePairingGeneration(existing ?? null);
    const tokens = existing?.tokens ? { ...existing.tokens } : {};
    for (const roleForToken of grantedRoles) {
      const existingToken = tokens[roleForToken];
      const tokenScopes =
        roleForToken === OPERATOR_ROLE
          ? resolveDeviceProfileRoleScopes(bootstrapProfile, roleForToken, grantedScopes)
          : [];
      tokens[roleForToken] = createDeviceAuthToken({
        role: roleForToken,
        scopes: tokenScopes,
        existing: existingToken,
        now,
        ...(existingToken ? { rotatedAtMs: now } : {}),
      });
    }

    const device = buildApprovedPairedDevice({
      pending,
      existing,
      roles,
      approvedScopes: nextApprovedScopes,
      tokens,
      now,
      approvedVia: "bootstrap",
      accessMetadata: options?.accessMetadata,
    });
    const nextNodeGeneration = resolveNodePairingGeneration(device);
    const nodePairingGenerationChanged = Boolean(
      previousNodeGeneration && previousNodeGeneration.key !== nextNodeGeneration?.key,
    );
    clearNodePairingGenerationBins(device, previousNodeGeneration);
    const installationIdentityChanged = Boolean(
      existing && existing.publicKey !== device.publicKey,
    );
    delete state.pendingById[requestId];
    state.pairedByDeviceId[device.deviceId] = device;
    persistState(
      state,
      baseDir,
      "both",
      installationIdentityChanged ? { clearApnsNodeIds: [device.deviceId] } : undefined,
    );
    return {
      status: "approved",
      requestId,
      device,
      ...(nodePairingGenerationChanged ? { nodePairingGenerationChanged: true as const } : {}),
    };
  });
}
