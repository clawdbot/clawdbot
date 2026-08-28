import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { NodePairingGeneration } from "../../infra/device-pairing-node-state.js";
import type { NodeSession } from "../node-registry.js";
import {
  NODE_WAKE_RECONNECT_RETRY_WAIT_MS,
  NODE_WAKE_RECONNECT_WAIT_MS,
  type NodeWakeLifecycle,
} from "../node-wake-state.js";
import {
  awaitNodeInvokeWithinDeadline,
  NODE_INVOKE_DEADLINE_EXPIRED,
} from "./nodes.invoke-deadline.js";
import { isNodePairingWorkCurrent, resolveDispatchableNodeSession } from "./nodes.shared.js";
import {
  maybeSendNodeWakeNudge,
  maybeWakeNodeWithApns,
  waitForNodeReconnect,
} from "./nodes.wake.js";
import type { GatewayRequestContext, RespondFn } from "./shared-types.js";

export async function resolveNodeSessionAfterWake(params: {
  nodeId: string;
  command: string;
  requestId: string | number;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  respond: RespondFn;
  generation: NodePairingGeneration;
  lifecycle: NodeWakeLifecycle;
  invokeDeadlineAtMs?: number;
  resolveRemainingInvokeTimeoutMs: () => number | undefined;
  respondIfInvokeExpired: () => boolean;
}): Promise<NodeSession | undefined> {
  const {
    nodeId,
    command,
    requestId,
    cfg,
    context,
    respond,
    generation,
    lifecycle,
    invokeDeadlineAtMs,
    resolveRemainingInvokeTimeoutMs,
    respondIfInvokeExpired,
  } = params;
  const continuePairingWork = async (): Promise<boolean> => {
    const pairingCurrent = await awaitNodeInvokeWithinDeadline(
      () => isNodePairingWorkCurrent({ nodeId, generation, lifecycle }),
      invokeDeadlineAtMs,
    );
    if (pairingCurrent === NODE_INVOKE_DEADLINE_EXPIRED) {
      respondIfInvokeExpired();
      return false;
    }
    if (pairingCurrent) {
      return true;
    }
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "node pairing changed while invocation was active", {
        retryable: true,
        details: { code: "PAIRING_CHANGED" },
      }),
    );
    return false;
  };

  const wakeFlowStartedAtMs = Date.now();
  context.logGateway.info(`node wake start node=${nodeId} req=${requestId} command=${command}`);
  const wake = await awaitNodeInvokeWithinDeadline(
    () => maybeWakeNodeWithApns(nodeId, { cfg, lifecycle, generation }),
    invokeDeadlineAtMs,
  );
  if (wake === NODE_INVOKE_DEADLINE_EXPIRED) {
    respondIfInvokeExpired();
    return undefined;
  }
  context.logGateway.info(
    `node wake stage=wake1 node=${nodeId} req=${requestId} ` +
      `available=${wake.available} throttled=${wake.throttled} ` +
      `path=${wake.path} durationMs=${wake.durationMs} ` +
      `apnsStatus=${wake.apnsStatus ?? -1} apnsReason=${wake.apnsReason ?? "-"}`,
  );
  if (respondIfInvokeExpired()) {
    return undefined;
  }

  if (wake.available) {
    const waitStartedAtMs = Date.now();
    const remainingTimeoutMs = resolveRemainingInvokeTimeoutMs();
    const waitTimeoutMs =
      invokeDeadlineAtMs === undefined
        ? NODE_WAKE_RECONNECT_WAIT_MS
        : Math.min(NODE_WAKE_RECONNECT_WAIT_MS, remainingTimeoutMs ?? 0);
    const reconnected = await waitForNodeReconnect({
      nodeId,
      context,
      timeoutMs: waitTimeoutMs,
      lifecycle,
      pairingGeneration: generation.key,
    });
    const waitDurationMs = Math.max(0, Date.now() - waitStartedAtMs);
    context.logGateway.info(
      `node wake stage=wait1 node=${nodeId} req=${requestId} ` +
        `reconnected=${reconnected} timeoutMs=${waitTimeoutMs} durationMs=${waitDurationMs}`,
    );
  }
  if (!(await continuePairingWork()) || respondIfInvokeExpired()) {
    return undefined;
  }

  let nodeSession = resolveDispatchableNodeSession(
    context.nodeRegistry.getForPairingGeneration(nodeId, generation.key),
  );
  if (!nodeSession && wake.available) {
    const retryWake = await awaitNodeInvokeWithinDeadline(
      () => maybeWakeNodeWithApns(nodeId, { force: true, cfg, lifecycle, generation }),
      invokeDeadlineAtMs,
    );
    if (retryWake === NODE_INVOKE_DEADLINE_EXPIRED) {
      respondIfInvokeExpired();
      return undefined;
    }
    context.logGateway.info(
      `node wake stage=wake2 node=${nodeId} req=${requestId} force=true ` +
        `available=${retryWake.available} throttled=${retryWake.throttled} ` +
        `path=${retryWake.path} durationMs=${retryWake.durationMs} ` +
        `apnsStatus=${retryWake.apnsStatus ?? -1} apnsReason=${retryWake.apnsReason ?? "-"}`,
    );
    if (respondIfInvokeExpired()) {
      return undefined;
    }
    if (retryWake.available) {
      const waitStartedAtMs = Date.now();
      const remainingTimeoutMs = resolveRemainingInvokeTimeoutMs();
      const waitTimeoutMs =
        invokeDeadlineAtMs === undefined
          ? NODE_WAKE_RECONNECT_RETRY_WAIT_MS
          : Math.min(NODE_WAKE_RECONNECT_RETRY_WAIT_MS, remainingTimeoutMs ?? 0);
      const reconnected = await waitForNodeReconnect({
        nodeId,
        context,
        timeoutMs: waitTimeoutMs,
        lifecycle,
        pairingGeneration: generation.key,
      });
      const waitDurationMs = Math.max(0, Date.now() - waitStartedAtMs);
      context.logGateway.info(
        `node wake stage=wait2 node=${nodeId} req=${requestId} ` +
          `reconnected=${reconnected} timeoutMs=${waitTimeoutMs} durationMs=${waitDurationMs}`,
      );
    }
    if (!(await continuePairingWork()) || respondIfInvokeExpired()) {
      return undefined;
    }
    nodeSession = resolveDispatchableNodeSession(
      context.nodeRegistry.getForPairingGeneration(nodeId, generation.key),
    );
  }

  if (!nodeSession) {
    if (respondIfInvokeExpired()) {
      return undefined;
    }
    const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
    const nudge = await awaitNodeInvokeWithinDeadline(
      () => maybeSendNodeWakeNudge(nodeId, { cfg, lifecycle, generation }),
      invokeDeadlineAtMs,
    );
    if (nudge === NODE_INVOKE_DEADLINE_EXPIRED) {
      respondIfInvokeExpired();
      return undefined;
    }
    if (!(await continuePairingWork())) {
      return undefined;
    }
    context.logGateway.info(
      `node wake nudge node=${nodeId} req=${requestId} sent=${nudge.sent} ` +
        `throttled=${nudge.throttled} reason=${nudge.reason} durationMs=${nudge.durationMs} ` +
        `apnsStatus=${nudge.apnsStatus ?? -1} apnsReason=${nudge.apnsReason ?? "-"}`,
    );
    context.logGateway.warn(
      `node wake done node=${nodeId} req=${requestId} connected=false ` +
        `reason=not_connected totalMs=${totalDurationMs}`,
    );
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "node not connected", {
        details: {
          code: "NOT_CONNECTED",
          nodeError: { code: "NOT_CONNECTED", message: "node not connected" },
          nodeCommandDispatched: false,
        },
      }),
    );
    return undefined;
  }

  const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
  context.logGateway.info(
    `node wake done node=${nodeId} req=${requestId} connected=true totalMs=${totalDurationMs}`,
  );
  return nodeSession;
}
