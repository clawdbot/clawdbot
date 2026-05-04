import { clearAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type {
  ChatRunState,
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
  ToolEventRecipientRegistry,
} from "./server-chat-state.js";

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
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
}) {
  let agentEventHandlerPromise: Promise<
    ReturnType<typeof import("./server-chat.js").createAgentEventHandler>
  > | null = null;
  const getAgentEventHandler = () => {
    agentEventHandlerPromise ??= Promise.all([
      import("./server-chat.js"),
      import("./server-session-key.js"),
    ]).then(([{ createAgentEventHandler }, { resolveSessionKeyForRun }]) =>
      createAgentEventHandler({
        broadcast: params.broadcast,
        broadcastToConnIds: params.broadcastToConnIds,
        nodeSendToSession: params.nodeSendToSession,
        agentRunSeq: params.agentRunSeq,
        chatRunState: params.chatRunState,
        resolveSessionKeyForRun,
        clearAgentRunContext,
        toolEventRecipients: params.toolEventRecipients,
        sessionEventSubscribers: params.sessionEventSubscribers,
        isChatSendRunActive: (runId) => {
          const entry = params.chatAbortControllers.get(runId);
          return entry !== undefined && entry.kind !== "agent";
        },
      }),
    );
    return agentEventHandlerPromise;
  };

  let transcriptUpdateHandlerPromise: Promise<
    ReturnType<typeof import("./server-session-events.js").createTranscriptUpdateBroadcastHandler>
  > | null = null;
  const getTranscriptUpdateHandler = () => {
    transcriptUpdateHandlerPromise ??= import("./server-session-events.js").then(
      ({ createTranscriptUpdateBroadcastHandler }) =>
        createTranscriptUpdateBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
          sessionMessageSubscribers: params.sessionMessageSubscribers,
        }),
    );
    return transcriptUpdateHandlerPromise;
  };

  let lifecycleEventHandlerPromise: Promise<
    ReturnType<typeof import("./server-session-events.js").createLifecycleEventBroadcastHandler>
  > | null = null;
  const getLifecycleEventHandler = () => {
    lifecycleEventHandlerPromise ??= import("./server-session-events.js").then(
      ({ createLifecycleEventBroadcastHandler }) =>
        createLifecycleEventBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
        }),
    );
    return lifecycleEventHandlerPromise;
  };

  const agentUnsub = onAgentEvent((evt) => {
    void getAgentEventHandler().then((handler) => handler(evt));
  });

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    params.broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  const transcriptUnsub = onSessionTranscriptUpdate((evt) => {
    void getTranscriptUpdateHandler().then((handler) => handler(evt));
  });

  const lifecycleUnsub = onSessionLifecycleEvent((evt) => {
    void getLifecycleEventHandler().then((handler) => handler(evt));
  });

  return {
    agentUnsub,
    heartbeatUnsub,
    transcriptUnsub,
    lifecycleUnsub,
  };
}
