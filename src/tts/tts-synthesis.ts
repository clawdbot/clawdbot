import { resolveChannelTtsVoiceDelivery } from "../channels/plugins/tts-capabilities.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose } from "../globals.js";
import { transcodeAudioBuffer } from "../media/media-services.js";
import type { TtsDirectiveOverrides } from "./provider-types.js";
import { assertSpeechRuntimeAvailable } from "./runtime-availability.js";
import { normalizeSpeechText } from "./speech-text.js";
import type { TtsResult, TtsSynthesisResult } from "./tts-runtime-types.js";
import {
  executeTtsProviderAttempts,
  resolveTtsRequestSetup,
  sanitizeTtsErrorForLog,
} from "./tts-synthesis-support.js";

export type TtsAudioPersistence = (params: {
  audioBuffer: Buffer;
  cfg: OpenClawConfig;
  fileExtension: string;
  outputFormat?: string;
}) => Promise<string>;

export function supportsNativeVoiceNoteTts(channel: string | undefined): boolean {
  return resolveChannelTtsVoiceDelivery(channel) !== undefined;
}

export function supportsTranscodedVoiceNoteTts(channel: string | undefined): boolean {
  const delivery = resolveChannelTtsVoiceDelivery(channel);
  return delivery?.synthesisTarget === "voice-note" && delivery.transcodesAudio === true;
}

export function resolveTtsSynthesisTarget(
  channel: string | undefined,
): "audio-file" | "voice-note" {
  return resolveChannelTtsVoiceDelivery(channel)?.synthesisTarget ?? "audio-file";
}

function supportsAudioFileVoiceMemoOutput(params: {
  fileExtension?: string;
  outputFormat?: string;
  audioFileFormats?: readonly string[];
}): boolean {
  const formats = new Set(params.audioFileFormats?.map((format) => format.trim().toLowerCase()));
  if (formats.size === 0) {
    return false;
  }
  const extension = params.fileExtension?.trim().toLowerCase();
  if (extension && formats.has(extension.replace(/^\./, ""))) {
    return true;
  }
  const outputFormat = params.outputFormat?.trim().toLowerCase();
  return outputFormat ? formats.has(outputFormat) : false;
}

export function shouldDeliverTtsAsVoice(params: {
  channel: string | undefined;
  target: "audio-file" | "voice-note" | undefined;
  voiceCompatible: boolean | undefined;
  fileExtension?: string;
  outputFormat?: string;
}): boolean {
  const delivery = resolveChannelTtsVoiceDelivery(params.channel);
  if (!delivery) {
    return false;
  }
  if (delivery.synthesisTarget === "audio-file") {
    return (
      params.target === "audio-file" &&
      supportsAudioFileVoiceMemoOutput({
        fileExtension: params.fileExtension,
        outputFormat: params.outputFormat,
        audioFileFormats: delivery.audioFileFormats,
      })
    );
  }
  if (params.target !== "voice-note") {
    return false;
  }
  return params.voiceCompatible === true || delivery.transcodesAudio === true;
}

export async function textToSpeechCore(
  params: {
    text: string;
    cfg: OpenClawConfig;
    prefsPath?: string;
    channel?: string;
    overrides?: TtsDirectiveOverrides;
    disableFallback?: boolean;
    timeoutMs?: number;
    agentId?: string;
    accountId?: string;
  },
  persistTtsAudio: TtsAudioPersistence,
): Promise<TtsResult> {
  const synthesis = await synthesizeSpeech(params);
  if (!synthesis.success || !synthesis.audioBuffer || !synthesis.fileExtension) {
    return {
      success: false,
      error: synthesis.error ?? "TTS conversion failed",
      persona: synthesis.persona,
      attemptedProviders: synthesis.attemptedProviders,
      attempts: synthesis.attempts,
    };
  }

  let audioBuffer = synthesis.audioBuffer;
  let fileExtension = synthesis.fileExtension;
  let outputFormat = synthesis.outputFormat;
  const transcoded = await maybePreTranscodeForVoiceDelivery({
    channel: params.channel,
    target: synthesis.target,
    audioBuffer,
    fileExtension,
    outputFormat,
  });
  if (transcoded) {
    audioBuffer = transcoded.audioBuffer;
    fileExtension = transcoded.fileExtension;
    outputFormat = transcoded.outputFormat;
  }

  let audioPath: string;
  try {
    audioPath = await persistTtsAudio({
      audioBuffer,
      cfg: params.cfg,
      fileExtension,
      outputFormat,
    });
  } catch (err) {
    logVerbose(`TTS: audio persistence failed: ${sanitizeTtsErrorForLog(err)}`);
    return {
      success: false,
      error: "TTS audio persistence failed",
      latencyMs: synthesis.latencyMs,
      provider: synthesis.provider,
      persona: synthesis.persona,
      fallbackFrom: synthesis.fallbackFrom,
      attemptedProviders: synthesis.attemptedProviders,
      attempts: synthesis.attempts,
    };
  }

  return {
    success: true,
    audioPath,
    latencyMs: synthesis.latencyMs,
    provider: synthesis.provider,
    persona: synthesis.persona,
    fallbackFrom: synthesis.fallbackFrom,
    attemptedProviders: synthesis.attemptedProviders,
    attempts: synthesis.attempts,
    outputFormat,
    voiceCompatible: synthesis.voiceCompatible,
    audioAsVoice: shouldDeliverTtsAsVoice({
      channel: params.channel,
      target: synthesis.target,
      voiceCompatible: synthesis.voiceCompatible,
      fileExtension,
      outputFormat,
    }),
    target: synthesis.target,
  };
}

async function maybePreTranscodeForVoiceDelivery(params: {
  channel: string | undefined;
  target: "audio-file" | "voice-note" | undefined;
  audioBuffer: Buffer;
  fileExtension: string;
  outputFormat?: string;
}): Promise<{ audioBuffer: Buffer; fileExtension: string; outputFormat?: string } | undefined> {
  if (params.target !== "audio-file") {
    return undefined;
  }
  const delivery = resolveChannelTtsVoiceDelivery(params.channel);
  const preferred = delivery?.preferAudioFileFormat?.trim().toLowerCase();
  if (!preferred) {
    return undefined;
  }
  const sourceExt = params.fileExtension.trim().toLowerCase().replace(/^\./, "");
  if (sourceExt === preferred) {
    return undefined;
  }
  const outcome = await transcodeAudioBuffer({
    audioBuffer: params.audioBuffer,
    sourceExtension: sourceExt,
    targetExtension: preferred,
  });
  if (!outcome.ok) {
    if (outcome.reason === "transcoder-failed") {
      // Surface only the case where the host actually attempted the transcode
      // and it broke. The other reasons are by-design skips and would just be log noise.
      logVerbose(
        `TTS: pre-transcode ${sourceExt}->${preferred} for channel=${params.channel ?? "?"} failed: ${outcome.detail ?? "unknown"}`,
      );
    }
    return undefined;
  }
  return {
    audioBuffer: outcome.buffer,
    fileExtension: `.${preferred}`,
    outputFormat: preferred,
  };
}

export async function synthesizeSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
}): Promise<TtsSynthesisResult> {
  assertSpeechRuntimeAvailable();
  const setup = resolveTtsRequestSetup({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    providerOverride: params.overrides?.provider,
    disableFallback: params.disableFallback,
    agentId: params.agentId,
    channelId: params.channel,
    accountId: params.accountId,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  const { cfg, config, persona, providers } = setup;
  const target = resolveTtsSynthesisTarget(params.channel);
  return await executeTtsProviderAttempts({
    cfg,
    config,
    persona,
    providers,
    synthesisText: normalizeSpeechText(params.text),
    providerOverrides: params.overrides?.providerOverrides,
    timeoutMs: params.timeoutMs,
    target,
    logLabel: "TTS",
    selectOperation: ({ resolvedProvider }) => ({
      kind: "ready",
      synthesize: ({ prepared, cfg: runtimeCfg, target: synthesisTarget, timeoutMs }) =>
        resolvedProvider.provider.synthesize({
          text: prepared.text,
          cfg: runtimeCfg,
          providerConfig: prepared.providerConfig,
          target: synthesisTarget,
          providerOverrides: prepared.providerOverrides,
          timeoutMs,
        }),
    }),
    buildSuccess: ({ synthesis, ...metadata }) => ({
      success: true,
      ...metadata,
      audioBuffer: synthesis.audioBuffer,
      outputFormat: synthesis.outputFormat,
      voiceCompatible: synthesis.voiceCompatible,
      fileExtension: synthesis.fileExtension,
      target,
    }),
  });
}
