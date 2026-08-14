import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isLikelyContextOverflowError } from "../failover/context-overflow.js";

export function isCompactionFailureError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(errorMessage);
  const hasCompactionTerm =
    lower.includes("summarization failed") ||
    lower.includes("auto-compaction") ||
    lower.includes("compaction failed") ||
    lower.includes("compaction");
  if (!hasCompactionTerm) {
    return false;
  }
  // Treat any likely overflow shape as a compaction failure when compaction terms are present.
  // Providers often vary wording (e.g. "context window exceeded") across APIs.
  if (isLikelyContextOverflowError(errorMessage)) {
    return true;
  }
  // Keep explicit fallback for bare "context overflow" strings.
  return lower.includes("context overflow");
}

const OBSERVED_OVERFLOW_TOKEN_PATTERNS = [
  /prompt is too long:\s*([\d,]+)\s+tokens\s*>\s*[\d,]+\s+maximum/i,
  /prompt is too long:\s*([\d,]+)\s*,\s*model maximum context length\s*:\s*[\d,]+/i,
  /requested\s+([\d,]+)\s+tokens/i,
  /token limit\s*:\s*[\d,]+\s*\(requested\s*:\s*([\d,]+)\)/i,
  /resulted in\s+([\d,]+)\s+tokens/i,
];

const OBSERVED_OVERFLOW_TOKEN_SUM_PATTERNS = [
  /input length(?:\s+and\s+max_tokens)?\s+exceed\s+context(?:\s+limit|\s+window)?\s*\(i\.e\s*([\d,]+)\s*\+\s*([\d,]+)\s*>\s*[\d,]+\)/i,
];

export function extractObservedOverflowTokenCount(errorMessage?: string): number | undefined {
  if (!errorMessage) {
    return undefined;
  }

  for (const pattern of OBSERVED_OVERFLOW_TOKEN_SUM_PATTERNS) {
    const match = errorMessage.match(pattern);
    const rawLeft = match?.[1]?.replaceAll(",", "");
    const rawRight = match?.[2]?.replaceAll(",", "");
    if (!rawLeft || !rawRight) {
      continue;
    }
    const left = Number(rawLeft);
    const right = Number(rawRight);
    if (Number.isFinite(left) && left > 0 && Number.isFinite(right) && right >= 0) {
      return Math.floor(left + right);
    }
  }

  for (const pattern of OBSERVED_OVERFLOW_TOKEN_PATTERNS) {
    const match = errorMessage.match(pattern);
    const rawCount = match?.[1]?.replaceAll(",", "");
    if (!rawCount) {
      continue;
    }
    const parsed = Number(rawCount);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return undefined;
}
