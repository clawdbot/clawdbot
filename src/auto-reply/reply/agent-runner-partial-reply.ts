import { settleProgressVisibilityCallbackResult } from "../../channels/progress-visibility.js";
import { hasOutboundReplyContent } from "../../plugin-sdk/reply-payload.js";
import type { GetReplyOptions } from "../types.js";

export function createPartialReplyTracker(options: GetReplyOptions | undefined) {
  let delivered = false;
  const onPartialReply = options?.onPartialReply;
  return {
    options: onPartialReply
      ? {
          ...options,
          onPartialReply: async (payload: Parameters<typeof onPartialReply>[0]) => {
            const observed = await settleProgressVisibilityCallbackResult(onPartialReply(payload));
            if (observed.visible && hasOutboundReplyContent(payload, { trimText: true })) {
              delivered = true;
            }
            return observed.result;
          },
        }
      : options,
    didDeliver: () => delivered,
  };
}
