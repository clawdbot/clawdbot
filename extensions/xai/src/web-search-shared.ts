import { postTrustedWebToolsJson, wrapWebContent } from "openclaw/plugin-sdk/provider-web-search";
import { normalizeXaiModelId } from "../model-id.js";
import {
  buildXaiResponsesToolBody,
  resolveXaiResponseTextCitationsAndInline,
  resolveXaiResponsesEndpoint,
} from "./responses-tool-shared.js";
import { isRecord } from "./tool-config-shared.js";
import type { XaiWebSearchResponse } from "./web-search-response.types.js";
export { extractXaiWebSearchContent } from "./responses-tool-shared.js";
export type { XaiWebSearchResponse } from "./web-search-response.types.js";

const XAI_DEFAULT_WEB_SEARCH_MODEL = "grok-4-1-fast";

type XaiWebSearchConfig = Record<string, unknown> & {
  baseUrl?: unknown;
  model?: unknown;
  inlineCitations?: unknown;
};

type XaiWebSearchResult = {
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

function resolveXaiSearchConfig(searchConfig?: Record<string, unknown>): XaiWebSearchConfig {
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

export function resolveXaiWebSearchEndpoint(searchConfig?: Record<string, unknown>): string {
  return resolveXaiResponsesEndpoint(resolveXaiSearchConfig(searchConfig).baseUrl);
}

export function resolveXaiInlineCitations(searchConfig?: Record<string, unknown>): boolean {
  return resolveXaiSearchConfig(searchConfig).inlineCitations === true;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "This operation was aborted")
  );
}

export function wrapXaiWebSearchError(error: unknown, timeoutSeconds: number): never {
  if (isAbortError(error)) {
    throw new Error(
      `xAI web search timed out after ${timeoutSeconds}s. Increase tools.web.search.timeoutSeconds if queries are complex.`,
      { cause: error },
    );
  }
  throw error;
}

export async function requestXaiWebSearch(params: {
  query: string;
  model: string;
  apiKey: string;
  endpoint: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
}): Promise<XaiWebSearchResult> {
  return await postTrustedWebToolsJson(
    {
      url: params.endpoint,
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
  ).catch((error: unknown) => wrapXaiWebSearchError(error, params.timeoutSeconds));
}
