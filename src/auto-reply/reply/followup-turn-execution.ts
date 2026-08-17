import { settleProgressVisibilityCallbackResult } from "../../channels/progress-visibility.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { executeAgentTurn } from "./agent-runner-execution.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import { resetReplyRunSession } from "./agent-runner-session-reset.js";
import { resolveTurnCommentaryProgressOwner } from "./commentary-progress-owner.js";
import { requiresDurableToolResultDelivery } from "./dispatch-from-config.payloads.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./followup-turn-admission.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { createTypingSignaler, type TypingSignaler } from "./typing-mode.js";

export type FollowupExecutionResult = {
  commentaryPayloadsEnabled: boolean;
  execution: AgentTurnExecutionResult;
  runStartedAt: number;
  sessionCtx: TemplateContext;
  pendingToolTasks: Set<Promise<void>>;
  progress: {
    drain(): Promise<void>;
    visibleToolErrorObserved(): boolean;
  };
};

function buildFollowupTemplateContext(turn: AdmittedFollowupTurn): TemplateContext {
  const queued = turn.queued;
  const run = queued.run;
  const surface = queued.originatingChannel ?? run.messageProvider;
  const sessionKey = turn.session.kind === "session" ? turn.session.key : run.sessionKey;
  const currentMessageId =
    run.inputProvenance?.kind === "internal_system" &&
    run.inputProvenance.sourceTool === "restart-sentinel"
      ? queued.originatingReplyToId
      : queued.messageId;
  return {
    Provider: run.messageProvider,
    Surface: surface,
    OriginatingChannel: queued.originatingChannel,
    OriginatingTo: queued.originatingTo,
    To: queued.originatingTo,
    AccountId: queued.originatingAccountId ?? run.agentAccountId,
    ChatType: queued.originatingChatType ?? run.chatType,
    SessionKey: sessionKey,
    RuntimePolicySessionKey: run.runtimePolicySessionKey ?? sessionKey,
    MessageSid: currentMessageId,
    MessageSidFull: currentMessageId,
    MessageThreadId: queued.originatingThreadId,
    ReplyToId: queued.originatingReplyToId,
    SenderId: run.senderId,
    MemberRoleIds: run.memberRoleIds,
    ChannelContext: run.channelContext,
    SenderName: run.senderName,
    SenderUsername: run.senderUsername,
    SenderE164: run.senderE164,
    GroupChannel: run.groupChannel,
    GroupSpace: run.groupSpace,
    InputProvenance: run.inputProvenance,
    InboundEventKind: queued.currentInboundEventKind,
    media: queued.media,
  } as TemplateContext;
}

/** Adapts an admitted queued turn to the canonical agent execution owner. */
export async function executeFollowupTurn(params: {
  turn: AdmittedFollowupTurn;
  defaults: FollowupRunnerParams;
  onExecutionStarted?: () => void;
  onToolResult: (payload: ReplyPayload, execution: { runId: string }) => Promise<void>;
  onCompactionNoticePayload: (payload: ReplyPayload, execution: { runId: string }) => Promise<void>;
}): Promise<FollowupExecutionResult> {
  const { turn, defaults } = params;
  const sourceOpts = defaults.opts;
  const roomEvent = turn.queued.currentInboundEventKind === "room_event";
  const progressAllowed = () => turn.sendPolicy === "allow" && !roomEvent;
  const currentVerboseLevel = (): VerboseLevel => {
    const session = turn.session;
    if (session.kind === "session" && session.storePath) {
      try {
        const loadedEntry = loadSessionEntryReadOnly({
          storePath: session.storePath,
          sessionKey: session.key,
        });
        const ownedEntry = session.current();
        const loadedGenerationMatches =
          loadedEntry !== undefined &&
          ownedEntry !== undefined &&
          loadedEntry.sessionId === ownedEntry.sessionId &&
          loadedEntry.lifecycleRevision === ownedEntry.lifecycleRevision &&
          loadedEntry.updatedAt >= ownedEntry.updatedAt;
        if (loadedGenerationMatches) {
          const level = loadedEntry.verboseLevel;
          if (level === "off" || level === "on" || level === "full") {
            return level;
          }
        }
      } catch {
        // A queued turn keeps its admitted snapshot when a read races store maintenance.
      }
    }
    const level = session.current()?.verboseLevel ?? turn.queued.run.verboseLevel;
    return level === "on" || level === "full" ? level : "off";
  };
  const forceToolResultProgress = sourceOpts?.forceToolResultProgress === true;
  const channelToolResultProgress = forceToolResultProgress ? sourceOpts.onToolResult : undefined;
  const shouldEmitVerboseToolResult = () => {
    const level = currentVerboseLevel();
    return level === "on" || level === "full";
  };
  const shouldEmitToolResult = () =>
    progressAllowed() && (forceToolResultProgress || shouldEmitVerboseToolResult());
  const shouldEmitToolOutput = () => progressAllowed() && currentVerboseLevel() === "full";
  const shouldEmitToolLifecycle = () =>
    progressAllowed() &&
    (shouldEmitToolResult() || defaults.opts?.allowToolLifecycleWhenProgressHidden === true);
  const { commentaryPayloadsEnabled, draftOwnsCommentaryProgress } =
    resolveTurnCommentaryProgressOwner({
      commentaryPayloadsEnabled: sourceOpts?.commentaryPayloadsEnabled === true,
      options: sourceOpts,
      resolveVerboseProgressVisibility: () => progressAllowed() && shouldEmitVerboseToolResult(),
    });
  let visibleToolError = false;
  let progressChain: Promise<void> = Promise.resolve();
  let pendingProgressTaskFailure: unknown;
  const pendingProgressTasks = new Set<Promise<void>>();
  const enqueueProgress = (deliver: () => Promise<void> | void): Promise<void> => {
    const deliveryTask = progressChain.then(deliver);
    progressChain = deliveryTask.catch(() => undefined);
    const observedTask = deliveryTask.catch((error: unknown) => {
      pendingProgressTaskFailure ??= error;
      throw error;
    });
    const trackedTask = observedTask.finally(() => pendingProgressTasks.delete(trackedTask));
    void trackedTask.catch(() => undefined);
    pendingProgressTasks.add(trackedTask);
    return progressChain;
  };
  const enqueueProgressResult = async (
    deliver: () => Promise<boolean | void> | boolean | void,
  ): Promise<boolean | void> => {
    let completed = false;
    let result: boolean | void = false;
    await enqueueProgress(async () => {
      result = await deliver();
      completed = true;
    });
    return completed ? result : false;
  };
  const wrap = <T>(callback: ((value: T) => unknown) | undefined, allowed = progressAllowed) =>
    callback
      ? (value: T) =>
          enqueueProgress(async () => {
            if (allowed()) {
              await callback(value);
            }
          })
      : undefined;
  const wrapVisibility = <T>(
    callback: ((value: T) => Promise<boolean | void> | boolean | void) | undefined,
    allowed = progressAllowed,
  ) =>
    callback
      ? (value: T) =>
          enqueueProgressResult(async () => {
            if (!allowed()) {
              return false;
            }
            return (await settleProgressVisibilityCallbackResult(callback(value))).visible;
          })
      : undefined;
  const baseTypingSignals = createTypingSignaler({
    typing: defaults.typing,
    mode: progressAllowed() ? defaults.typingMode : "never",
    isHeartbeat: defaults.opts?.isHeartbeat === true,
  });
  const typingSignals: TypingSignaler = {
    ...baseTypingSignals,
    signalRunStart: () => enqueueProgress(baseTypingSignals.signalRunStart),
    signalMessageStart: () => enqueueProgress(baseTypingSignals.signalMessageStart),
    signalTextDelta: (text) => enqueueProgress(() => baseTypingSignals.signalTextDelta(text)),
    signalReasoningDelta: () => enqueueProgress(baseTypingSignals.signalReasoningDelta),
    signalToolStart: () => enqueueProgress(baseTypingSignals.signalToolStart),
    signalExecutionActivity: () =>
      enqueueProgress(
        baseTypingSignals.signalExecutionActivity ?? baseTypingSignals.signalRunStart,
      ),
  };
  const progressOpts: InternalGetReplyOptions = {
    ...sourceOpts,
    // Queue callbacks are refreshed per session, but authority belongs to the
    // queued turn. Never let a later callback widen or narrow an older item.
    toolsAllow: turn.queued.toolsAllow,
    disableTools: turn.queued.disableTools,
    commentaryPayloadsEnabled,
    runId: turn.runId,
    onAgentRunStart: (runId, executionIdentityToken) => {
      params.onExecutionStarted?.();
      sourceOpts?.onAgentRunStart?.(runId, executionIdentityToken);
    },
    onBlockReply: undefined,
    onPartialReply: undefined,
    onAssistantMessageStart: undefined,
    onToolStart: wrapVisibility(sourceOpts?.onToolStart, shouldEmitToolLifecycle),
    onCommandOutput: sourceOpts?.onCommandOutput
      ? (output) =>
          enqueueProgressResult(async () => {
            if (!shouldEmitToolResult()) {
              return false;
            }
            const visible = (
              await settleProgressVisibilityCallbackResult(sourceOpts.onCommandOutput!(output))
            ).visible;
            if (
              visible &&
              (output.status === "failed" ||
                output.status === "error" ||
                (typeof output.exitCode === "number" && output.exitCode !== 0))
            ) {
              visibleToolError = true;
            }
            return visible;
          })
      : undefined,
    onItemEvent: sourceOpts?.onItemEvent
      ? (item) =>
          enqueueProgressResult(async () => {
            // Only an explicit draft-vs-durable owner contract may bypass hidden
            // tool-progress filtering for queued preambles.
            const draftOwnsPreamble =
              progressAllowed() && item.kind === "preamble" && draftOwnsCommentaryProgress;
            if (!draftOwnsPreamble && !shouldEmitToolResult()) {
              return false;
            }
            const visible = (
              await settleProgressVisibilityCallbackResult(sourceOpts.onItemEvent!(item))
            ).visible;
            if (
              visible &&
              (item.phase === "error" || item.status === "failed" || item.status === "error")
            ) {
              visibleToolError = true;
            }
            return visible;
          })
      : undefined,
    onNarrationUpdate: wrap(sourceOpts?.onNarrationUpdate),
    onPlanUpdate: wrapVisibility(sourceOpts?.onPlanUpdate),
    onApprovalEvent: wrapVisibility(sourceOpts?.onApprovalEvent, shouldEmitToolResult),
    onPatchSummary: wrapVisibility(sourceOpts?.onPatchSummary, shouldEmitToolResult),
    onCompactionStart: sourceOpts?.onCompactionStart
      ? () =>
          enqueueProgressResult(async () =>
            progressAllowed()
              ? (await settleProgressVisibilityCallbackResult(sourceOpts.onCompactionStart!()))
                  .visible
              : false,
          )
      : undefined,
    onCompactionEnd: sourceOpts?.onCompactionEnd
      ? () =>
          enqueueProgressResult(async () =>
            progressAllowed()
              ? (await settleProgressVisibilityCallbackResult(sourceOpts.onCompactionEnd!()))
                  .visible
              : false,
          )
      : undefined,
    onReasoningStream: wrapVisibility(sourceOpts?.onReasoningStream),
    onReasoningProgress: wrap(sourceOpts?.onReasoningProgress),
    onReasoningEnd: sourceOpts?.onReasoningEnd
      ? () =>
          enqueueProgressResult(async () =>
            progressAllowed()
              ? (await settleProgressVisibilityCallbackResult(sourceOpts.onReasoningEnd!())).visible
              : false,
          )
      : undefined,
    shouldSuppressToolErrorWarnings: () => {
      const explicit = sourceOpts?.suppressToolErrorWarnings;
      if (explicit !== undefined) {
        return explicit;
      }
      if (visibleToolError) {
        return true;
      }
      if (!shouldEmitToolResult()) {
        return false;
      }
      return undefined;
    },
    onToolResult: async (payload) => {
      return await enqueueProgressResult(async () => {
        if (!progressAllowed()) {
          return false;
        }
        const requiresDurableToolResult = requiresDurableToolResultDelivery(payload);
        const verboseToolResult = !requiresDurableToolResult && shouldEmitVerboseToolResult();
        const transientToolResultProgress = requiresDurableToolResult
          ? undefined
          : channelToolResultProgress;
        const toolResultDeliveryAvailable =
          Boolean(transientToolResultProgress) || verboseToolResult || requiresDurableToolResult;
        if (
          turn.queued.run.sourceReplyDeliveryMode === "message_tool_only" &&
          !toolResultDeliveryAvailable
        ) {
          return false;
        }
        const visible =
          transientToolResultProgress && !verboseToolResult
            ? (await settleProgressVisibilityCallbackResult(transientToolResultProgress(payload)))
                .visible
            : await params.onToolResult(payload, { runId: turn.runId }).then(() => true);
        if (visible && payload.isError === true) {
          visibleToolError = true;
        }
        return visible;
      });
    },
  };
  let pendingToolTaskFailure: unknown;
  const pendingToolTaskWatchers = new Set<Promise<void>>();
  const pendingToolTasks = new (class extends Set<Promise<void>> {
    override add(task: Promise<void>): this {
      const observedTask = task.catch((error: unknown) => {
        pendingToolTaskFailure ??= error;
        throw error;
      });
      const watcher = observedTask.finally(() => pendingToolTaskWatchers.delete(watcher));
      void watcher.catch(() => undefined);
      pendingToolTaskWatchers.add(watcher);
      return super.add(task);
    }
  })();
  const sessionCtx = buildFollowupTemplateContext(turn);
  if (turn.preflightError) {
    throw turn.preflightError instanceof Error
      ? turn.preflightError
      : new Error(formatErrorMessage(turn.preflightError));
  }
  let execution: AgentTurnExecutionResult;
  const runStartedAt = Date.now();
  if (turn.preflightFailurePayload) {
    execution = {
      runId: turn.runId,
      outcome: { kind: "rejected", payload: turn.preflightFailurePayload },
    };
  } else {
    try {
      execution = await executeAgentTurn({
        commandBody: turn.queued.prompt,
        transcriptCommandBody: turn.queued.transcriptPrompt,
        followupRun: turn.queued,
        sessionCtx,
        replyOperation: turn.operation,
        opts: progressOpts,
        typingSignals,
        blockReplyPipeline: null,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: turn.queued.run.blockReplyBreak,
        applyReplyToMode: (payload) => payload,
        shouldEmitToolResult,
        shouldEmitToolOutput,
        pendingToolTasks,
        resetSessionAfterRoleOrderingConflict: async (reason) => {
          const session = turn.session;
          if (session.kind !== "session") {
            return false;
          }
          return await resetReplyRunSession({
            options: {
              failureLabel: "role ordering conflict",
              buildLogMessage: (nextSessionId) =>
                `Role ordering conflict (${reason}). Restarting session ${session.key} -> ${nextSessionId}.`,
              cleanupTranscripts: true,
            },
            sessionKey: session.key,
            queueKey: session.key,
            activeSessionEntry: session.current(),
            activeSessionStore: turn.sessionStore,
            storePath: session.storePath,
            messageThreadId:
              sessionCtx.MessageThreadId != null ? String(sessionCtx.MessageThreadId) : undefined,
            followupRun: turn.queued,
            onActiveSessionEntry: (entry) => {
              session.adopt(entry);
              turn.operation.updateSessionId(entry.sessionId);
            },
            onNewSession: () => undefined,
          });
        },
        isHeartbeat: sourceOpts?.isHeartbeat === true,
        sessionKey: turn.session.kind === "session" ? turn.session.key : undefined,
        runtimePolicySessionKey: turn.queued.run.runtimePolicySessionKey,
        getActiveSessionEntry: turn.session.current,
        activeSessionStore: turn.sessionStore,
        storePath: turn.session.kind === "session" ? turn.session.storePath : undefined,
        resolvedVerboseLevel: currentVerboseLevel() ?? "off",
        toolProgressDetail: defaults.toolProgressDetail,
        onCompactionNoticePayload: (payload) =>
          enqueueProgress(() =>
            progressAllowed()
              ? params.onCompactionNoticePayload(payload, { runId: turn.runId })
              : undefined,
          ),
      });
    } catch (error) {
      while (
        pendingProgressTasks.size > 0 ||
        pendingToolTasks.size > 0 ||
        pendingToolTaskWatchers.size > 0
      ) {
        await Promise.allSettled([
          ...pendingProgressTasks,
          ...pendingToolTasks,
          ...pendingToolTaskWatchers,
        ]);
      }
      throw error;
    }
  }
  return {
    commentaryPayloadsEnabled,
    execution,
    runStartedAt,
    sessionCtx,
    pendingToolTasks,
    progress: {
      drain: async () => {
        let firstFailure: unknown = pendingProgressTaskFailure ?? pendingToolTaskFailure;
        while (
          pendingProgressTasks.size > 0 ||
          pendingToolTasks.size > 0 ||
          pendingToolTaskWatchers.size > 0
        ) {
          const results = await Promise.allSettled([
            ...pendingProgressTasks,
            ...pendingToolTasks,
            ...pendingToolTaskWatchers,
          ]);
          firstFailure ??= results.find((result) => result.status === "rejected")?.reason;
        }
        firstFailure ??= pendingProgressTaskFailure ?? pendingToolTaskFailure;
        if (firstFailure !== undefined) {
          throw firstFailure instanceof Error
            ? firstFailure
            : new Error(formatErrorMessage(firstFailure));
        }
      },
      visibleToolErrorObserved: () => visibleToolError,
    },
  };
}
