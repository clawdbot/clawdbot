import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { providerSupportsNativePdfDocument } from "../../media-understanding/defaults.js";
import { extractAssistantText } from "../pi-embedded-utils.js";

export type PdfModelConfig = { primary?: string; fallbacks?: string[] };

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

/**
 * Check whether a provider supports native PDF document input.
 */
export function providerSupportsNativePdf(provider: string): boolean {
  return providerSupportsNativePdfDocument({ providerId: provider });
}

/**
 * Parse a page range string (e.g. "1-5", "3", "1-3,7-9") into an array of 1-based page numbers.
 */
export function parsePageRange(range: string, maxPages: number): number[] {
  const pages = new Set<number>();
  const parts = range.split(",").map((p) => p.trim());
  for (const part of parts) {
    if (!part) {
      continue;
    }
    const dashMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (dashMatch) {
      const start = Number(dashMatch[1]);
      const end = Number(dashMatch[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
        throw new Error(`Invalid page range: "${part}"`);
      }
      for (let i = start; i <= Math.min(end, maxPages); i++) {
        pages.add(i);
      }
    } else {
      const num = Number(part);
      if (!Number.isFinite(num) || num < 1) {
        throw new Error(`Invalid page number: "${part}"`);
      }
      if (num <= maxPages) {
        pages.add(num);
      }
    }
  }
  return Array.from(pages).toSorted((a, b) => a - b);
}

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
