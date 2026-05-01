import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import type { ActiveMediaModel } from "./active-model.types.js";
import { isAudioAttachment } from "./attachments.js";
import { runAudioTranscription } from "./audio-transcription-runner.js";
import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";
import { normalizeMediaAttachments, resolveMediaAttachmentLocalRoots } from "./runner.js";
import type { MediaUnderstandingProvider } from "./types.js";

/**
 * Transcribes the first audio attachment BEFORE mention checking.
 * This allows voice notes to be processed in group chats with requireMention: true.
 * Returns the transcript or undefined if transcription fails or no audio is found.
 */
export async function transcribeFirstAudio(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
}): Promise<string | undefined> {
  const { ctx, cfg } = params;

  // Check if audio transcription is enabled in config
  const audioConfig = cfg.tools?.media?.audio;
  if (audioConfig?.enabled === false) {
    return undefined;
  }

  const attachments = normalizeMediaAttachments(ctx);
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  // Find first audio attachment
  const firstAudio = attachments.find(
    (att) => att && isAudioAttachment(att) && !att.alreadyTranscribed,
  );

  if (!firstAudio) {
    return undefined;
  }

  if (shouldLogVerbose()) {
    logVerbose(`audio-preflight: transcribing attachment ${firstAudio.index} for mention check`);
  }

  try {
    const { transcript } = await runAudioTranscription({
      ctx,
      cfg,
      attachments,
      agentDir: params.agentDir,
      providers: params.providers,
      activeModel: params.activeModel,
      localPathRoots: resolveMediaAttachmentLocalRoots({ cfg, ctx }),
    });
    if (!transcript) {
      return undefined;
    }

    if (audioConfig?.echoTranscript) {
      await sendTranscriptEcho({
        ctx,
        cfg,
        transcript,
        format: audioConfig.echoFormat ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT,
      });
    }

    // Mark this attachment as transcribed to avoid double-processing
    firstAudio.alreadyTranscribed = true;

    if (shouldLogVerbose()) {
      logVerbose(
        `audio-preflight: transcribed ${transcript.length} chars from attachment ${firstAudio.index}`,
      );
    }

    return transcript;
  } catch (err) {
    // Log but don't throw - let the message proceed with text-only mention check
    if (shouldLogVerbose()) {
      logVerbose(`audio-preflight: transcription failed: ${String(err)}`);
    }
    return undefined;
  }
}
