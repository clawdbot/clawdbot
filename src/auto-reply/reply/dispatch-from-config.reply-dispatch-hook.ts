import { runWithDispatchAbortSignal } from "./dispatch-from-config.abort.js";
import { createReplyDispatchEvent } from "./dispatch-from-config.events.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import { runtimeTakeoverHooksAllowed } from "./dispatch-from-config.restricted-runtime.js";
import type { DispatchFromConfigResult } from "./dispatch-from-config.types.js";

export function runReplyDispatchHook(
  state: PrepareDispatchOperationReadyState,
  options: { shouldSendToolSummaries: () => boolean; isTailDispatch?: true },
) {
  const { hookRunner, params } = state;
  if (
    !runtimeTakeoverHooksAllowed(params.replyOptions?.admittedSessionSettings) ||
    !hookRunner?.hasHooks("reply_dispatch", { dispatchKind: state.dispatchKind })
  ) {
    return undefined;
  }
  const run = () =>
    state.runWithDispatchLifecycleAdmission(
      async () =>
        await runWithDispatchAbortSignal(
          // Reset tails have entered dispatch admission; initial takeover still owns the pre-dispatch lease.
          options.isTailDispatch
            ? state.getDispatchAbortSignal()
            : state.getPreDispatchAbortSignal(),
          () =>
            hookRunner.runReplyDispatch(
              createReplyDispatchEvent({
                ctx: state.ctx,
                runId: params.replyOptions?.runId,
                sessionKey: state.acpDispatchSessionKey,
                toolsAllow: params.replyOptions?.toolsAllow,
                images: params.replyOptions?.images,
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
                shouldSendToolSummaries: options.shouldSendToolSummaries,
                shouldSendFullToolDetails: state.shouldEmitFullVerboseProgress(),
                sendPolicy: state.sendPolicy,
                ...(options.isTailDispatch ? { isTailDispatch: true } : {}),
              }),
              {
                cfg: state.cfg,
                dispatchKind: state.dispatchKind,
                dispatcher: state.dispatchHookDispatcher,
                abortSignal: state.getPreDispatchAbortSignal() ?? params.replyOptions?.abortSignal,
                onReplyStart: params.replyOptions?.onReplyStart,
                onAgentRunStart: params.replyOptions?.onAgentRunStart,
                userTurnTranscriptRecorder: params.replyOptions?.userTurnTranscriptRecorder,
                prepareAssistantTranscriptMessage:
                  params.replyOptions?.prepareAssistantTranscriptMessage,
                recordProcessed: state.recordProcessed,
                markIdle: state.markIdle,
              },
            ),
          state.trackDispatchLifecycleWork,
        ),
    );
  return options.isTailDispatch ? run() : state.traceReplyPhase("reply.reply_dispatch_hooks", run);
}

export async function runReplyDispatchTakeover(
  state: PrepareDispatchOperationReadyState,
  shouldSendToolSummaries: () => boolean,
): Promise<{ status: "complete"; result: DispatchFromConfigResult } | undefined> {
  const result = await runReplyDispatchHook(state, { shouldSendToolSummaries });
  if (!result?.handled) {
    return undefined;
  }
  state.commitInboundDedupeIfClaimed();
  state.completeDispatchReplyOperation();
  return {
    status: "complete",
    result: state.attachSourceReplyDeliveryMode({
      queuedFinal: result.queuedFinal,
      counts: result.counts,
    }),
  };
}
