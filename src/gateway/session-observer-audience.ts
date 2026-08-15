import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { resolveSessionSubscriptionKeys } from "./session-subscription-keys.js";

export function createSessionObserverAudience(params: {
  subscribers: SessionMessageSubscriberRegistry;
  sessionEventSubscribers?: SessionEventSubscriberRegistry;
  isVisible: (connId: string) => boolean;
  getConfig: () => OpenClawConfig;
}) {
  const messageSubscriberKeys = (sessionKey: string, agentId: string): string[] => {
    const config = params.getConfig();
    const persistedOwner = resolvePersistedSessionStoreOwnerForKey(config, sessionKey);
    const compatibilityAgentId =
      persistedOwner.kind === "configured"
        ? persistedOwner.agentId
        : tryResolveLegacyCompatibilityAgentId(config);
    return resolveSessionSubscriptionKeys(sessionKey, agentId, compatibilityAgentId);
  };

  const messageRecipients = (sessionKey: string, agentId: string): Set<string> => {
    const recipients = new Set<string>();
    for (const key of messageSubscriberKeys(sessionKey, agentId)) {
      for (const connId of params.subscribers.get(key)) {
        recipients.add(connId);
      }
    }
    return recipients;
  };

  return {
    deliveryOptions(sessionKey: string, agentId: string) {
      return {
        agentId,
        dropIfSlow: true,
        sessionKeys: messageSubscriberKeys(sessionKey, agentId),
        sessionSubscriptionVerified: true,
      };
    },

    has(sessionKey: string, agentId: string): boolean {
      for (const connId of messageRecipients(sessionKey, agentId)) {
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

    recipients(sessionKey: string, agentId: string): ReadonlySet<string> {
      const recipients = messageRecipients(sessionKey, agentId);
      for (const connId of params.sessionEventSubscribers?.getAll() ?? []) {
        if (params.isVisible(connId)) {
          recipients.add(connId);
        }
      }
      return recipients;
    },

    criticalRecipients(sessionKey: string, agentId: string): ReadonlySet<string> {
      const recipients = messageRecipients(sessionKey, agentId);
      // sessions.subscribe is operator.read-gated. Critical fanout drops only
      // Control UI visibility, preserving the existing subscription boundary.
      for (const connId of params.sessionEventSubscribers?.getAll() ?? []) {
        recipients.add(connId);
      }
      return recipients;
    },
  };
}
