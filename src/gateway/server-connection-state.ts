import { resolveUserProfileId } from "../state/user-profiles.js";
// Gateway connection and run registries.
// This state is transport-fed but can be constructed without HTTP or WebSocket servers.
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { createEventWebPushDelivery } from "./event-web-push.js";
import { createNativeNotificationRegistry } from "./native-notifications.js";
import { NOTIFICATION_TTL_MS } from "./notification-presentation.js";
import { createPresenceRecipientProjection } from "./presence-projection.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { canReceiveSessionEvent } from "./session-sharing.js";

/** Creates transport-independent connection, subscription, and run state. */
export function createGatewayConnectionState(params: {
  cfg: import("../config/config.js").OpenClawConfig;
  getRuntimeConfig?: () => import("../config/config.js").OpenClawConfig;
}) {
  const loadRuntimeConfig = params.getRuntimeConfig ?? (() => params.cfg);
  const clients = new GatewayClientRegistry();
  // Detached RPC dispatch can resume after close cleanup, so connection-owned
  // producers must validate against the live transport owner before mutation.
  const isConnectionActive = (connId: string) => {
    const client = clients.getByConnectionId(connId);
    return Boolean(client && !client.invalidated);
  };
  const sessionEventSubscribers = createSessionEventSubscriberRegistry(isConnectionActive);
  const sessionMessageSubscribers = createSessionMessageSubscriberRegistry(isConnectionActive);
  let replayNativeNotifications: (client: GatewayWsClient) => void = () => {
    throw new Error("Native notification replay is not ready");
  };
  const nativeNotifications = createNativeNotificationRegistry({
    clients,
    getRuntimeConfig: loadRuntimeConfig,
    send: (client, message) =>
      gatewayBroadcaster.broadcastToConnIds("notification", message, new Set([client.connId])),
    onSubscribe: (client) => replayNativeNotifications(client),
    createTestNotification: () => ({
      action: "show",
      alert: true,
      id: "openclaw-notification-test",
      category: "approval-requested",
      title: "OpenClaw",
      body: "Notifications are working on this device.",
      path: "/settings/notifications",
      expiresAtMs: Date.now() + NOTIFICATION_TTL_MS,
    }),
    onPreferencesChanged: (profileId, keys) => {
      const connIds = new Set(
        [...clients]
          .filter((client) => {
            const id = client.authenticatedUserProfile?.profileId;
            return id && resolveUserProfileId(id) === profileId;
          })
          .map((client) => client.connId),
      );
      gatewayBroadcaster.broadcastToConnIds("users.prefs.changed", { profileId, keys }, connIds);
    },
  });
  const eventWebPush = createEventWebPushDelivery({
    getRuntimeConfig: loadRuntimeConfig,
    nativeNotifications,
  });
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
    nativeNotifications,
    bindNativeNotificationReplay: (replay: typeof replayNativeNotifications) => {
      replayNativeNotifications = replay;
    },
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
