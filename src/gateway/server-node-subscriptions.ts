// Gateway node subscription manager.
// Maintains bidirectional node/session fanout indexes.
import { serializeEventPayload, type SerializedEventPayload } from "./node-registry.js";

// Node subscription manager keeps bidirectional node/session indexes so gateway
// events can fan out by session and all node cleanup paths remove reverse links.
type NodeSendEventFn = (opts: {
  nodeId: string;
  pairingGeneration: string;
  event: string;
  payloadJSON?: SerializedEventPayload | null;
}) => void | Promise<unknown>;

type NodeListConnectedFn = () => Array<{ nodeId: string; pairingGeneration?: string }>;

type NodeSubscriptionManager = {
  subscribe: (nodeId: string, pairingGeneration: string, sessionKey: string) => void;
  unsubscribe: (nodeId: string, pairingGeneration: string, sessionKey: string) => void;
  unsubscribeAll: (nodeId: string, pairingGeneration?: string) => void;
  updatePairingGeneration: (params: {
    nodeId: string;
    previousPairingGeneration: string;
    nextPairingGeneration: string;
    preserveSubscriptions: boolean;
  }) => void;
  sendToSession: (
    sessionKey: string,
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
  ) => Promise<void>;
  sendToAllSubscribed: (
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
  ) => Promise<void>;
  sendToAllConnected: (
    event: string,
    payload: unknown,
    listConnected?: NodeListConnectedFn | null,
    sendEvent?: NodeSendEventFn | null,
  ) => Promise<void>;
  clear: () => void;
};

/** Manages node subscriptions to gateway session events. */
export function createNodeSubscriptionManager(): NodeSubscriptionManager {
  const nodeSubscriptions = new Map<
    string,
    { pairingGeneration: string; sessionKeys: Set<string> }
  >();
  const sessionSubscribers = new Map<string, Map<string, string>>();

  const toPayloadJSON = (payload: unknown): SerializedEventPayload | null | undefined => {
    try {
      return serializeEventPayload(payload);
    } catch {
      return undefined;
    }
  };

  const settleFanout = async (sends: Array<() => void | Promise<unknown>>): Promise<void> => {
    // Public gateway callers intentionally fire-and-forget fanout. Settle every
    // sender so one transport failure cannot become an unhandled rejection.
    await Promise.allSettled(sends.map((send) => Promise.resolve().then(send)));
  };

  const subscribe = (nodeId: string, pairingGeneration: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedPairingGeneration = pairingGeneration.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedPairingGeneration || !normalizedSessionKey) {
      return;
    }

    let nodeEntry = nodeSubscriptions.get(normalizedNodeId);
    if (nodeEntry?.pairingGeneration !== normalizedPairingGeneration) {
      unsubscribeAll(normalizedNodeId);
      nodeEntry = undefined;
    }
    if (!nodeEntry) {
      nodeEntry = {
        pairingGeneration: normalizedPairingGeneration,
        sessionKeys: new Set<string>(),
      };
      nodeSubscriptions.set(normalizedNodeId, nodeEntry);
    }
    if (nodeEntry.sessionKeys.has(normalizedSessionKey)) {
      return;
    }
    nodeEntry.sessionKeys.add(normalizedSessionKey);

    let sessionMap = sessionSubscribers.get(normalizedSessionKey);
    if (!sessionMap) {
      sessionMap = new Map<string, string>();
      sessionSubscribers.set(normalizedSessionKey, sessionMap);
    }
    sessionMap.set(normalizedNodeId, normalizedPairingGeneration);
  };

  const unsubscribe = (nodeId: string, pairingGeneration: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedPairingGeneration = pairingGeneration.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedPairingGeneration || !normalizedSessionKey) {
      return;
    }

    const nodeEntry = nodeSubscriptions.get(normalizedNodeId);
    if (nodeEntry?.pairingGeneration !== normalizedPairingGeneration) {
      return;
    }
    nodeEntry.sessionKeys.delete(normalizedSessionKey);
    if (nodeEntry.sessionKeys.size === 0) {
      nodeSubscriptions.delete(normalizedNodeId);
    }

    const sessionMap = sessionSubscribers.get(normalizedSessionKey);
    if (sessionMap?.get(normalizedNodeId) === normalizedPairingGeneration) {
      sessionMap.delete(normalizedNodeId);
    }
    if (sessionMap?.size === 0) {
      sessionSubscribers.delete(normalizedSessionKey);
    }
  };

  function unsubscribeAll(nodeId: string, pairingGeneration?: string) {
    const normalizedNodeId = nodeId.trim();
    const nodeEntry = nodeSubscriptions.get(normalizedNodeId);
    if (
      !nodeEntry ||
      (pairingGeneration !== undefined && nodeEntry.pairingGeneration !== pairingGeneration.trim())
    ) {
      return;
    }
    // Remove reverse session indexes before deleting the node index so session
    // fanout cannot retain disconnected node ids.
    for (const sessionKey of nodeEntry.sessionKeys) {
      const sessionMap = sessionSubscribers.get(sessionKey);
      if (sessionMap?.get(normalizedNodeId) === nodeEntry.pairingGeneration) {
        sessionMap.delete(normalizedNodeId);
      }
      if (sessionMap?.size === 0) {
        sessionSubscribers.delete(sessionKey);
      }
    }
    nodeSubscriptions.delete(normalizedNodeId);
  }

  const updatePairingGeneration = (params: {
    nodeId: string;
    previousPairingGeneration: string;
    nextPairingGeneration: string;
    preserveSubscriptions: boolean;
  }) => {
    const normalizedNodeId = params.nodeId.trim();
    const previousPairingGeneration = params.previousPairingGeneration.trim();
    const nextPairingGeneration = params.nextPairingGeneration.trim();
    const nodeEntry = nodeSubscriptions.get(normalizedNodeId);
    if (
      !nodeEntry ||
      !previousPairingGeneration ||
      nodeEntry.pairingGeneration !== previousPairingGeneration
    ) {
      return;
    }
    if (!params.preserveSubscriptions || !nextPairingGeneration) {
      unsubscribeAll(normalizedNodeId, previousPairingGeneration);
      return;
    }
    nodeEntry.pairingGeneration = nextPairingGeneration;
    for (const sessionKey of nodeEntry.sessionKeys) {
      sessionSubscribers.get(sessionKey)?.set(normalizedNodeId, nextPairingGeneration);
    }
  };

  const sendToSession = async (
    sessionKey: string,
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
  ) => {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey || !sendEvent) {
      return;
    }
    const subscribers = sessionSubscribers.get(normalizedSessionKey);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const payloadJSON = toPayloadJSON(payload);
    if (payloadJSON === undefined) {
      return;
    }
    // Serialize once per event and reuse across all subscribed nodes to keep
    // fanout deterministic and avoid repeated JSON conversion.
    await settleFanout(
      [...subscribers].map(
        ([nodeId, pairingGeneration]) =>
          () =>
            sendEvent({ nodeId, pairingGeneration, event, payloadJSON }),
      ),
    );
  };

  const sendToAllSubscribed = async (
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
  ) => {
    if (!sendEvent) {
      return;
    }
    const payloadJSON = toPayloadJSON(payload);
    if (payloadJSON === undefined) {
      return;
    }
    await settleFanout(
      [...nodeSubscriptions].map(
        ([nodeId, subscription]) =>
          () =>
            sendEvent({
              nodeId,
              pairingGeneration: subscription.pairingGeneration,
              event,
              payloadJSON,
            }),
      ),
    );
  };

  const sendToAllConnected = async (
    event: string,
    payload: unknown,
    listConnected?: NodeListConnectedFn | null,
    sendEvent?: NodeSendEventFn | null,
  ) => {
    if (!sendEvent || !listConnected) {
      return;
    }
    const payloadJSON = toPayloadJSON(payload);
    if (payloadJSON === undefined) {
      return;
    }
    await settleFanout(
      listConnected().map(
        (node) => () =>
          node.pairingGeneration
            ? sendEvent({
                nodeId: node.nodeId,
                pairingGeneration: node.pairingGeneration,
                event,
                payloadJSON,
              })
            : undefined,
      ),
    );
  };

  const clear = () => {
    nodeSubscriptions.clear();
    sessionSubscribers.clear();
  };

  return {
    subscribe,
    unsubscribe,
    unsubscribeAll,
    updatePairingGeneration,
    sendToSession,
    sendToAllSubscribed,
    sendToAllConnected,
    clear,
  };
}
