/**
 * PDF tool parsing and response helpers.
 *
 * Normalizes PDF inputs, page ranges, provider native support, model config, and assistant text output.
 */
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AssistantMessage } from "../../llm/types.js";
import { providerSupportsNativePdfDocument } from "../../media-understanding/defaults.js";
import { extractAssistantText } from "../embedded-agent-utils.js";

/** Normalized PDF model preference used by tool registration and execution. */
type PdfModelConfig = { primary?: string; fallbacks?: string[] };

/** Reads `pdf` and `pdfs` tool arguments into a trimmed, de-duplicated PDF input list. */
export function resolvePdfInputs(record: Record<string, unknown>): string[] {
  const pdfCandidates: string[] = [];
  if (typeof record.pdf === "string") {
    pdfCandidates.push(record.pdf);
  }
  if (Array.isArray(record.pdfs)) {
    pdfCandidates.push(...record.pdfs.filter((v): v is string => typeof v === "string"));
  }

  const seenPdfs = new Set<string>();
  const pdfInputs: string[] = [];
  for (const candidate of pdfCandidates) {
    const trimmed = candidate.trim();
    if (!trimmed || seenPdfs.has(trimmed)) {
      continue;
    }
    seenPdfs.add(trimmed);
    pdfInputs.push(trimmed);
  }
  if (pdfInputs.length === 0) {
    throw new Error("pdf required: provide a path or URL to a PDF document");
  }
  return pdfInputs;
}

/** Checks whether a provider supports native PDF document input. */
export function providerSupportsNativePdf(provider: string): boolean {
  return providerSupportsNativePdfDocument({ providerId: provider });
}

/** Parses a page range string into sorted, unique, 1-based page numbers within `maxPages`. */
function readPageNumber(value: string, errorLabel: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${errorLabel}: "${value}"`);
  }
  return parsed;
}

export function parsePageRange(range: string, maxPages: number): number[] {
  const pages = new Set<number>();
  const parts = range.split(",").map((p) => p.trim());
  for (const part of parts) {
    if (!part) {
      continue;
    }
    const dashMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (dashMatch) {
      const start = readPageNumber(dashMatch[1] ?? "", "Invalid page range");
      const end = readPageNumber(dashMatch[2] ?? "", "Invalid page range");
      if (end < start) {
        throw new Error(`Invalid page range: "${part}"`);
      }
      for (let i = start; i <= Math.min(end, maxPages); i++) {
        pages.add(i);
      }
    } else {
      if (!/^\d+$/.test(part)) {
        throw new Error(`Invalid page number: "${part}"`);
      }
      const num = readPageNumber(part, "Invalid page number");
      if (num <= maxPages) {
        pages.add(num);
      }
    }
  }
  const parsedPages = Array.from(pages).toSorted((a, b) => a - b);
  if (parsedPages.length === 0) {
    throw new Error(`No PDF pages matched requested range "${range}"`);
  }
  return parsedPages;
}

/** Converts a provider assistant message into PDF text or throws a model-labelled failure. */
export function coercePdfAssistantText(params: {
  message: AssistantMessage;
  provider: string;
  model: string;
}): string {
  const label = `${params.provider}/${params.model}`;
  const errorMessage = params.message.errorMessage?.trim();
  const fail = (message?: string) => {
    throw new Error(
      message ? `PDF model failed (${label}): ${message}` : `PDF model failed (${label})`,
    );
  };
  if (params.message.stopReason === "error" || params.message.stopReason === "aborted") {
    fail(errorMessage);
  }
  if (errorMessage) {
    fail(errorMessage);
  }
  const text = extractAssistantText(params.message);
  const trimmed = text.trim();
  if (trimmed) {
    return trimmed;
  }
  throw new Error(`PDF model returned no text (${label}).`);
}

/** Reads configured PDF primary/fallback models from agent defaults. */
export function coercePdfModelConfig(cfg?: OpenClawConfig): PdfModelConfig {
  const primary = resolveAgentModelPrimaryValue(cfg?.agents?.defaults?.pdfModel);
  const fallbacks = resolveAgentModelFallbackValues(cfg?.agents?.defaults?.pdfModel);
  const modelConfig: PdfModelConfig = {};
  if (primary?.trim()) {
    modelConfig.primary = primary.trim();
  }
  if (fallbacks.length > 0) {
    modelConfig.fallbacks = fallbacks;
  }
  return modelConfig;
}

/** Caps requested PDF response tokens to the selected model's advertised maximum. */
export function resolvePdfToolMaxTokens(
  modelMaxTokens: number | undefined,
  requestedMaxTokens = 4096,
) {
  if (
    typeof modelMaxTokens !== "number" ||
    !Number.isFinite(modelMaxTokens) ||
    modelMaxTokens <= 0
  ) {
    return requestedMaxTokens;
  }
  return Math.min(requestedMaxTokens, modelMaxTokens);
}
