// Code-point measurement helpers.
//
// Text limits name their unit: platforms mix units per field (Telegram counts
// topic titles in code points but message entities in UTF-16 units), so every
// check site must make its unit visible. These count without materializing a
// code-point array; `utf16-slice.ts` owns the UTF-16-unit family.

/** Counts Unicode code points, equal to `Array.from(text).length` without the array. */
export function countCodePoints(text: string): number {
  let count = 0;
  for (let unit = 0; unit < text.length; unit += codePointUnitSpanAt(text, unit)) {
    count += 1;
  }
  return count;
}

/** Whether the code-point count exceeds `limit`, stopping at the first excess character. */
export function codePointCountExceeds(text: string, limit: number): boolean {
  // A code point spans at least one UTF-16 unit, so a short-enough string can never exceed.
  if (text.length <= limit) {
    return false;
  }
  let count = 0;
  for (let unit = 0; unit < text.length; unit += codePointUnitSpanAt(text, unit)) {
    count += 1;
    if (count > limit) {
      return true;
    }
  }
  // Matches `countCodePoints(text) > limit` even for non-positive limits.
  return count > limit;
}

/** Slices by code point, equal to `Array.from(text).slice(start, end).join("")` without the array. */
export function sliceCodePoints(text: string, start: number, end?: number): string {
  // Array.prototype.slice coerces bounds with ToIntegerOrInfinity; the strict
  // index comparisons below never fire on NaN or fractions without this.
  const from = toIntegerBound(start);
  const to = end === undefined ? undefined : toIntegerBound(end);
  if (from < 0 || (to !== undefined && to < 0)) {
    // Negative bounds are relative to the total count; resolve them in one extra pass.
    const total = countCodePoints(text);
    return sliceNonNegativeCodePoints(
      text,
      from < 0 ? Math.max(total + from, 0) : from,
      to === undefined ? total : to < 0 ? Math.max(total + to, 0) : to,
    );
  }
  return sliceNonNegativeCodePoints(text, from, to);
}

function toIntegerBound(value: number): number {
  return Number.isNaN(value) ? 0 : Math.trunc(value);
}

function sliceNonNegativeCodePoints(text: string, start: number, end?: number): string {
  if (end !== undefined && end <= start) {
    return "";
  }
  if (start === 0 && end === undefined) {
    return text;
  }
  let index = 0;
  let sliceStart = start === 0 ? 0 : -1;
  for (let unit = 0; unit < text.length;) {
    if (end !== undefined && index === end) {
      return sliceStart < 0 ? "" : text.slice(sliceStart, unit);
    }
    unit += codePointUnitSpanAt(text, unit);
    index += 1;
    if (index === start) {
      sliceStart = unit;
    }
  }
  // The walk ended before reaching `end`; a start past the total slices to empty.
  return sliceStart < 0 ? "" : text.slice(sliceStart);
}

/** UTF-16 units the code point at `unit` occupies, matching the string iterator's step. */
function codePointUnitSpanAt(text: string, unit: number): number {
  const codeUnit = text.charCodeAt(unit);
  const isLeadingPair =
    codeUnit >= 0xd800 && codeUnit <= 0xdbff && (text.charCodeAt(unit + 1) & 0xfc00) === 0xdc00;
  return isLeadingPair ? 2 : 1;
}
