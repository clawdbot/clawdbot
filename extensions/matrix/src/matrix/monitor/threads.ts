import type { MatrixEvent } from "matrix-js-sdk";
import { RelationType } from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events.js";

export function resolveMatrixThreadTarget(params: {
  threadReplies: "off" | "inbound" | "always";
  messageId: string;
  threadRootId?: string;
  isThreadRoot?: boolean;
}): string | undefined {
  const { threadReplies, messageId, threadRootId } = params;
  if (threadReplies === "off") return undefined;
  const isThreadRoot = params.isThreadRoot === true;
  const hasInboundThread = Boolean(threadRootId && threadRootId !== messageId && !isThreadRoot);
  if (threadReplies === "inbound") {
    return hasInboundThread ? threadRootId : undefined;
  }
  if (threadReplies === "always") {
    return threadRootId ?? messageId;
  }
  return undefined;
}

export function resolveMatrixThreadRootId(params: {
  event: MatrixEvent;
  content: RoomMessageEventContent;
}): string | undefined {
  const fromThread = params.event.getThread?.()?.id;
  if (fromThread) return fromThread;
  const direct = params.event.threadRootId ?? undefined;
  if (direct) return direct;
  const relates = params.content["m.relates_to"];
  if (!relates || typeof relates !== "object") return undefined;
  if ("rel_type" in relates && relates.rel_type === RelationType.Thread) {
    if ("event_id" in relates && typeof relates.event_id === "string") {
      return relates.event_id;
    }
    if (
      "m.in_reply_to" in relates &&
      typeof relates["m.in_reply_to"] === "object" &&
      relates["m.in_reply_to"] &&
      "event_id" in relates["m.in_reply_to"] &&
      typeof relates["m.in_reply_to"].event_id === "string"
    ) {
      return relates["m.in_reply_to"].event_id;
    }
  }
  return undefined;
}
