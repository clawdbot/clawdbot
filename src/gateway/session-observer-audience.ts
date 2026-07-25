import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat-state.js";

export function createSessionObserverAudience(params: {
  subscribers: SessionMessageSubscriberRegistry;
  sessionEventSubscribers?: SessionEventSubscriberRegistry;
  isVisible: (connId: string) => boolean;
}) {
  return {
    has(sessionKey: string): boolean {
      for (const connId of params.subscribers.get(sessionKey)) {
        if (params.isVisible(connId)) {
          return true;
        }
      }
      for (const connId of params.sessionEventSubscribers?.getAll() ?? []) {
        if (params.isVisible(connId)) {
          return true;
        }
      }
      return false;
    },

    recipients(sessionKey: string): ReadonlySet<string> {
      const recipients = new Set(params.subscribers.get(sessionKey));
      for (const connId of params.sessionEventSubscribers?.getAll() ?? []) {
        if (params.isVisible(connId)) {
          recipients.add(connId);
        }
      }
      return recipients;
    },
  };
}
