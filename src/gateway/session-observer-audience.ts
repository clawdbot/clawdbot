import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import type { SessionObserverState } from "./session-observer-model.js";
import { resolveSessionSubscriptionKeys } from "./session-subscription-keys.js";

export function createSessionObserverAudience(params: {
  subscribers: SessionMessageSubscriberRegistry;
  sessionEventSubscribers?: SessionEventSubscriberRegistry;
  isVisible: (connId: string) => boolean;
  getConfig: () => OpenClawConfig;
}) {
  const messageSubscriberKeys = (sessionKey: string, agentId: string): string[] => {
    const canonicalKeys = resolveSessionSubscriptionKeys(sessionKey, agentId);
    if (canonicalKeys[0] === sessionKey) {
      return canonicalKeys;
    }
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

  const classify = (sessionKey: string, agentId: string): "direct" | "broad" | "none" => {
    for (const key of messageSubscriberKeys(sessionKey, agentId)) {
      for (const connId of params.subscribers.get(key)) {
        if (params.isVisible(connId)) {
          return "direct";
        }
      }
    }
    for (const connId of params.sessionEventSubscribers?.getAll() ?? []) {
      if (params.isVisible(connId)) {
        return "broad";
      }
    }
    return "none";
  };

  return {
    classify,

    deliveryOptions(sessionKey: string, agentId: string) {
      return {
        agentId,
        dropIfSlow: true,
        sessionKeys: messageSubscriberKeys(sessionKey, agentId),
        sessionSubscriptionVerified: true,
      };
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

export function createSessionObserverAudienceLifecycle(params: {
  audience: Pick<ReturnType<typeof createSessionObserverAudience>, "classify">;
  states: Map<string, SessionObserverState>;
  subscribers: SessionMessageSubscriberRegistry;
  isCurrent: (state: SessionObserverState) => boolean;
  resolveUtilityModelRef: (agentId: string) => string | undefined;
  suspend: (state: SessionObserverState) => void;
  demote: (state: SessionObserverState) => void;
}) {
  type ObservedAudience = ReturnType<typeof params.audience.classify>;

  const reconcileState = (state: SessionObserverState): void => {
    const audience = params.audience.classify(state.sessionKey, state.agentId);
    if (audience === "none") {
      params.suspend(state);
    } else if (state.utilityModelRef && audience !== "direct") {
      params.demote(state);
    }
  };

  const reconcileAll = (): void => {
    // Suspension deletes the current entry; Map iteration keeps later states reachable.
    for (const state of params.states.values()) {
      reconcileState(state);
    }
  };

  const unsubscribe = params.subscribers.onChange((sessionKey) => {
    const state = params.states.get(sessionKey);
    if (state) {
      reconcileState(state);
    } else if (sessionKey.toLowerCase() === "global") {
      // Only the legacy bare alias can affect an agent-qualified state indirectly.
      reconcileAll();
    }
  });

  const stateIsCurrent = (
    state: SessionObserverState,
    observedAudience?: ObservedAudience,
  ): boolean =>
    params.isCurrent(state) &&
    (observedAudience ?? params.audience.classify(state.sessionKey, state.agentId)) !== "none";

  const modelStateIsCurrent = (
    state: SessionObserverState,
    observedAudience?: ObservedAudience,
  ): boolean =>
    Boolean(state.utilityModelRef) &&
    (observedAudience ?? params.audience.classify(state.sessionKey, state.agentId)) === "direct" &&
    params.isCurrent(state) &&
    params.resolveUtilityModelRef(state.agentId) === state.utilityModelRef;

  return { stateIsCurrent, modelStateIsCurrent, reconcileAll, unsubscribe };
}
