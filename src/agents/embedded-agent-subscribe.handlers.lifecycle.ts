/**
 * Handles lifecycle and compaction events from subscribed embedded-agent sessions.
 */
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { hasAcceptedSessionSpawn } from "./accepted-session-spawn.js";
import { sanitizeForConsole } from "./console-sanitize.js";
import {
  buildApiErrorObservationFields,
  buildTextObservationFields,
  shouldSuppressRawErrorConsoleSuffix,
} from "./embedded-agent-error-observation.js";
import {
  classifyFailoverReason,
  formatUserFacingAssistantErrorText,
  GENERIC_ASSISTANT_ERROR_TEXT,
} from "./embedded-agent-helpers.js";
import { hasCommittedMessagingToolDeliveryEvidence } from "./embedded-agent-runner/delivery-evidence.js";
import { hasAttemptTerminalState } from "./embedded-agent-runner/run/attempt-terminal-evidence.js";
import { resolveFinalAssistantVisibleText } from "./embedded-agent-runner/run/helpers.js";
import { isIncompleteTerminalAssistantTurn } from "./embedded-agent-runner/run/incomplete-turn-classification.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import {
  hasAssistantVisibleReply,
  readPendingToolMediaReply,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { isAssistantMessage } from "./embedded-agent-utils.js";
import type { AgentSessionEvent } from "./sessions/index.js";
import { summarizeToolValidationError } from "./tool-error-summary.js";

export {
  handleCompactionEnd,
  handleCompactionStart,
} from "./embedded-agent-subscribe.handlers.compaction.js";

export function handleAgentStart(ctx: EmbeddedAgentSubscribeContext) {
  ctx.log.debug(`embedded run agent start: runId=${ctx.params.runId}`);
  const data = { phase: "start", startedAt: Date.now() };
  emitAgentEvent({
    runId: ctx.params.runId,
    ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
    ...(ctx.params.sessionId ? { sessionId: ctx.params.sessionId } : {}),
    ...(ctx.params.agentId ? { agentId: ctx.params.agentId } : {}),
    ...(ctx.params.lifecycleGeneration
      ? { lifecycleGeneration: ctx.params.lifecycleGeneration }
      : {}),
    stream: "lifecycle",
    data,
  });
  runBestEffortCallback({
    label: "lifecycle agent event",
    log: ctx.log,
    callback: () =>
      ctx.params.onAgentEvent?.({
        stream: "lifecycle",
        data,
      }),
  });
}

export function handleAgentEnd(
  ctx: EmbeddedAgentSubscribeContext,
  evt?: Extract<AgentSessionEvent, { type: "agent_end" }>,
  options?: { deliveryGeneration?: number },
): void | Promise<void> {
  ctx.state.liveEditDiffStateById.clear();
  type BeforeTerminalDeliveryDecision = void | { suppressTerminalDelivery?: boolean };
  const isCurrentDeliveryGeneration = () =>
    options?.deliveryGeneration === undefined ||
    options.deliveryGeneration === ctx.getBlockReplyDeliveryGeneration();
  if (!isCurrentDeliveryGeneration()) {
    return;
  }
  const lastAssistant = ctx.state.lastAssistant;
  const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error";
  let lifecycleErrorText: string | undefined;
  // Terminal delivery does not depend on streamed text alone: when the streamed
  // assistant texts are empty, payload building falls back to the completed
  // assistant message's visible text, so such a turn still reaches the user.
  // Classification must key on the same fact, otherwise a delivered reply is
  // recorded here as an abandoned, replay-invalid turn. Error and abort stop
  // reasons keep the streamed-only view because their raw text can describe an
  // interrupted generation rather than a reply (mirrors
  // resolveTerminalAssistantTexts).
  const hasStreamedAssistantVisibleText =
    Array.isArray(ctx.state.assistantTexts) &&
    ctx.state.assistantTexts.some((text) => hasAssistantVisibleReply({ text }));
  const completedAssistantFallbackText =
    isAssistantMessage(lastAssistant) &&
    lastAssistant.stopReason !== "error" &&
    lastAssistant.stopReason !== "aborted"
      ? resolveFinalAssistantVisibleText(lastAssistant)
      : undefined;
  const hasAssistantVisibleText =
    hasStreamedAssistantVisibleText ||
    hasAssistantVisibleReply({ text: completedAssistantFallbackText ?? "" });
  const hadLivenessPreservingSideEffect =
    ctx.state.hadDeterministicSideEffect === true ||
    hasCommittedMessagingToolDeliveryEvidence(ctx.state) ||
    hasAcceptedSessionSpawn(ctx.state.acceptedSessionSpawns) ||
    (ctx.state.successfulCronAdds ?? 0) > 0;
  const deferredMediaUrls = ctx.state.deferredBlockReplies.flatMap(
    (payload) => payload.mediaUrls ?? [],
  );
  const hasTerminalOutput = hasAttemptTerminalState({
    yieldDetected: ctx.state.yielded,
    didSendDeterministicApprovalPrompt: ctx.state.deterministicApprovalPromptSent,
    heartbeatToolResponse: ctx.state.heartbeatToolResponse,
    lastToolError: ctx.state.lastToolError,
    toolMediaUrls: [...ctx.state.pendingToolMediaUrls, ...deferredMediaUrls],
    toolAudioAsVoice:
      ctx.state.pendingToolAudioAsVoice ||
      ctx.state.deferredBlockReplies.some((payload) => payload.audioAsVoice),
    toolTrustedLocalMedia: resolveTerminalToolMediaTrust({
      pendingMediaUrls: ctx.state.pendingToolMediaUrls,
      pendingTrustByUrl: ctx.state.pendingToolMediaTrustByUrl,
      deferredReplies: ctx.state.deferredBlockReplies,
    }),
    hasToolMediaBlockReply: ctx.state.hasToolMediaBlockReply,
    didDeliverSourceReplyViaMessageTool:
      ctx.state.messageToolOnlySourceReplyDelivered ||
      ctx.params.hasDeliveredMessageToolOnlySourceReply?.() === true,
    messagingToolSourceReplyPayloads: ctx.state.messagingToolSourceReplyPayloads,
    messagingToolSentTexts: ctx.state.messagingToolSentTexts,
    messagingToolSentMediaUrls: ctx.state.messagingToolSentMediaUrls,
    messagingToolSentTargets: ctx.state.messagingToolSentTargets,
    successfulCronAdds: ctx.state.successfulCronAdds,
    acceptedSessionSpawns: ctx.state.acceptedSessionSpawns,
    toolMetas: ctx.state.toolMetas,
  });
  const hadBeforeFinalizeSideEffect =
    hadLivenessPreservingSideEffect || ctx.state.replayState.hadPotentialSideEffects;
  const incompleteTerminalAssistant = isIncompleteTerminalAssistantTurn({
    hasAssistantVisibleText,
    hasTerminalOutput,
    lastAssistant: isAssistantMessage(lastAssistant) ? lastAssistant : null,
  });
  const replayInvalid =
    ctx.state.replayState.replayInvalid || incompleteTerminalAssistant ? true : undefined;
  // Tool-use terminal guard: when the last assistant message ended with a
  // tool-call stop reason, the turn is incomplete even when pre-tool text
  // exists — mark as abandoned so lifecycle consumers do not see a working
  // end state for an interrupted tool chain. (#76477)
  const derivedWorkingTerminalState = isError
    ? "blocked"
    : replayInvalid &&
        !hadLivenessPreservingSideEffect &&
        (!hasAssistantVisibleText || incompleteTerminalAssistant)
      ? "abandoned"
      : ctx.state.livenessState;
  const livenessState =
    ctx.state.livenessState === "working" ? derivedWorkingTerminalState : ctx.state.livenessState;

  if (isError && lastAssistant) {
    const rawError = lastAssistant.errorMessage?.trim();
    const failoverReason = classifyFailoverReason(rawError ?? "", {
      provider: lastAssistant.provider,
    });
    const errorText = formatUserFacingAssistantErrorText(lastAssistant, {
      cfg: ctx.params.config,
      sessionKey: ctx.params.sessionKey,
      provider: lastAssistant.provider,
      model: lastAssistant.model,
    });
    const observedError = buildApiErrorObservationFields(rawError, {
      provider: lastAssistant.provider,
    });
    const safeErrorText =
      buildTextObservationFields(errorText, {
        provider: lastAssistant.provider,
      }).textPreview ?? GENERIC_ASSISTANT_ERROR_TEXT;
    lifecycleErrorText = safeErrorText;
    const safeRunId = sanitizeForConsole(ctx.params.runId) ?? "-";
    const safeModel = sanitizeForConsole(lastAssistant.model) ?? "unknown";
    const safeProvider = sanitizeForConsole(lastAssistant.provider) ?? "unknown";
    const safeRawErrorPreview = sanitizeForConsole(observedError.rawErrorPreview);
    const rawErrorConsoleSuffix =
      safeRawErrorPreview &&
      !shouldSuppressRawErrorConsoleSuffix(observedError.providerRuntimeFailureKind)
        ? ` rawError=${safeRawErrorPreview}`
        : "";
    ctx.log.warn("embedded run agent end", {
      event: "embedded_run_agent_end",
      tags: ["error_handling", "lifecycle", "agent_end", "assistant_error"],
      runId: ctx.params.runId,
      isError: true,
      error: safeErrorText,
      failoverReason,
      model: lastAssistant.model,
      provider: lastAssistant.provider,
      ...observedError,
      consoleMessage: `embedded run agent end: runId=${safeRunId} isError=true model=${safeModel} provider=${safeProvider} error=${safeErrorText}${rawErrorConsoleSuffix}`,
    });
  } else {
    ctx.log.debug(`embedded run agent end: runId=${ctx.params.runId} isError=${isError}`);
  }

  const emitLifecycleTerminal = () => {
    const terminalStopReason =
      ctx.params.resolveTerminalStopReason?.() ??
      ctx.state.terminalStopReason ??
      (!isError && isAssistantMessage(lastAssistant) ? lastAssistant.stopReason : undefined);
    const terminalAborted =
      typeof ctx.state.terminalAborted === "boolean"
        ? ctx.state.terminalAborted
        : ctx.params.isTerminalAborted?.();
    // Validation loops lose their final safe tool result on abort/error
    // terminal paths. Preserve only the argument-free validator summary;
    // arbitrary tool errors can contain secrets.
    const toolErrorSummary =
      (terminalAborted === true || isError) && ctx.state.lastToolError
        ? summarizeToolValidationError(ctx.state.lastToolError)
        : undefined;
    const terminalMeta = {
      ...(terminalStopReason ? { stopReason: terminalStopReason } : {}),
      ...(ctx.state.yielded === true ? { yielded: true } : {}),
      ...(ctx.state.timeoutPhase ? { timeoutPhase: ctx.state.timeoutPhase } : {}),
      ...(typeof ctx.state.providerStarted === "boolean"
        ? { providerStarted: ctx.state.providerStarted }
        : {}),
      ...(typeof terminalAborted === "boolean" ? { aborted: terminalAborted } : {}),
      ...(toolErrorSummary ? { toolErrorSummary } : {}),
    };
    const phase =
      ctx.params.terminalLifecyclePhase === "finishing" ? "finishing" : isError ? "error" : "end";
    const errorData = isError ? { error: lifecycleErrorText ?? GENERIC_ASSISTANT_ERROR_TEXT } : {};
    emitAgentEvent({
      runId: ctx.params.runId,
      ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
      ...(ctx.params.sessionId ? { sessionId: ctx.params.sessionId } : {}),
      ...(ctx.params.agentId ? { agentId: ctx.params.agentId } : {}),
      ...(ctx.params.lifecycleGeneration
        ? { lifecycleGeneration: ctx.params.lifecycleGeneration }
        : {}),
      stream: "lifecycle",
      data: {
        phase,
        ...errorData,
        ...terminalMeta,
        ...(livenessState ? { livenessState } : {}),
        ...(replayInvalid ? { replayInvalid } : {}),
        endedAt: Date.now(),
      },
    });
    runBestEffortCallback({
      label: "lifecycle agent event",
      log: ctx.log,
      callback: () =>
        ctx.params.onAgentEvent?.({
          stream: "lifecycle",
          data: {
            phase,
            ...errorData,
            ...terminalMeta,
            ...(livenessState ? { livenessState } : {}),
            ...(replayInvalid ? { replayInvalid } : {}),
          },
        }),
    });
  };

  const finalizeAgentEnd = () => {
    if (!isCurrentDeliveryGeneration()) {
      return;
    }
    ctx.state.blockState.thinking = false;
    ctx.state.blockState.final = false;
    ctx.state.blockState.inlineCode = createInlineCodeState();
    ctx.state.blockState.fence = undefined;
    ctx.state.blockState.reasoningPendingFenceFragment = undefined;
    ctx.state.blockState.pendingFenceFragment = undefined;

    if (ctx.state.pendingCompactionRetry > 0) {
      ctx.resolveCompactionRetry(options?.deliveryGeneration);
    } else {
      ctx.maybeResolveCompactionWait();
    }
  };

  const flushPendingMediaAndChannel = () => {
    if (!isCurrentDeliveryGeneration()) {
      return undefined;
    }
    if (ctx.params.onBlockReply && !ctx.state.pendingToolMediaDeliveryFailed) {
      const pendingToolMediaReply = readPendingToolMediaReply(ctx.state);
      if (pendingToolMediaReply && hasAssistantVisibleReply(pendingToolMediaReply)) {
        ctx.emitBlockReply(pendingToolMediaReply, {
          onDelivered: () => {
            ctx.state.hasToolMediaBlockReply = true;
          },
        });
      }
    }

    const postMediaFlushResult = ctx.flushBlockReplyBuffer({ retryFailures: true });
    if (isPromiseLike<void>(postMediaFlushResult)) {
      return postMediaFlushResult.then(() => {
        if (!isCurrentDeliveryGeneration()) {
          return undefined;
        }
        const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.({ reason: "terminal" });
        if (isPromiseLike<void>(onBlockReplyFlushResult)) {
          return onBlockReplyFlushResult;
        }
        return undefined;
      });
    }

    const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.({ reason: "terminal" });
    if (isPromiseLike<void>(onBlockReplyFlushResult)) {
      return onBlockReplyFlushResult;
    }
    return undefined;
  };

  const runBeforeTerminalDelivery = ():
    | BeforeTerminalDeliveryDecision
    | Promise<BeforeTerminalDeliveryDecision> => {
    const result = ctx.params.onBeforeTerminalDelivery?.({
      messages: evt?.messages ?? [],
      willRetry: evt?.willRetry === true,
      ...(evt?.assistantEntryId ? { assistantEntryId: evt.assistantEntryId } : {}),
      ...(lastAssistant ? { lastAssistant } : {}),
      assistantTexts: ctx.state.assistantTexts,
      hasAssistantVisibleText,
      isError,
      incompleteTerminalAssistant,
      hadDeterministicSideEffect: hadBeforeFinalizeSideEffect,
    });
    if (isPromiseLike<void | { suppressTerminalDelivery?: boolean }>(result)) {
      return result;
    }
    return result;
  };

  const deliverTerminal = () => {
    if (!isCurrentDeliveryGeneration()) {
      return;
    }
    ctx.state.deferBlockReplyDelivery = false;
    ctx.flushDeferredAssistantEvents();
    ctx.flushDeferredBlockReplies();
    const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer({
      final: true,
      retryFailures: true,
    });
    finalizeAgentEnd();
    const flushPendingMediaAndChannelResult = isPromiseLike<void>(flushBlockReplyBufferResult)
      ? Promise.resolve(flushBlockReplyBufferResult).then(() =>
          isCurrentDeliveryGeneration() ? flushPendingMediaAndChannel() : undefined,
        )
      : flushPendingMediaAndChannel();

    if (isPromiseLike<void>(flushPendingMediaAndChannelResult)) {
      return Promise.resolve(flushPendingMediaAndChannelResult).then(
        () => (isCurrentDeliveryGeneration() ? emitLifecycleTerminalOnce() : undefined),
        (error: unknown) => {
          if (!isCurrentDeliveryGeneration()) {
            return undefined;
          }
          const emitted = emitLifecycleTerminalOnce();
          if (isPromiseLike<void>(emitted)) {
            return Promise.resolve(emitted).then(() => {
              throw error;
            });
          }
          throw error;
        },
      );
    }
    return emitLifecycleTerminalOnce();
  };

  const deliverTerminalWithLifecycleErrorFallback = () => {
    try {
      return deliverTerminal();
    } catch (error) {
      const emitted = emitLifecycleTerminalOnce();
      if (isPromiseLike<void>(emitted)) {
        return Promise.resolve(emitted).then(() => {
          throw error;
        });
      }
      throw error;
    }
  };

  const suppressTerminalDelivery = () => {
    if (!isCurrentDeliveryGeneration()) {
      return;
    }
    ctx.clearDeferredAssistantEvents();
    ctx.clearDeferredBlockReplies();
    finalizeAgentEnd();
  };

  let lifecycleTerminalEmitted = false;
  const emitLifecycleTerminalOnce = (): void | Promise<void> => {
    if (lifecycleTerminalEmitted || !isCurrentDeliveryGeneration()) {
      return;
    }
    lifecycleTerminalEmitted = true;
    let beforeLifecycleTerminal: void | Promise<void> = undefined;
    try {
      beforeLifecycleTerminal = ctx.params.onBeforeLifecycleTerminal?.();
    } catch (err) {
      ctx.log.debug(`before lifecycle terminal failed: ${String(err)}`);
    }
    if (isPromiseLike<void>(beforeLifecycleTerminal)) {
      return Promise.resolve(beforeLifecycleTerminal)
        .catch((err: unknown) => {
          ctx.log.debug(`before lifecycle terminal failed: ${String(err)}`);
        })
        .then(() => {
          emitLifecycleTerminal();
        });
    }
    emitLifecycleTerminal();
  };

  let beforeTerminalDelivery:
    | BeforeTerminalDeliveryDecision
    | Promise<BeforeTerminalDeliveryDecision>;
  try {
    beforeTerminalDelivery = runBeforeTerminalDelivery();
  } catch (error) {
    ctx.log.warn(`before terminal delivery failed: ${String(error)}`);
    return deliverTerminalWithLifecycleErrorFallback();
  }

  if (isPromiseLike<void | { suppressTerminalDelivery?: boolean }>(beforeTerminalDelivery)) {
    return Promise.resolve(beforeTerminalDelivery)
      .catch((error: unknown) => {
        ctx.log.warn(`before terminal delivery failed: ${String(error)}`);
        return undefined;
      })
      .then((decision) => {
        if (!isCurrentDeliveryGeneration()) {
          return undefined;
        }
        if (decision?.suppressTerminalDelivery === true) {
          suppressTerminalDelivery();
          return undefined;
        }
        return deliverTerminalWithLifecycleErrorFallback();
      });
  }
  if (beforeTerminalDelivery?.suppressTerminalDelivery === true) {
    suppressTerminalDelivery();
    return undefined;
  }
  return deliverTerminalWithLifecycleErrorFallback();
}
function resolveTerminalToolMediaTrust(params: {
  pendingMediaUrls: readonly string[];
  pendingTrustByUrl: ReadonlyMap<string, boolean>;
  deferredReplies: readonly { mediaUrls?: string[]; trustedLocalMedia?: boolean }[];
}): boolean {
  const trust = [
    ...params.pendingMediaUrls.map((url) => params.pendingTrustByUrl.get(url.trim()) === true),
    ...params.deferredReplies.flatMap((payload) =>
      (payload.mediaUrls ?? []).map(() => payload.trustedLocalMedia === true),
    ),
  ];
  return trust.length > 0 && trust.every(Boolean);
}

const testing = { resolveTerminalToolMediaTrust };
export { testing as __testing };
