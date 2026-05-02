/**
 * Direct SDK/HTTP calls for providers that support native PDF document input.
 * This bypasses pi-ai's content type system which does not have a "document" type.
 */

import { normalizeProviderTransportWithPlugin } from "../../plugins/provider-runtime.js";
import { isRecord } from "../../utils.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";

type PdfInput = {
  base64: string;
  filename?: string;
};

const NATIVE_PDF_PROVIDER_FETCH_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Anthropic – native PDF via Messages API
// ---------------------------------------------------------------------------

type AnthropicDocBlock = {
  type: "document";
  source: {
    type: "base64";
    media_type: "application/pdf";
    data: string;
  };
};

type AnthropicTextBlock = {
  type: "text";
  text: string;
};

type AnthropicContentBlock = AnthropicDocBlock | AnthropicTextBlock;

type AnthropicResponseContent = Array<{ type: string; text?: string }>;

export async function anthropicAnalyzePdf(params: {
  apiKey: string;
  modelId: string;
  prompt: string;
  pdfs: PdfInput[];
  maxTokens?: number;
  baseUrl?: string;
}): Promise<string> {
  const apiKey = normalizeSecretInput(params.apiKey);
  if (!apiKey) {
    throw new Error("Anthropic PDF: apiKey required");
  }

  const content: AnthropicContentBlock[] = [];
  for (const pdf of params.pdfs) {
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: pdf.base64,
      },
    });
  }
  content.push({ type: "text", text: params.prompt });

  const baseUrl = (params.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "pdfs-2024-09-25",
    },
    body: JSON.stringify({
      model: params.modelId,
      max_tokens: params.maxTokens ?? 4096,
      messages: [{ role: "user", content }],
    }),
    signal: AbortSignal.timeout(NATIVE_PDF_PROVIDER_FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Anthropic PDF request failed (${res.status} ${res.statusText})${body ? `: ${body.slice(0, 400)}` : ""}`,
    );
  }

  const json = (await res.json().catch(() => null)) as unknown;
  if (!isRecord(json)) {
    throw new Error("Anthropic PDF response was not JSON.");
  }

  const responseContent = json.content as AnthropicResponseContent | undefined;
  if (!Array.isArray(responseContent)) {
    throw new Error("Anthropic PDF response missing content array.");
  }

  const text = responseContent
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("");

  if (!text.trim()) {
    throw new Error("Anthropic PDF returned no text.");
  }

  return text.trim();
}

// ---------------------------------------------------------------------------
// Google Gemini – native PDF via generateContent API
// ---------------------------------------------------------------------------

type GeminiPart = { inline_data: { mime_type: string; data: string } } | { text: string };

type GeminiCandidate = {
  content?: { parts?: Array<{ text?: string }> };
};

export async function geminiAnalyzePdf(params: {
  apiKey: string;
  modelId: string;
  prompt: string;
  pdfs: PdfInput[];
  baseUrl?: string;
}): Promise<string> {
  const apiKey = normalizeSecretInput(params.apiKey);
  if (!apiKey) {
    throw new Error("Gemini PDF: apiKey required");
  }

  const parts: GeminiPart[] = [];
  for (const pdf of params.pdfs) {
    parts.push({
      inline_data: {
        mime_type: "application/pdf",
        data: pdf.base64,
      },
    });
  }
  parts.push({ text: params.prompt });

  const transport = normalizeProviderTransportWithPlugin({
    provider: "google",
    context: {
      provider: "google",
      api: "google-generative-ai",
      baseUrl: params.baseUrl,
    },
  }) ?? { baseUrl: params.baseUrl };
  const baseUrl = (transport.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(
    /\/v1beta$/i,
    "",
  );
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(params.modelId)}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
    }),
    signal: AbortSignal.timeout(NATIVE_PDF_PROVIDER_FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Gemini PDF request failed (${res.status} ${res.statusText})${body ? `: ${body.slice(0, 400)}` : ""}`,
    );
  }

  const json = (await res.json().catch(() => null)) as unknown;
  if (!isRecord(json)) {
    throw new Error("Gemini PDF response was not JSON.");
  }

  const candidates = json.candidates as GeminiCandidate[] | undefined;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("Gemini PDF returned no candidates.");
  }

  const textParts = candidates[0].content?.parts?.filter((p) => typeof p.text === "string") ?? [];
  const text = textParts.map((p) => p.text!).join("");

  if (!text.trim()) {
    throw new Error("Gemini PDF returned no text.");
  }

  return text.trim();
}
