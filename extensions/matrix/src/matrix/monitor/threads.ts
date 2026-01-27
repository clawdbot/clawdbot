// Type for raw Matrix event from @vector-im/matrix-bot-sdk
type MatrixRawEvent = {
  event_id: string;
  sender: string;
  type: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
};

type RoomMessageEventContent = {
  msgtype: string;
  body: string;
  "m.relates_to"?: {
    rel_type?: string;
    event_id?: string;
    "m.in_reply_to"?: { event_id?: string };
  };
};

const RelationType = {
  Thread: "m.thread",
} as const;

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
  event: MatrixRawEvent;
  content: RoomMessageEventContent;
}): string | undefined {
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
