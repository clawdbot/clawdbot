// Slack plugin module implements captionless audio mention preflight behavior.
import fs from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { mimeTypeFromFilePath } from "openclaw/plugin-sdk/media-mime";
import { createChannelPreflightAudio } from "openclaw/plugin-sdk/media-understanding-runtime";
import type { SlackFile, SlackMessageEvent } from "../../types.js";
import { MAX_SLACK_MEDIA_FILES, type SlackMediaResult } from "../media-types.js";

function isSlackAudioFile(file: SlackFile): boolean {
  if (file.subtype === "slack_audio") {
    return true;
  }
  const mime = file.mimetype?.split(";")[0]?.trim().toLowerCase();
  if (mime?.startsWith("audio/")) {
    return true;
  }
  return Boolean(mimeTypeFromFilePath(file.name)?.startsWith("audio/"));
}

const slackPreflightAudio = createChannelPreflightAudio({
  channel: "slack",
  isAudio: isSlackAudioFile,
});

export function findCaptionlessSlackAudioFile(message: SlackMessageEvent): SlackFile | undefined {
  if (message.text?.trim()) {
    return undefined;
  }
  return message.files?.slice(0, MAX_SLACK_MEDIA_FILES).find(isSlackAudioFile);
}

export function formatSlackAudioTranscriptForAgent(params: {
  transcript: string;
  rawBody: string;
}): string {
  const framed = `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(params.transcript)}`;
  return [framed, params.rawBody].filter(Boolean).join("\n");
}

export async function resolveSlackPreflightAudioTranscript(params: {
  media: readonly SlackMediaResult[];
  cfg: OpenClawConfig;
  accountId: string;
  originatingTo: string;
  sessionKey: string;
  messageThreadId?: string;
}): Promise<{ transcript: string; mediaIndex: number } | null> {
  const mediaIndex = params.media.findIndex((entry) =>
    entry.contentType?.toLowerCase().startsWith("audio/"),
  );
  if (mediaIndex < 0) {
    return null;
  }
  const transcript = await slackPreflightAudio.resolve({
    request: {
      ctx: {
        media: [...params.media],
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: params.originatingTo,
        AccountId: params.accountId,
        MessageThreadId: params.messageThreadId,
        ChatType: "channel",
        SessionKey: params.sessionKey,
      },
      cfg: params.cfg,
    },
  });
  return transcript ? { transcript, mediaIndex } : null;
}

export async function sendSlackPreflightAudioTranscriptEcho(params: {
  transcript: string;
  cfg: OpenClawConfig;
  accountId: string;
  originatingTo: string;
  messageThreadId?: string;
}): Promise<void> {
  await slackPreflightAudio.send(params);
}

export async function discardSlackPreflightMedia(
  media: readonly SlackMediaResult[] | null | undefined,
): Promise<void> {
  await Promise.allSettled((media ?? []).map((entry) => fs.rm(entry.path, { force: true })));
}
