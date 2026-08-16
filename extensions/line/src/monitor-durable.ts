// Line plugin module implements monitor durable behavior.
import { deriveDurableFinalDeliveryRequirements } from "openclaw/plugin-sdk/channel-outbound";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { LineChannelData } from "./types.js";

type LineDurableReplyOptions = {
  to: string;
  requiredCapabilities: ReturnType<typeof deriveDurableFinalDeliveryRequirements>;
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
  const reply = resolveSendableOutboundReplyParts(params.payload);
  if (!reply.hasText && !reply.hasMedia && !hasLineChannelData(params.payload)) {
    return false;
  }
  return {
    to: params.to,
    // Requiring reconciliation is what makes core hand this send a durable intent
    // id, which is the retry key LINE answers with 409 when a replayed part was
    // already accepted. Without it an interrupted send stays unresolved forever.
    requiredCapabilities: deriveDurableFinalDeliveryRequirements({
      payload: params.payload,
      payloadTransport: hasLineChannelData(params.payload),
      reconcileUnknownSend: true,
    }),
  };
}
