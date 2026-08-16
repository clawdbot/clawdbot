/**
 * Runtime SDK subpath for media understanding, image description, and audio transcription.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { sendTranscriptEcho } from "../media-understanding/echo-transcript.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

type TranscribeFirstAudio =
  typeof import("../media-understanding/audio-preflight.js").transcribeFirstAudio;
type SendTranscriptEcho = typeof sendTranscriptEcho;

const DEFAULT_ECHO_TRANSCRIPT_FORMAT = '📝 "{transcript}"';
const loadAudioPreflightRuntime = createLazyRuntimeModule(
  () => import("../media-understanding/audio-preflight.js"),
);

/** Creates shared preflight transcription and deferred-echo behavior for a channel. */
export function createChannelPreflightAudio<TAudio>(params: {
  channel: string;
  isAudio: (value: TAudio) => boolean;
  deferTranscriptEcho?: boolean;
  transcribeFirstAudio?: TranscribeFirstAudio;
  sendTranscriptEcho?: SendTranscriptEcho;
}) {
  const deferTranscriptEcho = params.deferTranscriptEcho ?? true;

  const suppress = (cfg: OpenClawConfig): OpenClawConfig => {
    if (!deferTranscriptEcho) {
      return cfg;
    }
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
  };

  const format = (transcript: string, formatTemplate: string): string => {
    // Function replacement preserves literal `$` sequences in provider output.
    return formatTemplate.replace("{transcript}", () => transcript);
  };

  return {
    isAudio: params.isAudio,
    suppress,
    format,

    async resolve(resolveParams: {
      request: Parameters<TranscribeFirstAudio>[0];
      abortSignal?: AbortSignal;
    }): Promise<string | undefined> {
      if (resolveParams.abortSignal?.aborted) {
        return undefined;
      }
      try {
        const transcribeFirstAudio =
          params.transcribeFirstAudio ?? (await loadAudioPreflightRuntime()).transcribeFirstAudio;
        if (resolveParams.abortSignal?.aborted) {
          return undefined;
        }
        const transcript = await transcribeFirstAudio({
          ...resolveParams.request,
          cfg: suppress(resolveParams.request.cfg),
        });
        return resolveParams.abortSignal?.aborted ? undefined : transcript;
      } catch (err) {
        logVerbose(`${params.channel}: audio preflight transcription failed: ${String(err)}`);
        return undefined;
      }
    },

    async send(sendParams: {
      transcript: string;
      cfg: OpenClawConfig;
      accountId: string;
      originatingTo: string;
      messageThreadId?: string;
      /** Platform-native inbound message id for optional echo reply threading. */
      messageId?: string;
      /** Channel chat type for replyToModeByChatType / adapter policy (e.g. direct|group|channel). */
      chatType?: string;
      /**
       * Optional already-resolved reply policy from inbound prepare (e.g. Slack matched-room
       * ReplyToMode). When set, echo delivery honors it over account/chat-type resolution.
       */
      replyToMode?: "off" | "first" | "all" | "batched";
    }): Promise<void> {
      const audio = sendParams.cfg.tools?.media?.audio;
      if (!audio?.echoTranscript) {
        return;
      }
      const messageId = typeof sendParams.messageId === "string" ? sendParams.messageId.trim() : "";
      const chatType = typeof sendParams.chatType === "string" ? sendParams.chatType.trim() : "";
      const replyToMode = sendParams.replyToMode;
      await (params.sendTranscriptEcho ?? sendTranscriptEcho)({
        ctx: {
          Provider: params.channel,
          Surface: params.channel,
          OriginatingChannel: params.channel,
          OriginatingTo: sendParams.originatingTo,
          AccountId: sendParams.accountId,
          MessageThreadId: sendParams.messageThreadId,
          ...(chatType ? { ChatType: chatType } : {}),
          ...(replyToMode === "off" ||
          replyToMode === "first" ||
          replyToMode === "all" ||
          replyToMode === "batched"
            ? { ReplyToMode: replyToMode }
            : {}),
          ...(messageId
            ? {
                MessageSid: messageId,
                MessageSidFirst: messageId,
                MessageSidFull: `${params.channel}:${messageId}`,
              }
            : {}),
        },
        cfg: sendParams.cfg,
        transcript: sendParams.transcript,
        format: audio.echoFormat ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT,
        logSuccess: false,
        failureLogPrefix: `${params.channel}: audio transcript echo failed`,
        reply: audio.echoReply === true,
      });
    },
  };
}

export {
  describeImageFile,
  describeImageFileWithModel,
  describeVideoFile,
  extractStructuredWithModel,
  runMediaUnderstandingFile,
  transcribeAudioFile,
  type ExtractStructuredWithModelParams,
  type RunMediaUnderstandingFileParams,
  type RunMediaUnderstandingFileResult,
} from "../media-understanding/runtime.js";
