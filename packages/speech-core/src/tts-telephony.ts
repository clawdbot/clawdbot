import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { TtsDirectiveOverrides } from "openclaw/plugin-sdk/speech-core";
import { assertSpeechRuntimeAvailable } from "./runtime-availability.js";
import { executeTtsProviderAttempts, resolveTtsRequestSetup } from "./tts-synthesis-support.js";
import type { TtsTelephonyResult } from "./tts-types.js";

export async function textToSpeechTelephony(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  overrides?: TtsDirectiveOverrides;
  timeoutMs?: number;
}): Promise<TtsTelephonyResult> {
  assertSpeechRuntimeAvailable();
  const setup = resolveTtsRequestSetup({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    providerOverride: params.overrides?.provider,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  const { cfg, config, persona, providers } = setup;
  return await executeTtsProviderAttempts({
    cfg,
    config,
    persona,
    providers,
    synthesisText: params.text,
    providerOverrides: params.overrides?.providerOverrides,
    timeoutMs: params.timeoutMs,
    target: "telephony",
    logLabel: "TTS telephony",
    requireTelephony: true,
    selectOperation: ({ resolvedProvider }) => {
      const synthesizeTelephony = resolvedProvider.provider.synthesizeTelephony as NonNullable<
        typeof resolvedProvider.provider.synthesizeTelephony
      >;
      return {
        kind: "ready",
        synthesize: ({ prepared, cfg: runtimeCfg, timeoutMs }) =>
          synthesizeTelephony({
            text: prepared.text,
            cfg: runtimeCfg,
            providerConfig: prepared.providerConfig,
            providerOverrides: prepared.providerOverrides,
            timeoutMs,
          }),
      };
    },
    buildSuccess: ({ synthesis, ...metadata }) => ({
      success: true,
      ...metadata,
      audioBuffer: synthesis.audioBuffer,
      outputFormat: synthesis.outputFormat,
      sampleRate: synthesis.sampleRate,
    }),
  });
}
