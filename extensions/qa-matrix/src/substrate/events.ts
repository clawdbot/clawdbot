export type MatrixQaRoomEvent = {
  content?: Record<string, unknown>;
  event_id?: string;
  origin_server_ts?: number;
  sender?: string;
  state_key?: string;
  type?: string;
};

export type MatrixQaObservedEventKind =
  | "membership"
  | "message"
  | "notice"
  | "redaction"
  | "reaction"
  | "room-event";

export type MatrixQaObservedEvent = {
  kind: MatrixQaObservedEventKind;
  roomId: string;
  eventId: string;
  sender?: string;
  stateKey?: string;
  type: string;
  originServerTs?: number;
  body?: string;
  formattedBody?: string;
  msgtype?: string;
  membership?: string;
  relatesTo?: {
    eventId?: string;
    inReplyToId?: string;
    isFallingBack?: boolean;
    relType?: string;
  };
  mentions?: {
    room?: boolean;
    userIds?: string[];
  };
  reaction?: {
    eventId?: string;
    key?: string;
  };
};

function normalizeMentionUserIds(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : undefined;
}

function resolveMatrixQaMessageContent(
  content: Record<string, unknown>,
  relatesTo: Record<string, unknown> | null,
) {
  const newContentRaw = content["m.new_content"];
  const newContent =
    typeof newContentRaw === "object" && newContentRaw !== null
      ? (newContentRaw as Record<string, unknown>)
      : null;
  if (relatesTo?.rel_type === "m.replace" && newContent) {
    return newContent;
  }
  return content;
}

function resolveMatrixQaObservedEventKind(params: { msgtype?: string; type: string }) {
  if (params.type === "m.reaction") {
    return "reaction" as const;
  }
  if (params.type === "m.room.redaction") {
    return "redaction" as const;
  }
  if (params.type === "m.room.member") {
    return "membership" as const;
  }
  if (params.type === "m.room.message") {
    return params.msgtype === "m.notice" ? ("notice" as const) : ("message" as const);
  }
  return "room-event" as const;
}

export function normalizeMatrixQaObservedEvent(
  roomId: string,
  event: MatrixQaRoomEvent,
): MatrixQaObservedEvent | null {
  const eventId = event.event_id?.trim();
  const type = event.type?.trim();
  if (!eventId || !type) {
    return null;
  }
  const content = event.content ?? {};
  const msgtype = typeof content.msgtype === "string" ? content.msgtype : undefined;
  const relatesToRaw = content["m.relates_to"];
  const relatesTo =
    typeof relatesToRaw === "object" && relatesToRaw !== null
      ? (relatesToRaw as Record<string, unknown>)
      : null;
  const inReplyToRaw = relatesTo?.["m.in_reply_to"];
  const inReplyTo =
    typeof inReplyToRaw === "object" && inReplyToRaw !== null
      ? (inReplyToRaw as Record<string, unknown>)
      : null;
  const messageContent = resolveMatrixQaMessageContent(content, relatesTo);
  const normalizedMsgtype =
    typeof messageContent.msgtype === "string" ? messageContent.msgtype : msgtype;
  const mentionsRaw = messageContent["m.mentions"] ?? content["m.mentions"];
  const mentions =
    typeof mentionsRaw === "object" && mentionsRaw !== null
      ? (mentionsRaw as Record<string, unknown>)
      : null;
  const mentionUserIds = normalizeMentionUserIds(mentions?.user_ids);
  const reactionKey =
    type === "m.reaction" && typeof relatesTo?.key === "string" ? relatesTo.key : undefined;
  const reactionEventId =
    type === "m.reaction" && typeof relatesTo?.event_id === "string"
      ? relatesTo.event_id
      : undefined;

  return {
    kind: resolveMatrixQaObservedEventKind({ msgtype: normalizedMsgtype, type }),
    roomId,
    eventId,
    sender: typeof event.sender === "string" ? event.sender : undefined,
    stateKey: typeof event.state_key === "string" ? event.state_key : undefined,
    type,
    originServerTs:
      typeof event.origin_server_ts === "number" ? Math.floor(event.origin_server_ts) : undefined,
    body: typeof messageContent.body === "string" ? messageContent.body : undefined,
    formattedBody:
      typeof messageContent.formatted_body === "string" ? messageContent.formatted_body : undefined,
    msgtype: normalizedMsgtype,
    membership: typeof content.membership === "string" ? content.membership : undefined,
    ...(relatesTo
      ? {
          relatesTo: {
            eventId: typeof relatesTo.event_id === "string" ? relatesTo.event_id : undefined,
            inReplyToId: typeof inReplyTo?.event_id === "string" ? inReplyTo.event_id : undefined,
            isFallingBack:
              typeof relatesTo.is_falling_back === "boolean"
                ? relatesTo.is_falling_back
                : undefined,
            relType: typeof relatesTo.rel_type === "string" ? relatesTo.rel_type : undefined,
          },
        }
      : {}),
    ...(mentions
      ? {
          mentions: {
            ...(mentions.room === true ? { room: true } : {}),
            ...(mentionUserIds ? { userIds: mentionUserIds } : {}),
          },
        }
      : {}),
    ...(reactionEventId || reactionKey
      ? {
          reaction: {
            ...(reactionEventId ? { eventId: reactionEventId } : {}),
            ...(reactionKey ? { key: reactionKey } : {}),
          },
        }
      : {}),
  };
}
