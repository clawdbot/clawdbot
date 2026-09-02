// Gateway event subscription wiring for agent, heartbeat, transcript, and lifecycle broadcasts.
import { isDefinitiveRunLifecycle } from "../agents/agent-run-terminal-outcome.js";
import {
  isAuditLedgerEnabled,
  isExecutionIdentityCollectionEnabled,
  resolveAuditMessageMode,
} from "../audit/audit-config.js";
import { createAuditEventRecorder } from "../audit/audit-recorder.js";
import { configureExecutionDecisionWorkSink } from "../audit/execution-decision-work.js";
import { configureExecutionIdentityAdmissionSink } from "../audit/execution-identity-admission.js";
import { configureMessageActionDecisionSink } from "../audit/message-action-decision.js";
import { onTrustedMessageAuditEvent } from "../audit/message-audit-events.js";
import { configureRuntimeActionDecisionSink } from "../audit/runtime-action-decision.js";
import {
  configureChannelAdmissionDecisionSink,
  configureChannelAdmissionEvidenceCollection,
} from "../channels/message-access/admission-evidence.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  type AgentEventRuntimePayload,
  onAgentAuditEvent,
  onAgentRuntimeEvent,
} from "../infra/agent-events.js";
import { clearAgentRunContext, getAgentRunContext } from "../infra/agent-run-registry.js";
import { onTrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createLazyPromise, createLazyPromiseLoader } from "../shared/lazy-runtime.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { isTerminalTaskStatus } from "../tasks/task-executor-policy.js";
import type { TaskRegistryObserverEvent } from "../tasks/task-registry.store.js";
import { markChatAbortTerminalPersistenceError } from "./chat-abort-lifecycle-internal.js";
import {
  type ChatAbortControllerEntry,
  removeChatAbortControllerEntry,
  type RestartRecoveryCandidate,
} from "./chat-abort.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import type {
  ChatRunState,
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
  ToolEventRecipientRegistry,
} from "./server-chat-state.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { mapTaskSummary, type TaskEventPayload } from "./server-methods/task-summary.js";
import { defaultSessionCompanionContextReader } from "./session-companion-context.js";
import { createSessionCompanion } from "./session-companion.js";
import { createSessionLifecyclePersistenceOwner } from "./session-lifecycle-persistence-owner.js";
import { createSessionObserver } from "./session-observer.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import { resolveTaskRequesterSessionTarget } from "./task-session-access.js";
import type { TerminalSessionManager } from "./terminal/session-manager.js";

function dispatchEventHandler<TEvent>(params: {
  loadHandler: () => Promise<(event: TEvent) => unknown>;
  event: TEvent;
  log: SubsystemLogger;
  failureMessage: string;
  context: Record<string, unknown>;
  onFailure?: () => void;
}) {
  return params
    .loadHandler()
    .then((handler) => handler(params.event))
    .then(() => undefined)
    .catch((error: unknown) => {
      params.log.warn(params.failureMessage, { ...params.context, error });
      params.onFailure?.();
    });
}

function terminalTaskId(event: TaskRegistryObserverEvent): string | undefined {
  if (event.kind !== "upserted" || !isTerminalTaskStatus(event.task.status)) {
    return undefined;
  }
  if (event.previous && isTerminalTaskStatus(event.previous.status)) {
    return undefined;
  }
  return event.task.taskId;
}

/** Register gateway runtime event subscriptions and return unsubscribe handles. */
export function startGatewayEventSubscriptions(params: {
  log: SubsystemLogger;
  broadcast: GatewayBroadcastFn;
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
  terminalSessions: Pick<TerminalSessionManager, "closeTaskSessions">;
}) {
  // The worker always runs retention maintenance. audit.enabled only controls
  // producer subscriptions, so disabling collection cannot strand expired rows.
  const runtimeConfig = getRuntimeConfig();
  const auditEnabled = isAuditLedgerEnabled(runtimeConfig);
  const auditMessageMode = resolveAuditMessageMode(runtimeConfig);
  const auditRecorder = createAuditEventRecorder({
    messageMode: auditEnabled ? auditMessageMode : "off",
  });
  const clearExecutionIdentityAdmissionSink = configureExecutionIdentityAdmissionSink(
    auditRecorder.recordExecutionIdentity,
  );
  const clearExecutionDecisionWorkSink = configureExecutionDecisionWorkSink(
    auditRecorder.recordExecutionDecisionWork,
  );
  const clearChannelAdmissionEvidenceCollection = configureChannelAdmissionEvidenceCollection(
    isExecutionIdentityCollectionEnabled(runtimeConfig),
  );
  const clearChannelAdmissionDecisionSink = configureChannelAdmissionDecisionSink(
    auditRecorder.recordExecutionDecision,
  );
  const clearMessageActionDecisionSink = configureMessageActionDecisionSink(
    auditRecorder.recordExecutionDecision,
  );
  const clearRuntimeActionDecisionSink = configureRuntimeActionDecisionSink(
    auditRecorder.recordExecutionDecision,
  );
  const sessionObserver = createSessionObserver({
    getConfig: getRuntimeConfig,
    subscribers: params.sessionMessageSubscribers,
    sessionEventSubscribers: params.sessionEventSubscribers,
    broadcastToConnIds: params.broadcastToConnIds,
  });
  const sessionCompanion = createSessionCompanion({
    contextReader: defaultSessionCompanionContextReader,
    getConfig: getRuntimeConfig,
    sessionObserver,
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
  const sessionLifecyclePersistence = createSessionLifecyclePersistenceOwner();
  const agentEventDispatches = new Set<Promise<void>>();
  const trackedRunIds = (runId: string, clientRunId: string) =>
    runId === clientRunId ? [runId] : [runId, clientRunId];
  const clearTrackedActiveRun = (run: { runId: string; clientRunId: string }) => {
    for (const candidateRunId of trackedRunIds(run.runId, run.clientRunId)) {
      const entry = params.chatAbortControllers.get(candidateRunId);
      if (!entry) {
        continue;
      }
      entry.projectSessionActive = false;
      entry.projectSessionTerminalPersisted = false;
      markChatAbortTerminalPersistenceError(entry, undefined);
      queueMicrotask(() => {
        const current = params.chatAbortControllers.get(candidateRunId);
        if (
          current === entry &&
          entry.registrationCleanupRequested === true &&
          !entry.projectSessionTerminalPersistence
        ) {
          removeChatAbortControllerEntry(params.chatAbortControllers, candidateRunId, entry);
        }
      });
    }
  };
  const settleTrackedTerminal = (run: {
    runId: string;
    clientRunId: string;
    persisted?: boolean;
  }) => {
    const persisted = run.persisted ?? true;
    for (const candidateRunId of trackedRunIds(run.runId, run.clientRunId)) {
      const entry = params.chatAbortControllers.get(candidateRunId);
      if (!entry) {
        continue;
      }
      if (persisted) {
        params.restartRecoveryCandidates.delete(candidateRunId);
        markChatAbortTerminalPersistenceError(entry, undefined);
      }
      entry.projectSessionTerminalPending = false;
      entry.projectSessionTerminalPersistence = undefined;
      entry.projectSessionTerminalPersisted = persisted;
      if (entry.registrationCleanupRequested === true) {
        removeChatAbortControllerEntry(params.chatAbortControllers, candidateRunId, entry);
      }
    }
  };
  const trackTrackedRunTerminalPersistence = (run: {
    runId: string;
    clientRunId: string;
    sessionId?: string;
    persistence: Promise<void>;
  }) => {
    let tracked = false;
    for (const candidateRunId of trackedRunIds(run.runId, run.clientRunId)) {
      const entry = params.chatAbortControllers.get(candidateRunId);
      if (!entry) {
        continue;
      }
      tracked = true;
      entry.projectSessionTerminalPersistence = run.persistence;
      void run.persistence.catch((error: unknown) => {
        markChatAbortTerminalPersistenceError(entry, error);
      });
      const lifecycleGeneration = entry.lifecycleGeneration?.trim();
      const sessionKey = entry.sessionKey.trim();
      const sessionId = run.sessionId?.trim() || entry.sessionId.trim();
      // Lazy chat consumption must retain the terminal time stamped at ingress.
      const observedAt = entry.projectSessionTerminalObservedAt;
      if (entry.controlUiVisible !== false && lifecycleGeneration && sessionKey && sessionId) {
        void run.persistence.catch(() => {
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
    return tracked;
  };
  const getSessionKeyModule = createLazyPromise(() => import("./server-session-key.js"), {
    cacheRejections: true,
  });
  const agentEventHandlerLoader = createLazyPromiseLoader(
    () => {
      // Lazy-load heavy chat modules only after the first agent event reaches the gateway.
      return Promise.all([import("./server-chat.js"), getSessionKeyModule()]).then(
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
            persistGatewaySessionLifecycleEventForEvent: sessionLifecyclePersistence.persist,
            updateRunToolErrorSummary: ({ runId, clientRunId, summary }) => {
              for (const candidateRunId of new Set([runId, clientRunId])) {
                const entry = params.chatAbortControllers.get(candidateRunId);
                if (entry) {
                  entry.toolErrorSummary = summary;
                }
              }
            },
            clearTrackedActiveRun,
            settleTrackedTerminal,
            trackTrackedRunTerminalPersistence,
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
                defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(
                  getRuntimeConfig(),
                  session.requestedKey,
                ),
              }),
          }),
      );
    },
    { cacheRejections: true },
  );
  const getAgentEventHandler = agentEventHandlerLoader.load;

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
    let failedDispatchCleanup: (() => void) | undefined;
    let terminalPreparation: Promise<void> | undefined;
    sessionObserver.handleEvent(evt);
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
      const observedAt =
        typeof evt.data.endedAt === "number" && Number.isFinite(evt.data.endedAt)
          ? evt.data.endedAt
          : evt.ts;
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
          entry.projectSessionTerminalObservedAt = observedAt;
        }
      }
      const trackedEntry = candidateRunIds
        .map((candidateRunId) => params.chatAbortControllers.get(candidateRunId))
        .find((entry) => entry !== undefined);
      const runContext = getAgentRunContext(evt.runId);
      const sessionAgentId = trackedEntry?.agentId ?? evt.agentId ?? runContext?.agentId;
      const knownSessionKey =
        evt.deliverySessionKey ??
        evt.sessionKey ??
        trackedEntry?.sessionKey ??
        runContext?.sessionKey;
      const eventLifecycleGeneration = evt.lifecycleGeneration?.trim();
      const terminalAuthority =
        evt.contextClaimId && eventLifecycleGeneration
          ? {
              claimId: evt.contextClaimId,
              lifecycleGeneration: eventLifecycleGeneration,
              runId: evt.runId,
            }
          : undefined;
      const trackedOwnerIsCurrent =
        !trackedEntry ||
        !eventLifecycleGeneration ||
        !trackedEntry.lifecycleGeneration ||
        trackedEntry.lifecycleGeneration === eventLifecycleGeneration;
      const claimIsComplete = !evt.contextClaimId || terminalAuthority !== undefined;
      const canPersistTerminal =
        isDefinitiveRunLifecycle({ phase: lifecyclePhase, data: evt.data }) &&
        evt.projectSessionLifecycle !== false &&
        trackedOwnerIsCurrent &&
        claimIsComplete;
      const prepareTerminalPersistence = (sessionKey: string) => {
        const persistence = sessionLifecyclePersistence.observe({
          sessionKey,
          ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
          event: evt,
          ...(terminalAuthority ? { authority: terminalAuthority } : {}),
          ...(clientRunId !== evt.runId ? { clientRunId } : {}),
        });
        if (terminalAuthority) {
          // A failed lazy handler cannot consume the prepared write and release
          // its claim. Persistence settlement becomes that cleanup boundary.
          const clearTerminalAuthority = () =>
            clearAgentRunContext(
              terminalAuthority.runId,
              terminalAuthority.lifecycleGeneration,
              terminalAuthority.claimId,
            );
          failedDispatchCleanup = () => {
            void persistence.then(clearTerminalAuthority, clearTerminalAuthority);
          };
        }
        clearTrackedActiveRun({ runId: evt.runId, clientRunId });
        const tracked = trackTrackedRunTerminalPersistence({
          runId: evt.runId,
          clientRunId,
          sessionId: evt.sessionId,
          persistence,
        });
        if (!tracked) {
          void persistence.catch((error: unknown) => {
            params.log.warn("Terminal session persistence failed", { runId: evt.runId, error });
          });
        }
        void persistence.then(
          () => settleTrackedTerminal({ runId: evt.runId, clientRunId }),
          () => settleTrackedTerminal({ runId: evt.runId, clientRunId, persisted: false }),
        );
      };
      if (canPersistTerminal) {
        if (knownSessionKey) {
          prepareTerminalPersistence(knownSessionKey);
        } else {
          // Context cleanup can precede a terminal event. Resolve its persisted
          // run mapping before the lazy chat handler consumes the same event.
          terminalPreparation = getSessionKeyModule().then(({ resolveSessionKeyForRun }) => {
            const sessionKey = resolveSessionKeyForRun(
              evt.runId,
              sessionAgentId ? { agentId: sessionAgentId } : undefined,
            );
            if (sessionKey) {
              prepareTerminalPersistence(sessionKey);
            }
          });
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
    const dispatchPreparation = terminalPreparation;
    const dispatch = dispatchEventHandler<AgentEventRuntimePayload>({
      loadHandler: dispatchPreparation
        ? () => dispatchPreparation.then(() => getAgentEventHandler())
        : getAgentEventHandler,
      event: evt,
      log: params.log,
      failureMessage: "Agent event dispatch failed",
      context: { runId: evt.runId, stream: evt.stream },
      onFailure: () => failedDispatchCleanup?.(),
    });
    agentEventDispatches.add(dispatch);
    void dispatch.then(() => agentEventDispatches.delete(dispatch));
  });
  const agentUnsub = async () => {
    unsubscribeAgentEvents();
    sessionCompanion.dispose();
    sessionObserver.dispose();
    unsubscribePrivateAuditEvents?.();
    unsubscribeToolAuditEvents?.();
    unsubscribeMessageAuditEvents?.();
    clearExecutionDecisionWorkSink();
    clearExecutionIdentityAdmissionSink();
    clearChannelAdmissionEvidenceCollection();
    clearChannelAdmissionDecisionSink();
    clearMessageActionDecisionSink();
    clearRuntimeActionDecisionSink();
    // A missing-key terminal can still be resolving its persisted run mapping.
    // Join dispatch first so handler consumption precedes persistence drain.
    await Promise.allSettled(agentEventDispatches);
    await agentEventHandlerLoader
      .peek()
      ?.then((handler) => handler.dispose())
      .catch(() => undefined);
    await sessionLifecyclePersistence.drain();
    await auditRecorder.stop();
  };

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    params.broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  const transcriptUnsub = onInternalSessionTranscriptUpdate((evt) => {
    void dispatchEventHandler({
      loadHandler: getTranscriptUpdateHandler,
      event: evt,
      log: params.log,
      failureMessage: "Transcript update dispatch failed",
      context: { sessionKey: evt.sessionKey },
    });
  });

  const unsubscribeProfileChanges = onUserProfilesChanged(() => {
    params.broadcastToConnIds(
      "sessions.changed",
      { reason: "profile-identity" },
      params.sessionEventSubscribers.getAll(),
    );
  });
  const unsubscribeLifecycle = onSessionLifecycleEvent((evt) => {
    void dispatchEventHandler({
      loadHandler: getLifecycleEventHandler,
      event: evt,
      log: params.log,
      failureMessage: "Lifecycle event dispatch failed",
      context: { sessionKey: evt.sessionKey },
    });
  });
  const lifecycleUnsub = () => {
    unsubscribeProfileChanges();
    unsubscribeLifecycle();
  };

  let taskObserverDisposed = false;
  const lastTaskSummaryById = new Map<string, string>();
  const taskObservers = {
    onEvent: (event: TaskRegistryObserverEvent) => {
      let payload: TaskEventPayload;
      let sessionTarget: ReturnType<typeof resolveTaskRequesterSessionTarget>;
      switch (event.kind) {
        case "upserted": {
          const task = mapTaskSummary(event.task);
          const summary = JSON.stringify(task);
          if (lastTaskSummaryById.get(task.id) === summary) {
            return;
          }
          lastTaskSummaryById.set(task.id, summary);
          payload = { action: "upserted", task };
          sessionTarget = resolveTaskRequesterSessionTarget(event.task);
          break;
        }
        case "deleted":
          lastTaskSummaryById.delete(event.taskId);
          payload = { action: "deleted", taskId: event.taskId };
          sessionTarget = resolveTaskRequesterSessionTarget(event.previous);
          break;
        case "restored":
          lastTaskSummaryById.clear();
          payload = { action: "restored" };
          break;
      }
      params.broadcast("task", payload, {
        dropIfSlow: true,
        ...(sessionTarget
          ? { sessionKeys: [sessionTarget.sessionKey], agentId: sessionTarget.agentId }
          : {}),
      });
      const taskId = terminalTaskId(event);
      if (taskId) {
        params.terminalSessions.closeTaskSessions(taskId);
      }
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
    sessionCompanion,
    sessionObserver,
    agentUnsub,
    heartbeatUnsub,
    transcriptUnsub,
    lifecycleUnsub,
    taskUnsub,
  };
}
