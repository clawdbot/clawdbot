import type { AgentCommandDeliveryStatus } from "../../agents/command/delivery.js";
import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { dispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.js";
import type { ReplyDispatchReceipt } from "../../auto-reply/reply/reply-dispatcher.types.js";
import { getChannelPlugin } from "../../channels/plugins/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";

/** Execution retains its recovery claim until the ordinary channel dispatcher settles delivery. */
export async function runAgentWithRecoveryChannelReply<T>(params: {
  opts: AgentCommandGatewayIngressOpts;
  cfg: OpenClawConfig;
  run: (opts: AgentCommandGatewayIngressOpts) => Promise<T>;
}): Promise<T> {
  const { opts } = params;
  if (
    !opts.mainRestartRecoveryAdmitted ||
    !opts.deliver ||
    opts.sourceReplyDeliveryMode === "message_tool_only" ||
    !opts.channel ||
    !opts.to ||
    !opts.sessionKey ||
    !opts.sessionId ||
    !opts.agentId
  ) {
    return params.run(opts);
  }
  const present = getChannelPlugin(opts.channel)?.streaming?.dispatchRecoveryReply;
  if (!present) {
    return params.run(opts);
  }
  const finalPayloads = createDeferredCore<ReplyPayload[]>();
  const finalDelivery = createDeferredCore<AgentCommandDeliveryStatus>();
  let execution: Promise<T> | undefined;
  let receipt: ReplyDispatchReceipt | undefined;
  let offeredFinal = false;
  try {
    await present({
      cfg: params.cfg,
      agentId: opts.agentId,
      sessionKey: opts.sessionKey,
      sessionId: opts.sessionId,
      accountId: opts.accountId,
      to: opts.to,
      threadId: opts.threadId,
      abortSignal: opts.abortSignal,
      dispatchReplyFromConfig: async (dispatch) => {
        const result = await dispatchReplyFromConfig({
          ...dispatch,
          replyOptions: {
            ...dispatch.replyOptions,
            runId: opts.runId,
            expectedExistingSessionId: opts.sessionId,
            pinExpectedExistingSession: true,
            abortSignal: opts.abortSignal,
            sourceReplyDeliveryMode: opts.sourceReplyDeliveryMode,
          },
          replyResolver: async (_ctx, replyOptions = {}) => {
            if (execution) {
              throw new Error("Restart continuation was already dispatched");
            }
            execution = params.run({
              ...opts,
              abortSignal: replyOptions.abortSignal,
              channelReply: {
                options: replyOptions,
                deliverFinal: async (payloads) => {
                  if (offeredFinal) {
                    throw new Error("Restart final reply was already offered");
                  }
                  offeredFinal = true;
                  finalPayloads.resolve(payloads);
                  return finalDelivery.promise;
                },
              },
            });
            // The command pauses at its existing final-delivery checkpoint; the standard
            // dispatcher now owns TTS, hooks, source policy, previews, and delivery receipts.
            return await Promise.race([finalPayloads.promise, execution.then(() => undefined)]);
          },
        });
        receipt = (await dispatch.dispatcher.waitForIdle()) || undefined;
        return result;
      },
    });
  } finally {
    const final = receipt?.counts.final;
    const failed = (final?.failedBeforeSend ?? 0) + (final?.failedAfterSend ?? 0);
    const sent = final?.delivered ?? 0;
    const suppressed = (final?.cancelled ?? 0) + (final?.deliveredNotVisible ?? 0);
    const settled =
      receipt !== undefined &&
      !receipt.hasPendingDelivery &&
      failed === 0 &&
      (sent > 0 || suppressed > 0);
    finalDelivery.resolve({
      requested: true,
      attempted: sent > 0 || failed > 0,
      status: settled ? (sent ? "sent" : "suppressed") : sent ? "partial_failed" : "failed",
      succeeded: settled ? true : sent ? "partial" : false,
      resultCount: sent,
    });
  }
  if (!execution) {
    throw new Error("Channel did not admit the restart continuation");
  }
  return execution;
}
