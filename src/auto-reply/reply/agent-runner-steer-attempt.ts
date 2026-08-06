import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  queueEmbeddedAgentMessageWithOutcomeAsync,
  type EmbeddedAgentQueueMessageOutcome,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
} from "../../plugins/before-agent-reply.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../plugins/hook-agent-context.js";
import type { TemplateContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  type ReplyOperation,
  type ReplyOperationHandoff,
  reserveReplyOperationAfterClear,
} from "./reply-run-registry.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";

type ActiveSteerAttemptResult =
  | { kind: "handled"; payloads: ReplyPayload[] }
  | {
      kind: "outcome";
      handoff?: ReplyOperationHandoff;
      outcome: EmbeddedAgentQueueMessageOutcome;
      steerSessionId: string;
    };

export async function attemptActiveReplySteer(params: {
  activeReplyOperation?: ReplyOperation;
  followupRun: FollowupRun;
  opts?: InternalGetReplyOptions;
  resetTriggered: boolean;
  resolvedQueue: QueueSettings;
  restartRecoverySourceTurnId?: string;
  sessionCtx: TemplateContext;
  sessionKey?: string;
}): Promise<ActiveSteerAttemptResult> {
  const { activeReplyOperation, followupRun, opts, sessionCtx, sessionKey } = params;
  const turnAdoptionLifecycle = opts?.turnAdoptionLifecycle;
  const handoff = activeReplyOperation
    ? reserveReplyOperationAfterClear({
        operation: activeReplyOperation,
        sessionKey: sessionKey ?? followupRun.run.sessionKey,
        resetTriggered: params.resetTriggered,
        routeThreadId: resolveRoutedDeliveryThreadId({
          ctx: sessionCtx,
          sessionKey: sessionKey ?? followupRun.run.sessionKey,
        }),
        originatingLeafEntryId: turnAdoptionLifecycle?.originatingLeafEntryId,
        upstreamAbortSignal: opts?.abortSignal,
      })
    : undefined;
  try {
    const steerSessionId = activeReplyOperation?.sessionId ?? followupRun.run.sessionId;
    const steerRunId = expectDefined(
      params.restartRecoverySourceTurnId ??
        buildChannelSourceTurnId({
          provider:
            followupRun.originatingChannel ??
            followupRun.run.messageProvider ??
            sessionCtx.Provider,
          accountId:
            followupRun.originatingAccountId ??
            followupRun.run.agentAccountId ??
            sessionCtx.AccountId,
          conversationId:
            followupRun.originatingTo ??
            followupRun.originatingChatId ??
            sessionKey ??
            followupRun.run.sessionKey,
          messageId: followupRun.messageId ?? sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
        }) ??
        normalizeOptionalString(opts?.runId),
      "steered turn id",
    );
    const trigger = "user";
    const hookResult = await runBeforeAgentReplyForTurn({
      runId: steerRunId,
      trigger,
      event: { cleanedBody: followupRun.prompt },
      context: {
        runId: steerRunId,
        agentId: followupRun.run.agentId,
        sessionKey: sessionKey ?? followupRun.run.sessionKey,
        sessionId: steerSessionId,
        workspaceDir: followupRun.run.workspaceDir,
        modelProviderId: followupRun.run.provider,
        modelId: followupRun.run.model,
        trigger,
        ...buildAgentHookContextChannelFields({
          sessionKey: sessionKey ?? followupRun.run.sessionKey,
          messageChannel: followupRun.originatingChannel,
          messageProvider: followupRun.run.messageProvider,
          currentChannelId: followupRun.originatingChatId,
          messageTo: followupRun.originatingTo,
          senderId: followupRun.run.senderId,
        }),
        ...buildAgentHookContextIdentityFields({
          trigger,
          senderId: followupRun.run.senderId,
          chatId: followupRun.originatingChatId,
          channelContext: followupRun.run.channelContext,
        }),
      },
    });
    if (hookResult?.handled) {
      handoff?.release();
      return { kind: "handled", payloads: buildHandledBeforeAgentReplyPayloads(hookResult.reply) };
    }
    const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
      steerSessionId,
      followupRun.prompt,
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        ...(followupRun.images?.length ? { images: followupRun.images } : {}),
        ...(followupRun.imageOrder?.length ? { imageOrder: followupRun.imageOrder } : {}),
        ...(followupRun.media?.length ? { media: followupRun.media } : {}),
        ...(turnAdoptionLifecycle ? { waitForTranscriptCommit: true } : {}),
        ...(params.resolvedQueue.debounceMs !== undefined
          ? { debounceMs: params.resolvedQueue.debounceMs }
          : {}),
        ...(followupRun.run.sourceReplyDeliveryMode
          ? { sourceReplyDeliveryMode: followupRun.run.sourceReplyDeliveryMode }
          : {}),
        taskSuggestionDeliveryMode: followupRun.run.taskSuggestionDeliveryMode,
        ...(followupRun.userTurnTranscriptRecorder
          ? { userTurnTranscriptRecorder: followupRun.userTurnTranscriptRecorder }
          : {}),
      },
    );
    return { kind: "outcome", handoff, outcome, steerSessionId };
  } catch (error) {
    handoff?.release();
    throw error;
  }
}
