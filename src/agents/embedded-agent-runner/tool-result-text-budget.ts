import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

type ToolResultTextBudgetOptions = {
  minimumRawWeight?: number;
};

const ASCII_RUN_OR_NON_ASCII_CODE_POINT_RE = /[\p{ASCII}]+|[^\p{ASCII}]/gu;

/**
 * Returns provider-independent character-budget units for tool-result text.
 * CJK weights match the shared token heuristic; callers may retain a larger
 * existing raw-text safety floor without multiplying the CJK adjustment twice.
 */
export function estimateToolResultTextChars(
  text: string,
  options: ToolResultTextBudgetOptions = {},
): number {
  const minimumRawWeight = Math.max(1, options.minimumRawWeight ?? 1);
  if (minimumRawWeight === 1) {
    return estimateStringChars(text);
  }
  let chars = 0;
  for (const match of text.matchAll(ASCII_RUN_OR_NON_ASCII_CODE_POINT_RE)) {
    const segment = match[0];
    const minimumChars = Math.ceil(segment.length * minimumRawWeight);
    chars +=
      segment.charCodeAt(0) <= 0x7f
        ? minimumChars
        : Math.max(estimateStringChars(segment), minimumChars);
  }
  return chars;
}

function sliceToolResultTextBudget(
  text: string,
  maxChars: number,
  options: ToolResultTextBudgetOptions,
  fromEnd: boolean,
): string {
  const budget = Math.max(0, Math.floor(maxChars));
  if (text.length <= budget && estimateToolResultTextChars(text, options) <= budget) {
    return text;
  }
  let best = "";
  let low = 0;
  // Every UTF-16 unit costs at least one budget unit, so longer candidates cannot fit.
  let high = Math.min(text.length, budget);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = fromEnd
      ? sliceUtf16Safe(text, text.length - midpoint)
      : sliceUtf16Safe(text, 0, midpoint);
    if (estimateToolResultTextChars(candidate, options) <= budget) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

export function sliceToolResultTextToBudget(
  text: string,
  maxChars: number,
  options: ToolResultTextBudgetOptions = {},
): string {
  return sliceToolResultTextBudget(text, maxChars, options, false);
}

export function sliceToolResultTextTailToBudget(
  text: string,
  maxChars: number,
  options: ToolResultTextBudgetOptions = {},
): string {
  return sliceToolResultTextBudget(text, maxChars, options, true);
}
