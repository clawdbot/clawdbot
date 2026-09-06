import {
  isPairedDeviceNodeBindingCurrent,
  resolveCurrentPairedDeviceNodeBinding,
} from "../infra/device-pairing-node-state.js";
import type { VoiceWakeRoutingConfig } from "../infra/voicewake-routing.js";
import { GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED } from "./events.js";
import {
  createNodeRegistryRuntime,
  setNodeRunnerStateChangedListener,
  type NodeRunnerStateChange,
} from "./node-registry-private.js";
// Gateway node session runtime factory.
// Creates node registry, subscription, and voice-wake fanout state.
import {
  NodeRegistry,
  serializeEventPayload,
  type NodeRegistryOptions,
  type SerializedEventPayload,
} from "./node-registry.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";
import { hasConnectedTalkNode } from "./server-talk-nodes.js";

// Node session runtime owns connected node registry state, session event
// subscriptions, and voice-wake fanout helpers for the gateway process.
/** Creates node registry/subscription runtime state for a gateway server. */
export function createGatewayNodeSessionRuntime(params: {
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  listRegisteredNodePluginToolCommands?: NodeRegistryOptions["listRegisteredNodePluginToolCommands"];
  getConfig?: NodeRegistryOptions["getConfig"];
  onRunnerStateChanged?: (nodeId: string, change: NodeRunnerStateChange) => void;
  resolveCurrentPairingState?: NodeRegistryOptions["resolveCurrentPairingState"];
  isPairingStateCurrent?: NodeRegistryOptions["isPairingStateCurrent"];
  onPairingInvalidated?: NodeRegistryOptions["onPairingInvalidated"];
  onPairingGenerationChanged?: NodeRegistryOptions["onPairingGenerationChanged"];
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
}) {
  const nodeSubscriptions = createNodeSubscriptionManager();
  const { nodeRegistry, nodeWorkerSupervisorTransport } = createNodeRegistryRuntime(
    () =>
      new NodeRegistry({
        listRegisteredNodePluginToolCommands: params.listRegisteredNodePluginToolCommands,
        getConfig: params.getConfig,
        resolveCurrentPairingState:
          params.resolveCurrentPairingState ?? resolveCurrentPairedDeviceNodeBinding,
        isPairingStateCurrent: params.isPairingStateCurrent ?? isPairedDeviceNodeBindingCurrent,
        onPairingInvalidated: params.onPairingInvalidated,
        onPairingGenerationChanged: (change) => {
          nodeSubscriptions.updatePairingGeneration({
            ...change,
            preserveSubscriptions: change.preserveSessionState,
          });
          params.onPairingGenerationChanged?.(change);
        },
      }),
  );
  setNodeRunnerStateChangedListener(nodeRegistry, (nodeId, change) => {
    // Lifecycle listeners advance the session-list cache fence before clients
    // can react to either broadcast and issue an immediate refresh.
    params.onRunnerStateChanged?.(nodeId, change);
    if (change.inventoryChanged || change.availabilityChanged) {
      params.broadcast(
        GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
        { nodeId },
        { dropIfSlow: true },
      );
    }
    if (change.availabilityChanged) {
      params.broadcast("sessions.changed", { reason: "runner-availability" }, { dropIfSlow: true });
    }
  });
  const nodePresenceTimers = new Map<string, ReturnType<typeof setInterval>>();
  const sessionEventSubscribers = params.sessionEventSubscribers;
  const sessionMessageSubscribers = params.sessionMessageSubscribers;
  const nodeSendEvent = (opts: {
    nodeId: string;
    pairingGeneration: string;
    event: string;
    payloadJSON?: SerializedEventPayload | null;
  }) => {
    return nodeRegistry.sendEventRawForPairingGeneration(
      opts.nodeId,
      opts.pairingGeneration,
      opts.event,
      opts.payloadJSON ?? null,
    );
  };
  // Session fanout goes through the subscription manager so node reconnects and
  // explicit unsubscribes keep both node->session indexes in sync.
  const nodeSendToSession = (sessionKey: string, event: string, payload: unknown) => {
    void nodeSubscriptions.sendToSession(sessionKey, event, payload, nodeSendEvent);
  };
  const nodeSendToAllSubscribed = (event: string, payload: unknown) => {
    void nodeSubscriptions.sendToAllSubscribed(event, payload, nodeSendEvent);
  };
  const resolveSubscriptionGeneration = (nodeId: string, connId?: string) => {
    const node = nodeRegistry.get(nodeId);
    return connId && node?.connId === connId ? node.pairingGeneration : undefined;
  };
  const nodeSubscribe = (nodeId: string, sessionKey: string, connId?: string) => {
    const pairingGeneration = resolveSubscriptionGeneration(nodeId, connId);
    if (pairingGeneration) {
      nodeSubscriptions.subscribe(nodeId, pairingGeneration, sessionKey);
    }
  };
  const nodeUnsubscribe = (nodeId: string, sessionKey: string, connId?: string) => {
    const pairingGeneration = resolveSubscriptionGeneration(nodeId, connId);
    if (pairingGeneration) {
      nodeSubscriptions.unsubscribe(nodeId, pairingGeneration, sessionKey);
    }
  };
  const sendVoiceWakeEventToCurrentNodes = (event: string, payload: unknown) => {
    const payloadJSON = serializeEventPayload(payload);
    for (const node of nodeRegistry.listConnected()) {
      const pairingGeneration = node.pairingGeneration;
      if (!pairingGeneration) {
        // Pending first-surface sessions have no command authority yet, but
        // their authenticated pairing identity still fences compatibility broadcasts.
        if (node.pairingIdentity) {
          void nodeRegistry
            .sendEventForPairingIdentity({
              nodeId: node.nodeId,
              connId: node.connId,
              pairingIdentity: node.pairingIdentity,
              event,
              payload,
            })
            .catch(() => undefined);
        }
        continue;
      }
      // Voice-wake broadcasts are fire-and-forget, but each node send still
      // resolves persistent generation before crossing its transport.
      void nodeRegistry
        .sendEventRawForPairingGeneration(node.nodeId, pairingGeneration, event, payloadJSON)
        .catch(() => undefined);
    }
  };
  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    params.broadcast("voicewake.changed", { triggers }, { dropIfSlow: true });
    sendVoiceWakeEventToCurrentNodes("voicewake.changed", { triggers });
  };
  const broadcastVoiceWakeRoutingChanged = (config: VoiceWakeRoutingConfig) => {
    params.broadcast("voicewake.routing.changed", { config }, { dropIfSlow: true });
    sendVoiceWakeEventToCurrentNodes("voicewake.routing.changed", { config });
  };
  const hasTalkNodeConnected = () => hasConnectedTalkNode(nodeRegistry);

  return {
    nodeRegistry,
    nodeWorkerSupervisorTransport,
    nodePresenceTimers,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe,
    nodeUnsubscribe,
    nodeUnsubscribeAll: nodeSubscriptions.unsubscribeAll,
    broadcastVoiceWakeChanged,
    broadcastVoiceWakeRoutingChanged,
    hasTalkNodeConnected,
  };
}
