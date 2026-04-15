/**
 * Detects inbound messages that are reflections of assistant-originated content.
 * These patterns indicate internal metadata leaked into a channel and then
 * bounced back as a new inbound message — creating an echo loop.
 */

import { findCodeRegions, isInsideCode } from "openclaw/plugin-sdk/text-runtime";

const INTERNAL_SEPARATOR_RE = /(?:#\+){2,}#?/;
const ASSISTANT_ROLE_MARKER_RE = /\bassistant\s+to\s*=\s*\w+/i;
// Require closing `>` to avoid false-positives on phrases like "<thought experiment>".
const THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/i;
const RELEVANT_MEMORIES_TAG_RE = /<\s*\/?\s*relevant[-_]memories\b[^<>]*>/i;
// Require closing `>` to avoid false-positives on phrases like "<final answer>".
const FINAL_TAG_RE = /<\s*\/?\s*final\b[^<>]*>/i;

const REFLECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: INTERNAL_SEPARATOR_RE, label: "internal-separator" },
  { re: ASSISTANT_ROLE_MARKER_RE, label: "assistant-role-marker" },
  { re: THINKING_TAG_RE, label: "thinking-tag" },
  { re: RELEVANT_MEMORIES_TAG_RE, label: "relevant-memories-tag" },
  { re: FINAL_TAG_RE, label: "final-tag" },
];

export type ReflectionDetection = {
  isReflection: boolean;
  matchedLabels: string[];
};

function hasMatchOutsideCode(text: string, re: RegExp): boolean {
  const codeRegions = findCodeRegions(text);
  const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);

  for (const match of text.matchAll(globalRe)) {
    const start = match.index ?? -1;
    if (start >= 0 && !isInsideCode(start, codeRegions)) {
      return true;
    }
  }

  return false;
}

/**
 * Check whether an inbound message appears to be a reflection of
 * assistant-originated content. Returns matched pattern labels for telemetry.
 */
export function detectReflectedContent(text: string): ReflectionDetection {
  if (!text) {
    return { isReflection: false, matchedLabels: [] };
  }

  const matchedLabels: string[] = [];
  for (const { re, label } of REFLECTION_PATTERNS) {
    if (hasMatchOutsideCode(text, re)) {
      matchedLabels.push(label);
    }
  }

  return {
    isReflection: matchedLabels.length > 0,
    matchedLabels,
  };
}
