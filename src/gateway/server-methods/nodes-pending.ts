// Node pending methods queue and drain work for paired nodes that may reconnect
// later, with optional APNs wake nudges.
import {
  ErrorCodes,
  errorShape,
  validateNodePendingDrainParams,
  validateNodePendingEnqueueParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
  type NodePairingGeneration,
} from "../../infra/node-pairing-state.js";
import {
  drainNodePendingWork,
  enqueueNodePendingWork,
  removeNodePendingWorkItem,
  type NodePendingWorkPriority,
  type NodePendingWorkType,
} from "../node-pending-work.js";
import {
  captureNodeWakeLifecycle,
  isNodeWakeLifecycleCurrent,
  NODE_WAKE_RECONNECT_RETRY_WAIT_MS,
  NODE_WAKE_RECONNECT_WAIT_MS,
  releaseNodeWakeLifecycle,
} from "../node-wake-state.js";
import { respondInvalidParams, respondUnavailableOnThrow } from "./nodes.helpers.js";
import { maybeSendNodeWakeNudge, maybeWakeNodeWithApns, waitForNodeReconnect } from "./nodes.js";
import type { RespondFn } from "./shared-types.js";
import type { GatewayRequestHandlers } from "./types.js";

function respondPairingChanged(respond: RespondFn) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, "node pairing changed while pending work was active", {
      retryable: true,
      details: { code: "PAIRING_CHANGED" },
    }),
  );
}

async function isPendingGenerationCurrent(params: {
  nodeId: string;
  generation: NodePairingGeneration;
  lifecycle: AbortSignal;
}): Promise<boolean> {
  return (
    isNodeWakeLifecycleCurrent(params.nodeId, params.lifecycle, params.generation.key) &&
    (await isNodePairingGenerationCurrent(params.generation))
  );
}

function resolveClientNodeId(
  client: { connect?: { device?: { id?: string }; client?: { id?: string } } } | null,
): string | null {
  const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id ?? "";
  const trimmed = nodeId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Gateway handlers for queueing work until a paired node reconnects. */
export const nodePendingHandlers: GatewayRequestHandlers = {
  "node.pending.drain": async ({ params, respond, client, context }) => {
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
    await respondUnavailableOnThrow(respond, async () => {
      const generation = await captureNodePairingGeneration(nodeId);
      if (!generation || !(await isNodePairingGenerationCurrent(generation))) {
        respondPairingChanged(respond);
        return;
      }
      // Draining deletes work, so the authenticated caller must still be the
      // registry session that owns the persisted generation.
      const session = context.nodeRegistry.getForPairingGeneration(nodeId, generation.key);
      if (!client?.connId || session?.connId !== client.connId) {
        respondPairingChanged(respond);
        return;
      }
      const p = params as { maxItems?: number };
      const drained = drainNodePendingWork(nodeId, {
        maxItems: p.maxItems,
        includeDefaultStatus: true,
        pairingGeneration: generation.key,
      });
      respond(true, { nodeId, ...drained }, undefined);
    });
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
      const nodeId = p.nodeId.trim();
      const generation = await captureNodePairingGeneration(nodeId);
      if (!generation) {
        respondPairingChanged(respond);
        return;
      }
      const wakeLifecycle = captureNodeWakeLifecycle(nodeId, generation.key);
      try {
        if (!(await isPendingGenerationCurrent({ nodeId, generation, lifecycle: wakeLifecycle }))) {
          respondPairingChanged(respond);
          return;
        }
        const queued = enqueueNodePendingWork({
          nodeId,
          type: p.type,
          priority: p.priority,
          expiresInMs: p.expiresInMs,
          pairingGeneration: generation.key,
        });
        let wakeTriggered = false;
        if (
          p.wake !== false &&
          !queued.deduped &&
          !context.nodeRegistry.getForPairingGeneration(nodeId, generation.key)
        ) {
          const wakeReqId = queued.item.id;
          context.logGateway.info(
            `node pending wake start node=${nodeId} req=${wakeReqId} type=${queued.item.type}`,
          );
          const cfg = context.getRuntimeConfig();
          const wake = await maybeWakeNodeWithApns(nodeId, {
            wakeReason: "node.pending",
            cfg,
            lifecycle: wakeLifecycle,
            generation,
          });
          context.logGateway.info(
            `node pending wake stage=wake1 node=${nodeId} req=${wakeReqId} ` +
              `available=${wake.available} throttled=${wake.throttled} ` +
              `path=${wake.path} durationMs=${wake.durationMs} ` +
              `apnsStatus=${wake.apnsStatus ?? -1} apnsReason=${wake.apnsReason ?? "-"}`,
          );
          wakeTriggered = wake.available;
          if (wake.available) {
            // Give the first wake a short reconnect window before forcing a
            // second wake; this keeps normal APNs delivery cheap and quiet.
            const reconnected = await waitForNodeReconnect({
              nodeId,
              context,
              timeoutMs: NODE_WAKE_RECONNECT_WAIT_MS,
              lifecycle: wakeLifecycle,
              pairingGeneration: generation.key,
            });
            context.logGateway.info(
              `node pending wake stage=wait1 node=${nodeId} req=${wakeReqId} ` +
                `reconnected=${reconnected} timeoutMs=${NODE_WAKE_RECONNECT_WAIT_MS}`,
            );
          }
          if (
            (await isPendingGenerationCurrent({
              nodeId,
              generation,
              lifecycle: wakeLifecycle,
            })) &&
            !context.nodeRegistry.getForPairingGeneration(nodeId, generation.key) &&
            wake.available
          ) {
            // A forced retry is only useful after the first wake was deliverable
            // but the node still has not reattached to the Gateway.
            const retryWake = await maybeWakeNodeWithApns(nodeId, {
              force: true,
              wakeReason: "node.pending",
              cfg,
              lifecycle: wakeLifecycle,
              generation,
            });
            context.logGateway.info(
              `node pending wake stage=wake2 node=${nodeId} req=${wakeReqId} force=true ` +
                `available=${retryWake.available} throttled=${retryWake.throttled} ` +
                `path=${retryWake.path} durationMs=${retryWake.durationMs} ` +
                `apnsStatus=${retryWake.apnsStatus ?? -1} apnsReason=${retryWake.apnsReason ?? "-"}`,
            );
            if (retryWake.available) {
              const reconnected = await waitForNodeReconnect({
                nodeId,
                context,
                timeoutMs: NODE_WAKE_RECONNECT_RETRY_WAIT_MS,
                lifecycle: wakeLifecycle,
                pairingGeneration: generation.key,
              });
              context.logGateway.info(
                `node pending wake stage=wait2 node=${nodeId} req=${wakeReqId} ` +
                  `reconnected=${reconnected} timeoutMs=${NODE_WAKE_RECONNECT_RETRY_WAIT_MS}`,
              );
            }
          }
          if (
            (await isPendingGenerationCurrent({
              nodeId,
              generation,
              lifecycle: wakeLifecycle,
            })) &&
            !context.nodeRegistry.getForPairingGeneration(nodeId, generation.key)
          ) {
            const nudge = await maybeSendNodeWakeNudge(nodeId, {
              cfg,
              lifecycle: wakeLifecycle,
              generation,
            });
            context.logGateway.info(
              `node pending wake nudge node=${nodeId} req=${wakeReqId} sent=${nudge.sent} ` +
                `throttled=${nudge.throttled} reason=${nudge.reason} durationMs=${nudge.durationMs} ` +
                `apnsStatus=${nudge.apnsStatus ?? -1} apnsReason=${nudge.apnsReason ?? "-"}`,
            );
            context.logGateway.warn(
              `node pending wake done node=${nodeId} req=${wakeReqId} connected=false reason=not_connected`,
            );
          } else if (
            await isPendingGenerationCurrent({
              nodeId,
              generation,
              lifecycle: wakeLifecycle,
            })
          ) {
            context.logGateway.info(
              `node pending wake done node=${nodeId} req=${wakeReqId} connected=true`,
            );
          }
        }
        if (!(await isPendingGenerationCurrent({ nodeId, generation, lifecycle: wakeLifecycle }))) {
          if (!queued.deduped) {
            removeNodePendingWorkItem({
              nodeId,
              itemId: queued.item.id,
              pairingGeneration: generation.key,
            });
          }
          respondPairingChanged(respond);
          return;
        }
        respond(
          true,
          {
            nodeId,
            revision: queued.revision,
            queued: queued.item,
            wakeTriggered,
          },
          undefined,
        );
      } finally {
        releaseNodeWakeLifecycle(nodeId, wakeLifecycle);
      }
    });
  },
};
