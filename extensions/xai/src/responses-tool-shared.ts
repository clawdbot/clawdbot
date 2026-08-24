// Xai plugin module implements responses tool shared behavior.
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import { postTrustedWebToolsJson } from "openclaw/plugin-sdk/provider-web-search";
import { truncateSanitizedExternalContent } from "openclaw/plugin-sdk/security-runtime";
import {
  isRecord,
  normalizeOptionalString as trimString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { XaiWebSearchResponse } from "./web-search-response.types.js";

const XAI_CITATION_MAX_COUNT = 20;
const XAI_CITATION_MAX_SCAN = 1_000;
const XAI_CITATION_URL_MAX_CHARS = 2_048;

function normalizeXaiCitationUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > XAI_CITATION_URL_MAX_CHARS) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.href.length > XAI_CITATION_URL_MAX_CHARS
    ) {
      return undefined;
    }
    return url.href === `${value}/` ? value : url.href;
  } catch {
    return undefined;
  }
}

function collectUrlCitations(annotations: unknown, citations: Set<string>): void {
  if (!Array.isArray(annotations)) {
    return;
  }
  let scanned = 0;
  for (const annotation of annotations) {
    if (++scanned > XAI_CITATION_MAX_SCAN || citations.size >= XAI_CITATION_MAX_COUNT) {
      break;
    }
    if (!isRecord(annotation) || annotation.type !== "url_citation") {
      continue;
    }
    const url = normalizeXaiCitationUrl(annotation.url);
    if (url) {
      citations.add(url);
    }
  }
}

const XAI_RESPONSES_BASE_URL = "https://api.x.ai/v1";
export const XAI_RESPONSES_ENDPOINT = `${XAI_RESPONSES_BASE_URL}/responses`;

export function resolveXaiResponsesEndpoint(baseUrl?: unknown): string {
  return `${(trimString(baseUrl) ?? XAI_RESPONSES_BASE_URL).replace(/\/+$/, "")}/responses`;
}

function buildXaiResponsesToolBody(params: {
  model: string;
  inputText: string;
  tools: Array<Record<string, unknown>>;
  maxTurns?: number;
  reasoningEffort?: "none" | "low" | "medium" | "high";
}): Record<string, unknown> {
  return {
    model: params.model,
    input: [{ role: "user", content: params.inputText }],
    tools: params.tools,
    store: false,
    ...(params.reasoningEffort ? { reasoning: { effort: params.reasoningEffort } } : {}),
    ...(params.maxTurns ? { max_turns: params.maxTurns } : {}),
  };
}

export async function requestXaiResponsesTool<T>(
  params: Parameters<typeof buildXaiResponsesToolBody>[0] & {
    apiKey: string;
    endpoint: string;
    timeoutSeconds: number;
    errorLabel: string;
    signal?: AbortSignal;
  },
  parseResponse: (data: XaiWebSearchResponse) => T,
): Promise<T> {
  return await postTrustedWebToolsJson(
    {
      url: params.endpoint,
      timeoutSeconds: params.timeoutSeconds,
      apiKey: params.apiKey,
      ...(params.signal ? { signal: params.signal } : {}),
      body: buildXaiResponsesToolBody(params),
      errorLabel: "xAI",
    },
    async (response) =>
      parseResponse(await readProviderJsonObjectResponse(response, params.errorLabel)),
  );
}

export function extractXaiWebSearchContent(
  data: XaiWebSearchResponse,
  maxContentChars?: number,
): {
  text: string | undefined;
  annotationCitations: string[];
  truncated?: true;
  retainedRawChars?: number;
  inlineCitationOffsetsSafe?: false;
} {
  const textParts: string[] = [];
  const annotationCitations = new Set<string>();
  const pendingAnnotations: Array<{ rawOffset: number; annotations: unknown }> = [];
  let remainingRawChars = maxContentChars;
  let completeRawPrefix = true;
  let truncated = false;
  let rawOffset = 0;
  for (const output of data.output ?? []) {
    if (!isRecord(output)) {
      continue;
    }
    const blocks =
      output.type === "message" && Array.isArray(output.content)
        ? output.content
        : output.type === "output_text"
          ? [output]
          : [];
    for (const block of blocks) {
      if (!isRecord(block) || block.type !== "output_text" || typeof block.text !== "string") {
        continue;
      }
      if (block.text) {
        const blockRawOffset = rawOffset;
        rawOffset += block.text.length;
        const text =
          remainingRawChars === undefined
            ? block.text
            : completeRawPrefix
              ? truncateUtf16Safe(block.text, remainingRawChars)
              : "";
        if (text.length < block.text.length) {
          truncated = true;
          completeRawPrefix = false;
        }
        if (text) {
          textParts.push(text);
          if (remainingRawChars !== undefined) {
            remainingRawChars -= text.length;
          }
          if (Array.isArray(block.annotations)) {
            pendingAnnotations.push({ rawOffset: blockRawOffset, annotations: block.annotations });
          }
        }
      }
    }
  }

  // Match the Responses SDK: adjacent output text blocks have no separator.
  const rawText =
    textParts.join("") || (typeof data.output_text === "string" ? data.output_text : "");
  let text = rawText;
  let retainedRawChars = rawText.length;
  if (maxContentChars !== undefined) {
    const bounded = truncateSanitizedExternalContent(rawText, maxContentChars);
    text = bounded.text;
    truncated ||= bounded.truncated;
    retainedRawChars = bounded.retainedRawChars;
  }
  for (const annotation of pendingAnnotations) {
    if (annotation.rawOffset < retainedRawChars) {
      collectUrlCitations(annotation.annotations, annotationCitations);
    }
  }
  const inlineCitationOffsetsSafe = text === rawText.slice(0, retainedRawChars);
  return {
    text: text || undefined,
    annotationCitations: [...annotationCitations],
    ...(truncated ? { truncated: true } : {}),
    ...(maxContentChars === undefined ? {} : { retainedRawChars }),
    ...(inlineCitationOffsetsSafe ? {} : { inlineCitationOffsetsSafe: false as const }),
  };
}

export function requireXaiResponseTextAndCitations(
  data: XaiWebSearchResponse,
  label: string,
  maxContentChars?: number,
): {
  content: string;
  citations: string[];
  truncated?: true;
  retainedRawChars?: number;
  inlineCitationOffsetsSafe?: false;
} {
  const { text, annotationCitations, truncated, retainedRawChars, inlineCitationOffsetsSafe } =
    extractXaiWebSearchContent(data, maxContentChars);
  if (!text) {
    throw new Error(`${label}: malformed JSON response`);
  }
  const explicitCitations = new Set<string>();
  if (Array.isArray(data.citations)) {
    let scanned = 0;
    for (const citation of data.citations) {
      if (++scanned > XAI_CITATION_MAX_SCAN || explicitCitations.size >= XAI_CITATION_MAX_COUNT) {
        break;
      }
      const url = normalizeXaiCitationUrl(citation);
      if (url) {
        explicitCitations.add(url);
      }
    }
  }
  return {
    content: text,
    citations: explicitCitations.size > 0 ? [...explicitCitations] : annotationCitations,
    ...(truncated ? { truncated: true } : {}),
    ...(retainedRawChars === undefined ? {} : { retainedRawChars }),
    ...(inlineCitationOffsetsSafe === false ? { inlineCitationOffsetsSafe: false as const } : {}),
  };
}

export function requireXaiResponseTextCitationsAndInline(
  data: XaiWebSearchResponse,
  label: string,
  inlineCitationsEnabled: boolean,
  maxContentChars?: number,
): {
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
  truncated?: true;
} {
  const { content, citations, truncated, retainedRawChars, inlineCitationOffsetsSafe } =
    requireXaiResponseTextAndCitations(data, label, maxContentChars);
  const inlineCitations =
    inlineCitationsEnabled && Array.isArray(data.inline_citations)
      ? data.inline_citations.slice(0, XAI_CITATION_MAX_COUNT).flatMap((citation) => {
          if (!isRecord(citation)) {
            return [];
          }
          const url = normalizeXaiCitationUrl(citation.url);
          return inlineCitationOffsetsSafe !== false &&
            url &&
            Number.isSafeInteger(citation.start_index) &&
            Number.isSafeInteger(citation.end_index) &&
            citation.start_index >= 0 &&
            citation.end_index >= citation.start_index &&
            citation.end_index <= (retainedRawChars ?? content.length)
            ? [{ start_index: citation.start_index, end_index: citation.end_index, url }]
            : [];
        })
      : undefined;
  return {
    content,
    citations,
    inlineCitations,
    ...(truncated ? { truncated: true } : {}),
  };
}
