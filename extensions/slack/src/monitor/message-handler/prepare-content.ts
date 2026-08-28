// Slack plugin module implements prepare content behavior.
import type { WebClient as SlackWebClient } from "@slack/web-api";
import { formatInboundMediaUnavailableText } from "openclaw/plugin-sdk/channel-inbound";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { formatSlackFileReference } from "../../file-reference.js";
import type { SlackFile, SlackMessageEvent } from "../../types.js";
import { resolveSlackMessageText } from "../block-text.js";
import type { SlackMediaResult } from "../media-types.js";
import type { SlackThreadStarter } from "../thread.js";

type SlackResolvedMessageContent = {
  rawBody: string;
  effectiveDirectMedia: SlackMediaResult[] | null;
};

const SLACK_MENTION_RESOLUTION_CONCURRENCY = 4;
const SLACK_MENTION_RESOLUTION_MAX_LOOKUPS_PER_MESSAGE = 20;
const SLACK_USER_MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]+)?>/gi;
const MAX_SLACK_UNAVAILABLE_FILE_TEXT_CHARS = 2000;

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

  const attachmentContent =
    ownFiles?.length || params.message.attachments?.length
      ? await loadSlackMediaModule().then(({ resolveSlackAttachmentContent }) =>
          resolveSlackAttachmentContent({
            files: ownFiles,
            attachments: params.message.attachments,
            client: params.client,
            token: params.botToken,
            maxBytes: params.mediaMaxBytes,
            readIdleTimeoutMs: params.mediaReadIdleTimeoutMs,
            totalTimeoutMs: params.mediaTotalTimeoutMs,
            abortSignal: params.abortSignal,
            preloadedMedia: params.preloadedMedia,
          }),
        )
      : null;

  const effectiveDirectMedia = attachmentContent?.media.length ? attachmentContent.media : null;
  const mediaPlaceholder = effectiveDirectMedia?.map((item) => item.placeholder).join(" ");

  let fileOnlyFallback = attachmentContent?.files
    ?.map((file) => `${formatSlackFileReference(file)} unavailable (${file.reason})`)
    .join(", ");
  // Excess files remain accounted for without adding an unbounded prompt block.
  if (fileOnlyFallback && fileOnlyFallback.length > MAX_SLACK_UNAVAILABLE_FILE_TEXT_CHARS) {
    fileOnlyFallback = `${truncateUtf16Safe(fileOnlyFallback, MAX_SLACK_UNAVAILABLE_FILE_TEXT_CHARS)}; … (file references truncated)`;
  }

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

  const primaryText = resolveSlackMessageText(params.message);
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

  let rawBody =
    [
      renderedMessageText,
      renderedAttachmentText,
      renderedBotAttachmentText,
      mediaPlaceholder,
      fileOnlyFallback ? `[Slack file: ${fileOnlyFallback}]` : undefined,
    ]
      .filter(Boolean)
      .join("\n") || "";
  const unavailableMediaCount = attachmentContent?.unavailableMediaCount ?? 0;
  if (unavailableMediaCount > 0) {
    rawBody = formatInboundMediaUnavailableText({
      body: rawBody,
      notice: `[slack ${
        unavailableMediaCount > 1 ? `${unavailableMediaCount} attachments` : "attachment"
      } unavailable]`,
    });
  }
  return rawBody ? { rawBody, effectiveDirectMedia } : null;
}
