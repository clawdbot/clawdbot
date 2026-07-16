// Gateway iOS approval push delivery.
// Sends APNs request/resolution wakes to paired operator devices.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import { loadOrCreateProcessDeviceIdentity } from "../infra/device-identity.js";
import {
  hasEffectivePairedDeviceRole,
  listDevicePairing,
  type DeviceAuthToken,
  type PairedDevice,
} from "../infra/device-pairing.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistrations,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsExecApprovalAlert,
  sendApnsExecApprovalResolvedWake,
  sendApnsPluginApprovalAlert,
  sendApnsPluginApprovalResolvedWake,
  shouldClearStoredApnsRegistration,
  type ApnsAuthConfig,
  type ApnsRegistration,
  type ApnsRelayConfig,
} from "../infra/push-apns.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";

// iOS approval push delivery targets paired operator devices with APNs
// registrations. Request pushes require approval scope plus identity-read access
// so the client can validate gateway ownership before presenting or resolving.
// Cleanup pushes reuse original targets so badges can clear after scope changes.
const APPROVALS_SCOPE = "operator.approvals";
const READ_SCOPE = "operator.read";
const OPERATOR_ROLE = "operator";

type GatewayLikeLogger = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type ApprovalPushTarget = {
  deviceId: string;
  scopes: readonly string[];
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

type ApprovalPushSendResult = {
  ok: boolean;
  status: number;
  reason?: string;
};

type ApprovalPushSender = (params: {
  target: DeliveryTarget;
  approvalId: string;
  plan: DeliveryPlan;
}) => Promise<ApprovalPushSendResult>;

type ApprovalRequestLike = { id: string };
type ApprovalResolvedLike = { id: string };

type ApprovalPushDriver<TRequest extends ApprovalRequestLike> = {
  approvalKind: "exec" | "plugin";
  sendRequested: (params: {
    request: TRequest;
    target: DeliveryTarget;
    plan: DeliveryPlan;
    gatewayDeviceId: string;
  }) => Promise<ApprovalPushSendResult>;
  sendResolved: (params: {
    approvalId: string;
    target: DeliveryTarget;
    plan: DeliveryPlan;
    gatewayDeviceId: string;
  }) => Promise<ApprovalPushSendResult>;
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

function canReceiveApprovalRequests(device: PairedDevice): boolean {
  const operatorToken = resolveActiveOperatorToken(device);
  if (!operatorToken) {
    return false;
  }
  return roleScopesAllow({
    role: OPERATOR_ROLE,
    requestedScopes: [APPROVALS_SCOPE, READ_SCOPE],
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
  return canReceiveApprovalRequests(params.device);
}

async function loadRegisteredTargets(params: {
  deviceIds: readonly string[];
}): Promise<DeliveryTarget[]> {
  if (params.deviceIds.length === 0) {
    return [];
  }
  return await loadApnsRegistrations(params.deviceIds);
}

async function resolvePairedTargets(params: {
  requireApprovalScope: boolean;
  isTargetVisible?: (target: ApprovalPushTarget) => boolean;
}): Promise<DeliveryTarget[]> {
  const pairing = await listDevicePairing();
  const deviceIds = pairing.paired
    .filter((device) => {
      if (!shouldTargetDevice({ device, requireApprovalScope: params.requireApprovalScope })) {
        return false;
      }
      const operatorToken = resolveActiveOperatorToken(device);
      if (
        params.isTargetVisible &&
        !params.isTargetVisible({
          deviceId: device.deviceId,
          scopes: operatorToken?.scopes ?? [],
        })
      ) {
        return false;
      }
      return true;
    })
    .map((device) => device.deviceId);
  return await loadRegisteredTargets({ deviceIds });
}

async function resolveDeliveryPlan(params: {
  approvalKind: "exec" | "plugin";
  requireApprovalScope: boolean;
  explicitNodeIds?: readonly string[];
  isTargetVisible?: (target: ApprovalPushTarget) => boolean;
  log: GatewayLikeLogger;
}): Promise<DeliveryPlan> {
  // Request delivery requires current approval scope; resolution delivery may
  // target prior node ids so existing notification badges can be cleared.
  const targets = params.explicitNodeIds?.length
    ? await loadRegisteredTargets({ deviceIds: params.explicitNodeIds })
    : await resolvePairedTargets({
        requireApprovalScope: params.requireApprovalScope,
        isTargetVisible: params.isTargetVisible,
      });
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
      params.log.warn?.(
        `${params.approvalKind} approvals: iOS direct APNs auth unavailable: ${auth.error}`,
      );
    }
  }

  const relayConfigByNodeId = new Map<string, ApnsRelayConfig>();
  if (needsRelay) {
    for (const target of targets) {
      if (target.registration.transport !== "relay") {
        continue;
      }
      const relay = resolveApnsRelayConfigFromEnv(process.env, getRuntimeConfig().gateway, {
        registrationRelayOrigin: target.registration.relayOrigin,
      });
      if (relay.ok) {
        relayConfigByNodeId.set(target.nodeId, relay.value);
      } else {
        params.log.warn?.(
          `${params.approvalKind} approvals: iOS relay APNs config unavailable: ${relay.error}`,
        );
      }
    }
  }
  const relayConfig = relayConfigByNodeId.values().next().value;

  // Relay sends are grouped by one base URL because the wake helpers accept a
  // single relay config; targets on other relay origins are skipped this round.
  return {
    targets: targets.filter((target) =>
      target.registration.transport === "direct"
        ? Boolean(directAuth)
        : relayConfigByNodeId.has(target.nodeId) &&
          relayConfigByNodeId.get(target.nodeId)?.baseUrl === relayConfig?.baseUrl,
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

async function sendRequestedPushes<TRequest extends ApprovalRequestLike>(params: {
  request: TRequest;
  plan: DeliveryPlan;
  log: GatewayLikeLogger;
  driver: ApprovalPushDriver<TRequest>;
}): Promise<{ attempted: number; delivered: number }> {
  const gatewayDeviceId = loadOrCreateProcessDeviceIdentity().deviceId;
  return await sendApprovalPushes({
    approvalId: params.request.id,
    plan: params.plan,
    log: params.log,
    approvalKind: params.driver.approvalKind,
    label: "request",
    logThrown: true,
    send: async ({ target, plan }) =>
      await params.driver.sendRequested({
        request: params.request,
        target,
        plan,
        gatewayDeviceId,
      }),
  });
}

async function sendApprovalPushes(params: {
  approvalId: string;
  plan: DeliveryPlan;
  log: GatewayLikeLogger;
  approvalKind: "exec" | "plugin";
  label: "request" | "cleanup";
  logThrown: boolean;
  send: ApprovalPushSender;
}): Promise<{ attempted: number; delivered: number }> {
  // Stale registrations are cleared on both direct and relay failures so future
  // approval prompts do not keep targeting dead APNs device tokens.
  const results = await Promise.allSettled(
    params.plan.targets.map(async (target) => {
      const result = await params.send({
        target,
        approvalId: params.approvalId,
        plan: params.plan,
      });
      await clearStaleApnsRegistrationIfNeeded({
        nodeId: target.nodeId,
        registration: target.registration,
        result,
      });
      if (!result.ok) {
        params.log.warn?.(
          `${params.approvalKind} approvals: iOS ${params.label} push failed node=${target.nodeId} status=${result.status} reason=${result.reason ?? "unknown"}`,
        );
      }
      return { nodeId: target.nodeId, ok: result.ok };
    }),
  );
  for (const result of results) {
    if (params.logThrown && result.status === "rejected") {
      const message = formatErrorMessage(result.reason);
      params.log.warn?.(
        `${params.approvalKind} approvals: iOS ${params.label} push threw error: ${message}`,
      );
    }
  }
  return {
    attempted: params.plan.targets.length,
    delivered: results.filter((result) => result.status === "fulfilled" && result.value.ok).length,
  };
}

async function sendResolvedPushes<TRequest extends ApprovalRequestLike>(params: {
  approvalId: string;
  plan: DeliveryPlan;
  log: GatewayLikeLogger;
  driver: ApprovalPushDriver<TRequest>;
}): Promise<void> {
  const gatewayDeviceId = loadOrCreateProcessDeviceIdentity().deviceId;
  await sendApprovalPushes({
    approvalId: params.approvalId,
    plan: params.plan,
    log: params.log,
    approvalKind: params.driver.approvalKind,
    label: "cleanup",
    logThrown: false,
    send: async ({ target, approvalId, plan }) =>
      await params.driver.sendResolved({
        approvalId,
        target,
        plan,
        gatewayDeviceId,
      }),
  });
}

function createApprovalIosPushDelivery<TRequest extends ApprovalRequestLike>(params: {
  log: GatewayLikeLogger;
  driver: ApprovalPushDriver<TRequest>;
}) {
  const approvalDeliveriesById = new Map<string, ApprovalDeliveryState>();
  const pendingDeliveryStateById = new Map<string, Promise<ApprovalDeliveryState | null>>();

  const sendCleanupPushForApproval = async (approvalId: string): Promise<void> => {
    // A resolve/expire event can arrive before the request push plan finishes;
    // wait for the pending state so cleanup reaches the same target set.
    const deliveryState =
      approvalDeliveriesById.get(approvalId) ?? (await pendingDeliveryStateById.get(approvalId));
    approvalDeliveriesById.delete(approvalId);
    pendingDeliveryStateById.delete(approvalId);
    if (!deliveryState?.nodeIds.length) {
      params.log.debug?.(
        `${params.driver.approvalKind} approvals: iOS cleanup push skipped approvalId=${approvalId} reason=missing-targets`,
      );
      return;
    }
    await deliveryState.requestPushPromise;
    const plan = await resolveDeliveryPlan({
      approvalKind: params.driver.approvalKind,
      requireApprovalScope: false,
      explicitNodeIds: deliveryState.nodeIds,
      log: params.log,
    });
    if (plan.targets.length === 0) {
      return;
    }
    await sendResolvedPushes({
      approvalId,
      plan,
      log: params.log,
      driver: params.driver,
    });
  };

  return {
    /** Sends the initial approval notification to visible iOS operator devices. */
    async handleRequested(
      request: TRequest,
      opts?: { isTargetVisible?: (target: ApprovalPushTarget) => boolean },
    ): Promise<boolean> {
      const deliveryStatePromise = (async (): Promise<ApprovalDeliveryState | null> => {
        const plan = await resolveDeliveryPlan({
          approvalKind: params.driver.approvalKind,
          requireApprovalScope: true,
          isTargetVisible: opts?.isTargetVisible,
          log: params.log,
        });
        if (plan.targets.length === 0) {
          approvalDeliveriesById.delete(request.id);
          return null;
        }

        const deliveryState: ApprovalDeliveryState = {
          nodeIds: plan.targets.map((target) => target.nodeId),
          requestPushPromise: sendRequestedPushes({
            request,
            plan,
            log: params.log,
            driver: params.driver,
          }).catch((err: unknown) => {
            const message = formatErrorMessage(err);
            params.log.error?.(
              `${params.driver.approvalKind} approvals: iOS request push failed: ${message}`,
            );
            return { attempted: plan.targets.length, delivered: 0 };
          }),
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
          `${params.driver.approvalKind} approvals: iOS request push reached no devices approvalId=${request.id} attempted=${attempted}`,
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

    /** Sends cleanup wakes for resolved approval requests. */
    async handleResolved(resolved: ApprovalResolvedLike): Promise<void> {
      await sendCleanupPushForApproval(resolved.id);
    },

    /** Sends cleanup wakes for expired approval requests. */
    async handleExpired(request: TRequest): Promise<void> {
      await sendCleanupPushForApproval(request.id);
    },
  };
}

/** Creates iOS push delivery for exec approval requests. */
export function createExecApprovalIosPushDelivery(params: { log: GatewayLikeLogger }) {
  return createApprovalIosPushDelivery<ExecApprovalRequest>({
    log: params.log,
    driver: {
      approvalKind: "exec",
      sendRequested: async ({ request, target, plan, gatewayDeviceId }) =>
        target.registration.transport === "direct"
          ? await sendApnsExecApprovalAlert({
              registration: target.registration,
              nodeId: target.nodeId,
              approvalId: request.id,
              gatewayDeviceId,
              auth: plan.directAuth!,
            })
          : await sendApnsExecApprovalAlert({
              registration: target.registration,
              nodeId: target.nodeId,
              approvalId: request.id,
              gatewayDeviceId,
              relayConfig: plan.relayConfig!,
            }),
      sendResolved: async ({ approvalId, target, plan, gatewayDeviceId }) =>
        target.registration.transport === "direct"
          ? await sendApnsExecApprovalResolvedWake({
              registration: target.registration,
              nodeId: target.nodeId,
              approvalId,
              gatewayDeviceId,
              auth: plan.directAuth!,
            })
          : await sendApnsExecApprovalResolvedWake({
              registration: target.registration,
              nodeId: target.nodeId,
              approvalId,
              gatewayDeviceId,
              relayConfig: plan.relayConfig!,
            }),
    },
  });
}

/** Creates iOS push delivery for plugin approval requests. */
export function createPluginApprovalIosPushDelivery(params: { log: GatewayLikeLogger }) {
  return createApprovalIosPushDelivery<PluginApprovalRequest>({
    log: params.log,
    driver: {
      approvalKind: "plugin",
      sendRequested: async ({ request, target, plan, gatewayDeviceId }) =>
        target.registration.transport === "direct"
          ? await sendApnsPluginApprovalAlert({
              registration: target.registration,
              nodeId: target.nodeId,
              approvalId: request.id,
              gatewayDeviceId,
              title: request.request.title,
              description: request.request.description,
              auth: plan.directAuth!,
            })
          : await sendApnsPluginApprovalAlert({
              registration: target.registration,
              nodeId: target.nodeId,
              approvalId: request.id,
              gatewayDeviceId,
              title: request.request.title,
              description: request.request.description,
              relayConfig: plan.relayConfig!,
            }),
      sendResolved: async ({ approvalId, target, plan, gatewayDeviceId }) =>
        target.registration.transport === "direct"
          ? await sendApnsPluginApprovalResolvedWake({
              registration: target.registration,
              nodeId: target.nodeId,
              approvalId,
              gatewayDeviceId,
              auth: plan.directAuth!,
            })
          : await sendApnsPluginApprovalResolvedWake({
              registration: target.registration,
              nodeId: target.nodeId,
              approvalId,
              gatewayDeviceId,
              relayConfig: plan.relayConfig!,
            }),
    },
  });
}
