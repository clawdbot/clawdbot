import { postTrustedWebToolsJson, wrapWebContent } from "openclaw/plugin-sdk/provider-web-search";
import { normalizeXaiModelId } from "../model-id.js";
import {
  buildXaiResponsesToolBody,
  extractXaiWebSearchContent,
  resolveXaiResponseTextCitationsAndInline,
  XAI_RESPONSES_ENDPOINT,
} from "./responses-tool-shared.js";
import { isRecord } from "./tool-config-shared.js";
import type { XaiWebSearchResponse } from "./web-search-response.types.js";
export { extractXaiWebSearchContent } from "./responses-tool-shared.js";
export type { XaiWebSearchResponse } from "./web-search-response.types.js";

export const XAI_WEB_SEARCH_ENDPOINT = XAI_RESPONSES_ENDPOINT;
export const XAI_DEFAULT_WEB_SEARCH_MODEL = "grok-4-1-fast";

type XaiWebSearchConfig = Record<string, unknown> & {
  model?: unknown;
  inlineCitations?: unknown;
};

export type XaiWebSearchResult = {
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
};

export function buildXaiWebSearchPayload(params: {
  query: string;
  provider: string;
  model: string;
  tookMs: number;
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
}): Record<string, unknown> {
  return {
    query: params.query,
    provider: params.provider,
    model: params.model,
    tookMs: params.tookMs,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: params.provider,
      wrapped: true,
    },
    content: wrapWebContent(params.content, "web_search"),
    citations: params.citations,
    ...(params.inlineCitations ? { inlineCitations: params.inlineCitations } : {}),
  };
}

export function resolveXaiSearchConfig(searchConfig?: Record<string, unknown>): XaiWebSearchConfig {
  return (
    (isRecord(searchConfig?.grok) ? (searchConfig.grok as XaiWebSearchConfig) : undefined) ?? {}
  );
}

export function resolveXaiWebSearchModel(searchConfig?: Record<string, unknown>): string {
  const config = resolveXaiSearchConfig(searchConfig);
  return typeof config.model === "string" && config.model.trim()
    ? normalizeXaiModelId(config.model.trim())
    : XAI_DEFAULT_WEB_SEARCH_MODEL;
}

export function resolveXaiInlineCitations(searchConfig?: Record<string, unknown>): boolean {
  return resolveXaiSearchConfig(searchConfig).inlineCitations === true;
}

export async function requestXaiWebSearch(params: {
  query: string;
  model: string;
  apiKey: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
}): Promise<XaiWebSearchResult> {
  return await postTrustedWebToolsJson(
    {
      url: XAI_WEB_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      apiKey: params.apiKey,
      body: buildXaiResponsesToolBody({
        model: params.model,
        inputText: params.query,
        tools: [{ type: "web_search" }],
      }),
      errorLabel: "xAI",
    },
    async (response) => {
      const data = (await response.json()) as XaiWebSearchResponse;
      return resolveXaiResponseTextCitationsAndInline(data, params.inlineCitations);
    },
  );
}

export const __testing = {
  buildXaiWebSearchPayload,
  extractXaiWebSearchContent,
  resolveXaiInlineCitations,
  resolveXaiSearchConfig,
  resolveXaiWebSearchModel,
  requestXaiWebSearch,
  XAI_DEFAULT_WEB_SEARCH_MODEL,
} as const;
