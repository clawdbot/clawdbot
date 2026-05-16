import type { WebClient as SlackWebClient } from "@slack/web-api";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackFileReference } from "../../file-reference.js";
import type { SlackFile, SlackMessageEvent } from "../../types.js";
import { MAX_SLACK_MEDIA_FILES, type SlackMediaResult } from "../media-types.js";
import type { SlackThreadStarter } from "../thread.js";

type SlackResolvedMessageContent = {
  rawBody: string;
  effectiveDirectMedia: SlackMediaResult[] | null;
};

const SLACK_MENTION_RESOLUTION_CONCURRENCY = 4;
const SLACK_MENTION_RESOLUTION_MAX_LOOKUPS_PER_MESSAGE = 20;
const SLACK_USER_MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]+)?>/gi;

type SlackTextObject = {
  text?: unknown;
};

type SlackRichTextElement = {
  type?: unknown;
  text?: unknown;
  url?: unknown;
  user_id?: unknown;
  channel_id?: unknown;
  usergroup_id?: unknown;
  name?: unknown;
  range?: unknown;
  elements?: unknown;
};

type SlackBlockLike = {
  type?: unknown;
  text?: unknown;
  elements?: unknown;
  fields?: unknown;
  alt_text?: unknown;
  title?: unknown;
};

type SlackBlocksText = {
  text: string;
  hasRichText: boolean;
};

type SlackMediaModule = typeof import("../media.js");
let slackMediaModulePromise: Promise<SlackMediaModule> | undefined;

function loadSlackMediaModule(): Promise<SlackMediaModule> {
  slackMediaModulePromise ??= import("../media.js");
  return slackMediaModulePromise;
}

function collectUniqueSlackMentionIds(texts: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const mentionIds: string[] = [];
  for (const text of texts) {
    if (!text) {
      continue;
    }
    SLACK_USER_MENTION_RE.lastIndex = 0;
    for (const match of text.matchAll(SLACK_USER_MENTION_RE)) {
      const userId = match[1];
      if (!userId || seen.has(userId)) {
        continue;
      }
      seen.add(userId);
      mentionIds.push(userId);
    }
  }
  return mentionIds;
}

function renderSlackUserMentions(
  text: string | undefined,
  renderedMentions: ReadonlyMap<string, string | null>,
): string | undefined {
  if (!text || renderedMentions.size === 0) {
    return text;
  }
  SLACK_USER_MENTION_RE.lastIndex = 0;
  return text.replace(SLACK_USER_MENTION_RE, (full, userId: string) => {
    const rendered = renderedMentions.get(userId);
    return rendered ?? full;
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readTextObject(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return normalizeOptionalString(readString((value as SlackTextObject).text));
}

function renderSlackRichTextLeaf(element: SlackRichTextElement): string {
  switch (element.type) {
    case "text":
      return readString(element.text) ?? "";
    case "link":
      return readString(element.text) ?? readString(element.url) ?? "";
    case "user": {
      const userId = readString(element.user_id);
      return userId ? `<@${userId}>` : "";
    }
    case "channel": {
      const channelId = readString(element.channel_id);
      return channelId ? `<#${channelId}>` : "";
    }
    case "usergroup": {
      const usergroupId = readString(element.usergroup_id);
      return usergroupId ? `<!subteam^${usergroupId}>` : "";
    }
    case "broadcast": {
      const range = readString(element.range);
      return range ? `<!${range}>` : "";
    }
    case "emoji": {
      const name = readString(element.name);
      return name ? `:${name}:` : "";
    }
    default:
      return "";
  }
}

function renderSlackRichTextElements(elements: unknown): string {
  if (!Array.isArray(elements)) {
    return "";
  }
  const parts: string[] = [];
  for (const rawElement of elements) {
    if (!rawElement || typeof rawElement !== "object") {
      continue;
    }
    const element = rawElement as SlackRichTextElement;
    switch (element.type) {
      case "rich_text_section":
      case "rich_text_preformatted":
      case "rich_text_quote": {
        parts.push(renderSlackRichTextElements(element.elements));
        break;
      }
      case "rich_text_list": {
        const listParts: string[] = [];
        if (Array.isArray(element.elements)) {
          for (const child of element.elements) {
            if (!child || typeof child !== "object") {
              continue;
            }
            const rendered = renderSlackRichTextElements((child as SlackRichTextElement).elements);
            if (rendered) {
              listParts.push(rendered);
            }
          }
        }
        const listText = listParts.join("\n");
        parts.push(listText);
        break;
      }
      default:
        parts.push(renderSlackRichTextLeaf(element));
        break;
    }
  }
  return parts.join("");
}

function readSlackBlockText(block: unknown): string | undefined {
  if (!block || typeof block !== "object") {
    return undefined;
  }
  const blockLike = block as SlackBlockLike;
  switch (blockLike.type) {
    case "rich_text":
      return normalizeOptionalString(renderSlackRichTextElements(blockLike.elements));
    case "section": {
      const text = readTextObject(blockLike.text);
      if (text) {
        return text;
      }
      if (Array.isArray(blockLike.fields)) {
        const fields: string[] = [];
        for (const field of blockLike.fields) {
          const fieldText = readTextObject(field);
          if (fieldText) {
            fields.push(fieldText);
          }
        }
        return fields.length > 0 ? fields.join("\n") : undefined;
      }
      return undefined;
    }
    case "header":
      return readTextObject(blockLike.text);
    case "context": {
      if (!Array.isArray(blockLike.elements)) {
        return undefined;
      }
      const parts: string[] = [];
      for (const element of blockLike.elements) {
        const text = readTextObject(element);
        if (text) {
          parts.push(text);
        }
      }
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    case "image":
      return (
        normalizeOptionalString(readString(blockLike.alt_text)) ?? readTextObject(blockLike.title)
      );
    case "video":
      return (
        readTextObject(blockLike.title) ?? normalizeOptionalString(readString(blockLike.alt_text))
      );
    default:
      return undefined;
  }
}

function resolveSlackBlocksText(blocks: unknown[] | undefined): SlackBlocksText | undefined {
  if (!blocks?.length) {
    return undefined;
  }
  const parts: string[] = [];
  let hasRichText = false;
  for (const block of blocks) {
    if (block && typeof block === "object" && (block as SlackBlockLike).type === "rich_text") {
      hasRichText = true;
    }
    const text = readSlackBlockText(block);
    if (text) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? { text: parts.join("\n"), hasRichText } : undefined;
}

function chooseSlackPrimaryText(params: {
  messageText: string | undefined;
  blocksText: SlackBlocksText | undefined;
}): string | undefined {
  const { messageText, blocksText } = params;
  if (!blocksText) {
    return messageText;
  }
  if (!messageText) {
    return blocksText.text;
  }
  if (blocksText.hasRichText && blocksText.text.length > messageText.length) {
    return blocksText.text;
  }
  return blocksText.text.length > messageText.length && blocksText.text.startsWith(messageText)
    ? blocksText.text
    : messageText;
}

function filterInheritedParentFiles(params: {
  files: SlackFile[] | undefined;
  isThreadReply: boolean;
  threadStarter: SlackThreadStarter | null;
}): SlackFile[] | undefined {
  const { files, isThreadReply, threadStarter } = params;
  if (!isThreadReply || !files?.length) {
    return files;
  }
  if (!threadStarter?.files?.length) {
    return files;
  }
  const starterFileIds = new Set(threadStarter.files.map((file) => file.id));
  const filtered = files.filter((file) => !file.id || !starterFileIds.has(file.id));
  if (filtered.length < files.length) {
    logVerbose(
      `slack: filtered ${files.length - filtered.length} inherited parent file(s) from thread reply`,
    );
  }
  return filtered.length > 0 ? filtered : undefined;
}

export async function resolveSlackMessageContent(params: {
  message: SlackMessageEvent;
  isThreadReply: boolean;
  threadStarter: SlackThreadStarter | null;
  isBotMessage: boolean;
  botToken: string;
  client?: SlackWebClient;
  mediaMaxBytes: number;
  resolveUserName?: (userId: string) => Promise<{ name?: string }>;
  mediaReadIdleTimeoutMs?: number;
  mediaTotalTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<SlackResolvedMessageContent | null> {
  const ownFiles = filterInheritedParentFiles({
    files: params.message.files,
    isThreadReply: params.isThreadReply,
    threadStarter: params.threadStarter,
  });

  const mediaPromise =
    ownFiles && ownFiles.length > 0
      ? loadSlackMediaModule().then(({ resolveSlackMedia }) =>
          resolveSlackMedia({
            files: ownFiles,
            client: params.client,
            token: params.botToken,
            maxBytes: params.mediaMaxBytes,
            readIdleTimeoutMs: params.mediaReadIdleTimeoutMs,
            totalTimeoutMs: params.mediaTotalTimeoutMs,
            abortSignal: params.abortSignal,
          }),
        )
      : Promise.resolve(null);

  const attachmentContentPromise =
    params.message.attachments && params.message.attachments.length > 0
      ? loadSlackMediaModule().then(({ resolveSlackAttachmentContent }) =>
          resolveSlackAttachmentContent({
            attachments: params.message.attachments,
            client: params.client,
            token: params.botToken,
            maxBytes: params.mediaMaxBytes,
            readIdleTimeoutMs: params.mediaReadIdleTimeoutMs,
            totalTimeoutMs: params.mediaTotalTimeoutMs,
            abortSignal: params.abortSignal,
          }),
        )
      : Promise.resolve(null);

  const [media, attachmentContent] = await Promise.all([mediaPromise, attachmentContentPromise]);

  const mergedMedia = [...(media ?? []), ...(attachmentContent?.media ?? [])];
  const effectiveDirectMedia = mergedMedia.length > 0 ? mergedMedia : null;
  const mediaPlaceholder = effectiveDirectMedia
    ? effectiveDirectMedia.map((item) => item.placeholder).join(" ")
    : undefined;

  const fallbackFiles = ownFiles ?? [];
  const fileOnlyFallback =
    !mediaPlaceholder && fallbackFiles.length > 0
      ? fallbackFiles
          .slice(0, MAX_SLACK_MEDIA_FILES)
          .map((file) => formatSlackFileReference(file))
          .join(", ")
      : undefined;
  const fileOnlyPlaceholder = fileOnlyFallback ? `[Slack file: ${fileOnlyFallback}]` : undefined;

  let botAttachmentText: string | undefined;
  if (params.isBotMessage && !attachmentContent?.text) {
    const botAttachmentTextParts: string[] = [];
    for (const attachment of params.message.attachments ?? []) {
      const text =
        normalizeOptionalString(attachment.text) ?? normalizeOptionalString(attachment.fallback);
      if (text) {
        botAttachmentTextParts.push(text);
      }
    }
    botAttachmentText =
      botAttachmentTextParts.length > 0 ? botAttachmentTextParts.join("\n") : undefined;
  }

  const blocksText = resolveSlackBlocksText(params.message.blocks);
  const primaryText = chooseSlackPrimaryText({
    messageText: normalizeOptionalString(params.message.text),
    blocksText,
  });
  const textParts = [primaryText, attachmentContent?.text, botAttachmentText];
  const renderedMentions = new Map<string, string | null>();
  const resolveUserName = params.resolveUserName;
  if (resolveUserName) {
    const mentionIds = collectUniqueSlackMentionIds(textParts);
    const lookupIds = mentionIds.slice(0, SLACK_MENTION_RESOLUTION_MAX_LOOKUPS_PER_MESSAGE);
    const skippedLookups = mentionIds.length - lookupIds.length;
    if (skippedLookups > 0) {
      logVerbose(
        `slack: skipping ${skippedLookups} mention lookup(s) beyond per-message cap (${SLACK_MENTION_RESOLUTION_MAX_LOOKUPS_PER_MESSAGE})`,
      );
    }
    const { results } = await runTasksWithConcurrency({
      tasks: lookupIds.map((userId) => async () => {
        const user = await resolveUserName(userId);
        const renderedName = normalizeOptionalString(user?.name);
        return { userId, rendered: renderedName ? `<@${userId}> (${renderedName})` : null };
      }),
      limit: SLACK_MENTION_RESOLUTION_CONCURRENCY,
    });
    for (const result of results) {
      if (!result) {
        continue;
      }
      renderedMentions.set(result.userId, result.rendered);
    }
  }

  const renderedMessageText = renderSlackUserMentions(textParts[0], renderedMentions);
  const renderedAttachmentText = renderSlackUserMentions(textParts[1], renderedMentions);
  const renderedBotAttachmentText = renderSlackUserMentions(textParts[2], renderedMentions);

  const rawBody =
    [
      renderedMessageText,
      renderedAttachmentText,
      renderedBotAttachmentText,
      mediaPlaceholder,
      fileOnlyPlaceholder,
    ]
      .filter(Boolean)
      .join("\n") || "";
  if (!rawBody) {
    return null;
  }

  return {
    rawBody,
    effectiveDirectMedia,
  };
}
