// Gateway event subscription wiring for agent, heartbeat, transcript, and lifecycle broadcasts.
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { isAuditLedgerEnabled, resolveAuditMessageMode } from "../audit/audit-config.js";
import { createAuditEventRecorder } from "../audit/audit-recorder.js";
import { onTrustedMessageAuditEvent } from "../audit/message-audit-events.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  clearAgentRunContext,
  onAgentAuditEvent,
  onAgentRuntimeEvent,
} from "../infra/agent-events.js";
import { onTrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import type { TaskRegistryObserverEvent } from "../tasks/task-registry.store.js";
import {
  type ChatAbortControllerEntry,
  removeChatAbortControllerEntry,
  type RestartRecoveryCandidate,
} from "./chat-abort.js";
import type {
  ChatRunState,
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
  ToolEventRecipientRegistry,
} from "./server-chat-state.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { mapTaskSummary, type TaskEventPayload } from "./server-methods/task-summary.js";

function dispatchEventHandler<TEvent>(params: {
  loadHandler: () => Promise<(event: TEvent) => unknown>;
  event: TEvent;
  log: SubsystemLogger;
  failureMessage: string;
  context: Record<string, unknown>;
}) {
  void params
    .loadHandler()
    .then((handler) => handler(params.event))
    .catch((error: unknown) => {
      params.log.warn(params.failureMessage, { ...params.context, error });
    });
}

/** Register gateway runtime event subscriptions and return unsubscribe handles. */
export function startGatewayEventSubscriptions(params: {
  log: SubsystemLogger;
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
  restartRecoveryCandidates: Map<string, RestartRecoveryCandidate>;
}) {
  // The worker always runs retention maintenance. audit.enabled only controls
  // producer subscriptions, so disabling collection cannot strand expired rows.
  const runtimeConfig = getRuntimeConfig();
  const auditEnabled = isAuditLedgerEnabled(runtimeConfig);
  const auditMessageMode = resolveAuditMessageMode(runtimeConfig);
  const auditRecorder = createAuditEventRecorder({
    messageMode: auditEnabled ? auditMessageMode : "off",
  });
  const unsubscribePrivateAuditEvents = auditEnabled
    ? onAgentAuditEvent(auditRecorder.record)
    : undefined;
  const unsubscribeToolAuditEvents = auditEnabled
    ? onTrustedToolExecutionEvent(auditRecorder.recordTool)
    : undefined;
  const unsubscribeMessageAuditEvents =
    auditEnabled && auditMessageMode !== "off"
      ? onTrustedMessageAuditEvent(auditRecorder.recordMessage)
      : undefined;
  const getAgentEventHandler = createLazyPromise(
    () => {
      // Lazy-load heavy chat modules only after the first agent event reaches the gateway.
      return Promise.all([import("./server-chat.js"), import("./server-session-key.js")]).then(
        ([{ createAgentEventHandler }, { resolveSessionKeyForRun }]) =>
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
            sessionMessageSubscribers: params.sessionMessageSubscribers,
            updateRunToolErrorSummary: ({ runId, clientRunId, summary }) => {
              for (const candidateRunId of new Set([runId, clientRunId])) {
                const entry = params.chatAbortControllers.get(candidateRunId);
                if (entry) {
                  entry.toolErrorSummary = summary;
                }
              }
            },
            clearTrackedActiveRun: ({ runId, clientRunId }) => {
              const candidateRunIds = runId === clientRunId ? [runId] : [runId, clientRunId];
              for (const candidateRunId of candidateRunIds) {
                const entry = params.chatAbortControllers.get(candidateRunId);
                // Chat abort entries can hold the requested key while chat run
                // state holds the canonical key; the run ids are the scoped match.
                if (entry) {
                  entry.projectSessionActive = false;
                  entry.projectSessionTerminalPending = false;
                  entry.projectSessionTerminalPersisted = false;
                  queueMicrotask(() => {
                    const current = params.chatAbortControllers.get(candidateRunId);
                    if (
                      current === entry &&
                      entry.registrationCleanupRequested === true &&
                      !entry.projectSessionTerminalPersistence
                    ) {
                      removeChatAbortControllerEntry(
                        params.chatAbortControllers,
                        candidateRunId,
                        entry,
                      );
                    }
                  });
                }
              }
            },
            markTrackedRunTerminalPersisted: ({ runId, clientRunId }) => {
              const candidateRunIds = runId === clientRunId ? [runId] : [runId, clientRunId];
              for (const candidateRunId of candidateRunIds) {
                params.restartRecoveryCandidates.delete(candidateRunId);
                const entry = params.chatAbortControllers.get(candidateRunId);
                if (entry) {
                  entry.projectSessionTerminalPending = false;
                  entry.projectSessionTerminalPersisted = true;
                  entry.projectSessionTerminalPersistence = undefined;
                }
              }
            },
            trackTrackedRunTerminalPersistence: ({
              runId,
              clientRunId,
              sessionId: terminalSessionId,
              observedAt,
              persistence,
            }) => {
              const candidateRunIds = runId === clientRunId ? [runId] : [runId, clientRunId];
              for (const candidateRunId of candidateRunIds) {
                const entry = params.chatAbortControllers.get(candidateRunId);
                if (entry) {
                  entry.projectSessionTerminalPending = false;
                  entry.projectSessionTerminalPersistence = persistence;
                  if (entry.registrationCleanupRequested === true) {
                    void persistence
                      .catch(() => undefined)
                      .then(() => {
                        if (params.chatAbortControllers.get(candidateRunId) === entry) {
                          removeChatAbortControllerEntry(
                            params.chatAbortControllers,
                            candidateRunId,
                            entry,
                          );
                        }
                      });
                  }
                  const lifecycleGeneration = entry.lifecycleGeneration?.trim();
                  const sessionKey = entry.sessionKey.trim();
                  const sessionId = terminalSessionId?.trim() || entry.sessionId.trim();
                  if (
                    entry.controlUiVisible !== false &&
                    lifecycleGeneration &&
                    sessionKey &&
                    sessionId
                  ) {
                    void persistence.catch(() => {
                      params.restartRecoveryCandidates.set(candidateRunId, {
                        runId: candidateRunId,
                        lifecycleGeneration,
                        sessionKey,
                        sessionId,
                        observedAt,
                      });
                    });
                  }
                }
              }
            },
            isChatSendRunActive: (runId) => {
              const entry = params.chatAbortControllers.get(runId);
              return entry !== undefined && entry.kind !== "agent";
            },
            resolveActiveLifecycleGenerationForRun: (runId) =>
              params.chatAbortControllers.get(runId)?.lifecycleGeneration,
            resolveSessionActiveRunState: (session) =>
              resolveVisibleActiveSessionRunState({
                context: params,
                ...session,
                defaultAgentId: resolveDefaultAgentId(getRuntimeConfig()),
              }),
          }),
      );
    },
    { cacheRejections: true },
  );

  const getSessionEventsModule = createLazyPromise(() => import("./server-session-events.js"), {
    cacheRejections: true,
  });

  let transcriptUpdateHandlerPromise: Promise<
    ReturnType<typeof import("./server-session-events.js").createTranscriptUpdateBroadcastHandler>
  > | null = null;
  const getTranscriptUpdateHandler = () => {
    transcriptUpdateHandlerPromise ??= getSessionEventsModule().then(
      ({ createTranscriptUpdateBroadcastHandler }) =>
        createTranscriptUpdateBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
          sessionMessageSubscribers: params.sessionMessageSubscribers,
          chatAbortControllers: params.chatAbortControllers,
        }),
    );
    return transcriptUpdateHandlerPromise;
  };

  let lifecycleEventHandlerPromise: Promise<
    ReturnType<typeof import("./server-session-events.js").createLifecycleEventBroadcastHandler>
  > | null = null;
  const getLifecycleEventHandler = () => {
    lifecycleEventHandlerPromise ??= getSessionEventsModule().then(
      ({ createLifecycleEventBroadcastHandler }) =>
        createLifecycleEventBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
          chatAbortControllers: params.chatAbortControllers,
        }),
    );
    return lifecycleEventHandlerPromise;
  };

  const unsubscribeAgentEvents = onAgentRuntimeEvent((evt) => {
    if (auditEnabled) {
      auditRecorder.record(evt);
    }
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string"
        ? evt.data.phase
        : undefined;
    if (lifecyclePhase === "end" || lifecyclePhase === "error") {
      const chatLink = evt.contextClaimId
        ? undefined
        : params.chatRunState.registry.peek(evt.runId);
      const clientRunId = chatLink?.clientRunId ?? evt.runId;
      const candidateRunIds = evt.runId === clientRunId ? [evt.runId] : [evt.runId, clientRunId];
      for (const candidateRunId of candidateRunIds) {
        const entry = params.chatAbortControllers.get(candidateRunId);
        const eventLifecycleGeneration = evt.lifecycleGeneration?.trim();
        if (
          entry &&
          (!eventLifecycleGeneration ||
            !entry.lifecycleGeneration ||
            entry.lifecycleGeneration === eventLifecycleGeneration)
        ) {
          entry.projectSessionTerminalPending = true;
          entry.projectSessionTerminalObservedAt =
            typeof evt.data.endedAt === "number" && Number.isFinite(evt.data.endedAt)
              ? evt.data.endedAt
              : evt.ts;
        }
      }
    } else if (lifecyclePhase === "start") {
      const chatLink = evt.contextClaimId
        ? undefined
        : params.chatRunState.registry.peek(evt.runId);
      const clientRunId = chatLink?.clientRunId ?? evt.runId;
      const candidateRunIds = evt.runId === clientRunId ? [evt.runId] : [evt.runId, clientRunId];
      const eventLifecycleGeneration = evt.lifecycleGeneration?.trim();
      for (const candidateRunId of candidateRunIds) {
        const entry = params.chatAbortControllers.get(candidateRunId);
        if (
          entry &&
          (!eventLifecycleGeneration ||
            !entry.lifecycleGeneration ||
            entry.lifecycleGeneration === eventLifecycleGeneration)
        ) {
          entry.projectSessionTerminalPending = false;
          entry.projectSessionTerminalObservedAt = undefined;
        }
      }
    }
    dispatchEventHandler({
      loadHandler: getAgentEventHandler,
      event: evt,
      log: params.log,
      failureMessage: "Agent event dispatch failed",
      context: { runId: evt.runId, stream: evt.stream },
    });
  });
  const agentUnsub = async () => {
    unsubscribeAgentEvents();
    unsubscribePrivateAuditEvents?.();
    unsubscribeToolAuditEvents?.();
    unsubscribeMessageAuditEvents?.();
    await auditRecorder.stop();
  };

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    params.broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  const transcriptUnsub = onInternalSessionTranscriptUpdate((evt) => {
    dispatchEventHandler({
      loadHandler: getTranscriptUpdateHandler,
      event: evt,
      log: params.log,
      failureMessage: "Transcript update dispatch failed",
      context: { sessionKey: evt.sessionKey },
    });
  });

  const lifecycleUnsub = onSessionLifecycleEvent((evt) => {
    dispatchEventHandler({
      loadHandler: getLifecycleEventHandler,
      event: evt,
      log: params.log,
      failureMessage: "Lifecycle event dispatch failed",
      context: { sessionKey: evt.sessionKey },
    });
  });

  let taskObserverDisposed = false;
  const taskObservers = {
    onEvent: (event: TaskRegistryObserverEvent) => {
      let payload: TaskEventPayload;
      switch (event.kind) {
        case "upserted":
          payload = { action: "upserted", task: mapTaskSummary(event.task) };
          break;
        case "deleted":
          payload = { action: "deleted", taskId: event.taskId };
          break;
        case "restored":
          payload = { action: "restored" };
          break;
      }
      params.broadcast("task", payload, { dropIfSlow: true });
    },
  };
  const taskObserverRuntimePromise = import("../tasks/task-registry.store.js").then((module) => {
    if (!taskObserverDisposed) {
      module.configureTaskRegistryRuntime({ observers: taskObservers });
    }
    return module;
  });
  void taskObserverRuntimePromise.catch((error: unknown) => {
    params.log.warn("Task registry observer registration failed", { error });
  });
  // The observer slot is a process-wide singleton. Cleanup returns its promise
  // so shutdown can await it, and only clears the slot when it still holds
  // this subscription's observer — a replacement gateway may have registered
  // its own observer before a stale deferred dispose runs.
  const taskUnsub = () => {
    taskObserverDisposed = true;
    return taskObserverRuntimePromise
      .then((module) => {
        if (module.getTaskRegistryObservers() === taskObservers) {
          module.configureTaskRegistryRuntime({ observers: null });
        }
      })
      .catch(() => undefined);
  };

  return {
    agentUnsub,
    heartbeatUnsub,
    transcriptUnsub,
    lifecycleUnsub,
    taskUnsub,
  };
}
