// Slack plugin module implements prepare content behavior.
import type { WebClient as SlackWebClient } from "@slack/web-api";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackFileReference } from "../../file-reference.js";
import type { SlackFile, SlackMessageEvent } from "../../types.js";
import { chooseSlackPrimaryText, resolveSlackBlocksText } from "../block-text.js";
import { MAX_SLACK_MEDIA_FILES, type SlackMediaResult } from "../media-types.js";
import type { SlackThreadStarter } from "../thread.js";

type SlackResolvedMessageContent = {
  rawBody: string;
  effectiveDirectMedia: SlackMediaResult[] | null;
};

const SLACK_MENTION_RESOLUTION_CONCURRENCY = 4;
const SLACK_MENTION_RESOLUTION_MAX_LOOKUPS_PER_MESSAGE = 20;
const SLACK_USER_MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]+)?>/gi;

const loadSlackMediaModule = createLazyRuntimeModule(() => import("../media.js"));

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
  preloadedMedia?: ReadonlyMap<SlackFile, SlackMediaResult>;
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
            preloadedMedia: params.preloadedMedia,
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
