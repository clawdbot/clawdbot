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

export type MatrixQaObservedEventAttachment = {
  caption?: string;
  filename?: string;
  kind: "audio" | "file" | "image" | "sticker" | "video";
};

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
  attachment?: MatrixQaObservedEventAttachment;
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

function resolveMatrixQaAttachmentKind(msgtype: string | undefined) {
  switch (msgtype) {
    case "m.audio":
      return "audio" as const;
    case "m.file":
      return "file" as const;
    case "m.image":
      return "image" as const;
    case "m.sticker":
      return "sticker" as const;
    case "m.video":
      return "video" as const;
    default:
      return undefined;
  }
}

function isLikelyMatrixQaFilenameBody(value: string) {
  return !value.includes("\n") && /\.[a-z0-9][a-z0-9._-]{0,24}$/i.test(value);
}

function resolveMatrixQaAttachmentSummary(params: {
  body?: string;
  filename?: string;
  msgtype?: string;
}): MatrixQaObservedEventAttachment | undefined {
  const kind = resolveMatrixQaAttachmentKind(params.msgtype);
  if (!kind) {
    return undefined;
  }
  const body = params.body?.trim() ?? "";
  const explicitFilename = params.filename?.trim() ?? "";
  const inferredFilename =
    !explicitFilename && body && isLikelyMatrixQaFilenameBody(body) ? body : "";
  const filename = explicitFilename || inferredFilename;
  const caption = body && body !== filename ? body : "";
  return {
    kind,
    ...(caption ? { caption } : {}),
    ...(filename ? { filename } : {}),
  };
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
  const normalizedFilename =
    typeof messageContent.filename === "string"
      ? messageContent.filename
      : typeof content.filename === "string"
        ? content.filename
        : undefined;
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
  const attachment = resolveMatrixQaAttachmentSummary({
    body: typeof messageContent.body === "string" ? messageContent.body : undefined,
    filename: normalizedFilename,
    msgtype: normalizedMsgtype,
  });

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
    ...(attachment ? { attachment } : {}),
  };
}

export function findMatrixQaObservedEventMatch(params: {
  cursorIndex: number;
  events: MatrixQaObservedEvent[];
  predicate: (event: MatrixQaObservedEvent) => boolean;
  roomId: string;
}) {
  for (let index = params.cursorIndex; index < params.events.length; index += 1) {
    const event = params.events[index];
    if (event?.roomId !== params.roomId) {
      continue;
    }
    if (params.predicate(event)) {
      return {
        event,
        nextCursorIndex: index + 1,
      };
    }
  }
  return undefined;
}
