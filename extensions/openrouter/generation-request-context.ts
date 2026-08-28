import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";

type OpenRouterAuthStore = Parameters<typeof resolveApiKeyForProvider>[0]["store"];

export async function resolveOpenRouterGenerationRequestContext(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: OpenRouterAuthStore;
  capability: "audio" | "image" | "video";
  jsonContentType: boolean;
}) {
  const auth = await resolveApiKeyForProvider({
    provider: "openrouter",
    cfg: params.cfg,
    agentDir: params.agentDir,
    store: params.authStore,
  });
  if (!auth.apiKey) {
    throw new Error("OpenRouter API key missing");
  }

  return resolveProviderHttpRequestConfig({
    baseUrl: params.cfg.models?.providers?.openrouter?.baseUrl,
    defaultBaseUrl: OPENROUTER_BASE_URL,
    allowPrivateNetwork: false,
    defaultHeaders: {
      Authorization: `Bearer ${auth.apiKey}`,
      ...(params.jsonContentType ? { "Content-Type": "application/json" } : {}),
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": "OpenClaw",
    },
    request: sanitizeConfiguredModelProviderRequest(
      params.cfg.models?.providers?.openrouter?.request,
    ),
    provider: "openrouter",
    capability: params.capability,
    transport: "http",
  });
}
