import { getRuntimeConfig } from "../config/io.js";
import {
  hasEffectivePairedDeviceRole,
  listDevicePairing,
  type DeviceAuthToken,
  type PairedDevice,
} from "../infra/device-pairing.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "../infra/exec-approvals.js";
import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsExecApprovalAlert,
  sendApnsExecApprovalResolvedWake,
  shouldClearStoredApnsRegistration,
  type ApnsAuthConfig,
  type ApnsRegistration,
  type ApnsRelayConfig,
} from "../infra/push-apns.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

const APPROVALS_SCOPE = "operator.approvals";
const OPERATOR_ROLE = "operator";

type GatewayLikeLogger = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type DeliveryTarget = {
  nodeId: string;
  registration: ApnsRegistration;
};

type DeliveryPlan = {
  targets: DeliveryTarget[];
  directAuth?: ApnsAuthConfig;
  relayConfig?: ApnsRelayConfig;
};

type ApprovalDeliveryState = {
  nodeIds: string[];
  requestPushPromise: Promise<{ attempted: number; delivered: number }>;
};

function isIosPlatform(platform: string | undefined): boolean {
  const normalized = normalizeOptionalLowercaseString(platform) ?? "";
  return normalized.startsWith("ios") || normalized.startsWith("ipados");
}

function resolveActiveOperatorToken(device: PairedDevice): DeviceAuthToken | null {
  const operatorToken = device.tokens?.[OPERATOR_ROLE];
  if (!operatorToken || operatorToken.revokedAtMs) {
    return null;
  }
  return operatorToken;
}

function canApproveExecRequests(device: PairedDevice): boolean {
  const operatorToken = resolveActiveOperatorToken(device);
  if (!operatorToken) {
    return false;
  }
  return roleScopesAllow({
    role: OPERATOR_ROLE,
    requestedScopes: [APPROVALS_SCOPE],
    allowedScopes: operatorToken.scopes,
  });
}

function shouldTargetDevice(params: {
  device: PairedDevice;
  requireApprovalScope: boolean;
}): boolean {
  if (!isIosPlatform(params.device.platform)) {
    return false;
  }
  if (!hasEffectivePairedDeviceRole(params.device, OPERATOR_ROLE)) {
    return false;
  }
  if (!params.requireApprovalScope) {
    return true;
  }
  return canApproveExecRequests(params.device);
}

async function loadRegisteredTargets(params: {
  deviceIds: readonly string[];
}): Promise<DeliveryTarget[]> {
  const targets = await Promise.all(
    params.deviceIds.map(async (nodeId) => {
      const registration = await loadApnsRegistration(nodeId);
      return registration ? { nodeId, registration } : null;
    }),
  );
  return targets.filter((target): target is DeliveryTarget => target !== null);
}

async function resolvePairedTargets(params: {
  requireApprovalScope: boolean;
}): Promise<DeliveryTarget[]> {
  const pairing = await listDevicePairing();
  const deviceIds = pairing.paired
    .filter((device) =>
      shouldTargetDevice({ device, requireApprovalScope: params.requireApprovalScope }),
    )
    .map((device) => device.deviceId);
  return await loadRegisteredTargets({ deviceIds });
}

async function resolveDeliveryPlan(params: {
  requireApprovalScope: boolean;
  explicitNodeIds?: readonly string[];
  log: GatewayLikeLogger;
}): Promise<DeliveryPlan> {
  const targets = params.explicitNodeIds?.length
    ? await loadRegisteredTargets({ deviceIds: params.explicitNodeIds })
    : await resolvePairedTargets({ requireApprovalScope: params.requireApprovalScope });
  if (targets.length === 0) {
    return { targets: [] };
  }

  const needsDirect = targets.some((target) => target.registration.transport === "direct");
  const needsRelay = targets.some((target) => target.registration.transport === "relay");

  let directAuth: ApnsAuthConfig | undefined;
  if (needsDirect) {
    const auth = await resolveApnsAuthConfigFromEnv(process.env);
    if (auth.ok) {
      directAuth = auth.value;
    } else {
      params.log.warn?.(`exec approvals: iOS direct APNs auth unavailable: ${auth.error}`);
    }
  }

  let relayConfig: ApnsRelayConfig | undefined;
  if (needsRelay) {
    const relay = resolveApnsRelayConfigFromEnv(process.env, getRuntimeConfig().gateway);
    if (relay.ok) {
      relayConfig = relay.value;
    } else {
      params.log.warn?.(`exec approvals: iOS relay APNs config unavailable: ${relay.error}`);
    }
  }

  return {
    targets: targets.filter((target) =>
      target.registration.transport === "direct" ? Boolean(directAuth) : Boolean(relayConfig),
    ),
    directAuth,
    relayConfig,
  };
}

async function clearStaleApnsRegistrationIfNeeded(params: {
  nodeId: string;
  registration: ApnsRegistration;
  result: { status: number; reason?: string };
}): Promise<void> {
  if (
    shouldClearStoredApnsRegistration({
      registration: params.registration,
      result: params.result,
    })
  ) {
    await clearApnsRegistrationIfCurrent({
      nodeId: params.nodeId,
      registration: params.registration,
    });
  }
}

async function sendRequestedPushes(params: {
  request: ExecApprovalRequest;
  plan: DeliveryPlan;
  log: GatewayLikeLogger;
}): Promise<{ attempted: number; delivered: number }> {
  const results = await Promise.allSettled(
    params.plan.targets.map(async (target) => {
      const result =
        target.registration.transport === "direct"
          ? await sendApnsExecApprovalAlert({
              registration: target.registration,
              nodeId: target.nodeId,
              approvalId: params.request.id,
              auth: params.plan.directAuth!,
            })
          : await sendApnsExecApprovalAlert({
              registration: target.registration,
              nodeId: target.nodeId,
              approvalId: params.request.id,
              relayConfig: params.plan.relayConfig!,
            });
      await clearStaleApnsRegistrationIfNeeded({
        nodeId: target.nodeId,
        registration: target.registration,
        result,
      });
      if (!result.ok) {
        params.log.warn?.(
          `exec approvals: iOS request push failed node=${target.nodeId} status=${result.status} reason=${result.reason ?? "unknown"}`,
        );
      }
      return { nodeId: target.nodeId, ok: result.ok };
    }),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      const message = formatErrorMessage(result.reason);
      params.log.warn?.(`exec approvals: iOS request push threw error: ${message}`);
    }
  }
  return {
    attempted: params.plan.targets.length,
    delivered: results.filter((result) => result.status === "fulfilled" && result.value.ok).length,
  };
}

async function sendResolvedPushes(params: {
  approvalId: string;
  plan: DeliveryPlan;
  log: GatewayLikeLogger;
}): Promise<void> {
  await Promise.allSettled(
    params.plan.targets.map(async (target) => {
      const result =
        target.registration.transport === "direct"
          ? await sendApnsExecApprovalResolvedWake({
              registration: target.registration,
              nodeId: target.nodeId,
              approvalId: params.approvalId,
              auth: params.plan.directAuth!,
            })
          : await sendApnsExecApprovalResolvedWake({
              registration: target.registration,
              nodeId: target.nodeId,
              approvalId: params.approvalId,
              relayConfig: params.plan.relayConfig!,
            });
      await clearStaleApnsRegistrationIfNeeded({
        nodeId: target.nodeId,
        registration: target.registration,
        result,
      });
      if (!result.ok) {
        params.log.warn?.(
          `exec approvals: iOS cleanup push failed node=${target.nodeId} status=${result.status} reason=${result.reason ?? "unknown"}`,
        );
      }
    }),
  );
}

export function createExecApprovalIosPushDelivery(params: { log: GatewayLikeLogger }) {
  const approvalDeliveriesById = new Map<string, ApprovalDeliveryState>();
  const pendingDeliveryStateById = new Map<string, Promise<ApprovalDeliveryState | null>>();

  return {
    async handleRequested(request: ExecApprovalRequest): Promise<boolean> {
      const deliveryStatePromise = (async (): Promise<ApprovalDeliveryState | null> => {
        const plan = await resolveDeliveryPlan({
          requireApprovalScope: true,
          log: params.log,
        });
        if (plan.targets.length === 0) {
          approvalDeliveriesById.delete(request.id);
          return null;
        }

        const deliveryState: ApprovalDeliveryState = {
          nodeIds: plan.targets.map((target) => target.nodeId),
          requestPushPromise: sendRequestedPushes({ request, plan, log: params.log }).catch(
            (err) => {
              const message = formatErrorMessage(err);
              params.log.error?.(`exec approvals: iOS request push failed: ${message}`);
              return { attempted: plan.targets.length, delivered: 0 };
            },
          ),
        };
        approvalDeliveriesById.set(request.id, deliveryState);
        return deliveryState;
      })();
      pendingDeliveryStateById.set(request.id, deliveryStatePromise);

      const deliveryState = await deliveryStatePromise;
      if (pendingDeliveryStateById.get(request.id) === deliveryStatePromise) {
        pendingDeliveryStateById.delete(request.id);
      }
      if (!deliveryState) {
        return false;
      }

      const { attempted, delivered } = await deliveryState.requestPushPromise;
      if (attempted > 0 && delivered === 0) {
        params.log.warn?.(
          `exec approvals: iOS request push reached no devices approvalId=${request.id} attempted=${attempted}`,
        );
        if (
          approvalDeliveriesById.get(request.id)?.requestPushPromise ===
          deliveryState.requestPushPromise
        ) {
          approvalDeliveriesById.delete(request.id);
        }
        return false;
      }
      return true;
    },

    async handleResolved(resolved: ExecApprovalResolved): Promise<void> {
      const deliveryState =
        approvalDeliveriesById.get(resolved.id) ??
        (await pendingDeliveryStateById.get(resolved.id));
      approvalDeliveriesById.delete(resolved.id);
      pendingDeliveryStateById.delete(resolved.id);
      if (!deliveryState?.nodeIds.length) {
        params.log.debug?.(
          `exec approvals: iOS cleanup push skipped approvalId=${resolved.id} reason=missing-targets`,
        );
        return;
      }
      await deliveryState.requestPushPromise;
      const plan = await resolveDeliveryPlan({
        requireApprovalScope: false,
        explicitNodeIds: deliveryState.nodeIds,
        log: params.log,
      });
      if (plan.targets.length === 0) {
        return;
      }
      await sendResolvedPushes({
        approvalId: resolved.id,
        plan,
        log: params.log,
      });
    },

    async handleExpired(request: ExecApprovalRequest): Promise<void> {
      const deliveryState =
        approvalDeliveriesById.get(request.id) ?? (await pendingDeliveryStateById.get(request.id));
      approvalDeliveriesById.delete(request.id);
      pendingDeliveryStateById.delete(request.id);
      if (!deliveryState?.nodeIds.length) {
        params.log.debug?.(
          `exec approvals: iOS cleanup push skipped approvalId=${request.id} reason=missing-targets`,
        );
        return;
      }
      await deliveryState.requestPushPromise;
      const plan = await resolveDeliveryPlan({
        requireApprovalScope: false,
        explicitNodeIds: deliveryState.nodeIds,
        log: params.log,
      });
      if (plan.targets.length === 0) {
        return;
      }
      await sendResolvedPushes({
        approvalId: request.id,
        plan,
        log: params.log,
      });
    },
  };
}
