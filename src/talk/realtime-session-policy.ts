import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { asBoolean } from "../utils/boolean.js";
import {
  normalizeSupportedRealtimeVoiceActivationName,
  sortRealtimeVoiceActivationNames,
} from "./activation-name.js";
import {
  resolveRealtimeVoiceAgentConsultToolPolicy,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceAgentConsultToolPolicy,
} from "./agent-consult-tool.js";

export type RealtimeVoiceWakeNamePolicy = "always" | "automatic" | "never";

export type RealtimeVoiceSessionPolicy = {
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  consultToolsAllow: string[] | undefined;
  consultPolicy: "auto" | "always";
  wakeNamePolicy: RealtimeVoiceWakeNamePolicy;
  wakeNames: string[];
  autoRespondToAudio: boolean;
};

/** Resolve generic consult, activation-name, and auto-response session policy. */
export function resolveRealtimeVoiceSessionPolicy(params: {
  isAgentProxy: boolean;
  supportsActivationNameGating: boolean;
  configuredToolPolicy: unknown;
  configuredConsultPolicy: "auto" | "always" | undefined;
  requireWakeName: boolean | undefined;
  configuredWakeNames: string[] | undefined;
  cfg: OpenClawConfig;
  agentId: string;
}): RealtimeVoiceSessionPolicy {
  const toolPolicy = resolveRealtimeVoiceAgentConsultToolPolicy(
    params.configuredToolPolicy,
    params.isAgentProxy ? "owner" : "safe-read-only",
  );
  const consultPolicy = params.configuredConsultPolicy ?? (params.isAgentProxy ? "always" : "auto");
  const wakeNamePolicy = resolveRealtimeVoiceWakeNamePolicy(params);
  const wakeNames =
    wakeNamePolicy === "never"
      ? []
      : resolveRealtimeVoiceWakeNames({
          configuredWakeNames: params.configuredWakeNames,
          cfg: params.cfg,
          agentId: params.agentId,
        });

  return {
    toolPolicy,
    consultToolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(toolPolicy),
    consultPolicy,
    wakeNamePolicy,
    wakeNames,
    autoRespondToAudio:
      wakeNamePolicy === "never" && (!params.isAgentProxy || consultPolicy !== "always"),
  };
}

export function isRealtimeVoiceWakeNameRequired(
  policy: RealtimeVoiceWakeNamePolicy,
  humanParticipantCount: number,
): boolean {
  return policy === "always" || (policy === "automatic" && humanParticipantCount > 1);
}

export function resolveRealtimeVoiceInterruptResponseOnInputAudio(value: unknown): boolean {
  return asBoolean(value) ?? true;
}

export function resolveRealtimeVoiceBargeIn(params: {
  configuredBargeIn: boolean | undefined;
  interruptResponseOnInputAudio: unknown;
}): boolean {
  if (typeof params.configuredBargeIn === "boolean") {
    return params.configuredBargeIn;
  }
  return resolveRealtimeVoiceInterruptResponseOnInputAudio(params.interruptResponseOnInputAudio);
}

export function resolveRealtimeVoiceMinBargeInAudioEndMs(configured: number | undefined): number {
  return typeof configured === "number" ? configured : 250;
}

function resolveRealtimeVoiceWakeNamePolicy(params: {
  isAgentProxy: boolean;
  supportsActivationNameGating: boolean;
  requireWakeName: boolean | undefined;
}): RealtimeVoiceWakeNamePolicy {
  if (!params.isAgentProxy || !params.supportsActivationNameGating) {
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

function resolveRealtimeVoiceWakeNames(params: {
  configuredWakeNames: string[] | undefined;
  cfg: OpenClawConfig;
  agentId: string;
}): string[] {
  if (params.configuredWakeNames !== undefined) {
    const configured = params.configuredWakeNames
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
