import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
import { normalizeProviderId } from "./model-selection.js";

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_RESPONSES_API = "openai-chatgpt-responses";

function directOpenAIPlatformModelRequiresApiKey(params: {
  provider: string;
  modelApi?: string;
}): boolean {
  return (
    normalizeProviderId(params.provider) === OPENAI_PROVIDER_ID &&
    params.modelApi !== undefined &&
    normalizeLowercaseStringOrEmpty(params.modelApi) !== OPENAI_CODEX_RESPONSES_API
  );
}

function openAICodexTransportRequiresOAuth(params: {
  provider: string;
  modelApi?: string;
}): boolean {
  return (
    normalizeProviderId(params.provider) === OPENAI_PROVIDER_ID &&
    normalizeLowercaseStringOrEmpty(params.modelApi ?? "") === OPENAI_CODEX_RESPONSES_API
  );
}

export function isAuthModeAllowedForModel(params: {
  provider: string;
  modelApi?: string;
  mode: ResolvedProviderAuth["mode"];
}): boolean {
  if (openAICodexTransportRequiresOAuth(params)) {
    // Subscription-class credentials are oauth profiles and ChatGPT tokens;
    // api-key must fail closed here or the codex backend 401s at request time.
    return params.mode === "oauth" || params.mode === "token";
  }
  return !directOpenAIPlatformModelRequiresApiKey(params) || params.mode === "api-key";
}

export function assertAuthModeAllowedForModel(params: {
  provider: string;
  modelApi?: string;
  profileId: string;
  mode: ResolvedProviderAuth["mode"];
}): void {
  if (isAuthModeAllowedForModel(params)) {
    return;
  }
  if (openAICodexTransportRequiresOAuth(params)) {
    throw new Error(
      `Auth profile "${params.profileId}" uses ${params.mode} auth, but ${params.provider}/${params.modelApi} requires a ChatGPT subscription (OAuth or token) profile.`,
    );
  }
  throw new Error(
    `Auth profile "${params.profileId}" uses ${params.mode} auth, but ${params.provider}/${params.modelApi} requires an OpenAI API key profile.`,
  );
}
