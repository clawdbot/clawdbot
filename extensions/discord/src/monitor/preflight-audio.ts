// Discord plugin module implements preflight audio behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { getFileExtension } from "openclaw/plugin-sdk/media-mime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const loadDiscordPreflightAudioRuntime = createLazyRuntimeModule(
  () => import("./preflight-audio.runtime.js"),
);

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

function collectAudioAttachments(
  attachments: DiscordAudioAttachment[] | undefined,
): DiscordAudioAttachment[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.filter(
    (att) => normalizeOptionalString(att.url) && inferAudioAttachmentMime(att),
  );
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
    try {
      const { transcribeFirstAudio } = await loadDiscordPreflightAudioRuntime();
      if (params.abortSignal?.aborted) {
        return {
          hasAudioAttachment,
          hasTypedText,
        };
      }
      const audioUrls = audioAttachments
        .map((att) => att.url)
        .map((url) => normalizeOptionalString(url))
        .filter((url): url is string => Boolean(url));
      if (audioUrls.length > 0) {
        transcript = await transcribeFirstAudio({
          ctx: {
            MediaUrls: audioUrls,
            MediaTypes: audioAttachments
              .map((att) => inferAudioAttachmentMime(att))
              .filter((contentType): contentType is string => Boolean(contentType)),
          },
          cfg: params.cfg,
          agentDir: undefined,
        });
        if (params.abortSignal?.aborted) {
          transcript = undefined;
        }
      }
    } catch (err) {
      logVerbose(`discord: audio preflight transcription failed: ${String(err)}`);
    }
  }

  return {
    hasAudioAttachment,
    hasTypedText,
    transcript,
  };
}
