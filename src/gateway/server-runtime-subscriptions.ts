import { onAgentEvent } from "../infra/agent-events.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import {
  createAgentEventHandler,
  type ChatRunState,
  type SessionEventSubscriberRegistry,
  type SessionMessageSubscriberRegistry,
  type ToolEventRecipientRegistry,
} from "./server-chat.js";
import {
  createLifecycleEventBroadcastHandler,
  createTranscriptUpdateBroadcastHandler,
} from "./server-session-events.js";

export function startGatewayEventSubscriptions(params: {
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
}) {
  const agentUnsub = onAgentEvent(
    createAgentEventHandler({
      broadcast: params.broadcast,
      broadcastToConnIds: params.broadcastToConnIds,
      nodeSendToSession: params.nodeSendToSession,
      agentRunSeq: params.agentRunSeq,
      chatRunState: params.chatRunState,
      resolveSessionKeyForRun: params.resolveSessionKeyForRun,
      clearAgentRunContext: params.clearAgentRunContext,
      toolEventRecipients: params.toolEventRecipients,
      sessionEventSubscribers: params.sessionEventSubscribers,
      isChatSendRunActive: (runId) => {
        const entry = params.chatAbortControllers.get(runId);
        return entry !== undefined && entry.kind !== "agent";
      },
    }),
  );

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    params.broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  const transcriptUnsub = onSessionTranscriptUpdate(
    createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds: params.broadcastToConnIds,
      sessionEventSubscribers: params.sessionEventSubscribers,
      sessionMessageSubscribers: params.sessionMessageSubscribers,
    }),
  );

  const lifecycleUnsub = onSessionLifecycleEvent(
    createLifecycleEventBroadcastHandler({
      broadcastToConnIds: params.broadcastToConnIds,
      sessionEventSubscribers: params.sessionEventSubscribers,
    }),
  );

  return {
    agentUnsub,
    heartbeatUnsub,
    transcriptUnsub,
    lifecycleUnsub,
  };
}
