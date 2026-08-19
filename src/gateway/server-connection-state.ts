// Gateway connection and run registries.
// This state is transport-fed but can be constructed without HTTP or WebSocket servers.
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { canReceiveSessionEvent } from "./session-sharing.js";

/** Creates transport-independent connection, subscription, and run state. */
export function createGatewayConnectionState(params: {
  cfg: import("../config/config.js").OpenClawConfig;
  getRuntimeConfig?: () => import("../config/config.js").OpenClawConfig;
}) {
  const loadRuntimeConfig = params.getRuntimeConfig ?? (() => params.cfg);
  const clients = new Set<GatewayWsClient>();
  // Detached RPC dispatch can resume after close cleanup, so connection-owned
  // producers must validate against the live transport owner before mutation.
  const isConnectionActive = (connId: string) => {
    for (const client of clients) {
      if (client.connId === connId && !client.invalidated) {
        return true;
      }
    }
    return false;
  };
  const sessionEventSubscribers = createSessionEventSubscriberRegistry(isConnectionActive);
  const sessionMessageSubscribers = createSessionMessageSubscriberRegistry(isConnectionActive);
  const gatewayBroadcaster = createGatewayBroadcaster({
    clients,
    sessionMessageSubscribers,
    canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) =>
      canReceiveSessionEvent({
        cfg: loadRuntimeConfig(),
        client,
        sessionKeys,
        agentId,
        event,
        payload,
      }),
  });
  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map<string, import("./server-shared.js").DedupeEntry>();
  const chatRunState = createChatRunState();
  const chatRunRegistry = chatRunState.registry;
  const addChatRun = chatRunRegistry.add;
  const removeChatRun = chatRunRegistry.remove;
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const chatQueuedTurns = new Map<string, import("./chat-queued-turns.js").QueuedChatTurnEntry>();
  const toolEventRecipients = chatRunState.toolEventRecipients;

  return {
    clients,
    isConnectionActive,
    ...gatewayBroadcaster,
    agentRunSeq,
    dedupe,
    chatRunState,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    chatQueuedTurns,
    toolEventRecipients,
    sessionEventSubscribers,
    sessionMessageSubscribers,
  };
}
