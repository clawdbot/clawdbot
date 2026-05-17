import type { XaiWebSearchResponse } from "./web-search-response.types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function extractUrlCitations(annotations: unknown): string[] {
  if (!Array.isArray(annotations)) {
    return [];
  }
  return annotations
    .filter(
      (annotation) =>
        isRecord(annotation) &&
        annotation.type === "url_citation" &&
        typeof annotation.url === "string",
    )
    .map((annotation) => annotation.url as string);
}

const XAI_RESPONSES_BASE_URL = "https://api.x.ai/v1";
export const XAI_RESPONSES_ENDPOINT = `${XAI_RESPONSES_BASE_URL}/responses`;

function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveXaiResponsesEndpoint(baseUrl?: unknown): string {
  return `${(trimString(baseUrl) ?? XAI_RESPONSES_BASE_URL).replace(/\/+$/, "")}/responses`;
}

export function buildXaiResponsesToolBody(params: {
  model: string;
  inputText: string;
  tools: Array<Record<string, unknown>>;
  maxTurns?: number;
}): Record<string, unknown> {
  return {
    model: params.model,
    input: [{ role: "user", content: params.inputText }],
    tools: params.tools,
    ...(params.maxTurns ? { max_turns: params.maxTurns } : {}),
  };
}

export function extractXaiWebSearchContent(data: XaiWebSearchResponse): {
  text: string | undefined;
  annotationCitations: string[];
} {
  for (const output of data.output ?? []) {
    if (!isRecord(output)) {
      continue;
    }
    if (output.type === "message") {
      const content = Array.isArray(output.content) ? output.content : [];
      for (const block of content) {
        if (!isRecord(block)) {
          continue;
        }
        if (block.type === "output_text" && typeof block.text === "string" && block.text) {
          const urls = extractUrlCitations(block.annotations);
          return { text: block.text, annotationCitations: [...new Set(urls)] };
        }
      }
    }

    if (output.type === "output_text" && typeof output.text === "string" && output.text) {
      const urls = extractUrlCitations(output.annotations);
      return { text: output.text, annotationCitations: [...new Set(urls)] };
    }
  }

  return {
    text: typeof data.output_text === "string" ? data.output_text : undefined,
    annotationCitations: [],
  };
}

export function resolveXaiResponseTextAndCitations(data: XaiWebSearchResponse): {
  content: string;
  citations: string[];
} {
  const { text, annotationCitations } = extractXaiWebSearchContent(data);
  return {
    content: text ?? "No response",
    citations:
      Array.isArray(data.citations) && data.citations.length > 0
        ? data.citations
        : annotationCitations,
  };
}

export function requireXaiResponseTextAndCitations(
  data: XaiWebSearchResponse,
  label: string,
): {
  content: string;
  citations: string[];
} {
  const { text, annotationCitations } = extractXaiWebSearchContent(data);
  if (!text) {
    throw new Error(`${label}: malformed JSON response`);
  }
  return {
    content: text,
    citations:
      Array.isArray(data.citations) && data.citations.length > 0
        ? data.citations
        : annotationCitations,
  };
}

export function resolveXaiResponseTextCitationsAndInline(
  data: XaiWebSearchResponse,
  inlineCitationsEnabled: boolean,
): {
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
} {
  const { content, citations } = resolveXaiResponseTextAndCitations(data);
  return {
    content,
    citations,
    inlineCitations:
      inlineCitationsEnabled && Array.isArray(data.inline_citations)
        ? data.inline_citations
        : undefined,
  };
}

export function requireXaiResponseTextCitationsAndInline(
  data: XaiWebSearchResponse,
  label: string,
  inlineCitationsEnabled: boolean,
): {
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
} {
  const { content, citations } = requireXaiResponseTextAndCitations(data, label);
  return {
    content,
    citations,
    inlineCitations:
      inlineCitationsEnabled && Array.isArray(data.inline_citations)
        ? data.inline_citations
        : undefined,
  };
}

export const __testing = {
  buildXaiResponsesToolBody,
  extractXaiWebSearchContent,
  requireXaiResponseTextCitationsAndInline,
  requireXaiResponseTextAndCitations,
  resolveXaiResponseTextCitationsAndInline,
  resolveXaiResponseTextAndCitations,
  resolveXaiResponsesEndpoint,
  XAI_RESPONSES_BASE_URL,
  XAI_RESPONSES_ENDPOINT,
} as const;
