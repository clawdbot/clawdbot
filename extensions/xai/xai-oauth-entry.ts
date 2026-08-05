import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";

const PROVIDER_ID = "xai";
const XAI_OAUTH_METHOD_ID = "oauth";
const XAI_OAUTH_CHOICE_ID = "xai-oauth";
const XAI_DEVICE_CODE_METHOD_ID = "device-code";
const XAI_DEVICE_CODE_CHOICE_ID = "xai-device-code";

const loadXaiOAuthRuntime = createLazyRuntimeModule(() => import("./xai-oauth.js"));

export function createXaiOAuthAuthMethod(): ProviderAuthMethod {
  return {
    id: XAI_OAUTH_METHOD_ID,
    label: "xAI OAuth",
    hint: "Remote-friendly browser sign-in without a localhost callback",
    kind: "oauth",
    wizard: {
      choiceId: XAI_OAUTH_CHOICE_ID,
      choiceLabel: "xAI OAuth",
      choiceHint: "Remote-friendly browser sign-in without a localhost callback",
      groupId: PROVIDER_ID,
      groupLabel: "xAI (Grok)",
      groupHint: "API key or OAuth",
      methodId: XAI_OAUTH_METHOD_ID,
    },
    run: async (ctx) => (await loadXaiOAuthRuntime()).loginXaiDeviceCode(ctx),
  };
}

export function createXaiDeviceCodeAuthMethod(): ProviderAuthMethod {
  return {
    id: XAI_DEVICE_CODE_METHOD_ID,
    label: "xAI device code",
    hint: "Deprecated alias for xAI OAuth device-code login",
    kind: "device_code",
    wizard: {
      choiceId: XAI_DEVICE_CODE_CHOICE_ID,
      choiceLabel: "xAI device code",
      choiceHint: "Compatibility alias for xAI OAuth device-code sign-in",
      assistantVisibility: "manual-only",
      groupId: PROVIDER_ID,
      groupLabel: "xAI (Grok)",
      groupHint: "API key or OAuth",
      methodId: XAI_DEVICE_CODE_METHOD_ID,
    },
    run: async (ctx) => (await loadXaiOAuthRuntime()).loginXaiDeviceCode(ctx),
  };
}

export async function refreshXaiOAuthCredential(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  return await (await loadXaiOAuthRuntime()).refreshXaiOAuthCredential(credential);
}
