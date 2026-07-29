// Discord plugin module implements tts behavior.
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig, TtsConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getDiscordRuntime } from "../runtime.js";
import { sanitizeVoiceReplyTextForSpeech } from "./sanitize.js";

type VoiceReplyAudioResult =
  | {
      status: "ok";
      mode: "file";
      audioPath: string;
      speakText: string;
    }
  | {
      status: "ok";
      mode: "stream";
      audioStream: ReadableStream<Uint8Array>;
      release?: () => Promise<void>;
      speakText: string;
    }
  | {
      status: "empty";
    }
  | {
      status: "failed";
      error?: string;
    };

export async function transcribeVoiceAudio(params: {
  cfg: OpenClawConfig;
  agentId: string;
  filePath: string;
}): Promise<string | undefined> {
  const result = await getDiscordRuntime().mediaUnderstanding.transcribeAudioFile({
    filePath: params.filePath,
    cfg: params.cfg,
    agentDir: resolveAgentDir(params.cfg, params.agentId),
    mime: "audio/wav",
  });
  return normalizeOptionalString(result.text);
}

export async function synthesizeVoiceReplyAudio(params: {
  cfg: OpenClawConfig;
  override?: TtsConfig;
  replyText: string;
  speakerLabel: string;
}): Promise<VoiceReplyAudioResult> {
  const runtime = getDiscordRuntime();
  const prepared = await runtime.tts.prepareTtsRequest({
    cfg: params.cfg,
    override: params.override,
    text: params.replyText,
  });
  const directive = prepared.directives;
  const rawSpeakText = directive.overrides.ttsText ?? directive.cleanedText.trim();
  const speakText = sanitizeVoiceReplyTextForSpeech(rawSpeakText, params.speakerLabel);
  if (!speakText) {
    return { status: "empty" };
  }
  const streamResult = await runtime.tts.textToSpeechStream?.({
    text: speakText,
    cfg: prepared.cfg,
    channel: "discord",
    overrides: directive.overrides,
    disableFallback: true,
  });
  if (streamResult?.success && streamResult.audioStream) {
    return {
      status: "ok",
      mode: "stream",
      audioStream: streamResult.audioStream,
      release: streamResult.release,
      speakText,
    };
  }

  const result = await runtime.tts.textToSpeech({
    text: speakText,
    cfg: prepared.cfg,
    channel: "discord",
    overrides: directive.overrides,
  });
  if (!result.success || !result.audioPath) {
    return { status: "failed", error: result.error ?? "unknown error" };
  }
  return { status: "ok", mode: "file", audioPath: result.audioPath, speakText };
}
