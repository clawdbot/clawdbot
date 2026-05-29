import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { VoiceCallTtsConfig } from "./config.js";

function resolveProviderVoiceSetting(providerConfig: unknown): string | undefined {
  if (!providerConfig || typeof providerConfig !== "object") {
    return undefined;
  }
  const candidate = providerConfig as {
    speakerVoice?: unknown;
    speakerVoiceId?: unknown;
    voice?: unknown;
    voiceId?: unknown;
  };
  return (
    normalizeOptionalString(candidate.speakerVoice) ??
    normalizeOptionalString(candidate.speakerVoiceId) ??
    normalizeOptionalString(candidate.voice) ??
    normalizeOptionalString(candidate.voiceId)
  );
}

export function resolvePreferredTtsVoice(config: { tts?: VoiceCallTtsConfig }): string | undefined {
  const providerId = config.tts?.provider;
  if (!providerId) {
    return undefined;
  }
  return resolveProviderVoiceSetting(config.tts?.providers?.[providerId]);
}
