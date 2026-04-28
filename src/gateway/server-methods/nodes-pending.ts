import {
  drainNodePendingWork,
  enqueueNodePendingWork,
  type NodePendingWorkPriority,
  type NodePendingWorkType,
} from "../node-pending-work.js";
import {
  ErrorCodes,
  errorShape,
  validateNodePendingDrainParams,
  validateNodePendingEnqueueParams,
} from "../protocol/index.js";
import { respondInvalidParams, respondUnavailableOnThrow } from "./nodes.helpers.js";
import {
  maybeSendNodeWakeNudge,
  maybeWakeNodeWithApns,
  NODE_WAKE_RECONNECT_RETRY_WAIT_MS,
  NODE_WAKE_RECONNECT_WAIT_MS,
  waitForNodeReconnect,
} from "./nodes.js";
import type { GatewayRequestHandlers } from "./types.js";

function resolveClientNodeId(
  client: { connect?: { device?: { id?: string }; client?: { id?: string } } } | null,
): string | null {
  const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id ?? "";
  const trimmed = nodeId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const nodePendingHandlers: GatewayRequestHandlers = {
  "node.pending.drain": async ({ params, respond, client }) => {
    if (!validateNodePendingDrainParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pending.drain",
        validator: validateNodePendingDrainParams,
      });
      return;
    }
    const nodeId = resolveClientNodeId(client);
    if (!nodeId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "node.pending.drain requires a connected device identity",
        ),
      );
      return;
    }
    const p = params as { maxItems?: number };
    const drained = drainNodePendingWork(nodeId, {
      maxItems: p.maxItems,
      includeDefaultStatus: true,
    });
    respond(true, { nodeId, ...drained }, undefined);
  },
  "node.pending.enqueue": async ({ params, respond, context }) => {
    if (!validateNodePendingEnqueueParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pending.enqueue",
        validator: validateNodePendingEnqueueParams,
      });
      return;
    }
    const p = params as {
      nodeId: string;
      type: NodePendingWorkType;
      priority?: NodePendingWorkPriority;
      expiresInMs?: number;
      wake?: boolean;
    };
    await respondUnavailableOnThrow(respond, async () => {
      const queued = enqueueNodePendingWork({
        nodeId: p.nodeId,
        type: p.type,
        priority: p.priority,
        expiresInMs: p.expiresInMs,
      });
      let wakeTriggered = false;
      if (p.wake !== false && !queued.deduped && !context.nodeRegistry.get(p.nodeId)) {
        const wakeReqId = queued.item.id;
        context.logGateway.info(
          `node pending wake start node=${p.nodeId} req=${wakeReqId} type=${queued.item.type}`,
        );
        const cfg = context.getRuntimeConfig();
        const wake = await maybeWakeNodeWithApns(p.nodeId, {
          wakeReason: "node.pending",
          cfg,
        });
        context.logGateway.info(
          `node pending wake stage=wake1 node=${p.nodeId} req=${wakeReqId} ` +
            `available=${wake.available} throttled=${wake.throttled} ` +
            `path=${wake.path} durationMs=${wake.durationMs} ` +
            `apnsStatus=${wake.apnsStatus ?? -1} apnsReason=${wake.apnsReason ?? "-"}`,
        );
        wakeTriggered = wake.available;
        if (wake.available) {
          const reconnected = await waitForNodeReconnect({
            nodeId: p.nodeId,
            context,
            timeoutMs: NODE_WAKE_RECONNECT_WAIT_MS,
          });
          context.logGateway.info(
            `node pending wake stage=wait1 node=${p.nodeId} req=${wakeReqId} ` +
              `reconnected=${reconnected} timeoutMs=${NODE_WAKE_RECONNECT_WAIT_MS}`,
          );
        }
        if (!context.nodeRegistry.get(p.nodeId) && wake.available) {
          const retryWake = await maybeWakeNodeWithApns(p.nodeId, {
            force: true,
            wakeReason: "node.pending",
            cfg,
          });
          context.logGateway.info(
            `node pending wake stage=wake2 node=${p.nodeId} req=${wakeReqId} force=true ` +
              `available=${retryWake.available} throttled=${retryWake.throttled} ` +
              `path=${retryWake.path} durationMs=${retryWake.durationMs} ` +
              `apnsStatus=${retryWake.apnsStatus ?? -1} apnsReason=${retryWake.apnsReason ?? "-"}`,
          );
          if (retryWake.available) {
            const reconnected = await waitForNodeReconnect({
              nodeId: p.nodeId,
              context,
              timeoutMs: NODE_WAKE_RECONNECT_RETRY_WAIT_MS,
            });
            context.logGateway.info(
              `node pending wake stage=wait2 node=${p.nodeId} req=${wakeReqId} ` +
                `reconnected=${reconnected} timeoutMs=${NODE_WAKE_RECONNECT_RETRY_WAIT_MS}`,
            );
          }
        }
        if (!context.nodeRegistry.get(p.nodeId)) {
          const nudge = await maybeSendNodeWakeNudge(p.nodeId, { cfg });
          context.logGateway.info(
            `node pending wake nudge node=${p.nodeId} req=${wakeReqId} sent=${nudge.sent} ` +
              `throttled=${nudge.throttled} reason=${nudge.reason} durationMs=${nudge.durationMs} ` +
              `apnsStatus=${nudge.apnsStatus ?? -1} apnsReason=${nudge.apnsReason ?? "-"}`,
          );
          context.logGateway.warn(
            `node pending wake done node=${p.nodeId} req=${wakeReqId} connected=false reason=not_connected`,
          );
        } else {
          context.logGateway.info(
            `node pending wake done node=${p.nodeId} req=${wakeReqId} connected=true`,
          );
        }
      }
      respond(
        true,
        {
          nodeId: p.nodeId,
          revision: queued.revision,
          queued: queued.item,
          wakeTriggered,
        },
        undefined,
      );
    });
  },
};
