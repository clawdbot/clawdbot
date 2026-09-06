import {
  QuestionAnswerUnconfirmedError,
  QuestionDispatchRefusedError,
} from "../../agents/harness/gateway-question-dispatch.js";
import { claimPendingAgentQuestionAnswerFromCaller } from "../../agents/harness/gateway-question.js";
import { logVerbose } from "../../globals.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { RunReplyAgentParams } from "./agent-runner-core.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  resolveFollowupAbortSignal,
} from "./queue/types.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { resolveInboundReplyToolAuthorityOverlay } from "./reply-tool-authority.js";

type ReplyQuestionInputParams = Pick<
  RunReplyAgentParams,
  | "commandBody"
  | "transcriptCommandBody"
  | "followupRun"
  | "opts"
  | "resetTriggered"
  | "sessionCtx"
  | "sessionEntry"
  | "sessionKey"
>;

type ReplyQuestionInputResult =
  | { handled: false }
  | { handled: true; payload: ReplyPayload | undefined };

/** Question-only runtimes accept answers without exposing ordinary steering. */
export async function runReplyQuestionInput(
  params: ReplyQuestionInputParams,
): Promise<ReplyQuestionInputResult> {
  const { followupRun, opts, sessionKey } = params;
  const external =
    followupRun.run.inputProvenance === undefined ||
    followupRun.run.inputProvenance.kind === "external_user";
  const text = (
    params.transcriptCommandBody ??
    followupRun.transcriptPrompt ??
    params.commandBody
  ).trim();
  if (
    !sessionKey ||
    opts?.isHeartbeat ||
    params.resetTriggered ||
    opts?.messageInjectionDisposition === "accepted" ||
    !external ||
    !text ||
    followupRun.images?.length ||
    followupRun.media?.length
  ) {
    return { handled: false };
  }

  const caller = resolveInboundReplyToolAuthorityOverlay({
    ctx: params.sessionCtx,
    sessionEntry: params.sessionEntry,
    senderIsOwner: followupRun.run.senderIsOwner === true,
    toolsAllow: followupRun.toolsAllow,
    disableTools: followupRun.disableTools === true,
  });
  const sourceAbort = opts?.abortSignal;
  const queuedAbort = resolveFollowupAbortSignal(followupRun);
  const assertSourceCurrent = () => {
    sourceAbort?.throwIfAborted();
    queuedAbort?.throwIfAborted();
  };
  const state = resolveReplyOperationRunState(opts);
  let outcome: { status: "answered" } | { status: "indeterminate"; errorMessage: string };
  try {
    const claimed = await claimPendingAgentQuestionAnswerFromCaller({
      sessionKey,
      text,
      caller,
      assertSourceCurrent,
      persist: followupRun.userTurnTranscriptRecorder
        ? async () => {
            await followupRun.userTurnTranscriptRecorder?.persistApproved();
          }
        : undefined,
    });
    if (!claimed) {
      return { handled: false };
    }
    outcome = { status: "answered" };
  } catch (error) {
    if (error instanceof QuestionDispatchRefusedError) {
      if (state) {
        state.admission = { status: "skipped", reason: "question-response-refused" };
      }
      return {
        handled: true,
        payload: markReplyPayloadForSourceSuppressionDelivery({
          text: `The answer was not sent: ${error.message}. Use the question controls in the Control UI, or check the active run and your permissions before retrying.`,
          isError: true,
        }),
      };
    }
    if (!(error instanceof QuestionAnswerUnconfirmedError)) {
      throw error;
    }
    outcome = { status: "indeterminate", errorMessage: error.message };
  }

  // Publish custody before adoption can fail or cancel this incoming dispatch.
  // Neither outcome permits replay or aborting the independent question creator.
  if (state) {
    state.admission =
      outcome.status === "indeterminate"
        ? { status: "skipped", reason: "question-response-indeterminate" }
        : { status: "accepted", mode: "steer" };
  }
  try {
    await admitFollowupRunLifecycle(followupRun);
  } catch (error) {
    logVerbose(`question input adoption failed after custody transferred: ${String(error)}`);
  } finally {
    completeFollowupRunLifecycle(followupRun, "consumed");
  }
  return {
    handled: true,
    payload:
      outcome.status === "indeterminate"
        ? markReplyPayloadForSourceSuppressionDelivery({
            text: outcome.errorMessage,
            isError: true,
          })
        : undefined,
  };
}
