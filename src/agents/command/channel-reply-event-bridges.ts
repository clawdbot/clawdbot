import {
  createAgentReplyEventBridges,
  createCliToolSummaryTracker,
} from "../../auto-reply/reply/agent-runner-cli-dispatch.js";
import { createCommandChannelReplyCallbacks } from "./channel-reply-callbacks.js";

/** CLI and ACP publish the same event stream consumed by ordinary channel turns. */
export async function withCommandChannelReplyEvents<T>(
  params: Parameters<typeof createCommandChannelReplyCallbacks>[0],
  run: () => Promise<T>,
): Promise<T> {
  const options = params.opts.channelReply?.options;
  if (!options) {
    return run();
  }
  const callbacks = createCommandChannelReplyCallbacks(params);
  const summary = createCliToolSummaryTracker({
    detailMode: callbacks.toolProgressDetail,
    commandDetailsVisible: params.resolvedVerboseLevel === "full",
    shouldEmitToolResult: callbacks.shouldEmitToolResult ?? (() => false),
    shouldEmitToolOutput: callbacks.shouldEmitToolOutput ?? (() => false),
    deliver: async (payload) => {
      await callbacks.onToolResult?.(payload);
    },
  });
  const bridges = createAgentReplyEventBridges({
    runId: params.runId,
    preserveProgressCallbackStartOrder: options.preserveProgressCallbackStartOrder,
    onAssistantText: async (text) => await callbacks.onPartialReply?.({ text }),
    onReasoningText: async (payload) => {
      await callbacks.onReasoningStream?.({ ...payload, requiresReasoningProgressOptIn: true });
    },
    onReasoningProgress: async (payload) => {
      await options.onReasoningProgress?.(payload);
    },
    onToolEvent: async (payload) => {
      await callbacks.onAgentEvent?.({ stream: "tool", data: payload });
      await summary.noteToolEvent(payload);
    },
    onPlanUpdate: options.onPlanUpdate,
    onCompactionStart: options.onCompactionStart,
    onCompactionEnd: options.onCompactionEnd,
    onCommentaryText:
      options.progressPreambleEnabled || options.commentaryPayloadsEnabled
        ? async (payload) => {
            await options.onItemEvent?.({
              kind: "message",
              phase: "delta",
              summary: payload.text,
              itemId: payload.itemId,
            });
            if (options.commentaryPayloadsEnabled) {
              await options.onBlockReply?.({ text: payload.text, isCommentary: true });
            }
          }
        : undefined,
  });
  try {
    return await run();
  } finally {
    bridges.unsubscribe();
    await bridges.drain();
  }
}
