// Discord plugin module owns realtime voice activation policy.
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeSupportedRealtimeVoiceActivationName,
  sortRealtimeVoiceActivationNames,
} from "openclaw/plugin-sdk/realtime-voice";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

type DiscordRealtimeVoiceConfig = NonNullable<DiscordAccountConfig["voice"]>["realtime"];

export type DiscordRealtimeWakeNamePolicy = "always" | "automatic" | "never";

export function resolveDiscordRealtimeWakeNamePolicy(params: {
  isAgentProxy: boolean;
  providerId: string;
  requireWakeName: boolean | undefined;
}): DiscordRealtimeWakeNamePolicy {
  if (!params.isAgentProxy || params.providerId !== "openai") {
    return "never";
  }
  if (params.requireWakeName === true) {
    return "always";
  }
  if (params.requireWakeName === false) {
    return "never";
  }
  return "automatic";
}

export function isDiscordRealtimeWakeNameRequired(
  policy: DiscordRealtimeWakeNamePolicy,
  humanParticipantCount: number,
): boolean {
  return policy === "always" || (policy === "automatic" && humanParticipantCount > 1);
}

export function resolveDiscordRealtimeWakeNames(params: {
  config: DiscordRealtimeVoiceConfig;
  cfg: OpenClawConfig;
  agentId: string;
}): string[] {
  const rawConfigured = params.config?.wakeNames;
  if (rawConfigured) {
    const configured = rawConfigured
      .map((name) => normalizeSupportedRealtimeVoiceActivationName(name))
      .filter((name): name is string => Boolean(name));
    return sortRealtimeVoiceActivationNames(uniqueStrings(configured));
  }
  const agent = params.cfg.agents?.list?.find((candidate) => candidate.id === params.agentId);
  const configuredAgentNames = [agent?.name, agent?.identity?.name]
    .map((name) => normalizeSupportedRealtimeVoiceActivationName(name))
    .filter((name): name is string => Boolean(name));
  const productWakeNames = [normalizeSupportedRealtimeVoiceActivationName("OpenClaw")].filter(
    (name): name is string => Boolean(name),
  );
  const defaults =
    configuredAgentNames.length > 0
      ? [...configuredAgentNames, ...productWakeNames]
      : [normalizeSupportedRealtimeVoiceActivationName(params.agentId), ...productWakeNames].filter(
          (name): name is string => Boolean(name),
        );
  return sortRealtimeVoiceActivationNames(uniqueStrings(defaults));
}
