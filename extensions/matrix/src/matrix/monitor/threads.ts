import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";
import { RelationType } from "./types.js";

export type MatrixThreadReplies = "off" | "inbound" | "always";

export type MatrixThreadRouting = {
  threadId?: string;
};

export function resolveMatrixThreadSessionKeys(params: {
  baseSessionKey: string;
  threadId?: string | null;
  parentSessionKey?: string;
  useSuffix?: boolean;
}): { sessionKey: string; parentSessionKey?: string } {
  return resolveThreadSessionKeys({
    ...params,
    // Matrix event IDs are opaque and case-sensitive; keep the exact thread root.
    normalizeThreadId: (threadId) => threadId,
  });
}

function resolveMatrixRelatedReplyToEventId(relates: unknown): string | undefined {
  if (!relates || typeof relates !== "object") {
    return undefined;
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
  return undefined;
}

export function resolveMatrixThreadRouting(params: {
  isDirectMessage: boolean;
  threadReplies: MatrixThreadReplies;
  dmThreadReplies?: MatrixThreadReplies;
  messageId: string;
  threadRootId?: string;
}): MatrixThreadRouting {
  const effectiveThreadReplies =
    params.isDirectMessage && params.dmThreadReplies !== undefined
      ? params.dmThreadReplies
      : params.threadReplies;
  const messageId = params.messageId.trim();
  const threadRootId = params.threadRootId?.trim();
  const inboundThreadId = threadRootId && threadRootId !== messageId ? threadRootId : undefined;
  const threadId =
    effectiveThreadReplies === "off"
      ? undefined
      : effectiveThreadReplies === "inbound"
        ? inboundThreadId
        : (inboundThreadId ?? (messageId || undefined));

  return {
    threadId,
  };
}

export function resolveMatrixThreadRootId(params: {
  event: MatrixRawEvent;
  content: RoomMessageEventContent;
}): string | undefined {
  const relates = params.content["m.relates_to"];
  if (!relates || typeof relates !== "object") {
    return undefined;
  }
  if ("rel_type" in relates && relates.rel_type === RelationType.Thread) {
    if ("event_id" in relates && typeof relates.event_id === "string") {
      return relates.event_id;
    }
    return resolveMatrixRelatedReplyToEventId(relates);
  }
  return undefined;
}

export function resolveMatrixReplyToEventId(content: RoomMessageEventContent): string | undefined {
  return resolveMatrixRelatedReplyToEventId(content["m.relates_to"]);
}
