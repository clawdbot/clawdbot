// OpenAI model route membership shared by catalog and policy surfaces.

export const OPENAI_CHAT_LATEST_MODEL_ID = "chat-latest";
export const OPENAI_GPT_56_MODEL_ID = "gpt-5.6";
export const OPENAI_GPT_56_SOL_MODEL_ID = "gpt-5.6-sol";
export const OPENAI_GPT_56_TERRA_MODEL_ID = "gpt-5.6-terra";
export const OPENAI_GPT_56_LUNA_MODEL_ID = "gpt-5.6-luna";
export const OPENAI_GPT_55_MODEL_ID = "gpt-5.5";
export const OPENAI_GPT_55_PRO_MODEL_ID = "gpt-5.5-pro";
export const OPENAI_GPT_54_MODEL_ID = "gpt-5.4";
export const OPENAI_GPT_54_LEGACY_MODEL_ID = "gpt-5.4-codex";
export const OPENAI_GPT_54_PRO_MODEL_ID = "gpt-5.4-pro";
export const OPENAI_GPT_54_MINI_MODEL_ID = "gpt-5.4-mini";
export const OPENAI_GPT_54_NANO_MODEL_ID = "gpt-5.4-nano";
export const OPENAI_GPT_53_CODEX_SPARK_MODEL_ID = "gpt-5.3-codex-spark";

export const OPENAI_GPT_56_VARIANT_MODEL_IDS = [
  OPENAI_GPT_56_SOL_MODEL_ID,
  OPENAI_GPT_56_TERRA_MODEL_ID,
  OPENAI_GPT_56_LUNA_MODEL_ID,
] as const;

/** Models with known first-party Platform and ChatGPT transports. */
export const OPENAI_DUAL_ROUTE_MODEL_IDS = [
  ...OPENAI_GPT_56_VARIANT_MODEL_IDS,
  OPENAI_GPT_55_MODEL_ID,
  OPENAI_GPT_55_PRO_MODEL_ID,
  OPENAI_GPT_54_MODEL_ID,
  OPENAI_GPT_54_PRO_MODEL_ID,
  OPENAI_GPT_54_MINI_MODEL_ID,
] as const;

/** Direct aliases excluded from the ChatGPT catalog. */
export const OPENAI_PLATFORM_ONLY_ROUTE_MODEL_IDS = [
  OPENAI_CHAT_LATEST_MODEL_ID,
  OPENAI_GPT_56_MODEL_ID,
] as const;

export const OPENAI_SUBSCRIPTION_ONLY_ROUTE_MODEL_IDS = [
  OPENAI_GPT_53_CODEX_SPARK_MODEL_ID,
] as const;

/** Modern model refs recognized by the unified OpenAI provider surface. */
export const OPENAI_PROVIDER_MODERN_MODEL_IDS = [
  ...OPENAI_PLATFORM_ONLY_ROUTE_MODEL_IDS,
  ...OPENAI_DUAL_ROUTE_MODEL_IDS,
  OPENAI_GPT_54_NANO_MODEL_ID,
  ...OPENAI_SUBSCRIPTION_ONLY_ROUTE_MODEL_IDS,
] as const;

export const OPENAI_CHATGPT_MODERN_MODEL_IDS = [
  ...OPENAI_DUAL_ROUTE_MODEL_IDS,
  ...OPENAI_SUBSCRIPTION_ONLY_ROUTE_MODEL_IDS,
] as const;

const openAIDualRouteModelIds = new Set<string>(OPENAI_DUAL_ROUTE_MODEL_IDS);
const openAIPlatformOnlyRouteModelIds = new Set<string>(OPENAI_PLATFORM_ONLY_ROUTE_MODEL_IDS);
const openAISubscriptionOnlyRouteModelIds = new Set<string>(
  OPENAI_SUBSCRIPTION_ONLY_ROUTE_MODEL_IDS,
);

export function normalizeOpenAIModelRouteId(value: string | undefined): string {
  const modelId = value?.trim() ?? "";
  // OpenAI-compatible model ids are case-sensitive. Collapse only the shipped
  // legacy alias; configured custom ids must retain their authored identity.
  const normalized = modelId.toLowerCase();
  return normalized === OPENAI_GPT_54_LEGACY_MODEL_ID ||
    normalized === `openai/${OPENAI_GPT_54_LEGACY_MODEL_ID}`
    ? OPENAI_GPT_54_MODEL_ID
    : modelId;
}

function normalizeOpenAIRouteMembershipId(value: string | undefined): string {
  // Static first-party membership is case-insensitive without changing catalog keys.
  return normalizeOpenAIModelRouteId(value).toLowerCase();
}

export function isOpenAIDualRouteModelId(value: string | undefined): boolean {
  return openAIDualRouteModelIds.has(normalizeOpenAIRouteMembershipId(value));
}

export function isOpenAIPlatformOnlyRouteModelId(value: string | undefined): boolean {
  return openAIPlatformOnlyRouteModelIds.has(normalizeOpenAIRouteMembershipId(value));
}

export function isOpenAISubscriptionOnlyRouteModelId(value: string | undefined): boolean {
  return openAISubscriptionOnlyRouteModelIds.has(normalizeOpenAIRouteMembershipId(value));
}
