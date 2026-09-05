import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

type MatrixQaAuthStage = "m.login.dummy" | "m.login.registration_token";

type MatrixQaSendMessageContent = {
  body: string;
  format?: "org.matrix.custom.html";
  formatted_body?: string;
  "m.new_content"?: MatrixQaSendMessageContent;
  "m.mentions"?: {
    user_ids?: string[];
  };
  "m.relates_to"?:
    | {
        rel_type: "m.thread";
        event_id: string;
        is_falling_back: true;
        "m.in_reply_to": {
          event_id: string;
        };
      }
    | {
        rel_type: "m.replace";
        event_id: string;
      };
  msgtype: "m.text";
};

type MatrixQaMediaMessageType = "m.audio" | "m.file" | "m.image" | "m.video";

type MatrixQaSendMediaMessageContent = Omit<MatrixQaSendMessageContent, "msgtype"> & {
  filename?: string;
  info?: {
    mimetype?: string;
    size?: number;
  };
  msgtype: MatrixQaMediaMessageType;
  url: string;
};

type MatrixQaSendReactionContent = {
  "m.relates_to": {
    event_id: string;
    key: string;
    rel_type: "m.annotation";
  };
};

export type MatrixQaUiaaResponse = {
  completed?: string[];
  flows?: Array<{ stages?: string[] }>;
  session?: string;
};

function buildMatrixThreadRelation(threadRootEventId: string, replyToEventId?: string) {
  return {
    "m.relates_to": {
      rel_type: "m.thread" as const,
      event_id: threadRootEventId,
      is_falling_back: true as const,
      "m.in_reply_to": {
        event_id: replyToEventId?.trim() || threadRootEventId,
      },
    },
  };
}

function buildMatrixReplacementRelation(targetEventId: string) {
  const normalizedTargetEventId = targetEventId.trim();
  if (!normalizedTargetEventId) {
    throw new Error("Matrix replacement requires a target event id");
  }
  return {
    "m.relates_to": {
      rel_type: "m.replace" as const,
      event_id: normalizedTargetEventId,
    },
  };
}

export function buildMatrixReactionRelation(
  messageId: string,
  emoji: string,
): MatrixQaSendReactionContent {
  const normalizedMessageId = messageId.trim();
  const normalizedEmoji = emoji.trim();
  if (!normalizedMessageId) {
    throw new Error("Matrix reaction requires a messageId");
  }
  if (!normalizedEmoji) {
    throw new Error("Matrix reaction requires an emoji");
  }
  return {
    "m.relates_to": {
      rel_type: "m.annotation",
      event_id: normalizedMessageId,
      key: normalizedEmoji,
    },
  };
}

function escapeMatrixHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function buildMatrixMentionLink(userId: string) {
  const href = `https://matrix.to/#/${encodeURIComponent(userId)}`;
  const label = escapeMatrixHtml(userId);
  return `<a href="${href}">${label}</a>`;
}

export function buildMatrixQaMessageContent(params: {
  body: string;
  mentionUserIds?: string[];
  replyToEventId?: string;
  threadRootEventId?: string;
}): MatrixQaSendMessageContent {
  const body = params.body;
  const uniqueMentionUserIds = uniqueStrings(params.mentionUserIds?.filter(Boolean) ?? []);
  const formattedParts: string[] = [];
  let cursor = 0;
  let usedFormattedMention = false;

  while (cursor < body.length) {
    let matchedUserId: string | null = null;
    for (const userId of uniqueMentionUserIds) {
      if (body.startsWith(userId, cursor)) {
        matchedUserId = userId;
        break;
      }
    }
    if (matchedUserId) {
      formattedParts.push(buildMatrixMentionLink(matchedUserId));
      cursor += matchedUserId.length;
      usedFormattedMention = true;
      continue;
    }
    formattedParts.push(escapeMatrixHtml(body[cursor] ?? ""));
    cursor += 1;
  }

  return {
    body,
    msgtype: "m.text",
    ...(usedFormattedMention
      ? {
          format: "org.matrix.custom.html" as const,
          formatted_body: formattedParts.join(""),
        }
      : {}),
    ...(uniqueMentionUserIds.length > 0
      ? { "m.mentions": { user_ids: uniqueMentionUserIds } }
      : {}),
    ...(params.threadRootEventId
      ? buildMatrixThreadRelation(params.threadRootEventId, params.replyToEventId)
      : {}),
  };
}

export function buildMatrixQaReplacementMessageContent(params: {
  body: string;
  mentionUserIds?: string[];
  targetEventId: string;
}): MatrixQaSendMessageContent {
  const newContent = buildMatrixQaMessageContent({
    body: params.body,
    mentionUserIds: params.mentionUserIds,
  });
  return {
    body: `* ${params.body}`,
    msgtype: "m.text",
    "m.new_content": newContent,
    ...buildMatrixReplacementRelation(params.targetEventId),
  };
}

function resolveMatrixQaMediaMsgtype(params: {
  contentType?: string;
  kind?: "audio" | "file" | "image" | "video";
}): MatrixQaMediaMessageType {
  if (params.kind === "audio" || params.contentType?.startsWith("audio/")) {
    return "m.audio";
  }
  if (params.kind === "video" || params.contentType?.startsWith("video/")) {
    return "m.video";
  }
  if (params.kind === "image" || params.contentType?.startsWith("image/")) {
    return "m.image";
  }
  return "m.file";
}

export function buildMatrixQaMediaMessageContent(params: {
  body?: string;
  contentType?: string;
  fileName?: string;
  kind?: "audio" | "file" | "image" | "video";
  mentionUserIds?: string[];
  replyToEventId?: string;
  size: number;
  threadRootEventId?: string;
  url: string;
}): MatrixQaSendMediaMessageContent {
  const normalizedBody = params.body?.trim() || params.fileName?.trim() || "(file)";
  const content = buildMatrixQaMessageContent({
    body: normalizedBody,
    mentionUserIds: params.mentionUserIds,
    replyToEventId: params.replyToEventId,
    threadRootEventId: params.threadRootEventId,
  });
  return {
    ...content,
    filename: params.fileName?.trim() || undefined,
    info: {
      ...(params.contentType ? { mimetype: params.contentType } : {}),
      size: params.size,
    },
    msgtype: resolveMatrixQaMediaMsgtype({
      contentType: params.contentType,
      kind: params.kind,
    }),
    url: params.url,
  };
}

export function resolveNextRegistrationAuth(params: {
  registrationToken: string;
  response: MatrixQaUiaaResponse;
}) {
  const session = params.response.session?.trim();
  if (!session) {
    throw new Error("Matrix registration UIAA response did not include a session id.");
  }

  const completed = new Set(
    (params.response.completed ?? []).filter(
      (stage): stage is MatrixQaAuthStage =>
        stage === "m.login.dummy" || stage === "m.login.registration_token",
    ),
  );
  const supportedStages = new Set<MatrixQaAuthStage>([
    "m.login.registration_token",
    "m.login.dummy",
  ]);

  for (const flow of params.response.flows ?? []) {
    const flowStages = flow.stages ?? [];
    if (
      flowStages.length === 0 ||
      flowStages.some((stage) => !supportedStages.has(stage as MatrixQaAuthStage))
    ) {
      continue;
    }
    const stages = flowStages as MatrixQaAuthStage[];
    const nextStage = stages.find((stage) => !completed.has(stage));
    if (!nextStage) {
      continue;
    }
    if (nextStage === "m.login.registration_token") {
      return {
        session,
        type: nextStage,
        token: params.registrationToken,
      };
    }
    return {
      session,
      type: nextStage,
    };
  }

  throw new Error(
    `Matrix registration requires unsupported auth stages: ${JSON.stringify(params.response.flows ?? [])}`,
  );
}
