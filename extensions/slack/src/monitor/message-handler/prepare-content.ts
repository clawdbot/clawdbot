import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { SlackFile, SlackMessageEvent } from "../../types.js";
import {
  MAX_SLACK_MEDIA_FILES,
  resolveSlackAttachmentContent,
  resolveSlackMedia,
  type SlackMediaResult,
  type SlackThreadStarter,
} from "../media.js";

export type SlackResolvedMessageContent = {
  rawBody: string;
  effectiveDirectMedia: SlackMediaResult[] | null;
};

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
}): Promise<SlackResolvedMessageContent | null> {
  const ownFiles = filterInheritedParentFiles({
    files: params.message.files,
    isThreadReply: params.isThreadReply,
    threadStarter: params.threadStarter,
  });

  const media = await resolveSlackMedia({
    files: ownFiles,
    token: params.botToken,
    maxBytes: params.mediaMaxBytes,
  });

  const attachmentContent = await resolveSlackAttachmentContent({
    attachments: params.message.attachments,
    token: params.botToken,
    maxBytes: params.mediaMaxBytes,
  });

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
          .map((file) => normalizeOptionalString(file.name) ?? "file")
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

  const rawBody =
    [
      normalizeOptionalString(params.message.text),
      attachmentContent?.text,
      botAttachmentText,
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
