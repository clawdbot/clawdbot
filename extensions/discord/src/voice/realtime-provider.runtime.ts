import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import * as realtimeVoice from "openclaw/plugin-sdk/realtime-voice";
import type { RealtimeVoiceProviderConfig } from "openclaw/plugin-sdk/realtime-voice";

export type DiscordRealtimeVoiceConfig = NonNullable<DiscordAccountConfig["voice"]>["realtime"];

export function buildProviderConfigs(
  realtimeConfig: DiscordRealtimeVoiceConfig,
): Record<string, RealtimeVoiceProviderConfig | undefined> | undefined {
  const configs = realtimeConfig?.providers;
  return configs && Object.keys(configs).length > 0 ? { ...configs } : undefined;
}

export function buildProviderConfigOverrides(
  realtimeConfig: DiscordRealtimeVoiceConfig,
): RealtimeVoiceProviderConfig | undefined {
  const overrides = {
    ...(realtimeConfig?.model ? { model: realtimeConfig.model } : {}),
    ...(realtimeConfig?.speakerVoice
      ? { voice: realtimeConfig.speakerVoice }
      : realtimeConfig?.speakerVoiceId
        ? { voice: realtimeConfig.speakerVoiceId }
        : {}),
    ...(typeof realtimeConfig?.minBargeInAudioEndMs === "number"
      ? { minBargeInAudioEndMs: realtimeConfig.minBargeInAudioEndMs }
      : {}),
  };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function acquireConfiguredRealtimeVoiceProvider(
  ...args: Parameters<typeof realtimeVoice.acquireConfiguredRealtimeVoiceProvider>
): ReturnType<typeof realtimeVoice.acquireConfiguredRealtimeVoiceProvider> {
  if (typeof realtimeVoice.acquireConfiguredRealtimeVoiceProvider === "function") {
    return realtimeVoice.acquireConfiguredRealtimeVoiceProvider(...args);
  }
  // Discord's published host range includes the older host-owned callback API.
  return {
    ...realtimeVoice.resolveConfiguredRealtimeVoiceProvider(...args),
    release() {},
    run: (operation) => operation(),
  };
}
