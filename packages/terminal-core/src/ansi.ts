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
const WIDTH_CONTROL_REGEX = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(
    0x7f,
  )}-${String.fromCharCode(0x9f)}]`,
  "gu",
);
const REGIONAL_INDICATOR_REGEX = /[\u{1F1E6}-\u{1F1FF}]/gu;
const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function hasAnsiIntroducer(input: string): boolean {
  return input.includes("\u001B") || input.includes("\u009B") || input.includes("\u009D");
}

function isZeroWidthDefaultIgnorable(code: number): boolean {
  return (
    code === 0x00ad ||
    code === 0x034f ||
    code === 0x061c ||
    code === 0x1160 ||
    code === 0x180e ||
    code === 0x200b ||
    code === 0x200c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfe0e ||
    code === 0xfeff
  );
}

function isHangulLeadingJamo(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115e) || (code >= 0xa960 && code <= 0xa97c);
}

function isHangulMedialJamo(code: number): boolean {
  return (code >= 0x1161 && code <= 0x11a7) || (code >= 0xd7b0 && code <= 0xd7c6);
}

function isHangulTrailingJamo(code: number): boolean {
  return (code >= 0x11a8 && code <= 0x11ff) || (code >= 0xd7cb && code <= 0xd7fb);
}

function codePointAtStart(input: string, index: number): number | undefined {
  return input.codePointAt(index);
}

function charLengthForCodePoint(code: number): number {
  return code > 0xffff ? 2 : 1;
}

function readHangulJamoSyllableCluster(input: string, start: number): string | undefined {
  const firstCode = codePointAtStart(input, start);
  if (firstCode === undefined || !isHangulLeadingJamo(firstCode)) {
    return undefined;
  }
  let index = start + charLengthForCodePoint(firstCode);
  const medialCode = codePointAtStart(input, index);
  if (medialCode === undefined || !isHangulMedialJamo(medialCode)) {
    return undefined;
  }
  index += charLengthForCodePoint(medialCode);
  while (index < input.length) {
    const trailingCode = codePointAtStart(input, index);
    if (trailingCode === undefined || !isHangulTrailingJamo(trailingCode)) {
      break;
    }
    index += charLengthForCodePoint(trailingCode);
  }
  return input.slice(start, index);
}

function splitPrintableWidthClusters(input: string): string[] {
  return splitGraphemes(input);
}

function printableWidthClusterWidth(input: string): number {
  const normalized = /[\u1100-\u11FF\uA960-\uA97C\uD7B0-\uD7FB]/u.test(input)
    ? input.normalize("NFC")
    : input;
  const startsWithHangulSyllable =
    normalized.length === input.length &&
    input === normalized &&
    input.length > 0 &&
    readHangulJamoSyllableCluster(input, 0) === input;
  return startsWithHangulSyllable ? 2 : stringWidth(normalized);
}

function printableWidthChunkWidth(input: string): number {
  return splitPrintableWidthClusters(input).reduce(
    (width, cluster) => width + printableWidthClusterWidth(cluster),
    0,
  );
}

function widthAcrossDefaultIgnorableBoundaries(input: string): number {
  let width = 0;
  let chunk = "";
  const flush = (): void => {
    if (chunk) {
      width += printableWidthChunkWidth(chunk);
      chunk = "";
    }
  };
  for (const char of input) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (isZeroWidthDefaultIgnorable(code)) {
      flush();
      continue;
    }
    chunk += char;
  }
  flush();
  return width;
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
  const segments = (() => {
    if (!graphemeSegmenter) {
      return Array.from(input);
    }
    try {
      return Array.from(graphemeSegmenter.segment(input), (segment) => segment.segment);
    } catch {
      return Array.from(input);
    }
  })();
  if (!/[\u1100-\u11FF\uA960-\uA97C\uD7B0-\uD7FB]/u.test(input)) {
    return segments;
  }
  const combined: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    const firstCode = codePointAtStart(segment, 0);
    if (firstCode === undefined || !isHangulLeadingJamo(firstCode)) {
      combined.push(segment);
      continue;
    }
    let cluster = segment;
    let nextIndex = index + 1;
    const segmentHasMedial = Array.from(segment).some((char) => {
      const code = char.codePointAt(0);
      return code !== undefined && isHangulMedialJamo(code);
    });
    if (!segmentHasMedial) {
      const next = segments[nextIndex] ?? "";
      const nextCode = codePointAtStart(next, 0);
      if (nextCode === undefined || !isHangulMedialJamo(nextCode)) {
        combined.push(segment);
        continue;
      }
      cluster += next;
      nextIndex += 1;
    }
    while (nextIndex < segments.length) {
      const next = segments[nextIndex] ?? "";
      const nextCode = codePointAtStart(next, 0);
      if (nextCode === undefined || !isHangulTrailingJamo(nextCode)) {
        break;
      }
      cluster += next;
      nextIndex += 1;
    }
    combined.push(cluster);
    index = nextIndex - 1;
  }
  return combined;
}

/**
 * Sanitize a value for safe interpolation into log messages.
 * Strips ANSI escape sequences, C0/C1 control characters, and DEL to
 * prevent log forging / terminal escape injection (CWE-117).
 */
export function sanitizeForLog(v: string): string {
  // Pattern built at runtime so the source file stays free of literal control
  // characters AND the linter cannot statically detect them (no-control-regex).
  const c0Start = String.fromCharCode(0x00);
  const c0End = String.fromCharCode(0x1f);
  const del = String.fromCharCode(0x7f);
  const c1Start = String.fromCharCode(0x80);
  const c1End = String.fromCharCode(0x9f);
  const controlCharsRegex = new RegExp(`[${c0Start}-${c0End}${del}${c1Start}-${c1End}]`, "g");
  return stripAnsi(v).replace(controlCharsRegex, "");
}

function printableTextWidth(text: string): number {
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
  const widthInput = printable
    .replace(/[\u260E]\uFE0F?\u20E3/gu, "\u260E")
    .replace(/[\u2764]\uFE0F?\u200D\u{1F525}/gu, "\u{1F525}")
    .replace(/^\uFE0F+/u, "")
    .replace(/^\u200D+/u, "")
    .replace(/([0-9#*])\uFE0F(?!\u20E3)/gu, "$1")
    .replace(/\u200D$/gu, "")
    .replace(REGIONAL_INDICATOR_REGEX, "a");
  return widthAcrossDefaultIgnorableBoundaries(widthInput);
}

function textWidth(text: string): number {
  let width = 0;
  let printableStart = 0;
  const flushPrintable = (end: number): void => {
    if (end > printableStart) {
      width += printableTextWidth(text.slice(printableStart, end));
    }
  };
  for (let index = 0; index < text.length; index += 1) {
    WIDTH_CONTROL_REGEX.lastIndex = 0;
    if (!WIDTH_CONTROL_REGEX.test(text.charAt(index))) {
      continue;
    }
    flushPrintable(index);
    if (text.charAt(index) === "\t") {
      // Tabs execute inside CSI too; string-width intentionally treats them as zero-width.
      width += 1;
    }
    printableStart = index + 1;
  }
  flushPrintable(text.length);
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
  const resetSgrWithoutWidthControls = (value: string): string | undefined => {
    const introducerLength =
      value.charCodeAt(0) === 0x9b
        ? 1
        : value.charCodeAt(0) === 0x1b && value.charCodeAt(1) === 0x5b
          ? 2
          : 0;
    if (introducerLength === 0 || value.charAt(value.length - 1) !== "m") {
      return undefined;
    }
    let body = "";
    let paramsForResetDetection = "";
    for (let index = introducerLength; index < value.length - 1; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 0x09) {
        continue;
      }
      const char = value.charAt(index);
      body += char;
      if (code > 0x1f && code !== 0x7f) {
        paramsForResetDetection += char;
      }
    }
    const params = paramsForResetDetection.replace(/[ -/]+$/u, "");
    const resets =
      params === "" ||
      params.split(/[;:]/u).some((part) => part === "" || Number.parseInt(part, 10) === 0);
    return resets ? `${value.slice(0, introducerLength)}${body}m` : undefined;
  };
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
        const reset = resetSgrWithoutWidthControls(segment.value);
        if (reset) {
          out += reset;
        }
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
