import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
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
    for (const match of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/gi)) {
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
  return text.replace(/<@([A-Z0-9]+)(?:\|[^>]+)?>/gi, (full, userId: string) => {
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
        const listText = Array.isArray(element.elements)
          ? element.elements
              .map((child) =>
                child && typeof child === "object"
                  ? renderSlackRichTextElements((child as SlackRichTextElement).elements)
                  : "",
              )
              .filter(Boolean)
              .join("\n")
          : "";
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
        const fields = blockLike.fields.map(readTextObject).filter(Boolean);
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
      const parts = blockLike.elements.map(readTextObject).filter(Boolean);
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

function resolveSlackBlocksText(blocks: unknown[] | undefined): string | undefined {
  if (!blocks?.length) {
    return undefined;
  }
  const parts = blocks.map(readSlackBlockText).filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function chooseSlackPrimaryText(params: {
  messageText: string | undefined;
  blocksText: string | undefined;
}): string | undefined {
  const { messageText, blocksText } = params;
  if (!blocksText) {
    return messageText;
  }
  if (!messageText) {
    return blocksText;
  }
  return blocksText.length > messageText.length && blocksText.startsWith(messageText)
    ? blocksText
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
  mediaMaxBytes: number;
  resolveUserName?: (userId: string) => Promise<{ name?: string }>;
}): Promise<SlackResolvedMessageContent | null> {
  const ownFiles = filterInheritedParentFiles({
    files: params.message.files,
    isThreadReply: params.isThreadReply,
    threadStarter: params.threadStarter,
  });

  const media =
    ownFiles && ownFiles.length > 0
      ? await (async () => {
          const { resolveSlackMedia } = await loadSlackMediaModule();
          return resolveSlackMedia({
            files: ownFiles,
            token: params.botToken,
            maxBytes: params.mediaMaxBytes,
          });
        })()
      : null;

  const attachmentContent =
    params.message.attachments && params.message.attachments.length > 0
      ? await (async () => {
          const { resolveSlackAttachmentContent } = await loadSlackMediaModule();
          return resolveSlackAttachmentContent({
            attachments: params.message.attachments,
            token: params.botToken,
            maxBytes: params.mediaMaxBytes,
          });
        })()
      : null;

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

  const botAttachmentText =
    params.isBotMessage && !attachmentContent?.text
      ? (params.message.attachments ?? [])
          .map(
            (attachment) =>
              normalizeOptionalString(attachment.text) ??
              normalizeOptionalString(attachment.fallback),
          )
          .filter(Boolean)
          .join("\n")
      : undefined;

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
