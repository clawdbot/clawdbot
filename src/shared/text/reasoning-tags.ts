import {
  scanReasoningTags,
  stripReasoningTagsFromMarkdown,
} from "../../../packages/markdown-core/src/reasoning-tags.js";
// Reasoning tag helpers find and remove model reasoning tag blocks from text.
import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { findFinalTagMatches } from "./final-tags.js";
export type ReasoningTagMode = "strict" | "preserve";
export type ReasoningTagTrim = "none" | "start" | "both";
export type ReasoningTagScope = "all" | "leading";

function applyTrim(value: string, mode: ReasoningTagTrim): string {
  if (mode === "none") {
    return value;
  }
  if (mode === "start") {
    return value.trimStart();
  }
  return value.trim();
}

/** Detects whether a stray reasoning close tag separates two visible text regions. */
export function hasOrphanReasoningCloseBoundary(params: {
  before: string;
  after: string;
}): boolean {
  return params.before.trim().length > 0 && params.after.trim().length > 0;
}

/** Strips model reasoning/final tags from visible text while preserving literal code examples. */
export function stripReasoningTagsFromText(
  text: string,
  options?: {
    mode?: ReasoningTagMode;
    trim?: ReasoningTagTrim;
    scope?: ReasoningTagScope;
  },
): string {
  if (!text) {
    return text;
  }

  const mode = options?.mode ?? "strict";
  const trimMode = options?.trim ?? "both";
  const scope = options?.scope ?? "all";

  let cleaned = text;
  const matches = findFinalTagMatches(cleaned);
  const hasThinkingTag = scanReasoningTags(cleaned).tags.length > 0;
  if (matches.length === 0 && !hasThinkingTag) {
    return text;
  }
  if (matches.length > 0) {
    const preCodeRegions = findCodeRegions(cleaned);
    let visible = "";
    let lastIndex = 0;
    for (const match of matches) {
      if (!isInsideCode(match.index, preCodeRegions)) {
        visible += cleaned.slice(lastIndex, match.index);
        lastIndex = match.index + match.text.length;
      }
    }
    cleaned = visible + cleaned.slice(lastIndex);
  }

  return applyTrim(stripReasoningTagsFromMarkdown(cleaned, { mode, scope }), trimMode);
}
