import stringWidth from "string-width";
import {
  ANSI_COMPAT_CONTROL_SEQUENCE_PATTERN,
  ANSI_OSC_INTRODUCER_PATTERN,
  ANSI_STRING_TERMINATOR_PATTERN,
  matchAnsiOscAt,
  scanAnsiCsiAt,
  splitAnsiSegments,
} from "./ansi-sequences.js";

/*
 * The following compatibility grammar is derived from ansi-regex and strip-ansi.
 *
 * MIT License
 *
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const ANSI_OSC_SEQUENCE_PATTERN = `${ANSI_OSC_INTRODUCER_PATTERN}[\\s\\S]*?${ANSI_STRING_TERMINATOR_PATTERN}`;
const ANSI_COMPAT_SEQUENCE_AT_INDEX_REGEX = new RegExp(
  `${ANSI_OSC_SEQUENCE_PATTERN}|${ANSI_COMPAT_CONTROL_SEQUENCE_PATTERN}`,
  "y",
);
const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function hasAnsiIntroducer(input: string): boolean {
  return input.includes("\u001B") || input.includes("\u009B") || input.includes("\u009D");
}

/**
 * Strip ANSI against original input positions so one removal cannot synthesize
 * a second sequence. C0 controls execute without ending CSI, CAN/SUB cancel it,
 * and ESC restarts escape parsing.
 */
function stripAnsiInternal(
  input: string,
  options: { compatibilityGrammar: boolean; preserveIncompleteCsi?: boolean },
): string {
  const output: string[] = [];
  let copyStart = 0;
  let index = 0;

  while (index < input.length) {
    const introducerCode = input.charCodeAt(index);
    if (introducerCode !== 0x1b && introducerCode !== 0x9b && introducerCode !== 0x9d) {
      index += 1;
      continue;
    }

    const osc = matchAnsiOscAt(input, index);
    if (osc) {
      output.push(input.slice(copyStart, index));
      index += osc.length;
      copyStart = index;
      continue;
    }

    const csi = scanAnsiCsiAt(input, index);
    if (!csi) {
      ANSI_COMPAT_SEQUENCE_AT_INDEX_REGEX.lastIndex = index;
      const compatibilityMatch = options.compatibilityGrammar
        ? ANSI_COMPAT_SEQUENCE_AT_INDEX_REGEX.exec(input)
        : null;
      if (compatibilityMatch) {
        output.push(input.slice(copyStart, index));
        index += compatibilityMatch[0].length;
        copyStart = index;
        continue;
      }
      index += 1;
      continue;
    }

    ANSI_COMPAT_SEQUENCE_AT_INDEX_REGEX.lastIndex = index;
    const compatibilityMatch = options.compatibilityGrammar
      ? ANSI_COMPAT_SEQUENCE_AT_INDEX_REGEX.exec(input)
      : null;
    if (!csi.ended && options.preserveIncompleteCsi) {
      break;
    }

    let cursor = index + csi.value.length;
    const canonicalLength = csi.value.length;
    if (
      csi.controls.length === 0 &&
      compatibilityMatch &&
      compatibilityMatch[0].length > canonicalLength
    ) {
      cursor = index + compatibilityMatch[0].length;
    }

    output.push(input.slice(copyStart, index), ...csi.controls);
    index = cursor;
    copyStart = cursor;
  }

  output.push(input.slice(copyStart));
  return output.join("");
}

export function stripAnsi(input: string): string {
  if (!hasAnsiIntroducer(input)) {
    return input;
  }
  return stripAnsiInternal(input, { compatibilityGrammar: false });
}

export function stripAnsiSequences(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError(`Expected a \`string\`, got \`${typeof input}\``);
  }
  if (!hasAnsiIntroducer(input)) {
    return input;
  }
  return stripAnsiInternal(input, { compatibilityGrammar: true });
}

/** Preserve pending CSI visibly because an output chunk boundary is not true EOF. */
export function stripAnsiForStreamChunk(
  input: string,
  options?: { compatibilityGrammar?: boolean },
): string {
  if (!hasAnsiIntroducer(input)) {
    return input;
  }
  return stripAnsiInternal(input, {
    compatibilityGrammar: options?.compatibilityGrammar === true,
    preserveIncompleteCsi: true,
  });
}

export function splitGraphemes(input: string): string[] {
  if (!input) {
    return [];
  }
  if (!graphemeSegmenter) {
    return Array.from(input);
  }
  try {
    return Array.from(graphemeSegmenter.segment(input), (segment) => segment.segment);
  } catch {
    return Array.from(input);
  }
}

// Construct once without embedding literal controls; DEL and C1 form one range.
const LOG_CONTROL_CHARS_REGEX = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
  "g",
);

/**
 * Sanitize a value for safe interpolation into log messages.
 * Strips ANSI escape sequences, C0/C1 control characters, and DEL to
 * prevent log forging / terminal escape injection (CWE-117).
 */
export function sanitizeForLog(v: string): string {
  return stripAnsi(v).replace(LOG_CONTROL_CHARS_REGEX, "");
}

function textWidth(text: string): number {
  // POSIX renders these default-ignorable Hangul fillers as wide/halfwidth cells;
  // same-shaping representatives and well-formed surrogates preserve terminal output.
  const printable = /[\u115F\u3164\uFFA0\uD800-\uDFFF]/u.test(text)
    ? text
        .replace(/[\uD800-\uDFFF]/gu, "\uFFFD")
        .replaceAll("\u115F", "\u1100")
        .replaceAll("\u3164", "\u3131")
        .replaceAll("\uFFA0", "\uFF8A")
    : text;
  // OpenClaw owns ANSI parsing; upstream must not reinterpret malformed sequences.
  let width = stringWidth(printable, { countAnsiEscapeCodes: true });
  // Tabs execute inside CSI too; string-width intentionally treats them as zero-width.
  for (let index = text.indexOf("\t"); index !== -1; index = text.indexOf("\t", index + 1)) {
    width += 1;
  }
  return width;
}

export function visibleWidth(input: string): number {
  return textWidth(stripAnsi(input));
}

/**
 * Truncate to at most `maxWidth` visible columns, dropping whole grapheme
 * clusters that would overflow while preserving zero-width ANSI sequences
 * verbatim. Independently executed controls inside CSI count toward the budget
 * while the containing sequence stays atomic. A single wide grapheme that
 * cannot fit is dropped whole, so `visibleWidth(result) <= maxWidth`.
 */
export function truncateToVisibleWidth(input: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  const plainInput = stripAnsi(input);
  const inputWidth = textWidth(plainInput);
  if (inputWidth <= maxWidth) {
    return input;
  }
  let out = "";
  let used = 0;
  // Once the visible budget is spent we stop emitting graphemes but keep
  // copying zero-width ANSI sequences, so trailing resets/link-closes still
  // land without letting embedded executable controls exceed the budget.
  let budgetSpent = false;
  const appendVisible = (segment: string): void => {
    if (budgetSpent) {
      return;
    }
    const remaining = maxWidth - used;
    const width = segment === plainInput ? inputWidth : textWidth(segment);
    if (width <= remaining) {
      out += segment;
      used += width;
      return;
    }

    const graphemes = splitGraphemes(segment);
    let offset = 0;
    const offsets = [offset];
    for (const grapheme of graphemes) {
      offset += grapheme.length;
      offsets.push(offset);
    }
    let start = 0;
    let fittedWidth = 0;
    if (remaining <= width / 2) {
      let end = Math.max(
        1,
        Math.min(graphemes.length - 1, Math.floor((remaining * graphemes.length) / width)),
      );
      let stride = 1;
      // Estimate the cell boundary first; gallop handles uneven/zero-width clusters.
      while (end < graphemes.length) {
        const candidateWidth = textWidth(segment.slice(0, offsets[end]));
        if (candidateWidth > remaining) {
          break;
        }
        start = end;
        fittedWidth = candidateWidth;
        end = Math.min(graphemes.length, end + stride);
        stride *= 2;
      }
      while (start + 1 < end) {
        const middle = Math.floor((start + end) / 2);
        const candidateWidth = textWidth(segment.slice(0, offsets[middle]));
        if (candidateWidth <= remaining) {
          start = middle;
          fittedWidth = candidateWidth;
        } else {
          end = middle;
        }
      }
    } else {
      const overflow = width - remaining;
      let tooShort = 0;
      let removed = Math.min(graphemes.length, 1);
      let removedWidth = width;
      // Near-end cuts search short complete-grapheme suffixes, not repeated full prefixes.
      while (removed < graphemes.length) {
        removedWidth = textWidth(segment.slice(offsets[graphemes.length - removed]));
        if (removedWidth >= overflow) {
          break;
        }
        tooShort = removed;
        removed = Math.min(graphemes.length, removed * 2);
      }
      if (removed === graphemes.length) {
        removedWidth = width;
      }
      while (tooShort + 1 < removed) {
        const middle = Math.floor((tooShort + removed) / 2);
        const candidateWidth = textWidth(segment.slice(offsets[graphemes.length - middle]));
        if (candidateWidth >= overflow) {
          removed = middle;
          removedWidth = candidateWidth;
        } else {
          tooShort = middle;
        }
      }
      start = graphemes.length - removed;
      fittedWidth = width - removedWidth;
    }
    out += segment.slice(0, offsets[start]);
    used += fittedWidth;
    budgetSpent = true;
  };
  for (const segment of splitAnsiSegments(input)) {
    if (segment.kind === "ansi") {
      // CSI retains only C0/DEL controls; TAB is the sole visible-width member.
      const widthControls = segment.controls.filter((control) => control === "\t");
      const controlWidth = widthControls.length;
      if (!budgetSpent && used + controlWidth <= maxWidth) {
        out += segment.value;
        used += controlWidth;
      } else if (controlWidth > 0) {
        out += segment.value.replaceAll("\t", "");
        budgetSpent = true;
      } else {
        out += segment.value;
      }
    } else {
      appendVisible(segment.value);
    }
  }
  return out;
}
