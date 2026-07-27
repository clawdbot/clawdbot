import crypto from "node:crypto";
import type { CurrentInboundPromptContext } from "../../agents/embedded-agent-runner/run/params.js";
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
  key?: string;
  store?: Record<string, SessionEntry>;
  storePath?: string;
}): FollowupSessionOwner {
  let ownedSessionId = params.admittedSessionId;
  let ownedLifecycleRevision =
    params.entry?.sessionId === ownedSessionId ? params.entry.lifecycleRevision : undefined;
  const matchesGeneration = (entry: SessionEntry | undefined) =>
    entry?.sessionId === ownedSessionId &&
    entry.lifecycleRevision === ownedLifecycleRevision
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
      if (
        !storedEntry ||
        (matchesGeneration(storedEntry) && nextEntry.updatedAt >= storedEntry.updatedAt)
      ) {
        params.store[params.key] = nextEntry;
      }
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
    if (storedEntry && !storedMatchesOwnedGeneration && !storedMatchesAdoptedGeneration) {
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
    matchesGeneration(params.store[params.key]) &&
    currentEntry.updatedAt >= params.store[params.key]!.updatedAt
  ) {
    params.store[params.key] = currentEntry;
  }
  return params.key
    ? { kind: "session", key: params.key, storePath: params.storePath, current, publish, adopt }
    : { kind: "detached", current, publish, adopt };
}

function resolveFollowupCurrentMessageId(queued: FollowupRun): string | undefined {
  return queued.run.inputProvenance?.kind === "internal_system" &&
    queued.run.inputProvenance.sourceTool === "restart-sentinel"
    ? queued.originatingReplyToId
    : queued.messageId;
}

function createFollowupSessionStoreView(params: {
  key?: string;
  owner: FollowupSessionOwner;
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
    set: (entry: SessionEntry | undefined) => params.owner.publish(entry),
  });
  return view;
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
  const initialEntry =
    (replySessionKey ? params.defaults.sessionStore?.[replySessionKey] : undefined) ??
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
      if (
        params.defaults.storePath &&
        ((entry && entry.sessionId !== operation.sessionId) || (!entry && expectedPersistedEntry))
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
      (admittedEntry === undefined || reloadedEntry ? freshestMatchingEntry : undefined) ??
      (admittedEntry === undefined && freshestMatchingEntry === undefined
        ? initialEntry?.sessionId === operation.sessionId
          ? initialEntry
          : undefined
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
      chatType: queued.originatingChatType ?? run.chatType ?? activeEntry?.chatType,
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
    const previousCompactionCount = activeEntry?.compactionCount ?? 0;
    const notifyPreflightCompaction =
      sendPolicy === "allow" &&
      queued.currentInboundEventKind !== "room_event" &&
      shouldNotifyUserAboutCompaction(config)
        ? async (phase: CompactionNoticePhase) => {
            const noticeEntry =
              replySessionKey && params.defaults.storePath
                ? loadSessionEntry({
                    storePath: params.defaults.storePath,
                    sessionKey: replySessionKey,
                  })
                : session.current();
            assertPersistedGeneration(noticeEntry);
            const noticeSendPolicy = resolveSendPolicy({
              cfg: config,
              entry: noticeEntry,
              sessionKey: turn.queued.run.runtimePolicySessionKey ?? replySessionKey,
              channel:
                turn.queued.originatingChannel ??
                turn.queued.run.messageProvider ??
                sessionDeliveryChannel(noticeEntry),
              chatType:
                turn.queued.originatingChatType ??
                turn.queued.run.chatType ??
                noticeEntry?.chatType,
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
      const previousEntry = session.current();
      const generationRotated = Boolean(
        activeEntry &&
        (activeEntry.sessionId !== previousEntry?.sessionId ||
          activeEntry.lifecycleRevision !== previousEntry?.lifecycleRevision),
      );
      if (activeEntry && generationRotated) {
        session.adopt(activeEntry);
        activeEntry = session.current() ?? activeEntry;
        operation.updateSessionId(activeEntry.sessionId);
        turn.queued = {
          ...turn.queued,
          run: {
            ...turn.queued.run,
            sessionId: activeEntry.sessionId,
            sessionFile:
              resolveAdmittedRunSessionFile({
                agentId: turn.queued.run.agentId,
                sessionId: activeEntry.sessionId,
                sessionFile: activeEntry.sessionFile,
                storePath: params.defaults.storePath,
              }) ?? resolveSessionTranscriptPath(activeEntry.sessionId, turn.queued.run.agentId),
            cliSessionBindingFacts: undefined,
            autoFallbackPrimaryProbe: undefined,
            modelSelectionLocked: activeEntry.modelSelectionLocked === true,
          },
        };
        sendPolicy = resolveSendPolicy({
          cfg: config,
          entry: activeEntry,
          sessionKey: turn.queued.run.runtimePolicySessionKey ?? replySessionKey,
          channel:
            turn.queued.originatingChannel ??
            turn.queued.run.messageProvider ??
            sessionDeliveryChannel(activeEntry),
          chatType:
            turn.queued.originatingChatType ?? turn.queued.run.chatType ?? activeEntry.chatType,
        });
        currentInboundContext =
          params.defaults.opts?.isHeartbeat === true
            ? params.queued.currentInboundContext
            : refreshActiveGoalContext(params.queued.currentInboundContext, activeEntry);
        turn.sendPolicy = sendPolicy;
        turn.currentInboundContext = currentInboundContext;
        turn.queued = { ...turn.queued, currentInboundContext };
      } else {
        session.publish(activeEntry);
      }
      turn.preflightCompactionApplied =
        generationRotated || (activeEntry?.compactionCount ?? 0) > previousCompactionCount;
    } catch (error) {
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
        return { kind: "admitted", turn };
      }
      turn.preflightFailurePayload = markReplyPayloadForSourceSuppressionDelivery({ text });
    }
    return { kind: "admitted", turn };
  } catch (error) {
    operation.complete();
    throw error instanceof Error ? error : new Error(formatErrorMessage(error));
  }
}
