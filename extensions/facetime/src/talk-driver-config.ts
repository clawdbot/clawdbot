import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildRealtimeVoiceAgentConsultPolicyInstructions,
  getRealtimeVoiceProvider,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONSULT_SENDER_AUTH_VERSION,
  resolveConfiguredRealtimeVoiceProvider,
  type RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import type { FaceTimeConfig } from "./config.js";

export const CONSULT_SYSTEM_PROMPT = [
  "You are the configured OpenClaw agent receiving a delegated request from an authenticated owner in a private 1:1 FaceTime call.",
  "The authenticated caller is the configured owner/user described by this agent's workspace context, including USER.md. When asked who is speaking, identify them from that workspace context without asking them to reconfirm.",
  "Use the normal workspace, memory, tools, and approval policies for this agent.",
  "Prefer registered OpenClaw tools over exec.",
  "Never claim completion unless the relevant tool result confirms it.",
  "Return a concise, speakable answer suitable for realtime TTS.",
].join(" ");
export const INPUT_AUDIO_STATUS_INTERVAL_MS = 1_000;
export const REALTIME_READY_TIMEOUT_MS = 15_000;
export const MAX_TRANSCRIPT_ENTRY_CHARS = 2_000;
export const MAX_TRANSCRIPT_CHARS = 12_000;
export const AGENT_CONSULT_MESSAGE_PROVIDER = "voice";
export const FACETIME_END_CALL_TOOL_NAME = "facetime_end_call";
export const FACETIME_END_CALL_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: FACETIME_END_CALL_TOOL_NAME,
  description:
    "Immediately end the current FaceTime call when the caller clearly asks to hang up, end, leave, or disconnect this call. Do not use this to cancel background work.",
  parameters: {
    type: "object",
    properties: {},
  },
};

export function assertAuthenticatedSenderConsultSupport(): void {
  if (REALTIME_VOICE_AGENT_CONSULT_SENDER_AUTH_VERSION !== 1) {
    throw new Error(
      "OpenClaw host does not support authenticated sender identity for realtime agent consults; update OpenClaw before enabling FaceTime",
    );
  }
}

export function agentIdFromSessionKey(sessionKey: string, config: OpenClawConfig): string {
  return resolveAgentIdFromSessionKey(sessionKey, resolveDefaultAgentId(config));
}

export function buildRealtimeInstructions(params: {
  instructions: string | undefined;
  bootstrapContext: string | undefined;
  toolPolicy: FaceTimeConfig["realtime"]["toolPolicy"];
}): string {
  const callControlInstructions = [
    "Call control:",
    `- When the caller asks you to hang up, end, leave, or disconnect the current FaceTime call, call ${FACETIME_END_CALL_TOOL_NAME} immediately.`,
    `- Never delegate a current-call hangup request to ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME}, ask for confirmation, or say that you will check.`,
  ].join("\n");
  const proxyInstructions =
    params.toolPolicy === "none"
      ? undefined
      : [
          "Mode: OpenClaw agent proxy.",
          "You are the realtime voice surface for the same configured OpenClaw agent the owner can message directly.",
          "The FaceTime caller is the authenticated owner/user described by the loaded workspace profile context. Recognize them from that context without asking them to reconfirm.",
          "Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
          `Delegate substantive requests, actions, tool work, current facts, memory, workspace context, identity, persona, and user-specific context with ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME}.`,
          "Do not block, refuse, or downscope at the voice layer. Delegate to OpenClaw and treat its result as authoritative.",
          'While waiting for a tool result, use at most one short natural backchannel such as "one sec"; do not repeat progress updates or treat it as the final answer.',
          "Never claim you retried or are retrying unless a new tool result explicitly confirms a new attempt.",
          buildRealtimeVoiceAgentConsultPolicyInstructions({
            toolPolicy: params.toolPolicy,
            consultPolicy: "always",
          }),
        ]
          .filter(Boolean)
          .join("\n");
  return [
    params.instructions?.trim(),
    params.bootstrapContext?.trim(),
    callControlInstructions,
    proxyInstructions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function resolveFaceTimeRealtimeProvider(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
  agentId: string;
}) {
  const configuredProviderId = params.config.realtime.provider;
  const sourceProviders = params.config.realtime.providers;
  const selectedProviderIds = configuredProviderId
    ? new Set([
        configuredProviderId,
        getRealtimeVoiceProvider(configuredProviderId, params.fullConfig)?.id,
      ])
    : undefined;
  const selectedEntries = configuredProviderId
    ? Object.entries(sourceProviders).filter(([providerId]) => selectedProviderIds?.has(providerId))
    : Object.entries(sourceProviders);
  const providers = Object.fromEntries(
    await Promise.all(
      selectedEntries.map(async ([providerId, providerConfig]) => {
        const resolved = await resolveConfiguredSecretInputString({
          config: params.fullConfig,
          env: process.env,
          value: providerConfig.apiKey,
          path: `plugins.entries.facetime.config.realtime.providers.${providerId}.apiKey`,
        });
        if (resolved.value) {
          return [providerId, { ...providerConfig, apiKey: resolved.value }] as const;
        }
        if (resolved.unresolvedRefReason) {
          if (configuredProviderId) {
            throw new Error(resolved.unresolvedRefReason);
          }
          const { apiKey: _unresolvedApiKey, ...remainingConfig } = providerConfig;
          return [providerId, remainingConfig] as const;
        }
        return [providerId, { ...providerConfig }] as const;
      }),
    ),
  );
  return resolveConfiguredRealtimeVoiceProvider({
    configuredProviderId,
    providerConfigs: providers,
    providerConfigOverrides: params.config.realtime.voice
      ? { voice: params.config.realtime.voice }
      : undefined,
    cfg: params.fullConfig,
    agentId: params.agentId,
    defaultModel: params.config.realtime.model,
    surface: "bridge",
    noRegisteredProviderMessage: "No realtime voice provider registered",
  });
}
