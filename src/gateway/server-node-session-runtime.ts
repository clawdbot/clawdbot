// Gateway node session runtime factory.
// Creates node registry, subscription, and voice-wake fanout state.
import {
  NodeRegistry,
  type NodeRegistryOptions,
  type SerializedEventPayload,
} from "./node-registry.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";
import { hasConnectedTalkNode } from "./server-talk-nodes.js";

// Node session runtime owns connected node registry state, session event
// subscriptions, and voice-wake fanout helpers for the gateway process.
/** Creates node registry/subscription runtime state for a gateway server. */
export function createGatewayNodeSessionRuntime(params: {
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  listRegisteredNodePluginToolCommands?: NodeRegistryOptions["listRegisteredNodePluginToolCommands"];
  nodePluginToolsEnabled?: boolean;
  nodeSkillsEnabled?: boolean;
}) {
  const nodeRegistry = new NodeRegistry({
    listRegisteredNodePluginToolCommands: params.listRegisteredNodePluginToolCommands,
    nodePluginToolsEnabled: params.nodePluginToolsEnabled,
    nodeSkillsEnabled: params.nodeSkillsEnabled,
  });
  const nodePresenceTimers = new Map<string, ReturnType<typeof setInterval>>();
  const nodeSubscriptions = createNodeSubscriptionManager();
  const sessionEventSubscribers = createSessionEventSubscriberRegistry();
  const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
  const nodeSendEvent = (opts: {
    nodeId: string;
    event: string;
    payloadJSON?: SerializedEventPayload | null;
  }) => {
    nodeRegistry.sendEventRaw(opts.nodeId, opts.event, opts.payloadJSON ?? null);
  };
  // Session fanout goes through the subscription manager so node reconnects and
  // explicit unsubscribes keep both node->session indexes in sync.
  const nodeSendToSession = (sessionKey: string, event: string, payload: unknown) =>
    nodeSubscriptions.sendToSession(sessionKey, event, payload, nodeSendEvent);
  const nodeSendToAllSubscribed = (event: string, payload: unknown) =>
    nodeSubscriptions.sendToAllSubscribed(event, payload, nodeSendEvent);
  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    params.broadcast("voicewake.changed", { triggers }, { dropIfSlow: true });
  };
  const hasTalkNodeConnected = () => hasConnectedTalkNode(nodeRegistry);

  return {
    nodeRegistry,
    nodePresenceTimers,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe: nodeSubscriptions.subscribe,
    nodeUnsubscribe: nodeSubscriptions.unsubscribe,
    nodeUnsubscribeAll: nodeSubscriptions.unsubscribeAll,
    broadcastVoiceWakeChanged,
    hasTalkNodeConnected,
  };
}
