import crypto from "node:crypto";
import type { CurrentInboundPromptContext } from "../../agents/embedded-agent-runner/run/params.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { TypingMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { resolveRunAfterAutoFallbackPrimaryProbeRecheck } from "./agent-runner-auto-fallback.js";
import { resolveAdmittedRunSessionFile } from "./agent-runner-core.js";
import { buildPreflightCompactionFailureText } from "./agent-runner-failure-reply.js";
import { runPreflightCompactionIfNeeded } from "./agent-runner-memory.js";
import {
  resolveQueuedReplyExecutionConfig,
  resolveQueuedReplyRuntimeConfig,
} from "./agent-runner-utils.js";
import {
  createCompactionNoticePayload,
  shouldNotifyUserAboutCompaction,
  type CompactionNoticePhase,
} from "./compaction-notice.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { refreshActiveGoalContext } from "./inbound-meta.js";
import {
  admitFollowupRunLifecycle,
  isFollowupRunAborted,
  resolveFollowupAbortSignal,
  type FollowupRun,
} from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import {
  createReplySessionEntryHandle,
  ReplySessionGenerationInvalidatedError as FollowupSessionGenerationInvalidatedError,
} from "./session-entry-handle.js";
import type { TypingController } from "./typing.js";

export type FollowupRunnerParams = {
  opts?: InternalGetReplyOptions;
  typing: TypingController;
  typingMode: TypingMode;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  toolProgressDetail?: "explain" | "raw";
};

export async function settleQueuedFollowupPresentation(
  defaults: FollowupRunnerParams,
): Promise<void> {
  try {
    await defaults.opts?.onQueuedFollowupSettled?.();
  } catch (error) {
    defaultRuntime.error?.(
      `followup queue: queued presentation cleanup failed: ${formatErrorMessage(error)}`,
    );
  }
}

type FollowupSessionOwner = {
  current: () => SessionEntry | undefined;
  publish(entry: SessionEntry | undefined): void;
  adopt(entry: SessionEntry): void;
} & ({ kind: "detached" } | { kind: "session"; key: string; storePath?: string });

export type AdmittedFollowupTurn = {
  runId: string;
  queued: FollowupRun;
  operation: ReplyOperation;
  config: OpenClawConfig;
  session: FollowupSessionOwner;
  sessionStore?: Record<string, SessionEntry>;
  currentInboundContext?: CurrentInboundPromptContext;
  sendPolicy: "allow" | "deny";
  preflightCompactionApplied: boolean;
  preflightFailurePayload?: ReplyPayload;
  preflightError?: unknown;
};

type FollowupAdmissionResult =
  | { kind: "admitted"; turn: AdmittedFollowupTurn }
  | { kind: "deferred"; reason: "active-run" }
  | {
      kind: "skipped";
      reason: "aborted" | "lifecycle-invalidated";
      operation?: ReplyOperation;
    };

function resolveFollowupCurrentMessageId(queued: FollowupRun): string | undefined {
  return queued.run.inputProvenance?.kind === "internal_system" &&
    queued.run.inputProvenance.sourceTool === "restart-sentinel"
    ? queued.originatingReplyToId
    : queued.messageId;
}

function isSameSessionGeneration(
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.sessionId === right.sessionId &&
    left.lifecycleRevision === right.lifecycleRevision,
  );
}

/** Resolves one queued item into an immutable admitted turn. */
export async function admitFollowupTurn(params: {
  queued: FollowupRun;
  defaults: FollowupRunnerParams;
  onCompactionNoticePayload?: (payload: ReplyPayload, turn: AdmittedFollowupTurn) => Promise<void>;
}): Promise<FollowupAdmissionResult> {
  const resolvedConfig = await resolveQueuedReplyExecutionConfig(params.queued.run.config, {
    originatingChannel: params.queued.originatingChannel,
    messageProvider: params.queued.run.messageProvider,
    originatingAccountId: params.queued.originatingAccountId,
    agentAccountId: params.queued.run.agentAccountId,
  });
  const config = resolveQueuedReplyRuntimeConfig(resolvedConfig);
  const replySessionKey = params.queued.run.sessionKey ?? params.defaults.sessionKey;
  const initialStoredEntry = replySessionKey
    ? params.defaults.sessionStore?.[replySessionKey]
    : undefined;
  const initialEntry =
    initialStoredEntry ??
    (replySessionKey === params.defaults.sessionKey ? params.defaults.sessionEntry : undefined);
  let run = { ...params.queued.run, config };
  const resolveRunSessionFile = (source: FollowupRun["run"], sessionId: string) =>
    resolveAdmittedRunSessionFile({
      agentId: source.agentId,
      sessionId,
      sessionKey: replySessionKey,
      storePath: params.defaults.storePath,
    }) ?? source.sessionFile;
  const admission = await admitReplyTurn({
    sessionId: params.queued.admissionSessionId ?? run.sessionId,
    sessionKey: replySessionKey ?? "",
    expectedSessionId: initialEntry?.sessionId,
    storePath: params.defaults.storePath,
    kind: "queued_followup",
    resetTriggered: false,
    routeThreadId: params.queued.originatingThreadId,
    originatingLeafEntryId: params.queued.turnAdoptionLifecycle?.originatingLeafEntryId,
    upstreamAbortSignal: resolveFollowupAbortSignal(params.queued),
    onReplyAdmissionWaitChange: params.queued.onReplyAdmissionWaitChange,
  });
  if (admission.status === "skipped") {
    return admission.reason === "active-run"
      ? { kind: "deferred", reason: "active-run" }
      : { kind: "skipped", reason: admission.reason };
  }
  const operation = admission.operation;
  operation.retainFailureUntilComplete();
  let queuedFollowupAdmitted = false;
  try {
    await admitFollowupRunLifecycle(params.queued);
    if (isFollowupRunAborted(params.queued)) {
      return { kind: "skipped", reason: "aborted", operation };
    }

    // Queue drains retain the latest live runner closure per key. Keep local dispatcher
    // callbacks in that closure so retried non-routable items use the newest transport owner.
    queuedFollowupAdmitted = true;
    await params.defaults.opts?.onQueuedFollowupAdmitted?.();
    if (operation.sessionId !== run.sessionId) {
      run = {
        ...run,
        sessionId: operation.sessionId,
        sessionFile: resolveRunSessionFile(run, operation.sessionId),
        cliSessionBindingFacts: undefined,
        autoFallbackPrimaryProbe: undefined,
        modelSelectionLocked: false,
      };
    }
    const admittedEntry = replySessionKey
      ? params.defaults.storePath
        ? loadSessionEntry({ storePath: params.defaults.storePath, sessionKey: replySessionKey })
        : params.defaults.sessionStore?.[replySessionKey]
      : undefined;
    const expectedPersistedEntry =
      admission.sessionEntry?.sessionId === operation.sessionId
        ? admission.sessionEntry
        : initialEntry?.sessionId === operation.sessionId
          ? initialEntry
          : undefined;
    const assertPersistedGeneration = (entry: SessionEntry | undefined) => {
      const matchesExpectedGeneration = isSameSessionGeneration(entry, expectedPersistedEntry);
      const shouldValidateGeneration =
        Boolean(params.defaults.storePath) || entry !== initialStoredEntry;
      if (
        shouldValidateGeneration &&
        ((expectedPersistedEntry && !matchesExpectedGeneration) ||
          (!expectedPersistedEntry && entry && entry.sessionId !== operation.sessionId))
      ) {
        throw new FollowupSessionGenerationInvalidatedError(
          "Follow-up session generation changed after reply admission",
        );
      }
    };
    assertPersistedGeneration(admittedEntry);
    const admissionEntry =
      admission.sessionEntry?.sessionId === operation.sessionId
        ? admission.sessionEntry
        : undefined;
    const reloadedEntry =
      admittedEntry?.sessionId === operation.sessionId ? admittedEntry : undefined;
    const freshestMatchingEntry =
      reloadedEntry && admissionEntry
        ? reloadedEntry.updatedAt >= admissionEntry.updatedAt
          ? reloadedEntry
          : admissionEntry
        : (reloadedEntry ?? admissionEntry);
    let activeEntry =
      freshestMatchingEntry ??
      (admittedEntry === undefined && initialEntry?.sessionId === operation.sessionId
        ? initialEntry
        : undefined);
    const lifecycleRevisionChanged =
      operation.sessionId === params.queued.run.sessionId &&
      activeEntry?.sessionId === operation.sessionId &&
      activeEntry.lifecycleRevision !==
        (initialEntry?.sessionId === operation.sessionId
          ? initialEntry.lifecycleRevision
          : undefined);
    if (activeEntry?.sessionId === operation.sessionId) {
      run = {
        ...run,
        sessionFile: resolveRunSessionFile(run, operation.sessionId),
        modelSelectionLocked: activeEntry.modelSelectionLocked === true,
        ...(lifecycleRevisionChanged
          ? {
              cliSessionBindingFacts: undefined,
              autoFallbackPrimaryProbe: undefined,
            }
          : {}),
      };
    }
    run = resolveRunAfterAutoFallbackPrimaryProbeRecheck({
      run,
      entry: activeEntry,
      sessionKey: replySessionKey,
    });
    const queued: FollowupRun = { ...params.queued, run };
    const sessionEntryHandle = createReplySessionEntryHandle({
      sessionEntry: activeEntry,
      sessionKey: replySessionKey,
      sessionStore: params.defaults.sessionStore,
      generationFence: {
        sessionId: operation.sessionId,
        expectedStoreEntry: initialStoredEntry,
      },
    });
    const session: FollowupSessionOwner = {
      ...(replySessionKey
        ? { kind: "session" as const, key: replySessionKey, storePath: params.defaults.storePath }
        : { kind: "detached" as const }),
      current: () => sessionEntryHandle.getCurrent(),
      publish: (entry) => entry && sessionEntryHandle.replaceCurrent(entry),
      adopt: (entry) => sessionEntryHandle.adoptCurrent(entry),
    };
    const sessionStore = replySessionKey
      ? sessionEntryHandle.toCompatSessionStore()
      : params.defaults.sessionStore;
    const resolveTurnSendPolicy = (entry: SessionEntry | undefined, source: FollowupRun = queued) =>
      resolveSendPolicy({
        cfg: config,
        entry,
        sessionKey: source.run.runtimePolicySessionKey ?? replySessionKey,
        channel:
          source.originatingChannel ?? source.run.messageProvider ?? sessionDeliveryChannel(entry),
        chatType: normalizeChatType(
          source.originatingChatType ?? source.run.chatType ?? entry?.chatType,
        ),
      });
    const currentInboundContext =
      params.defaults.opts?.isHeartbeat === true
        ? queued.currentInboundContext
        : refreshActiveGoalContext(queued.currentInboundContext, activeEntry);
    // Preallocate the one lifecycle identity passed as opts.runId; canonical
    // execution owns registration and cleanup under this same id.
    const turn: AdmittedFollowupTurn = {
      runId: crypto.randomUUID(),
      queued: { ...queued, currentInboundContext },
      operation,
      config,
      session,
      sessionStore,
      currentInboundContext,
      sendPolicy: resolveTurnSendPolicy(activeEntry),
      preflightCompactionApplied: false,
    };
    const refreshTurnSessionState = (entry: SessionEntry | undefined) => {
      const refreshedInboundContext =
        params.defaults.opts?.isHeartbeat === true
          ? params.queued.currentInboundContext
          : refreshActiveGoalContext(params.queued.currentInboundContext, entry);
      turn.sendPolicy = resolveTurnSendPolicy(entry, turn.queued);
      turn.currentInboundContext = refreshedInboundContext;
      turn.queued = { ...turn.queued, currentInboundContext: refreshedInboundContext };
    };
    const readTurnSessionEntry = () =>
      replySessionKey && params.defaults.storePath
        ? loadSessionEntry({
            storePath: params.defaults.storePath,
            sessionKey: replySessionKey,
          })
        : replySessionKey && params.defaults.sessionStore
          ? params.defaults.sessionStore[replySessionKey]
          : session.current();
    const synchronizeTurnGeneration = (
      entry: SessionEntry | undefined,
      previousEntry: SessionEntry | undefined,
    ) => {
      const generationRotated = Boolean(entry && !isSameSessionGeneration(entry, previousEntry));
      if (entry && generationRotated) {
        operation.updateSessionId(entry.sessionId);
        turn.queued = {
          ...turn.queued,
          run: {
            ...turn.queued.run,
            sessionId: entry.sessionId,
            sessionFile: resolveRunSessionFile(turn.queued.run, entry.sessionId),
            cliSessionBindingFacts: undefined,
            autoFallbackPrimaryProbe: undefined,
            modelSelectionLocked: entry.modelSelectionLocked === true,
          },
        };
      }
      return generationRotated;
    };
    const previousCompactionCount = activeEntry?.compactionCount ?? 0;
    let pendingTerminalCompactionNotice:
      | { phase: Exclude<CompactionNoticePhase, "start">; text?: string }
      | undefined;
    let compactionNoticeGenerationInvalidated = false;
    const notifyPreflightCompaction =
      turn.sendPolicy === "allow" &&
      queued.currentInboundEventKind !== "room_event" &&
      shouldNotifyUserAboutCompaction(config)
        ? async (phase: CompactionNoticePhase, text?: string) => {
            if (phase !== "start") {
              pendingTerminalCompactionNotice = { phase, text };
              return;
            }
            const noticeEntry = readTurnSessionEntry();
            try {
              assertPersistedGeneration(noticeEntry);
            } catch (error) {
              if (error instanceof FollowupSessionGenerationInvalidatedError) {
                compactionNoticeGenerationInvalidated = true;
                operation.abortForRestart();
                throw error;
              }
              throw error;
            }
            if (resolveTurnSendPolicy(noticeEntry, turn.queued) === "deny") {
              return;
            }
            await params.onCompactionNoticePayload?.(
              createCompactionNoticePayload({
                phase,
                currentMessageId: resolveFollowupCurrentMessageId(queued),
              }),
              turn,
            );
          }
        : undefined;
    const preflightEntry = session.current();
    try {
      activeEntry = await runPreflightCompactionIfNeeded({
        cfg: config,
        followupRun: turn.queued,
        promptForEstimate: turn.queued.prompt,
        defaultModel: params.defaults.defaultModel,
        sessionEntry: activeEntry,
        sessionStore,
        sessionKey: replySessionKey,
        storePath: params.defaults.storePath,
        isHeartbeat: params.defaults.opts?.isHeartbeat === true,
        replyOperation: operation,
        onCompactionNotice: notifyPreflightCompaction,
      });
      if (compactionNoticeGenerationInvalidated) {
        throw new FollowupSessionGenerationInvalidatedError(
          "Follow-up session generation changed during preflight notice delivery",
        );
      }
      if (replySessionKey && params.defaults.storePath) {
        const persistedEntry = readTurnSessionEntry();
        if (
          (!persistedEntry && preflightEntry) ||
          (persistedEntry &&
            !isSameSessionGeneration(persistedEntry, preflightEntry) &&
            !isSameSessionGeneration(persistedEntry, activeEntry))
        ) {
          throw new FollowupSessionGenerationInvalidatedError(
            "Follow-up session generation changed during preflight",
          );
        }
        if (
          persistedEntry &&
          (!activeEntry ||
            (isSameSessionGeneration(persistedEntry, activeEntry) &&
              persistedEntry.updatedAt >= activeEntry.updatedAt))
        ) {
          activeEntry = persistedEntry;
        }
      }
      if (activeEntry) {
        session.adopt(activeEntry);
        activeEntry = session.current() ?? activeEntry;
      }
      const generationRotated = synchronizeTurnGeneration(activeEntry, preflightEntry);
      refreshTurnSessionState(activeEntry);
      turn.preflightCompactionApplied =
        generationRotated || (activeEntry?.compactionCount ?? 0) > previousCompactionCount;
    } catch (error) {
      const failureEntry = readTurnSessionEntry();
      if (!isSameSessionGeneration(failureEntry, session.current())) {
        assertPersistedGeneration(failureEntry);
      }
      if (failureEntry) {
        session.adopt(failureEntry);
        activeEntry = session.current() ?? failureEntry;
      }
      synchronizeTurnGeneration(activeEntry, preflightEntry);
      refreshTurnSessionState(activeEntry);
      if (compactionNoticeGenerationInvalidated) {
        throw new FollowupSessionGenerationInvalidatedError(
          "Follow-up session generation changed during preflight notice delivery",
        );
      }
      if (error instanceof FollowupSessionGenerationInvalidatedError) {
        throw error;
      }
      operation.fail("run_failed", error);
      const admittedVerboseLevel = session.current()?.verboseLevel ?? turn.queued.run.verboseLevel;
      const text = buildPreflightCompactionFailureText(formatErrorMessage(error), {
        includeDetails: admittedVerboseLevel === "on" || admittedVerboseLevel === "full",
      });
      if (!text) {
        turn.preflightError = error;
      } else {
        turn.preflightFailurePayload = markReplyPayloadForSourceSuppressionDelivery({ text });
      }
    }
    if (
      pendingTerminalCompactionNotice &&
      turn.sendPolicy === "allow" &&
      turn.queued.currentInboundEventKind !== "room_event"
    ) {
      await params.onCompactionNoticePayload?.(
        createCompactionNoticePayload({
          phase: pendingTerminalCompactionNotice.phase,
          text: pendingTerminalCompactionNotice.text,
          currentMessageId: resolveFollowupCurrentMessageId(turn.queued),
        }),
        turn,
      );
    }
    return { kind: "admitted", turn };
  } catch (error) {
    if (queuedFollowupAdmitted) {
      await settleQueuedFollowupPresentation(params.defaults);
    }
    operation.complete();
    throw error instanceof Error ? error : new Error(formatErrorMessage(error));
  }
}
