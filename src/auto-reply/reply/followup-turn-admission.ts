import crypto from "node:crypto";
import type { CurrentInboundPromptContext } from "../../agents/embedded-agent-runner/run/params.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionTranscriptPath } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { TypingMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
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
  agentCfgContextTokens?: number;
  toolProgressDetail?: "explain" | "raw";
};

type FollowupSessionOwner =
  | {
      kind: "detached";
      current(): SessionEntry | undefined;
      publish(entry: SessionEntry | undefined): void;
      adopt(entry: SessionEntry): void;
    }
  | {
      kind: "session";
      key: string;
      storePath?: string;
      current(): SessionEntry | undefined;
      publish(entry: SessionEntry | undefined): void;
      adopt(entry: SessionEntry): void;
    };

type FollowupSessionStoreOwner = FollowupSessionOwner & {
  clear(): void;
};

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

class FollowupSessionGenerationInvalidatedError extends Error {}

function createFollowupSessionOwner(params: {
  admittedSessionId: string;
  entry?: SessionEntry;
  expectedStoreEntry?: SessionEntry;
  key?: string;
  store?: Record<string, SessionEntry>;
  storePath?: string;
}): FollowupSessionStoreOwner {
  let ownedSessionId = params.admittedSessionId;
  let ownedLifecycleRevision =
    params.entry?.sessionId === ownedSessionId ? params.entry.lifecycleRevision : undefined;
  const matchesGeneration = (entry: SessionEntry | undefined) =>
    entry?.sessionId === ownedSessionId && entry.lifecycleRevision === ownedLifecycleRevision
      ? entry
      : undefined;
  let currentEntry = matchesGeneration(params.entry);
  const current = () => {
    const storedEntry = matchesGeneration(params.key ? params.store?.[params.key] : undefined);
    if (storedEntry && (!currentEntry || storedEntry.updatedAt >= currentEntry.updatedAt)) {
      currentEntry = storedEntry;
    }
    return currentEntry;
  };
  const publish = (entry: SessionEntry | undefined) => {
    const nextEntry = matchesGeneration(entry);
    if (nextEntry && (!currentEntry || nextEntry.updatedAt >= currentEntry.updatedAt)) {
      currentEntry = nextEntry;
    }
    if (nextEntry && params.key && params.store) {
      const storedEntry = params.store[params.key];
      if (!storedEntry && params.expectedStoreEntry) {
        return;
      }
      if (
        !storedEntry ||
        (matchesGeneration(storedEntry) && nextEntry.updatedAt >= storedEntry.updatedAt)
      ) {
        params.store[params.key] = nextEntry;
      }
    }
  };
  const clear = () => {
    currentEntry = undefined;
    if (params.key && params.store && matchesGeneration(params.store[params.key])) {
      delete params.store[params.key];
    }
  };
  const adopt = (entry: SessionEntry) => {
    const storedEntry = params.key ? params.store?.[params.key] : undefined;
    const storedMatchesOwnedGeneration = Boolean(matchesGeneration(storedEntry));
    const storedMatchesAdoptedGeneration = Boolean(
      storedEntry &&
      storedEntry.sessionId === entry.sessionId &&
      storedEntry.lifecycleRevision === entry.lifecycleRevision,
    );
    const storedEntryWasDeleted = Boolean(
      params.key && params.store && !storedEntry && params.expectedStoreEntry,
    );
    if (
      storedEntryWasDeleted ||
      (storedEntry && !storedMatchesOwnedGeneration && !storedMatchesAdoptedGeneration)
    ) {
      throw new FollowupSessionGenerationInvalidatedError(
        "Follow-up session generation was replaced during admission",
      );
    }
    const adoptedEntry =
      storedMatchesAdoptedGeneration && storedEntry && storedEntry.updatedAt >= entry.updatedAt
        ? storedEntry
        : entry;
    ownedSessionId = adoptedEntry.sessionId;
    ownedLifecycleRevision = adoptedEntry.lifecycleRevision;
    currentEntry = adoptedEntry;
    if (
      params.key &&
      params.store &&
      (!storedEntry || storedMatchesOwnedGeneration || adoptedEntry !== storedEntry)
    ) {
      params.store[params.key] = adoptedEntry;
    }
  };
  if (
    currentEntry &&
    params.key &&
    params.store?.[params.key] &&
    ((params.store[params.key] === params.expectedStoreEntry &&
      !matchesGeneration(params.store[params.key])) ||
      (matchesGeneration(params.store[params.key]) &&
        currentEntry.updatedAt >= params.store[params.key]!.updatedAt))
  ) {
    params.store[params.key] = currentEntry;
  }
  return params.key
    ? {
        kind: "session",
        key: params.key,
        storePath: params.storePath,
        current,
        clear,
        publish,
        adopt,
      }
    : { kind: "detached", current, clear, publish, adopt };
}

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

function createFollowupSessionStoreView(params: {
  key?: string;
  owner: FollowupSessionStoreOwner;
  store?: Record<string, SessionEntry>;
}): Record<string, SessionEntry> | undefined {
  if (!params.key) {
    return params.store;
  }
  const view = { ...params.store };
  Object.defineProperty(view, params.key, {
    configurable: true,
    enumerable: true,
    get: () => params.owner.current(),
    set: (entry: SessionEntry | undefined) => {
      if (!entry) {
        params.owner.clear();
        return;
      }
      const current = params.owner.current();
      if (!isSameSessionGeneration(entry, current)) {
        params.owner.adopt(entry);
        return;
      }
      params.owner.publish(entry);
    },
  });
  return new Proxy(view, {
    deleteProperty: (target, key) => {
      if (key === params.key) {
        // CAS failures invalidate only the owned generation; a concurrent replacement
        // remains in the backing store while this view forgets its stale snapshot.
        params.owner.clear();
        return true;
      }
      return Reflect.deleteProperty(target, key);
    },
  });
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
  const admission = await admitReplyTurn({
    sessionId: params.queued.admissionSessionId ?? run.sessionId,
    sessionKey: replySessionKey ?? "",
    expectedSessionId: initialEntry?.sessionId,
    storePath: params.defaults.storePath,
    kind: "queued_followup",
    resetTriggered: false,
    routeThreadId: params.queued.originatingThreadId,
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
  try {
    await admitFollowupRunLifecycle(params.queued);
    if (isFollowupRunAborted(params.queued)) {
      return { kind: "skipped", reason: "aborted", operation };
    }

    // Queue drains retain the latest live runner closure per key. Keep local dispatcher
    // callbacks in that closure so retried non-routable items use the newest transport owner.
    await params.defaults.opts?.onQueuedFollowupAdmitted?.();
    if (operation.sessionId !== run.sessionId) {
      run = {
        ...run,
        sessionId: operation.sessionId,
        sessionFile:
          resolveAdmittedRunSessionFile({
            agentId: run.agentId,
            sessionId: operation.sessionId,
            storePath: params.defaults.storePath,
          }) ?? resolveSessionTranscriptPath(operation.sessionId, run.agentId),
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
        sessionFile:
          resolveAdmittedRunSessionFile({
            agentId: run.agentId,
            sessionId: operation.sessionId,
            sessionFile: activeEntry.sessionFile,
            storePath: params.defaults.storePath,
          }) ?? run.sessionFile,
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
    const session = createFollowupSessionOwner({
      admittedSessionId: operation.sessionId,
      entry: activeEntry,
      expectedStoreEntry: initialStoredEntry,
      key: replySessionKey,
      store: params.defaults.sessionStore,
      storePath: params.defaults.storePath,
    });
    const sessionStore = createFollowupSessionStoreView({
      key: replySessionKey,
      owner: session,
      store: params.defaults.sessionStore,
    });
    let sendPolicy = resolveSendPolicy({
      cfg: config,
      entry: activeEntry,
      sessionKey: run.runtimePolicySessionKey ?? replySessionKey,
      channel:
        queued.originatingChannel ?? run.messageProvider ?? sessionDeliveryChannel(activeEntry),
      chatType: normalizeChatType(
        queued.originatingChatType ?? run.chatType ?? activeEntry?.chatType,
      ),
    });
    let currentInboundContext =
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
      sendPolicy,
      preflightCompactionApplied: false,
    };
    const refreshTurnSessionState = (entry: SessionEntry | undefined) => {
      sendPolicy = resolveSendPolicy({
        cfg: config,
        entry,
        sessionKey: turn.queued.run.runtimePolicySessionKey ?? replySessionKey,
        channel:
          turn.queued.originatingChannel ??
          turn.queued.run.messageProvider ??
          sessionDeliveryChannel(entry),
        chatType: normalizeChatType(
          turn.queued.originatingChatType ?? turn.queued.run.chatType ?? entry?.chatType,
        ),
      });
      currentInboundContext =
        params.defaults.opts?.isHeartbeat === true
          ? params.queued.currentInboundContext
          : refreshActiveGoalContext(params.queued.currentInboundContext, entry);
      turn.sendPolicy = sendPolicy;
      turn.currentInboundContext = currentInboundContext;
      turn.queued = { ...turn.queued, currentInboundContext };
    };
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
            sessionFile:
              resolveAdmittedRunSessionFile({
                agentId: turn.queued.run.agentId,
                sessionId: entry.sessionId,
                sessionFile: entry.sessionFile,
                storePath: params.defaults.storePath,
              }) ?? resolveSessionTranscriptPath(entry.sessionId, turn.queued.run.agentId),
            cliSessionBindingFacts: undefined,
            autoFallbackPrimaryProbe: undefined,
            modelSelectionLocked: entry.modelSelectionLocked === true,
          },
        };
      }
      return generationRotated;
    };
    const previousCompactionCount = activeEntry?.compactionCount ?? 0;
    let pendingTerminalCompactionNotice: Exclude<CompactionNoticePhase, "start"> | undefined;
    let compactionNoticeGenerationInvalidated = false;
    const notifyPreflightCompaction =
      sendPolicy === "allow" &&
      queued.currentInboundEventKind !== "room_event" &&
      shouldNotifyUserAboutCompaction(config)
        ? async (phase: CompactionNoticePhase) => {
            if (phase !== "start") {
              pendingTerminalCompactionNotice = phase;
              return;
            }
            const noticeEntry =
              replySessionKey && params.defaults.storePath
                ? loadSessionEntry({
                    storePath: params.defaults.storePath,
                    sessionKey: replySessionKey,
                  })
                : replySessionKey && params.defaults.sessionStore
                  ? params.defaults.sessionStore[replySessionKey]
                  : session.current();
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
            const noticeSendPolicy = resolveSendPolicy({
              cfg: config,
              entry: noticeEntry,
              sessionKey: turn.queued.run.runtimePolicySessionKey ?? replySessionKey,
              channel:
                turn.queued.originatingChannel ??
                turn.queued.run.messageProvider ??
                sessionDeliveryChannel(noticeEntry),
              chatType: normalizeChatType(
                turn.queued.originatingChatType ??
                  turn.queued.run.chatType ??
                  noticeEntry?.chatType,
              ),
            });
            if (noticeSendPolicy === "deny") {
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
        agentCfgContextTokens: params.defaults.agentCfgContextTokens,
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
        const persistedEntry = loadSessionEntry({
          storePath: params.defaults.storePath,
          sessionKey: replySessionKey,
        });
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
      const failureEntry =
        replySessionKey && params.defaults.storePath
          ? loadSessionEntry({
              storePath: params.defaults.storePath,
              sessionKey: replySessionKey,
            })
          : replySessionKey && params.defaults.sessionStore
            ? params.defaults.sessionStore[replySessionKey]
            : session.current();
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
          phase: pendingTerminalCompactionNotice,
          currentMessageId: resolveFollowupCurrentMessageId(turn.queued),
        }),
        turn,
      );
    }
    return { kind: "admitted", turn };
  } catch (error) {
    operation.complete();
    throw error instanceof Error ? error : new Error(formatErrorMessage(error));
  }
}
