// Xiaomi plugin module implements thinking behavior.
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import { XIAOMI_PROVIDER_ID, XIAOMI_TOKEN_PLAN_PROVIDER_ID } from "./provider-catalog.js";

const MIMO_REASONING_MODEL_IDS = new Set([
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-pro",
]);

export function isMiMoReasoningModelId(modelId: string): boolean {
  return MIMO_REASONING_MODEL_IDS.has(modelId.toLowerCase());
}

export function isMiMoProviderId(providerId: unknown): boolean {
  return providerId === XIAOMI_PROVIDER_ID || providerId === XIAOMI_TOKEN_PLAN_PROVIDER_ID;
}

export function isMiMoReasoningModelRef(model: { provider?: string; id?: unknown }): boolean {
  return (
    isMiMoProviderId(model.provider) &&
    typeof model.id === "string" &&
    isMiMoReasoningModelId(model.id)
  );
}

const MIMO_THINKING_LEVEL_IDS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const MIMO_THINKING_PROFILE = {
  levels: MIMO_THINKING_LEVEL_IDS.map((id) => ({ id })),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

export function resolveMiMoThinkingProfile(modelId: string): ProviderThinkingProfile | undefined {
  return isMiMoReasoningModelId(modelId) ? MIMO_THINKING_PROFILE : undefined;
}
