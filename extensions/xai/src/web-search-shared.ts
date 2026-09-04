// Xai plugin module implements web search shared behavior.
import { wrapWebContent } from "openclaw/plugin-sdk/provider-web-search";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { XAI_DEFAULT_MODEL_ID } from "../model-definitions.js";
import { normalizeXaiModelId } from "../model-id.js";
import {
  requestXaiResponsesTool,
  requireXaiResponseTextCitationsAndInline,
  resolveXaiResponsesEndpoint,
} from "./responses-tool-shared.js";
import type { XaiWebSearchResponse } from "./web-search-response.types.js";
export type { XaiWebSearchResponse } from "./web-search-response.types.js";

const XAI_DEFAULT_WEB_SEARCH_MODEL = XAI_DEFAULT_MODEL_ID;
const XAI_WEB_SEARCH_MAX_CONTENT_CHARS = 20_000;

type XaiWebSearchConfig = Record<string, unknown> & {
  baseUrl?: unknown;
  model?: unknown;
  inlineCitations?: unknown;
};

type XaiWebSearchResult = {
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
  truncated?: true;
};

export function buildXaiWebSearchPayload(params: {
  query: string;
  provider: string;
  model: string;
  tookMs: number;
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
  truncated?: boolean;
  source?: "web_search" | "x_search";
}): Record<string, unknown> {
  return {
    query: params.query,
    provider: params.provider,
    model: params.model,
    tookMs: params.tookMs,
    externalContent: {
      untrusted: true,
      source: params.source ?? "web_search",
      provider: params.provider,
      wrapped: true,
    },
    content: wrapWebContent(params.content, "web_search"),
    citations: params.citations,
    ...(params.inlineCitations ? { inlineCitations: params.inlineCitations } : {}),
    ...(params.truncated ? { truncated: true } : {}),
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

function wrapXaiWebSearchError(error: unknown, timeoutSeconds: number): never {
  if (isAbortError(error)) {
    throw Object.assign(
      new Error(
        `xAI web search timed out after ${timeoutSeconds}s. Increase tools.web.search.timeoutSeconds if queries are complex.`,
        { cause: error },
      ),
      { code: "ETIMEDOUT" },
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
  signal?: AbortSignal;
}): Promise<XaiWebSearchResult> {
  params.signal?.throwIfAborted();
  return await requestXaiResponsesTool(
    {
      ...params,
      inputText: params.query,
      tools: [{ type: "web_search" }],
      reasoningEffort: params.model === XAI_DEFAULT_WEB_SEARCH_MODEL ? "low" : undefined,
      errorLabel: "xAI web search failed",
    },
    (data) =>
      requireXaiResponseTextCitationsAndInline(
        data,
        "xAI web search failed",
        params.inlineCitations,
        XAI_WEB_SEARCH_MAX_CONTENT_CHARS,
      ),
  ).catch((error: unknown) => {
    if (params.signal?.aborted && error === params.signal.reason) {
      throw error;
    }
    return wrapXaiWebSearchError(error, params.timeoutSeconds);
  });
}
