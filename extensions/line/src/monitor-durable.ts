import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { LineChannelData } from "./types.js";

export type LineDurableReplyOptions = {
  to: string;
};

function hasLineChannelData(payload: ReplyPayload): boolean {
  const lineData = payload.channelData?.line as LineChannelData | undefined;
  return Boolean(lineData && Object.keys(lineData).length > 0);
}

export function resolveLineDurableReplyOptions(params: {
  payload: ReplyPayload;
  infoKind: string;
  to: string;
  replyToken?: string | null;
  replyTokenUsed: boolean;
}): LineDurableReplyOptions | false {
  if (params.infoKind !== "final") {
    return false;
  }
  if (params.replyToken && !params.replyTokenUsed) {
    return false;
  }
  if (hasLineChannelData(params.payload)) {
    return false;
  }
  const reply = resolveSendableOutboundReplyParts(params.payload);
  if (reply.hasMedia || !reply.hasText) {
    return false;
  }
  return {
    to: params.to,
  };
}
