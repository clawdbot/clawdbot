import { postTrustedWebToolsJson, wrapWebContent } from "openclaw/plugin-sdk/provider-web-search";
import {
  buildXaiResponsesToolBody,
  resolveXaiResponseTextCitationsAndInline,
  resolveXaiResponsesEndpoint,
} from "./responses-tool-shared.js";
import {
  coerceXaiToolConfig,
  resolveNormalizedXaiToolModel,
  resolvePositiveIntegerToolConfig,
} from "./tool-config-shared.js";
import { type XaiWebSearchResponse } from "./web-search-shared.js";

export const XAI_DEFAULT_X_SEARCH_MODEL = "grok-4-1-fast-non-reasoning";

type XaiXSearchConfig = {
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  inlineCitations?: unknown;
  maxTurns?: unknown;
};

export type XaiXSearchOptions = {
  query: string;
  allowedXHandles?: string[];
  excludedXHandles?: string[];
  fromDate?: string;
  toDate?: string;
  enableImageUnderstanding?: boolean;
  enableVideoUnderstanding?: boolean;
};

type XaiXSearchResult = {
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
};

function resolveXaiXSearchConfig(config?: Record<string, unknown>): XaiXSearchConfig {
  return coerceXaiToolConfig(config) as XaiXSearchConfig;
}

export function resolveXaiXSearchModel(config?: Record<string, unknown>): string {
  return resolveNormalizedXaiToolModel({
    config,
    defaultModel: XAI_DEFAULT_X_SEARCH_MODEL,
  });
}

export function resolveXaiXSearchEndpoint(config?: Record<string, unknown>): string {
  return resolveXaiResponsesEndpoint(resolveXaiXSearchConfig(config).baseUrl);
}

export function resolveXaiXSearchInlineCitations(config?: Record<string, unknown>): boolean {
  return resolveXaiXSearchConfig(config).inlineCitations === true;
}

export function resolveXaiXSearchMaxTurns(config?: Record<string, unknown>): number | undefined {
  return resolvePositiveIntegerToolConfig(config, "maxTurns");
}

function buildXSearchTool(options: XaiXSearchOptions): Record<string, unknown> {
  return {
    type: "x_search",
    ...(options.allowedXHandles?.length ? { allowed_x_handles: options.allowedXHandles } : {}),
    ...(options.excludedXHandles?.length ? { excluded_x_handles: options.excludedXHandles } : {}),
    ...(options.fromDate ? { from_date: options.fromDate } : {}),
    ...(options.toDate ? { to_date: options.toDate } : {}),
    ...(options.enableImageUnderstanding ? { enable_image_understanding: true } : {}),
    ...(options.enableVideoUnderstanding ? { enable_video_understanding: true } : {}),
  };
}

export function buildXaiXSearchPayload(params: {
  query: string;
  model: string;
  tookMs: number;
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
  options?: XaiXSearchOptions;
}): Record<string, unknown> {
  return {
    query: params.query,
    provider: "xai",
    model: params.model,
    tookMs: params.tookMs,
    externalContent: {
      untrusted: true,
      source: "x_search",
      provider: "xai",
      wrapped: true,
    },
    content: wrapWebContent(params.content, "web_search"),
    citations: params.citations,
    ...(params.inlineCitations ? { inlineCitations: params.inlineCitations } : {}),
    ...(params.options?.allowedXHandles?.length
      ? { allowedXHandles: params.options.allowedXHandles }
      : {}),
    ...(params.options?.excludedXHandles?.length
      ? { excludedXHandles: params.options.excludedXHandles }
      : {}),
    ...(params.options?.fromDate ? { fromDate: params.options.fromDate } : {}),
    ...(params.options?.toDate ? { toDate: params.options.toDate } : {}),
    ...(params.options?.enableImageUnderstanding ? { enableImageUnderstanding: true } : {}),
    ...(params.options?.enableVideoUnderstanding ? { enableVideoUnderstanding: true } : {}),
  };
}

export async function requestXaiXSearch(params: {
  apiKey: string;
  endpoint: string;
  model: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
  maxTurns?: number;
  options: XaiXSearchOptions;
}): Promise<XaiXSearchResult> {
  return await postTrustedWebToolsJson(
    {
      url: params.endpoint,
      timeoutSeconds: params.timeoutSeconds,
      apiKey: params.apiKey,
      body: buildXaiResponsesToolBody({
        model: params.model,
        inputText: params.options.query,
        tools: [buildXSearchTool(params.options)],
        maxTurns: params.maxTurns,
      }),
      errorLabel: "xAI",
    },
    async (response) => {
      const data = (await response.json()) as XaiWebSearchResponse;
      return resolveXaiResponseTextCitationsAndInline(data, params.inlineCitations);
    },
  );
}
