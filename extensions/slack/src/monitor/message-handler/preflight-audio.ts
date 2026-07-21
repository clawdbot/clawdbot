// Slack plugin module implements captionless audio mention preflight behavior.
import fs from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { mimeTypeFromFilePath } from "openclaw/plugin-sdk/media-mime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { SlackFile, SlackMessageEvent } from "../../types.js";
import { MAX_SLACK_MEDIA_FILES, type SlackMediaResult } from "../media-types.js";

const SLACK_DEFAULT_ECHO_TRANSCRIPT_FORMAT = '📝 "{transcript}"';

const loadSlackPreflightAudioRuntime = createLazyRuntimeModule(
  () => import("./preflight-audio.runtime.js"),
);

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

function suppressSlackPreflightAudioEcho(cfg: OpenClawConfig): OpenClawConfig {
  const audio = cfg.tools?.media?.audio;
  if (!audio?.echoTranscript) {
    return cfg;
  }
  return {
    ...cfg,
    tools: {
      ...cfg.tools,
      media: {
        ...cfg.tools?.media,
        audio: {
          ...audio,
          echoTranscript: false,
        },
      },
    },
  };
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
  try {
    const { transcribeFirstAudio } = await loadSlackPreflightAudioRuntime();
    const transcript = await transcribeFirstAudio({
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
      cfg: suppressSlackPreflightAudioEcho(params.cfg),
    });
    return transcript ? { transcript, mediaIndex } : null;
  } catch (err) {
    logVerbose(`slack: audio preflight transcription failed: ${String(err)}`);
    return null;
  }
}

function formatSlackAudioTranscriptEcho(transcript: string, format: string): string {
  // Function replacement preserves literal `$` sequences in provider output.
  return format.replace("{transcript}", () => transcript);
}

export async function sendSlackPreflightAudioTranscriptEcho(params: {
  transcript: string;
  cfg: OpenClawConfig;
  accountId: string;
  originatingTo: string;
  messageThreadId?: string;
}): Promise<void> {
  const audio = params.cfg.tools?.media?.audio;
  if (!audio?.echoTranscript) {
    return;
  }
  const text = formatSlackAudioTranscriptEcho(
    params.transcript,
    audio.echoFormat ?? SLACK_DEFAULT_ECHO_TRANSCRIPT_FORMAT,
  );
  try {
    const { sendDurableMessageBatch } = await loadSlackPreflightAudioRuntime();
    const send = await sendDurableMessageBatch({
      cfg: params.cfg,
      channel: "slack",
      to: params.originatingTo,
      accountId: params.accountId,
      threadId: params.messageThreadId,
      payloads: [{ text }],
      bestEffort: true,
      durability: "best_effort",
    });
    if (send.status === "failed") {
      throw send.error;
    }
  } catch (err) {
    logVerbose(`slack: audio transcript echo failed: ${String(err)}`);
  }
}

export async function discardSlackPreflightMedia(
  media: readonly SlackMediaResult[] | null | undefined,
): Promise<void> {
  await Promise.allSettled((media ?? []).map((entry) => fs.rm(entry.path, { force: true })));
}
