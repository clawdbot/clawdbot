import { runWithDispatchAbortSignal } from "./dispatch-from-config.abort.js";
import {
  admittedSessionSettingsRestrictRuntime,
  createReplyDispatchEvent,
} from "./dispatch-from-config.events.js";
import type { PrepareDispatchExecutionReadyState } from "./dispatch-from-config.prepare-execution.js";
import type { DispatchFromConfigResult } from "./dispatch-from-config.types.js";

export async function handleAcpDispatchTailAfterReset(
  state: PrepareDispatchExecutionReadyState,
): Promise<{ status: "complete"; result: DispatchFromConfigResult } | undefined> {
  if (state.ctx.AcpDispatchTailAfterReset !== true) {
    return undefined;
  }
  // Command handling prepared a trailing prompt after ACP in-place reset.
  // Route that tail through ACP now (same turn) instead of embedded dispatch.
  state.ctx.AcpDispatchTailAfterReset = false;
  const hookRunner = state.hookRunner;
  if (admittedSessionSettingsRestrictRuntime(state.params.replyOptions?.admittedSessionSettings)) {
    return undefined;
  }
  if (!hookRunner?.hasHooks("reply_dispatch", { dispatchKind: state.dispatchKind })) {
    return undefined;
  }
  const tailDispatchResult = await state.runWithDispatchLifecycleAdmission(
    async () =>
      await runWithDispatchAbortSignal(
        state.getDispatchAbortSignal(),
        () =>
          hookRunner.runReplyDispatch(
            createReplyDispatchEvent({
              ctx: state.ctx,
              runId: state.params.replyOptions?.runId,
              sessionKey: state.acpDispatchSessionKey,
              toolsAllow: state.params.replyOptions?.toolsAllow,
              images: state.params.replyOptions?.images,
              inboundAudio: state.inboundAudio,
              sessionTtsAuto: state.sessionTtsAuto,
              ttsChannel: state.deliveryChannel,
              suppressUserDelivery: state.suppressHookUserDelivery,
              suppressReplyLifecycle: state.suppressHookReplyLifecycle,
              sourceReplyDeliveryMode: state.sourceReplyDeliveryMode,
              shouldRouteToOriginating: state.shouldRouteToOriginating,
              originatingChannel: state.routeReplyChannel,
              originatingTo: state.routeReplyTo,
              originatingAccountId: state.replyContextAccountId,
              originatingThreadId: state.routeReplyThreadId,
              originatingChatType: state.replyRoute.chatType,
              shouldSendToolSummaries: state.shouldSendToolSummaries,
              shouldSendFullToolDetails: state.shouldEmitFullVerboseProgress(),
              sendPolicy: state.sendPolicy,
              isTailDispatch: true,
            }),
            {
              cfg: state.cfg,
              dispatchKind: state.dispatchKind,
              dispatcher: state.dispatchHookDispatcher,
              abortSignal:
                state.getPreDispatchAbortSignal() ?? state.params.replyOptions?.abortSignal,
              onReplyStart: state.params.replyOptions?.onReplyStart,
              onAgentRunStart: state.params.replyOptions?.onAgentRunStart,
              userTurnTranscriptRecorder: state.params.replyOptions?.userTurnTranscriptRecorder,
              prepareAssistantTranscriptMessage:
                state.params.replyOptions?.prepareAssistantTranscriptMessage,
              recordProcessed: state.recordProcessed,
              markIdle: state.markIdle,
            },
          ),
        state.trackDispatchLifecycleWork,
      ),
  );
  if (!tailDispatchResult?.handled) {
    return undefined;
  }
  state.recordAgentDispatchCompleted("completed");
  state.completeDispatchReplyOperation();
  return {
    status: "complete",
    result: state.attachSourceReplyDeliveryMode({
      queuedFinal: tailDispatchResult.queuedFinal,
      counts: tailDispatchResult.counts,
      ...(state.routeState.sessionMetadataChangesForResult
        ? { sessionMetadataChanges: state.routeState.sessionMetadataChangesForResult }
        : {}),
    }),
  };
}
