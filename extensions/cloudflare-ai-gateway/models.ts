import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const CLOUDFLARE_AI_GATEWAY_PROVIDER_ID = "cloudflare-ai-gateway";
export const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID = "claude-sonnet-4-6";
export const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF = `${CLOUDFLARE_AI_GATEWAY_PROVIDER_ID}/${CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID}`;

const CLOUDFLARE_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW = 200_000;
const CLOUDFLARE_AI_GATEWAY_DEFAULT_MAX_TOKENS = 64_000;
const CLOUDFLARE_AI_GATEWAY_DEFAULT_COST = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
};

export function buildCloudflareAiGatewayModelDefinition(params?: {
  id?: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
}): ModelDefinitionConfig {
  const id = params?.id?.trim() || CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID;
  return {
    id,
    name: params?.name ?? "Claude Sonnet 4.6",
    reasoning: params?.reasoning ?? true,
    input: params?.input ?? ["text", "image"],
    cost: CLOUDFLARE_AI_GATEWAY_DEFAULT_COST,
    contextWindow: CLOUDFLARE_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW,
    maxTokens: CLOUDFLARE_AI_GATEWAY_DEFAULT_MAX_TOKENS,
  };
}

export function resolveCloudflareAiGatewayBaseUrl(params: {
  accountId: string;
  gatewayId: string;
}): string {
  const accountId = params.accountId.trim();
  const gatewayId = params.gatewayId.trim();
  if (!accountId || !gatewayId) {
    return "";
  }
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`;
}
