import { validateNodeEventParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
} from "../../infra/node-pairing-state.js";
import type { NodeEventContext } from "../server-node-events-types.js";
import { respondInvalidParams, respondUnavailableOnThrow } from "./nodes.helpers.js";
import { resolveDispatchableNodeSession, respondPairingChanged } from "./nodes.shared.js";
import type { GatewayRequestHandlers } from "./types.js";

export const nodeEventHandlers: GatewayRequestHandlers = {
  "node.event": async ({ params, respond, context, client }) => {
    if (!validateNodeEventParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.event",
        validator: validateNodeEventParams,
      });
      return;
    }
    const p = params as { event: string; payload?: unknown; payloadJSON?: string | null };
    const payloadJSON =
      typeof p.payloadJSON === "string"
        ? p.payloadJSON
        : p.payload !== undefined
          ? JSON.stringify(p.payload)
          : null;
    await respondUnavailableOnThrow(respond, async () => {
      const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id ?? "node";
      const nodeSession = context.nodeRegistry.get(nodeId);
      const eventConnId = client?.connId;
      const eventPairingGeneration = nodeSession?.pairingGeneration;
      const isEventConnectionCurrent = async (): Promise<boolean> => {
        if (!eventConnId || !eventPairingGeneration) {
          return false;
        }
        const before = resolveDispatchableNodeSession(
          context.nodeRegistry.getForPairingGeneration(nodeId, eventPairingGeneration),
        );
        if (!before || before.connId !== eventConnId) {
          return false;
        }
        if (!(await context.nodeRegistry.isConnectionCurrentPairingState(eventConnId))) {
          return false;
        }
        const after = resolveDispatchableNodeSession(
          context.nodeRegistry.getForPairingGeneration(nodeId, eventPairingGeneration),
        );
        return after?.connId === eventConnId;
      };
      const { handleNodeEvent } = await import("../server-node-events.js");
      const apnsGeneration =
        p.event === "push.apns.register" ? await captureNodePairingGeneration(nodeId) : null;
      const presenceAllowed =
        nodeSession !== undefined &&
        nodeSession.connId === client?.connId &&
        nodeSession.permissions?.accessibility === true;
      const nodeContext: NodeEventContext = {
        deps: context.deps,
        broadcast: context.broadcast,
        nodeSendToSession: context.nodeSendToSession,
        nodeSubscribe: async (subscriptionNodeId, sessionKey, subscriptionConnId) => {
          if (
            subscriptionNodeId !== nodeId ||
            !subscriptionConnId ||
            subscriptionConnId !== client?.connId ||
            !(await isEventConnectionCurrent())
          ) {
            return;
          }
          context.nodeSubscribe(subscriptionNodeId, sessionKey, subscriptionConnId);
        },
        nodeUnsubscribe: async (subscriptionNodeId, sessionKey, subscriptionConnId) => {
          if (
            subscriptionNodeId !== nodeId ||
            !subscriptionConnId ||
            subscriptionConnId !== client?.connId ||
            !(await isEventConnectionCurrent())
          ) {
            return;
          }
          context.nodeUnsubscribe(subscriptionNodeId, sessionKey, subscriptionConnId);
        },
        broadcastVoiceWakeChanged: context.broadcastVoiceWakeChanged,
        addChatRun: context.addChatRun,
        removeChatRun: context.removeChatRun,
        chatAbortControllers: context.chatAbortControllers,
        dedupe: context.dedupe,
        agentRunSeq: context.agentRunSeq,
        getHealthCache: context.getHealthCache,
        refreshHealthSnapshot: context.refreshHealthSnapshot,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
        loadGatewayModelCatalogSnapshot: context.loadGatewayModelCatalogSnapshot,
        authorizeNodeSystemRunEvent: (eventParams) =>
          context.nodeRegistry.authorizeSystemRunEvent({
            nodeId: eventParams.nodeId,
            connId: eventParams.connId,
            runId: eventParams.runId,
            sessionKey: eventParams.sessionKey,
            terminal: eventParams.terminal,
          }),
        updateNodePresenceActivity: (activity) => {
          const updated = context.nodeRegistry.updatePresenceActivity(activity);
          return updated?.lastActiveAtMs !== undefined && updated.presenceUpdatedAtMs !== undefined
            ? {
                lastActiveAtMs: updated.lastActiveAtMs,
                presenceUpdatedAtMs: updated.presenceUpdatedAtMs,
              }
            : null;
        },
        clearNodePresenceActivity: (activity) =>
          context.nodeRegistry.clearPresenceActivity(activity),
        logGateway: { warn: context.logGateway.warn },
      };
      const result = await handleNodeEvent(
        nodeContext,
        nodeId,
        {
          event: p.event,
          payloadJSON,
        },
        {
          connId: client?.connId,
          deviceId: client?.connect?.device?.id,
          pairingGeneration: eventPairingGeneration
            ? { nodeId, key: eventPairingGeneration }
            : undefined,
          presenceAllowed,
          isConnectionCurrent: isEventConnectionCurrent,
          resolveApnsRegistrationGeneration: async () => {
            if (!apnsGeneration || !client?.connId) {
              return null;
            }
            const before = resolveDispatchableNodeSession(
              context.nodeRegistry.getForPairingGeneration(nodeId, apnsGeneration.key),
            );
            if (!before || before.connId !== client.connId) {
              return null;
            }
            if (!(await isNodePairingGenerationCurrent(apnsGeneration))) {
              return null;
            }
            const after = resolveDispatchableNodeSession(
              context.nodeRegistry.getForPairingGeneration(nodeId, apnsGeneration.key),
            );
            return after?.connId === client.connId ? apnsGeneration.key : null;
          },
        },
      );
      if (result?.reason === "pairing_changed") {
        respondPairingChanged(respond);
        return;
      }
      respond(true, result ?? { ok: true }, undefined);
    });
  },
};
