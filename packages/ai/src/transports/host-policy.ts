import type { Api, Context, Model } from "@openclaw/llm-core";
import { getAiTransportHost, type AiProviderRequestPolicyInput } from "../host.js";

export function buildGuardedModelFetch(
  model: Model,
  timeoutMs?: number,
  options?: { sanitizeSse?: boolean },
): typeof fetch {
  const host = getAiTransportHost();
  if (options !== undefined) {
    return host.buildModelFetch(model, timeoutMs, options) ?? globalThis.fetch;
  }
  if (timeoutMs !== undefined) {
    return host.buildModelFetch(model, timeoutMs) ?? globalThis.fetch;
  }
  return host.buildModelFetch(model) ?? globalThis.fetch;
}

export function resolveProviderEndpoint(baseUrl?: string): { endpointClass: string } {
  return { endpointClass: getAiTransportHost().resolveProviderEndpointClass(baseUrl) };
}

export function resolveProviderRequestCapabilities(input: AiProviderRequestPolicyInput) {
  return getAiTransportHost().resolveProviderRequestCapabilities(input);
}

export function resolveProviderRequestPolicyConfig(input: {
  provider?: string;
  api?: string;
  baseUrl?: string;
  capability?: string;
  transport?: string;
  providerHeaders?: Record<string, string>;
  callerHeaders?: Record<string, string>;
  precedence?: "caller-wins" | "defaults-win";
}): { headers?: Record<string, string> } {
  return { headers: getAiTransportHost().resolveProviderRequestHeaders(input) };
}

export function resolveModelRequestTimeoutMs(model: Model, timeoutMs?: number): number | undefined {
  return timeoutMs ?? getAiTransportHost().resolveModelRequestTimeoutMs(model);
}

export function resolveOpenAIStrictToolSetting(
  model: Pick<Model, "provider" | "api" | "baseUrl" | "id"> & { compat?: unknown },
  options?: { transport?: "stream" | "websocket"; supportsStrictMode?: boolean },
): boolean | undefined {
  return getAiTransportHost().resolveOpenAIStrictToolSetting(model, options);
}

export function transformTransportMessages(
  messages: Context["messages"],
  model: Model,
  normalizeToolCallId?: (
    id: string,
    targetModel: Model,
    source: { provider: string; api: Api; model: string },
  ) => string,
  options?: {
    normalizeSameModelToolCallIds?: boolean;
    preserveCrossModelToolCallThoughtSignature?: boolean;
  },
): Context["messages"] {
  return getAiTransportHost().transformTransportMessages(
    messages,
    model,
    normalizeToolCallId,
    options,
  );
}
