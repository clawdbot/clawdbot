import {
  estimateStringCharsWithMinimumRawWeight as estimateToolResultTextChars,
  type StringCharBudgetOptions,
} from "@openclaw/normalization-core/cjk-chars";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

export { estimateToolResultTextChars };

function sliceToolResultTextBudget(
  text: string,
  maxChars: number,
  options: StringCharBudgetOptions,
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
  options: StringCharBudgetOptions = {},
): string {
  return sliceToolResultTextBudget(text, maxChars, options, false);
}

export function sliceToolResultTextTailToBudget(
  text: string,
  maxChars: number,
  options: StringCharBudgetOptions = {},
): string {
  return sliceToolResultTextBudget(text, maxChars, options, true);
}
