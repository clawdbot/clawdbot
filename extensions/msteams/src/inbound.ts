export type MSTeamsQuoteInfo = {
  sender: string;
  body: string;
};

/**
 * Decode common HTML entities to plain text.
 */
export function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // must be last to prevent double-decoding (e.g. &amp;lt; → &lt; not <)
}

/**
 * Strip HTML tags, preserving text content.
 */
export function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/**
 * Extract quote info from MS Teams HTML reply attachments.
 * Teams wraps quoted content in a blockquote with itemtype="http://schema.skype.com/Reply".
 */
export function extractMSTeamsQuoteInfo(
  attachments: Array<{ contentType?: string | null; content?: unknown }>,
): MSTeamsQuoteInfo | undefined {
  for (const att of attachments) {
    // Content may be a plain string or an object with .text/.body (e.g. Adaptive Card payloads).
    let content = "";
    if (typeof att.content === "string") {
      content = att.content;
    } else if (typeof att.content === "object" && att.content !== null) {
      const record = att.content as Record<string, unknown>;
      content =
        typeof record.text === "string"
          ? record.text
          : typeof record.body === "string"
            ? record.body
            : "";
    }
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

    // Extract body from <p itemprop="copy">.
    const bodyMatch = /<p[^>]*itemprop=["']copy["'][^>]*>(.*?)<\/p>/is.exec(content);
    const body = bodyMatch?.[1] ? htmlToPlainText(bodyMatch[1]) : undefined;

    if (body) {
      return { sender: sender ?? "unknown", body };
    }
  }
  return undefined;
}

export type MentionableActivity = {
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
