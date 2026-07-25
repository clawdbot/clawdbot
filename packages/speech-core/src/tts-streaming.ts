import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { TtsDirectiveOverrides } from "openclaw/plugin-sdk/speech-core";
import { assertSpeechRuntimeAvailable } from "./runtime-availability.js";
import { executeTtsProviderAttempts, resolveTtsRequestSetup } from "./tts-synthesis-support.js";
import { resolveTtsSynthesisTarget } from "./tts-synthesis.js";
import type { TtsStreamResult, TtsSynthesisStreamResult } from "./tts-types.js";

export async function streamSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
}): Promise<TtsSynthesisStreamResult> {
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
    synthesisText: params.text,
    providerOverrides: params.overrides?.providerOverrides,
    timeoutMs: params.timeoutMs,
    target,
    logLabel: "TTS stream",
    selectOperation: ({ provider, resolvedProvider }) => {
      if (!resolvedProvider.provider.streamSynthesize) {
        return {
          kind: "skip",
          reasonCode: "unsupported_for_streaming",
          message: `${provider} does not support streaming TTS`,
        };
      }
      return {
        kind: "ready",
        synthesize: ({ prepared, cfg: runtimeCfg, target: synthesisTarget, timeoutMs }) =>
          resolvedProvider.provider.streamSynthesize!({
            text: prepared.text,
            cfg: runtimeCfg,
            providerConfig: prepared.providerConfig,
            target: synthesisTarget,
            providerOverrides: prepared.providerOverrides,
            timeoutMs,
          }),
      };
    },
    buildSuccess: ({ synthesis, ...metadata }) => ({
      success: true,
      ...metadata,
      audioStream: synthesis.audioStream,
      outputFormat: synthesis.outputFormat,
      voiceCompatible: synthesis.voiceCompatible,
      fileExtension: synthesis.fileExtension,
      target,
      release: synthesis.release,
    }),
  });
}

export async function textToSpeechStream(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
}): Promise<TtsStreamResult> {
  const synthesis = await streamSpeech(params);
  if (!synthesis.success || !synthesis.audioStream || !synthesis.fileExtension) {
    return {
      success: false,
      error: synthesis.error ?? "Streaming TTS conversion failed",
      persona: synthesis.persona,
      attemptedProviders: synthesis.attemptedProviders,
      attempts: synthesis.attempts,
    };
  }
  return synthesis;
}
