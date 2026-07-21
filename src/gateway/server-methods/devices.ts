// Gateway RPC handlers for device pairing and device-token lifecycle operations.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateDevicePairApproveParams,
  validateDevicePairListParams,
  validateDevicePairRemoveParams,
  validateDevicePairRejectParams,
  validateDevicePairRenameParams,
  validateDeviceTokenRevokeParams,
  validateDeviceTokenRotateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  approveDevicePairing,
  formatDevicePairingForbiddenMessage,
  getPairedDevice,
  getPendingDevicePairing,
  listDevicePairing,
  removePairedDevice,
  type DeviceAuthToken,
  type RevokeDeviceTokenDenyReason,
  type RotateDeviceTokenDenyReason,
  rejectDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
  summarizeDeviceTokens,
  updatePairedDeviceMetadata,
} from "../../infra/device-pairing.js";
import type { DiagnosticSecurityEventInput } from "../../infra/diagnostic-events.js";
import { clearRemovedNodeRuntimeState } from "../node-runtime-state.js";
import { invalidateNodeWakeState } from "../node-wake-state.js";
import {
  deniesCrossDeviceManagement,
  deniesDeviceTokenRoleManagement,
  pairedDeviceHasNonOperatorRole,
  requestsNonOperatorDeviceRole,
  resolveDeviceManagementAuthz,
  resolveDeviceSessionAuthz,
} from "./device-management-authz.js";
import type { DeviceManagementAuthz } from "./device-management-authz.js";
import { emitDeviceManagementSecurityEvent } from "./device-management-security.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEVICE_TOKEN_ROTATION_DENIED_MESSAGE = "device token rotation denied";
const DEVICE_TOKEN_REVOCATION_DENIED_MESSAGE = "device token revocation denied";

type DeviceSessionAuthz = ReturnType<typeof resolveDeviceSessionAuthz>;

const DEVICE_PAIR_APPROVAL_DENIED_MESSAGE = "device pairing approval denied";
const DEVICE_PAIR_REJECTION_DENIED_MESSAGE = "device pairing rejection denied";

function redactPairedDevice(
  device: { tokens?: Record<string, DeviceAuthToken> } & Record<string, unknown>,
  opts?: { connected?: boolean },
) {
  // Pairing lists are visible to operators; expose token lifecycle metadata
  // without returning raw token material or the internal approved-scope set.
  const { tokens, approvedScopes: _approvedScopes, ...rest } = device;
  return {
    ...rest,
    ...(opts?.connected !== undefined ? { connected: opts.connected } : {}),
    tokens: summarizeDeviceTokens(tokens),
  };
}

function logDeviceTokenRotationDenied(params: {
  log: { warn: (message: string) => void };
  deviceId: string;
  role: string;
  reason:
    | RotateDeviceTokenDenyReason
    | "unknown-device-or-role"
    | "device-ownership-mismatch"
    | "role-management-requires-admin";
  scope?: string | null;
}) {
  const suffix = params.scope ? ` scope=${params.scope}` : "";
  params.log.warn(
    `device token rotation denied device=${params.deviceId} role=${params.role} reason=${params.reason}${suffix}`,
  );
}

function logDeviceTokenRevocationDenied(params: {
  log: { warn: (message: string) => void };
  deviceId: string;
  role: string;
  reason:
    | RevokeDeviceTokenDenyReason
    | "device-ownership-mismatch"
    | "role-management-requires-admin";
  scope?: string | null;
}) {
  const suffix = params.scope ? ` scope=${params.scope}` : "";
  params.log.warn(
    `device token revocation denied device=${params.deviceId} role=${params.role} reason=${params.reason}${suffix}`,
  );
}

function shouldReturnRotatedDeviceToken(authz: DeviceManagementAuthz): boolean {
  // Admins can rotate any token, but only a device rotating itself receives
  // the new token in-band; other rotations are notification/invalidations.
  return Boolean(authz.callerDeviceId && authz.callerDeviceId === authz.normalizedTargetDeviceId);
}

function emitDeviceSecurityEvent(params: {
  action: string;
  outcome: DiagnosticSecurityEventInput["outcome"];
  severity: DiagnosticSecurityEventInput["severity"];
  authz: DeviceSessionAuthz;
  targetDeviceId?: string;
  policyId: string;
  decision: NonNullable<DiagnosticSecurityEventInput["policy"]>["decision"];
  controlId: string;
  reason?: string;
  attributes?: Record<string, string | number | boolean>;
}) {
  emitDeviceManagementSecurityEvent(params);
}

function emitDevicePairingDeniedSecurityEvent(params: {
  authz: DeviceSessionAuthz;
  targetDeviceId?: string;
  controlId: string;
  reason: string;
  severity?: DiagnosticSecurityEventInput["severity"];
}) {
  emitDeviceSecurityEvent({
    action: "device.pairing.denied",
    outcome: "denied",
    severity: params.severity ?? "medium",
    authz: params.authz,
    targetDeviceId: params.targetDeviceId,
    policyId: "gateway.device-pairing",
    decision: "deny",
    controlId: params.controlId,
    reason: params.reason,
  });
}

function emitDevicePairingLifecycleSecurityEvent(params: {
  action:
    | "device.pairing.approved"
    | "device.pairing.rejected"
    | "device.pairing.removed"
    | "device.pairing.renamed";
  severity: DiagnosticSecurityEventInput["severity"];
  authz: DeviceSessionAuthz;
  targetDeviceId: string;
  controlId: string;
  attributes?: Record<string, string | number | boolean>;
}) {
  emitDeviceSecurityEvent({
    action: params.action,
    outcome: "success",
    severity: params.severity,
    authz: params.authz,
    targetDeviceId: params.targetDeviceId,
    policyId: "gateway.device-pairing",
    decision: "allow",
    controlId: params.controlId,
    attributes: params.attributes,
  });
}

function emitDeviceTokenDeniedSecurityEvent(params: {
  action: "device.token.rotation_denied" | "device.token.revocation_denied";
  authz: DeviceSessionAuthz;
  targetDeviceId: string;
  controlId: string;
  reason: string;
  role: string;
}) {
  emitDeviceSecurityEvent({
    action: params.action,
    outcome: "denied",
    severity: "medium",
    authz: params.authz,
    targetDeviceId: params.targetDeviceId,
    policyId: "gateway.device-token",
    decision: "deny",
    controlId: params.controlId,
    reason: params.reason,
    attributes: { role: params.role.trim() },
  });
}

function emitDeviceTokenLifecycleSecurityEvent(params: {
  action: "device.token.rotated" | "device.token.revoked";
  severity: DiagnosticSecurityEventInput["severity"];
  authz: DeviceSessionAuthz;
  targetDeviceId: string;
  controlId: string;
  role: string;
  scopeCount?: number;
}) {
  emitDeviceSecurityEvent({
    action: params.action,
    outcome: "success",
    severity: params.severity,
    authz: params.authz,
    targetDeviceId: params.targetDeviceId,
    policyId: "gateway.device-token",
    decision: "allow",
    controlId: params.controlId,
    attributes: {
      role: params.role,
      ...(params.scopeCount !== undefined ? { scope_count: params.scopeCount } : {}),
    },
  });
}

/** Gateway request handlers for device pair approval, removal, token rotation, and revocation. */
export const deviceHandlers: GatewayRequestHandlers = {
  "device.pair.list": async ({ params, respond, context, client }) => {
    if (!validateDevicePairListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.list params: ${formatValidationErrors(
            validateDevicePairListParams.errors,
          )}`,
        ),
      );
      return;
    }
    const list = await listDevicePairing();
    const authz = resolveDeviceSessionAuthz(client);
    const visibleList =
      authz.callerDeviceId && !authz.isAdminCaller
        ? {
            pending: list.pending.filter(
              (request) => request.deviceId.trim() === authz.callerDeviceId,
            ),
            paired: list.paired.filter((device) => device.deviceId.trim() === authz.callerDeviceId),
          }
        : list;
    respond(
      true,
      {
        pending: visibleList.pending,
        // Live-connection state lets clients distinguish active pairings from
        // stale ones; node-role links alone do not cover operator clients.
        paired: visibleList.paired.map((device) =>
          redactPairedDevice(device, {
            connected: context.hasConnectedClientsForDevice?.(device.deviceId.trim()) ?? false,
          }),
        ),
      },
      undefined,
    );
  },
  "device.pair.approve": async ({ params, respond, context, client }) => {
    if (!validateDevicePairApproveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.approve params: ${formatValidationErrors(
            validateDevicePairApproveParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { requestId } = params as { requestId: string };
    const authz = resolveDeviceSessionAuthz(client);
    if (!authz.isAdminCaller) {
      const pending = await getPendingDevicePairing(requestId);
      if (!pending) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_APPROVAL_DENIED_MESSAGE),
        );
        return;
      }
      if (authz.callerDeviceId && pending.deviceId.trim() !== authz.callerDeviceId) {
        context.logGateway.warn(
          `device pairing approval denied request=${requestId} reason=device-ownership-mismatch`,
        );
        emitDevicePairingDeniedSecurityEvent({
          authz,
          targetDeviceId: pending.deviceId,
          controlId: "device.pair.approve",
          reason: "device-ownership-mismatch",
        });
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_APPROVAL_DENIED_MESSAGE),
        );
        return;
      }
      if (requestsNonOperatorDeviceRole(pending)) {
        context.logGateway.warn(
          `device pairing approval denied request=${requestId} reason=role-management-requires-admin`,
        );
        emitDevicePairingDeniedSecurityEvent({
          authz,
          targetDeviceId: pending.deviceId,
          controlId: "device.pair.approve",
          reason: "role-management-requires-admin",
        });
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_APPROVAL_DENIED_MESSAGE),
        );
        return;
      }
    }
    const approved = await approveDevicePairing(requestId, { callerScopes: authz.callerScopes });
    if (!approved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
      return;
    }
    if (approved.status === "forbidden") {
      emitDevicePairingDeniedSecurityEvent({
        authz,
        controlId: "device.pair.approve",
        reason: approved.reason,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, formatDevicePairingForbiddenMessage(approved)),
      );
      return;
    }
    const normalizedDeviceId = approved.device.deviceId.trim();
    if (approved.nodePairingGenerationChanged) {
      invalidateNodeWakeState(normalizedDeviceId);
      // Mark the retired node generation before publishing success so buffered
      // node RPCs cannot retain authority while transport teardown is deferred.
      context.invalidateClientsForDevice?.(normalizedDeviceId, {
        role: "node",
        reason: "device-pairing-reapproved",
      });
    }
    context.logGateway.info(
      `device pairing approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`,
    );
    emitDevicePairingLifecycleSecurityEvent({
      action: "device.pairing.approved",
      severity: "low",
      authz,
      targetDeviceId: approved.device.deviceId,
      controlId: "device.pair.approve",
      attributes: {
        role_count: approved.device.roles?.length ?? (approved.device.role ? 1 : 0),
        scope_count: approved.device.approvedScopes?.length ?? approved.device.scopes?.length ?? 0,
      },
    });
    context.broadcast(
      "device.pair.resolved",
      {
        requestId,
        deviceId: approved.device.deviceId,
        decision: "approved",
        ts: Date.now(),
      },
      { dropIfSlow: true },
    );
    respond(true, { requestId, device: redactPairedDevice(approved.device) }, undefined);
    if (approved.nodePairingGenerationChanged) {
      queueMicrotask(() => {
        context.disconnectClientsForDevice?.(normalizedDeviceId, { role: "node" });
      });
    }
  },
  "device.pair.reject": async ({ params, respond, context, client }) => {
    if (!validateDevicePairRejectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.reject params: ${formatValidationErrors(
            validateDevicePairRejectParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { requestId } = params as { requestId: string };
    const authz = resolveDeviceSessionAuthz(client);
    if (authz.callerDeviceId && !authz.isAdminCaller) {
      const pending = await getPendingDevicePairing(requestId);
      if (!pending) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_REJECTION_DENIED_MESSAGE),
        );
        return;
      }
      if (pending.deviceId.trim() !== authz.callerDeviceId) {
        context.logGateway.warn(
          `device pairing rejection denied request=${requestId} reason=device-ownership-mismatch`,
        );
        emitDevicePairingDeniedSecurityEvent({
          authz,
          targetDeviceId: pending.deviceId,
          controlId: "device.pair.reject",
          reason: "device-ownership-mismatch",
        });
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_REJECTION_DENIED_MESSAGE),
        );
        return;
      }
    }
    const rejected = await rejectDevicePairing(requestId);
    if (!rejected) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
      return;
    }
    emitDevicePairingLifecycleSecurityEvent({
      action: "device.pairing.rejected",
      authz,
      targetDeviceId: rejected.deviceId,
      controlId: "device.pair.reject",
      severity: "low",
    });
    context.broadcast(
      "device.pair.resolved",
      {
        requestId,
        deviceId: rejected.deviceId,
        decision: "rejected",
        ts: Date.now(),
      },
      { dropIfSlow: true },
    );
    respond(true, rejected, undefined);
  },
  "device.pair.remove": async ({ params, respond, context, client }) => {
    if (!validateDevicePairRemoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.remove params: ${formatValidationErrors(
            validateDevicePairRemoveParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { deviceId } = params as { deviceId: string };
    const authz = resolveDeviceManagementAuthz(client, deviceId);
    if (deniesCrossDeviceManagement(authz)) {
      context.logGateway.warn(
        `device pairing removal denied device=${deviceId} reason=device-ownership-mismatch`,
      );
      emitDevicePairingDeniedSecurityEvent({
        authz,
        targetDeviceId: deviceId,
        controlId: "device.pair.remove",
        reason: "device-ownership-mismatch",
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "device pairing removal denied"),
      );
      return;
    }
    if (authz.callerDeviceId && !authz.isAdminCaller) {
      const paired = await getPairedDevice(authz.normalizedTargetDeviceId);
      if (paired && pairedDeviceHasNonOperatorRole(paired)) {
        context.logGateway.warn(
          `device pairing removal denied device=${deviceId} reason=role-management-requires-admin`,
        );
        emitDevicePairingDeniedSecurityEvent({
          authz,
          targetDeviceId: deviceId,
          controlId: "device.pair.remove",
          reason: "role-management-requires-admin",
        });
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "device pairing removal denied"),
        );
        return;
      }
    }
    const removed = await removePairedDevice(deviceId);
    if (!removed) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown deviceId"));
      return;
    }
    clearRemovedNodeRuntimeState({ nodeId: removed.deviceId, context });
    context.invalidateClientsForDevice?.(removed.deviceId, {
      reason: "device-pair-removed",
    });
    context.logGateway.info(`device pairing removed device=${removed.deviceId}`);
    emitDevicePairingLifecycleSecurityEvent({
      action: "device.pairing.removed",
      severity: "medium",
      authz,
      targetDeviceId: removed.deviceId,
      controlId: "device.pair.remove",
    });
    respond(true, removed, undefined);
    queueMicrotask(() => {
      context.disconnectClientsForDevice?.(removed.deviceId);
    });
  },
  "device.pair.rename": async ({ params, respond, context, client }) => {
    if (!validateDevicePairRenameParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.rename params: ${formatValidationErrors(
            validateDevicePairRenameParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { deviceId, label } = params as {
      deviceId: string;
      label: string;
    };
    const trimmed = label.trim();
    if (!trimmed) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "label required"));
      return;
    }
    const authz = resolveDeviceManagementAuthz(client, deviceId);
    if (deniesCrossDeviceManagement(authz)) {
      context.logGateway.warn(
        `device pairing rename denied device=${deviceId} reason=device-ownership-mismatch`,
      );
      emitDevicePairingDeniedSecurityEvent({
        authz,
        targetDeviceId: deviceId,
        controlId: "device.pair.rename",
        reason: "device-ownership-mismatch",
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "device pairing rename denied"),
      );
      return;
    }
    if (authz.callerDeviceId && !authz.isAdminCaller) {
      const paired = await getPairedDevice(authz.normalizedTargetDeviceId);
      if (paired && pairedDeviceHasNonOperatorRole(paired)) {
        context.logGateway.warn(
          `device pairing rename denied device=${deviceId} reason=role-management-requires-admin`,
        );
        emitDevicePairingDeniedSecurityEvent({
          authz,
          targetDeviceId: deviceId,
          controlId: "device.pair.rename",
          reason: "role-management-requires-admin",
        });
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "device pairing rename denied"),
        );
        return;
      }
    }
    const updated = await updatePairedDeviceMetadata(deviceId, { operatorLabel: trimmed });
    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown deviceId"));
      return;
    }
    context.logGateway.info(`device pairing renamed device=${deviceId} label=${trimmed}`);
    emitDevicePairingLifecycleSecurityEvent({
      action: "device.pairing.renamed",
      severity: "low",
      authz,
      targetDeviceId: deviceId,
      controlId: "device.pair.rename",
    });
    respond(true, { deviceId, label: trimmed }, undefined);
  },
  "device.token.rotate": async ({ params, respond, context, client }) => {
    if (!validateDeviceTokenRotateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.token.rotate params: ${formatValidationErrors(
            validateDeviceTokenRotateParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { deviceId, role, scopes } = params as {
      deviceId: string;
      role: string;
      scopes?: string[];
    };
    const authz = resolveDeviceManagementAuthz(client, deviceId);
    if (deniesCrossDeviceManagement(authz)) {
      logDeviceTokenRotationDenied({
        log: context.logGateway,
        deviceId,
        role,
        reason: "device-ownership-mismatch",
      });
      emitDeviceTokenDeniedSecurityEvent({
        action: "device.token.rotation_denied",
        authz,
        targetDeviceId: deviceId,
        controlId: "device.token.rotate",
        reason: "device-ownership-mismatch",
        role,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE),
      );
      return;
    }
    if (deniesDeviceTokenRoleManagement(authz, role)) {
      logDeviceTokenRotationDenied({
        log: context.logGateway,
        deviceId,
        role,
        reason: "role-management-requires-admin",
      });
      emitDeviceTokenDeniedSecurityEvent({
        action: "device.token.rotation_denied",
        authz,
        targetDeviceId: deviceId,
        controlId: "device.token.rotate",
        reason: "role-management-requires-admin",
        role,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE),
      );
      return;
    }
    const rotated = await rotateDeviceToken({
      deviceId,
      role,
      scopes,
      callerScopes: authz.callerScopes,
    });
    if (!rotated.ok) {
      logDeviceTokenRotationDenied({
        log: context.logGateway,
        deviceId,
        role,
        reason: rotated.reason,
        scope: rotated.scope,
      });
      emitDeviceTokenDeniedSecurityEvent({
        action: "device.token.rotation_denied",
        authz,
        targetDeviceId: deviceId,
        controlId: "device.token.rotate",
        reason: rotated.reason,
        role,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE),
      );
      return;
    }
    const entry = rotated.entry;
    const normalizedDeviceId = deviceId.trim();
    context.logGateway.info(
      `device token rotated device=${deviceId} role=${entry.role} scopes=${entry.scopes.join(",")}`,
    );
    emitDeviceTokenLifecycleSecurityEvent({
      action: "device.token.rotated",
      severity: "medium",
      authz,
      targetDeviceId: deviceId,
      controlId: "device.token.rotate",
      role: entry.role,
      scopeCount: entry.scopes.length,
    });
    if (entry.role === "node") {
      invalidateNodeWakeState(normalizedDeviceId);
    }
    // Mark affected clients invalid *before* responding so any RPCs already
    // pipelined into their WS socket buffer are rejected at the per-request
    // dispatch check, closing the race between queueMicrotask-scheduled
    // disconnect and inflight frames.
    context.invalidateClientsForDevice?.(normalizedDeviceId, {
      role: entry.role,
      reason: "device-token-rotated",
    });
    respond(
      true,
      {
        deviceId,
        role: entry.role,
        ...(shouldReturnRotatedDeviceToken(authz) ? { token: entry.token } : {}),
        scopes: entry.scopes,
        rotatedAtMs: entry.rotatedAtMs ?? entry.createdAtMs,
      },
      undefined,
    );
    queueMicrotask(() => {
      context.disconnectClientsForDevice?.(normalizedDeviceId, { role: entry.role });
    });
  },
  "device.token.revoke": async ({ params, respond, context, client }) => {
    if (!validateDeviceTokenRevokeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.token.revoke params: ${formatValidationErrors(
            validateDeviceTokenRevokeParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { deviceId, role } = params as { deviceId: string; role: string };
    const authz = resolveDeviceManagementAuthz(client, deviceId);
    if (deniesCrossDeviceManagement(authz)) {
      context.logGateway.warn(
        `device token revocation denied device=${deviceId} role=${role} reason=device-ownership-mismatch`,
      );
      emitDeviceTokenDeniedSecurityEvent({
        action: "device.token.revocation_denied",
        authz,
        targetDeviceId: deviceId,
        controlId: "device.token.revoke",
        reason: "device-ownership-mismatch",
        role,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_REVOCATION_DENIED_MESSAGE),
      );
      return;
    }
    if (deniesDeviceTokenRoleManagement(authz, role)) {
      logDeviceTokenRevocationDenied({
        log: context.logGateway,
        deviceId,
        role,
        reason: "role-management-requires-admin",
      });
      emitDeviceTokenDeniedSecurityEvent({
        action: "device.token.revocation_denied",
        authz,
        targetDeviceId: deviceId,
        controlId: "device.token.revoke",
        reason: "role-management-requires-admin",
        role,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_REVOCATION_DENIED_MESSAGE),
      );
      return;
    }
    const revoked = await revokeDeviceToken({ deviceId, role, callerScopes: authz.callerScopes });
    if (!revoked.ok) {
      logDeviceTokenRevocationDenied({
        log: context.logGateway,
        deviceId,
        role,
        reason: revoked.reason,
        scope: revoked.scope,
      });
      emitDeviceTokenDeniedSecurityEvent({
        action: "device.token.revocation_denied",
        authz,
        targetDeviceId: deviceId,
        controlId: "device.token.revoke",
        reason: revoked.reason,
        role,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_REVOCATION_DENIED_MESSAGE),
      );
      return;
    }
    const entry = revoked.entry;
    const normalizedDeviceId = deviceId.trim();
    context.logGateway.info(`device token revoked device=${normalizedDeviceId} role=${entry.role}`);
    emitDeviceTokenLifecycleSecurityEvent({
      action: "device.token.revoked",
      severity: "high",
      authz,
      targetDeviceId: normalizedDeviceId,
      controlId: "device.token.revoke",
      role: entry.role,
    });
    if (entry.role === "node") {
      invalidateNodeWakeState(normalizedDeviceId);
    }
    // Mark affected clients invalid *before* responding so any RPCs already
    // pipelined into their WS socket buffer are rejected at the per-request
    // dispatch check, closing the race between queueMicrotask-scheduled
    // disconnect and inflight frames.
    context.invalidateClientsForDevice?.(normalizedDeviceId, {
      role: entry.role,
      reason: "device-token-revoked",
    });
    respond(
      true,
      {
        deviceId: normalizedDeviceId,
        role: entry.role,
        revokedAtMs: entry.revokedAtMs ?? Date.now(),
      },
      undefined,
    );
    queueMicrotask(() => {
      context.disconnectClientsForDevice?.(normalizedDeviceId, { role: entry.role });
    });
  },
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
