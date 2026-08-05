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
            await onPartialReply(payload);
            if (hasOutboundReplyContent(payload, { trimText: true })) {
              delivered = true;
            }
          },
        }
      : options,
    didDeliver: () => delivered,
  };
}
