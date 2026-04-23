import { downloadFile } from "../utils/file-utils.js";
import { getQQBotMediaDir } from "../utils/platform.js";
import { normalizeOptionalString } from "../utils/string-normalize.js";
import { transcribeAudio, resolveSTTConfig } from "../utils/stt.js";
// Re-export formatVoiceText from core/.
export { formatVoiceText } from "../utils/voice-text.js";

// ---- Injected audio-convert dependencies ----

/** Audio conversion interface — implemented by the upper-layer audio-convert module. */
export interface AudioConvertAdapter {
  convertSilkToWav(
    silkPath: string,
    outputDir: string,
  ): Promise<{ wavPath: string; duration: number } | null>;
  isVoiceAttachment(att: { content_type: string; filename?: string }): boolean;
  formatDuration(seconds: number): string;
}

let _audioAdapter: AudioConvertAdapter | null = null;

/** Register the audio conversion adapter — called by gateway startup. */
export function registerAudioConvertAdapter(adapter: AudioConvertAdapter): void {
  _audioAdapter = adapter;
}

function getAudioAdapter(): AudioConvertAdapter {
  if (!_audioAdapter) {
    throw new Error("AudioConvertAdapter not registered — call registerAudioConvertAdapter first");
  }
  return _audioAdapter;
}

export interface RawAttachment {
  content_type: string;
  url: string;
  filename?: string;
  voice_wav_url?: string;
  asr_refer_text?: string;
}

export type TranscriptSource = "stt" | "asr" | "fallback";

/** Normalized attachment output consumed by the gateway. */
export interface ProcessedAttachments {
  attachmentInfo: string;
  imageUrls: string[];
  imageMediaTypes: string[];
  voiceAttachmentPaths: string[];
  voiceAttachmentUrls: string[];
  voiceAsrReferTexts: string[];
  voiceTranscripts: string[];
  voiceTranscriptSources: TranscriptSource[];
  attachmentLocalPaths: Array<string | null>;
}

interface ProcessContext {
  accountId: string;
  cfg: unknown;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

const EMPTY_RESULT: ProcessedAttachments = {
  attachmentInfo: "",
  imageUrls: [],
  imageMediaTypes: [],
  voiceAttachmentPaths: [],
  voiceAttachmentUrls: [],
  voiceAsrReferTexts: [],
  voiceTranscripts: [],
  voiceTranscriptSources: [],
  attachmentLocalPaths: [],
};

/** Download, convert, transcribe, and classify inbound attachments. */
export async function processAttachments(
  attachments: RawAttachment[] | undefined,
  ctx: ProcessContext,
): Promise<ProcessedAttachments> {
  if (!attachments?.length) {
    return EMPTY_RESULT;
  }

  const { accountId: _accountId, cfg, log } = ctx;
  const downloadDir = getQQBotMediaDir("downloads");

  const imageUrls: string[] = [];
  const imageMediaTypes: string[] = [];
  const voiceAttachmentPaths: string[] = [];
  const voiceAttachmentUrls: string[] = [];
  const voiceAsrReferTexts: string[] = [];
  const voiceTranscripts: string[] = [];
  const voiceTranscriptSources: TranscriptSource[] = [];
  const attachmentLocalPaths: Array<string | null> = [];
  const otherAttachments: string[] = [];

  // Phase 1: download all attachments in parallel.
  const downloadTasks = attachments.map(async (att) => {
    const attUrl = att.url?.startsWith("//") ? `https:${att.url}` : att.url;
    const isVoice = getAudioAdapter().isVoiceAttachment(att);
    const wavUrl =
      isVoice && att.voice_wav_url
        ? att.voice_wav_url.startsWith("//")
          ? `https:${att.voice_wav_url}`
          : att.voice_wav_url
        : "";

    let localPath: string | null = null;
    let audioPath: string | null = null;

    if (isVoice && wavUrl) {
      const wavLocalPath = await downloadFile(wavUrl, downloadDir);
      if (wavLocalPath) {
        localPath = wavLocalPath;
        audioPath = wavLocalPath;
        log?.debug?.(`Voice attachment: ${att.filename}, downloaded WAV directly (skip SILK→WAV)`);
      } else {
        log?.error(`Failed to download voice_wav_url, falling back to original URL`);
      }
    }

    if (!localPath) {
      localPath = await downloadFile(attUrl, downloadDir, att.filename);
    }

    return { att, attUrl, isVoice, localPath, audioPath };
  });

  const downloadResults = await Promise.all(downloadTasks);

  // Phase 2: convert/transcribe voice attachments and classify everything else.
  const processTasks = downloadResults.map(
    async ({ att, attUrl, isVoice, localPath, audioPath }) => {
      const asrReferText = normalizeOptionalString(att.asr_refer_text) ?? "";
      const wavUrl =
        isVoice && att.voice_wav_url
          ? att.voice_wav_url.startsWith("//")
            ? `https:${att.voice_wav_url}`
            : att.voice_wav_url
          : "";
      const voiceSourceUrl = wavUrl || attUrl;

      const meta = {
        voiceUrl: isVoice && voiceSourceUrl ? voiceSourceUrl : undefined,
        asrReferText: isVoice && asrReferText ? asrReferText : undefined,
      };

      if (localPath) {
        if (att.content_type?.startsWith("image/")) {
          log?.debug?.(`Downloaded attachment to: ${localPath}`);
          return { localPath, type: "image" as const, contentType: att.content_type, meta };
        }
        if (isVoice) {
          log?.debug?.(`Downloaded attachment to: ${localPath}`);
          return processVoiceAttachment(
            localPath,
            audioPath,
            att,
            asrReferText,
            cfg,
            downloadDir,
            log,
          );
        }
        log?.debug?.(`Downloaded attachment to: ${localPath}`);
        return { localPath, type: "other" as const, filename: att.filename, meta };
      }
      log?.error(`Failed to download: ${attUrl}`);
      if (att.content_type?.startsWith("image/")) {
        return {
          localPath: null,
          type: "image-fallback" as const,
          attUrl,
          contentType: att.content_type,
          meta,
        };
      }
      if (isVoice && asrReferText) {
        log?.info(`Voice attachment download failed, using asr_refer_text fallback`);
        return {
          localPath: null,
          type: "voice-fallback" as const,
          transcript: asrReferText,
          meta,
        };
      }
      return {
        localPath: null,
        type: "other-fallback" as const,
        filename: att.filename ?? att.content_type,
        meta,
      };
    },
  );

  const processResults = await Promise.all(processTasks);

  // Phase 3: collect results in the original attachment order.
  for (const result of processResults) {
    if (result.meta.voiceUrl) {
      voiceAttachmentUrls.push(result.meta.voiceUrl);
    }
    if (result.meta.asrReferText) {
      voiceAsrReferTexts.push(result.meta.asrReferText);
    }

    if (result.type === "image" && result.localPath) {
      imageUrls.push(result.localPath);
      imageMediaTypes.push(result.contentType);
      attachmentLocalPaths.push(result.localPath);
    } else if (result.type === "voice" && result.localPath) {
      voiceAttachmentPaths.push(result.localPath);
      voiceTranscripts.push(result.transcript);
      voiceTranscriptSources.push(result.transcriptSource);
      attachmentLocalPaths.push(result.localPath);
    } else if (result.type === "other" && result.localPath) {
      otherAttachments.push(`[Attachment: ${result.localPath}]`);
      attachmentLocalPaths.push(result.localPath);
    } else if (result.type === "image-fallback") {
      imageUrls.push(result.attUrl);
      imageMediaTypes.push(result.contentType);
      attachmentLocalPaths.push(null);
    } else if (result.type === "voice-fallback") {
      voiceTranscripts.push(result.transcript);
      voiceTranscriptSources.push("asr");
      attachmentLocalPaths.push(null);
    } else if (result.type === "other-fallback") {
      otherAttachments.push(`[Attachment: ${result.filename}] (download failed)`);
      attachmentLocalPaths.push(null);
    }
  }

  const attachmentInfo = otherAttachments.length > 0 ? "\n" + otherAttachments.join("\n") : "";

  return {
    attachmentInfo,
    imageUrls,
    imageMediaTypes,
    voiceAttachmentPaths,
    voiceAttachmentUrls,
    voiceAsrReferTexts,
    voiceTranscripts,
    voiceTranscriptSources,
    attachmentLocalPaths,
  };
}

// formatVoiceText is now in core/utils/voice-text.ts (re-exported above).

// Internal helpers.

type VoiceResult =
  | {
      localPath: string;
      type: "voice";
      transcript: string;
      transcriptSource: TranscriptSource;
      meta: { voiceUrl?: string; asrReferText?: string };
    }
  | {
      localPath: string;
      type: "voice";
      transcript: string;
      transcriptSource: TranscriptSource;
      meta: { voiceUrl?: string; asrReferText?: string };
    };

async function processVoiceAttachment(
  localPath: string,
  audioPath: string | null,
  att: RawAttachment,
  asrReferText: string,
  cfg: unknown,
  downloadDir: string,
  log: ProcessContext["log"],
): Promise<VoiceResult> {
  const wavUrl = att.voice_wav_url
    ? att.voice_wav_url.startsWith("//")
      ? `https:${att.voice_wav_url}`
      : att.voice_wav_url
    : "";
  const attUrl = att.url?.startsWith("//") ? `https:${att.url}` : att.url;
  const voiceSourceUrl = wavUrl || attUrl;
  const meta = {
    voiceUrl: voiceSourceUrl || undefined,
    asrReferText: asrReferText || undefined,
  };

  const sttCfg = resolveSTTConfig(cfg as Record<string, unknown>);
  if (!sttCfg) {
    if (asrReferText) {
      log?.debug?.(
        `Voice attachment: ${att.filename} (STT not configured, using asr_refer_text fallback)`,
      );
      return { localPath, type: "voice", transcript: asrReferText, transcriptSource: "asr", meta };
    }
    log?.debug?.(`Voice attachment: ${att.filename} (STT not configured, skipping transcription)`);
    return {
      localPath,
      type: "voice",
      transcript: "[Voice message - transcription unavailable because STT is not configured]",
      transcriptSource: "fallback",
      meta,
    };
  }

  // Convert SILK input to WAV before STT when necessary.
  if (!audioPath) {
    log?.debug?.(`Voice attachment: ${att.filename}, converting SILK→WAV...`);
    try {
      const wavResult = await getAudioAdapter().convertSilkToWav(localPath, downloadDir);
      if (wavResult) {
        audioPath = wavResult.wavPath;
        log?.debug?.(
          `Voice converted: ${wavResult.wavPath} (${getAudioAdapter().formatDuration(wavResult.duration)})`,
        );
      } else {
        audioPath = localPath;
      }
    } catch (convertErr) {
      log?.error(
        `Voice conversion failed: ${
          convertErr instanceof Error ? convertErr.message : JSON.stringify(convertErr)
        }`,
      );
      if (asrReferText) {
        return {
          localPath,
          type: "voice",
          transcript: asrReferText,
          transcriptSource: "asr",
          meta,
        };
      }
      return {
        localPath,
        type: "voice",
        transcript: "[Voice message - format conversion failed]",
        transcriptSource: "fallback",
        meta,
      };
    }
  }

  // Run speech-to-text on the prepared audio file.
  try {
    const transcript = await transcribeAudio(audioPath, cfg as Record<string, unknown>);
    if (transcript) {
      log?.debug?.(`STT transcript: ${transcript.slice(0, 100)}...`);
      return { localPath, type: "voice", transcript, transcriptSource: "stt", meta };
    }
    if (asrReferText) {
      log?.debug?.(`STT returned empty result, using asr_refer_text fallback`);
      return { localPath, type: "voice", transcript: asrReferText, transcriptSource: "asr", meta };
    }
    log?.debug?.(`STT returned empty result`);
    return {
      localPath,
      type: "voice",
      transcript: "[Voice message - transcription returned an empty result]",
      transcriptSource: "fallback",
      meta,
    };
  } catch (sttErr) {
    log?.error(`STT failed: ${sttErr instanceof Error ? sttErr.message : JSON.stringify(sttErr)}`);
    if (asrReferText) {
      return { localPath, type: "voice", transcript: asrReferText, transcriptSource: "asr", meta };
    }
    return {
      localPath,
      type: "voice",
      transcript: "[Voice message - transcription failed]",
      transcriptSource: "fallback",
      meta,
    };
  }
}
