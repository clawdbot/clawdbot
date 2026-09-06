// Gateway connection and run registries.
// This state is transport-fed but can be constructed without HTTP or WebSocket servers.
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { createEventWebPushDelivery } from "./event-web-push.js";
import { createMentionInbox } from "./mention-inbox.js";
import { createPresenceRecipientProjection } from "./presence-projection.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import { WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { canReceiveSessionEvent } from "./session-sharing.js";

/** Creates transport-independent connection, subscription, and run state. */
export function createGatewayConnectionState(params: {
  bootId: string;
  cfg: import("../config/config.js").OpenClawConfig;
  getRuntimeConfig?: () => import("../config/config.js").OpenClawConfig;
}) {
  const loadRuntimeConfig = params.getRuntimeConfig ?? (() => params.cfg);
  const clients = new GatewayClientRegistry();
  // RPCs survive ordinary disconnects, so connection-owned projections still
  // validate the live transport before publishing into a retired connection.
  const isConnectionActive = (connId: string) => {
    const client = clients.getByConnectionId(connId);
    return Boolean(client && !client.invalidated);
  };
  const sessionEventSubscribers = createSessionEventSubscriberRegistry(isConnectionActive);
  const sessionMessageSubscribers = createSessionMessageSubscriberRegistry(isConnectionActive);
  const eventWebPush = createEventWebPushDelivery({ getRuntimeConfig: loadRuntimeConfig });
  const gatewayBroadcaster = createGatewayBroadcaster({
    clients,
    preparePresenceProjection: (presence) =>
      createPresenceRecipientProjection({ cfg: loadRuntimeConfig(), presence }),
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
    onBroadcast: (event, payload, opts) => eventWebPush.handleEvent(event, payload, opts),
  });
  const mentionInbox = createMentionInbox({
    gatewayInstanceId: params.bootId,
    getRuntimeConfig: loadRuntimeConfig,
    *getClients() {
      // Draining connections remain registered, but no longer count as online recipients.
      for (const client of clients) {
        if (
          !client.invalidated &&
          client.socket.readyState === WEBSOCKET_OPEN_READY_STATE &&
          (client.connect.role ?? "operator") === "operator"
        ) {
          yield client;
        }
      }
    },
    broadcastToConnIds: gatewayBroadcaster.broadcastToConnIds,
    // Targeted websocket invalidations do not enter the global Web Push event hook.
    onMentionCreated: eventWebPush.deliverMention,
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
    connectionWork: new GatewayConnectionWork(),
    mentionInbox,
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
