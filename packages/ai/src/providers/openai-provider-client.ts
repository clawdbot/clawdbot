import OpenAI from "openai";
import { getAiTransportHost } from "../host.js";
import { resolveOpenAIClientBaseUrl } from "../transports/openai-transport-shared.js";
import type { Model } from "../types.js";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.js";

export function createOpenAIProviderClient(
  model: Model<"openai-completions" | "openai-responses">,
  apiKey: string,
  headers: Record<string, string>,
  optionsHeaders?: Record<string, string>,
): OpenAI {
  // Merge options headers last so they can override defaults
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }

  const defaultHeaders =
    model.provider === "cloudflare-ai-gateway"
      ? {
          ...headers,
          Authorization: headers.Authorization ?? null,
          "cf-aig-authorization": `Bearer ${apiKey}`,
        }
      : headers;

  const baseUrl = isCloudflareProvider(model.provider)
    ? resolveCloudflareBaseUrl(model)
    : model.baseUrl;
  return new OpenAI({
    apiKey,
    baseURL: resolveOpenAIClientBaseUrl(model, baseUrl),
    dangerouslyAllowBrowser: true,
    defaultHeaders,
    maxRetries: 0,
    // OpenAI supports custom fetch, so sentinels stay opaque until guarded egress.
    fetch: getAiTransportHost().buildModelFetch(model),
  });
}
