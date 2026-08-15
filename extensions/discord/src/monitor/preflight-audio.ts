// Discord plugin module implements preflight audio behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getFileExtension } from "openclaw/plugin-sdk/media-mime";
import { createChannelPreflightAudio } from "openclaw/plugin-sdk/media-understanding-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type DiscordAudioAttachment = {
  content_type?: string;
  duration_secs?: number;
  filename?: string;
  url?: string;
  waveform?: string;
};

const AUDIO_ATTACHMENT_MIME_BY_EXT = new Map([
  [".aac", "audio/aac"],
  [".caf", "audio/x-caf"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/opus"],
  [".wav", "audio/wav"],
]);

function inferAudioAttachmentMime(attachment: DiscordAudioAttachment): string | undefined {
  const contentType = normalizeOptionalString(attachment.content_type);
  if (contentType?.startsWith("audio/")) {
    return contentType;
  }
  if (
    typeof attachment.duration_secs === "number" ||
    typeof normalizeOptionalString(attachment.waveform) === "string"
  ) {
    return "audio/ogg";
  }
  const ext = getFileExtension(attachment.filename ?? attachment.url);
  return ext ? AUDIO_ATTACHMENT_MIME_BY_EXT.get(ext) : undefined;
}

const discordPreflightAudio = createChannelPreflightAudio({
  channel: "discord",
  isAudio: (attachment: DiscordAudioAttachment) =>
    Boolean(normalizeOptionalString(attachment.url) && inferAudioAttachmentMime(attachment)),
  // Discord uses this transcript only for mention admission and has no deferred
  // admitted-message echo, so its transcription config must remain unchanged.
  deferTranscriptEcho: false,
});

function collectAudioAttachments(
  attachments: DiscordAudioAttachment[] | undefined,
): DiscordAudioAttachment[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.filter(discordPreflightAudio.isAudio);
}

export async function resolveDiscordPreflightAudioMentionContext(params: {
  message: {
    attachments?: DiscordAudioAttachment[];
    content?: string;
  };
  isDirectMessage: boolean;
  shouldRequireMention: boolean;
  mentionRegexes: RegExp[];
  cfg: OpenClawConfig;
  abortSignal?: AbortSignal;
}): Promise<{
  hasAudioAttachment: boolean;
  hasTypedText: boolean;
  transcript?: string;
}> {
  const audioAttachments = collectAudioAttachments(params.message.attachments);
  const hasAudioAttachment = audioAttachments.length > 0;
  const hasTypedText = Boolean(params.message.content?.trim());
  const needsPreflightTranscription =
    hasAudioAttachment &&
    // Caption text suppresses preflight; media-only messages remain eligible.
    !hasTypedText &&
    (params.isDirectMessage || (params.shouldRequireMention && params.mentionRegexes.length > 0));

  let transcript: string | undefined;
  if (needsPreflightTranscription) {
    if (params.abortSignal?.aborted) {
      return {
        hasAudioAttachment,
        hasTypedText,
      };
    }
    const media = audioAttachments.flatMap((attachment) => {
      const url = normalizeOptionalString(attachment.url);
      return url ? [{ url, contentType: inferAudioAttachmentMime(attachment) }] : [];
    });
    if (media.length > 0) {
      transcript = await discordPreflightAudio.resolve({
        request: {
          ctx: { media },
          cfg: params.cfg,
          agentDir: undefined,
        },
        abortSignal: params.abortSignal,
      });
    }
  }

  return {
    hasAudioAttachment,
    hasTypedText,
    transcript,
  };
}
