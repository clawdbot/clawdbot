// Msteams plugin module implements inbound behavior.
import { decodeHtmlEntities } from "openclaw/plugin-sdk/html-entity-runtime";

type MSTeamsQuoteInfo = {
  sender: string;
  body: string;
  /**
   * The quoted message's Teams id (the blockquote `itemid`). Present when Teams
   * includes it; used to fetch the complete message text via Graph because the
   * inbound blockquote only carries a truncated `preview` snippet.
   */
  id?: string;
  senderId?: string;
  fromQuotedReplyEntity?: boolean;
};

type MSTeamsAttachmentLike = {
  contentType?: string | null;
  content?: unknown;
};

type MSTeamsEntityLike = {
  type?: string;
  text?: unknown;
  messageId?: unknown;
  mentioned?: {
    id?: unknown;
    name?: unknown;
  };
  senderId?: unknown;
  senderName?: unknown;
  preview?: unknown;
};

type BuildMSTeamsNormalizedTextParams = {
  text: string;
  entities?: MSTeamsEntityLike[] | null;
  attachments?: MSTeamsAttachmentLike[];
  botId?: string | null;
  botName?: string | null;
};

/**
 * Strip HTML tags, preserving text content.
 */
function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " "))
    .replaceAll("\u00a0", " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract quote info from MS Teams HTML reply attachments.
 * Teams wraps quoted content in a blockquote with itemtype="http://schema.skype.com/Reply".
 */
export function extractMSTeamsQuoteInfo(
  attachments: MSTeamsAttachmentLike[],
  entities?: MSTeamsEntityLike[] | null,
): MSTeamsQuoteInfo | undefined {
  for (const att of attachments) {
    const content = readMSTeamsAttachmentContent(att);
    if (!content) {
      continue;
    }

    // Look for the Skype Reply schema blockquote.
    if (!content.includes("http://schema.skype.com/Reply")) {
      continue;
    }

    // Extract sender from <strong itemprop="mri">.
    const senderMatch = /<strong[^>]*itemprop=["']mri["'][^>]*>(.*?)<\/strong>/i.exec(content);
    const sender = senderMatch?.[1] ? htmlToPlainText(senderMatch[1]) : undefined;

    // Extract body from <p itemprop="copy"> (full quoted text) and fall back to
    // <p itemprop="preview"> — the truncated snippet Teams actually sends for
    // quote replies. Prefer `copy` when both are present.
    const copyMatch = /<p[^>]*itemprop=["']copy["'][^>]*>(.*?)<\/p>/is.exec(content);
    const bodyMatch =
      copyMatch ?? /<p[^>]*itemprop=["']preview["'][^>]*>(.*?)<\/p>/is.exec(content);
    const body = bodyMatch?.[1] ? htmlToPlainText(bodyMatch[1]) : undefined;

    // Capture the blockquote `itemid` (the quoted message's Teams id) so callers
    // can fetch the complete message text via Graph when only a preview snippet
    // is available.
    const idMatch = /<blockquote[^>]*\bitemid=["']([^"']+)["'][^>]*>/is.exec(content);
    const id = idMatch?.[1]?.trim() || undefined;

    if (body) {
      return { sender: sender ?? "unknown", body, ...(id ? { id } : {}) };
    }
  }
  for (const entity of entities ?? []) {
    if (entity.type !== "quotedReply" || typeof entity.preview !== "string") {
      continue;
    }
    const body = normalizeMSTeamsWhitespace(entity.preview);
    if (body) {
      const senderName = typeof entity.senderName === "string" ? entity.senderName.trim() : "";
      const id = typeof entity.messageId === "string" ? entity.messageId.trim() : "";
      return {
        sender: senderName || "unknown",
        body,
        ...(id ? { id } : {}),
        senderId: typeof entity.senderId === "string" ? entity.senderId : undefined,
        fromQuotedReplyEntity: true,
      };
    }
  }
  return undefined;
}

type MentionableActivity = {
  recipient?: { id?: string } | null;
  entities?: Array<{
    type?: string;
    mentioned?: { id?: string };
  }> | null;
};

export function normalizeMSTeamsConversationId(raw: string): string {
  return raw.split(";")[0] ?? raw;
}

export function extractMSTeamsConversationMessageId(raw: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const match = /(?:^|;)messageid=([^;]+)/i.exec(raw);
  const value = match?.[1]?.trim() ?? "";
  return value || undefined;
}

export function parseMSTeamsActivityTimestamp(value: unknown): Date | undefined {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function stripMSTeamsMentionTags(text: string): string {
  // Teams wraps mentions in <at>...</at> tags
  return text.replace(/<at[^>]*>.*?<\/at>/gi, "").trim();
}

function readMSTeamsAttachmentContent(att: MSTeamsAttachmentLike): string {
  if (typeof att.content === "string") {
    return att.content;
  }
  if (typeof att.content !== "object" || att.content === null) {
    return "";
  }
  const record = att.content as Record<string, unknown>;
  return typeof record.text === "string"
    ? record.text
    : typeof record.body === "string"
      ? record.body
      : "";
}

function normalizeMSTeamsWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripMSTeamsQuotedMarkers(text: string): string {
  return text.replace(/<quoted\b[^>]*\/>/gi, "").trim();
}

function normalizeMSTeamsMentionTags(
  text: string,
  entities: MSTeamsEntityLike[],
  botId?: string | null,
  botName?: string | null,
): string {
  const mentionsByTag = new Map<string, { id?: string; name: string }>();
  const botMentionNames = new Set<string>();
  for (const entity of entities) {
    if (
      entity.type !== "mention" ||
      typeof entity.text !== "string" ||
      typeof entity.mentioned?.name !== "string"
    ) {
      continue;
    }
    const mentionedId = typeof entity.mentioned.id === "string" ? entity.mentioned.id : undefined;
    if (mentionedId && botId && mentionedId === botId) {
      botMentionNames.add(entity.mentioned.name.trim());
    }
    mentionsByTag.set(entity.text, {
      id: mentionedId,
      name: entity.mentioned.name,
    });
  }
  return text.replace(/<at\b[^>]*>.*?<\/at>/gis, (tag) => {
    const mention = mentionsByTag.get(tag);
    if (mention?.id && botId && mention.id === botId) {
      return "";
    }
    if (mention) {
      return `@${mention.name}`;
    }
    const displayName = htmlToPlainText(tag);
    if (
      botId &&
      displayName &&
      (botMentionNames.has(displayName.trim()) || displayName.trim() === botName?.trim())
    ) {
      return "";
    }
    return displayName ? `@${displayName}` : "";
  });
}

function extractMSTeamsForwardBodies(attachments: MSTeamsAttachmentLike[]): string[] {
  const bodies: string[] = [];
  for (const attachment of attachments) {
    const content = readMSTeamsAttachmentContent(attachment);
    if (!content.includes("http://schema.skype.com/Forward")) {
      continue;
    }
    const matches = content.matchAll(
      /<blockquote\b[^>]*itemtype=["']http:\/\/schema\.skype\.com\/Forward["'][^>]*>(.*?)<\/blockquote>/gis,
    );
    for (const match of matches) {
      const body = htmlToPlainText(match[1] ?? "");
      if (body) {
        bodies.push(body);
      }
    }
  }
  return bodies;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function labelMSTeamsForwardBody(text: string, body: string): string {
  const marker = `[Forwarded message]\n${body}\n[/Forwarded message]`;
  if (text.includes(marker)) {
    return text;
  }
  const bodyPattern = body.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  const collapsedPattern = new RegExp(`(^|\\n\\s*\\n|\\n)${bodyPattern}(?=$|\\n)`, "g");
  const matches = [...text.matchAll(collapsedPattern)];
  const match = matches.at(-1);
  if (match?.index !== undefined) {
    const replacement = `${match[1] ?? ""}${marker}`;
    return `${text.slice(0, match.index)}${replacement}${text.slice(match.index + match[0].length)}`;
  }
  return `${text}\n\n${marker}`;
}

export function buildMSTeamsNormalizedText(params: BuildMSTeamsNormalizedTextParams): string {
  const entities = params.entities ?? [];
  const attachments = params.attachments ?? [];
  let text = normalizeMSTeamsMentionTags(params.text, entities, params.botId, params.botName);
  text = stripMSTeamsQuotedMarkers(text);
  text = normalizeMSTeamsWhitespace(text);

  for (const forwardBody of extractMSTeamsForwardBodies(attachments)) {
    text = labelMSTeamsForwardBody(text, forwardBody);
  }

  return normalizeMSTeamsWhitespace(text);
}

/**
 * Bot Framework uses 'a:xxx' conversation IDs for personal chats, but Graph API
 * requires the '19:{userId}_{botAppId}@unq.gbl.spaces' format.
 *
 * This is the documented Graph API format for 1:1 chat thread IDs between a user
 * and a bot/app. See Microsoft docs "Get chat between user and app":
 * https://learn.microsoft.com/en-us/graph/api/userscopeteamsappinstallation-get-chat
 *
 * The format is only synthesized when the Bot Framework conversation ID starts with
 * 'a:' (the opaque format used by BF but not recognized by Graph). If the ID already
 * has the '19:...' Graph format, it is passed through unchanged.
 */
export function translateMSTeamsDmConversationIdForGraph(params: {
  isDirectMessage: boolean;
  conversationId: string;
  aadObjectId?: string | null;
  appId?: string | null;
}): string {
  const { isDirectMessage, conversationId, aadObjectId, appId } = params;
  return isDirectMessage && conversationId.startsWith("a:") && aadObjectId && appId
    ? `19:${aadObjectId}_${appId}@unq.gbl.spaces`
    : conversationId;
}

export function wasMSTeamsBotMentioned(activity: MentionableActivity): boolean {
  const botId = activity.recipient?.id;
  if (!botId) {
    return false;
  }
  const entities = activity.entities ?? [];
  return entities.some((e) => e.type === "mention" && e.mentioned?.id === botId);
}
