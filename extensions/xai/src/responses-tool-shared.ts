import type { XaiWebSearchResponse } from "./web-search-response.types.js";

export const XAI_RESPONSES_ENDPOINT = "https://api.x.ai/v1/responses";

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
    if (output.type === "message") {
      for (const block of output.content ?? []) {
        if (block.type === "output_text" && typeof block.text === "string" && block.text) {
          const urls = (block.annotations ?? [])
            .filter(
              (annotation) =>
                annotation.type === "url_citation" && typeof annotation.url === "string",
            )
            .map((annotation) => annotation.url as string);
          return { text: block.text, annotationCitations: [...new Set(urls)] };
        }
      }
    }

    if (output.type === "output_text" && typeof output.text === "string" && output.text) {
      const urls = (output.annotations ?? [])
        .filter(
          (annotation) => annotation.type === "url_citation" && typeof annotation.url === "string",
        )
        .map((annotation) => annotation.url as string);
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

export const __testing = {
  buildXaiResponsesToolBody,
  extractXaiWebSearchContent,
  resolveXaiResponseTextCitationsAndInline,
  resolveXaiResponseTextAndCitations,
  XAI_RESPONSES_ENDPOINT,
} as const;
