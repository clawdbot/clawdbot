import stringWidth from "string-width";
import {
  ANSI_COMPAT_CONTROL_SEQUENCE_PATTERN,
  ANSI_OSC_INTRODUCER_PATTERN,
  ANSI_STRING_TERMINATOR_PATTERN,
  iterateAnsiSegments,
  matchAnsiOscAt,
  scanAnsiCsiAt,
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
// string-width already requires Intl.Segmenter at module initialization.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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

/** Let sequential renderers consume graphemes without retaining a full-run array. */
export function* iterateGraphemes(input: string): Generator<string, void> {
  for (const { segment } of graphemeSegmenter.segment(input)) {
    yield segment;
  }
}

export function splitGraphemes(input: string): string[] {
  if (!input) {
    return [];
  }
  return Array.from(graphemeSegmenter.segment(input), (segment) => segment.segment);
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

    const segments = graphemeSegmenter.segment(segment);
    const measurePrefix = remaining <= width / 2;
    let current: Intl.SegmentData | undefined;
    let candidateWidth = 0;
    let low = 0;
    let high = segment.length;
    let end = 0;
    let fittedWidth = 0;
    const fits = (position: number): boolean => {
      if (position === segment.length) {
        return false;
      }
      // containing() keeps UTF-16 probes on whole graphemes without indexing the
      // entire line. Reuse its result while probing one oversized cluster.
      if (
        !current ||
        position < current.index ||
        position >= current.index + current.segment.length
      ) {
        // SAFETY: the end sentinel returns above; other probes resolve inside this segment.
        current = segments.containing(position) as Intl.SegmentData;
        candidateWidth =
          current.index === 0
            ? 0
            : measurePrefix
              ? textWidth(segment.slice(0, current.index))
              : width - textWidth(segment.slice(current.index));
      }
      if (candidateWidth > remaining) {
        return false;
      }
      end = current.index;
      fittedWidth = candidateWidth;
      return true;
    };
    let probe = Math.min(segment.length - 1, Math.floor((remaining * segment.length) / width));
    let fitting = fits(probe);
    const initiallyFits = fitting;
    let stride = 1;
    // Bracket the estimate before bisecting so small cuts measure short prefixes
    // or suffixes even when the line contains many variable-width graphemes.
    while (low < high) {
      if (fitting) {
        low = probe;
      } else {
        high = probe;
      }
      if (fitting !== initiallyFits || probe === 0 || probe === segment.length) {
        break;
      }
      probe = initiallyFits
        ? Math.min(segment.length, probe + stride)
        : Math.max(0, probe - stride);
      stride *= 2;
      fitting = fits(probe);
    }
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (fits(middle)) {
        low = middle;
      } else {
        high = middle;
      }
    }
    out += segment.slice(0, end);
    used += fittedWidth;
    budgetSpent = true;
  };
  for (const segment of iterateAnsiSegments(input)) {
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
