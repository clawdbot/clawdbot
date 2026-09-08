import type { ChatEvent } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat.js";

export function createWorkerChatProjection(sessionKey: string) {
  const events: ChatEvent[] = [];
  const state = createChatRunState();
  const captureChat = (event: string, payload: unknown) => {
    if (event === "chat") {
      events.push(payload as ChatEvent);
    }
  };
  const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
  sessionMessageSubscribers.subscribe("fault-chat", sessionKey);
  const handler = createAgentEventHandler({
    broadcast: captureChat,
    broadcastToConnIds: captureChat,
    nodeSendToSession: () => {},
    agentRunSeq: new Map(),
    chatRunState: state,
    resolveSessionKeyForRun: () => sessionKey,
    clearAgentRunContext,
    toolEventRecipients: state.toolEventRecipients,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers,
    loadGatewaySessionLifecycleSnapshotForEvent: () => ({ row: null }),
    persistGatewaySessionLifecycleEventForEvent: async () => {},
  });
  const unsubscribe = onAgentRuntimeEvent(handler);
  return {
    events,
    state,
    dispose() {
      unsubscribe();
      handler.dispose();
      state.clear();
    },
  };
}
