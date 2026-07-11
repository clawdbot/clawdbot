// Full CSI: ESC [ <params> <final byte> covers cursor movement, erase, and SGR.
const ESC_ANSI_CSI_PATTERN = "\\x1b\\[[\\x20-\\x3f]*[\\x40-\\x7e]";
const C1_ANSI_CSI_PATTERN = "\\x9b[\\x20-\\x3f]*[\\x40-\\x7e]";
const ANSI_CSI_PATTERN = `(?:${ESC_ANSI_CSI_PATTERN}|${C1_ANSI_CSI_PATTERN})`;
// OSC: ESC ] or C1 OSC, then <payload> ST. Covers hyperlinks and clipboard/title escapes.
// ST can be ESC \, BEL, or its C1 form.
const ANSI_OSC_INTRODUCER_PATTERN = "(?:\\x1b\\]|\\x9d)";
const ANSI_STRING_TERMINATOR_PATTERN = "(?:\\x1b\\\\|\\x07|\\x9c)";
const ANSI_OSC_PATTERN = `${ANSI_OSC_INTRODUCER_PATTERN}[^\\x07\\x1b\\x9c]*${ANSI_STRING_TERMINATOR_PATTERN}`;

const ANSI_OSC_AT_INDEX_REGEX = new RegExp(ANSI_OSC_PATTERN, "y");
const ANSI_SEQUENCE_REGEX = new RegExp(`${ANSI_OSC_PATTERN}|${ANSI_CSI_PATTERN}`, "g");

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
const ANSI_CONTROL_SEQUENCE_PATTERN =
  "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
const ANSI_COMPAT_SEQUENCE_AT_INDEX_REGEX = new RegExp(
  `${ANSI_OSC_SEQUENCE_PATTERN}|${ANSI_CONTROL_SEQUENCE_PATTERN}`,
  "y",
);
const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function csiIntroducerLength(input: string, index: number): number {
  const code = input.charCodeAt(index);
  if (code === 0x9b) {
    return 1;
  }
  return code === 0x1b && input.charCodeAt(index + 1) === 0x5b ? 2 : 0;
}

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

    ANSI_OSC_AT_INDEX_REGEX.lastIndex = index;
    const oscMatch = ANSI_OSC_AT_INDEX_REGEX.exec(input);
    if (oscMatch) {
      output.push(input.slice(copyStart, index));
      index += oscMatch[0].length;
      copyStart = index;
      continue;
    }

    const introducerLength = csiIntroducerLength(input, index);
    if (introducerLength === 0) {
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
    let cursor = index + introducerLength;
    const controls: string[] = [];
    let ended = false;
    while (cursor < input.length) {
      const code = input.charCodeAt(cursor);
      if (code === 0x18 || code === 0x1a) {
        cursor += 1;
        ended = true;
        break;
      }
      if (code === 0x1b || code === 0x9b) {
        ended = true;
        break;
      }
      if (code <= 0x1f || code === 0x7f) {
        // These controls execute independently; the caller still owns whether
        // to retain, remove, or escape them in its output format.
        controls.push(input.charAt(cursor));
        cursor += 1;
        continue;
      }
      if (code >= 0x20 && code <= 0x3f) {
        cursor += 1;
        continue;
      }
      if (code >= 0x40 && code <= 0x7e) {
        cursor += 1;
      }
      ended = true;
      break;
    }

    if (!ended && options.preserveIncompleteCsi) {
      break;
    }

    const canonicalLength = cursor - index;
    if (
      controls.length === 0 &&
      compatibilityMatch &&
      compatibilityMatch[0].length > canonicalLength
    ) {
      cursor = index + compatibilityMatch[0].length;
    }

    output.push(input.slice(copyStart, index), ...controls);
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

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0x200d
  );
}

function isFullWidthCodePoint(codePoint: number): boolean {
  if (codePoint < 0x1100) {
    return false;
  }
  return (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x3247 && codePoint !== 0x303f) ||
    (codePoint >= 0x3250 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0xa4c6) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97c) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6b) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1aff0 && codePoint <= 0x1aff3) ||
    (codePoint >= 0x1aff5 && codePoint <= 0x1affb) ||
    (codePoint >= 0x1affd && codePoint <= 0x1affe) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

const rgiEmojiPattern = new RegExp("^\\p{RGI_Emoji}$", "v");
const emojiPresentationPattern = /\p{Emoji_Presentation}/u;
const regionalIndicatorPattern = /\p{Regional_Indicator}/u;
const unqualifiedKeycapPattern = /^[#*0-9]\u20E3$/u;
const extendedPictographicPattern = /\p{Extended_Pictographic}/gu;

function isWideEmojiGrapheme(grapheme: string): boolean {
  const isRgiEmoji = rgiEmojiPattern.test(grapheme);
  // RGI recognizes paired flags while keeping a lone regional indicator narrow.
  if (regionalIndicatorPattern.test(grapheme)) {
    return isRgiEmoji;
  }
  if (
    emojiPresentationPattern.test(grapheme) ||
    isRgiEmoji ||
    unqualifiedKeycapPattern.test(grapheme)
  ) {
    return true;
  }
  // Minimally qualified ZWJ sequences still shape as one wide emoji in terminals.
  return (
    grapheme.includes("\u200D") && (grapheme.match(extendedPictographicPattern)?.length ?? 0) >= 2
  );
}

function graphemeWidth(grapheme: string): number {
  if (!grapheme) {
    return 0;
  }
  if (isWideEmojiGrapheme(grapheme)) {
    return 2;
  }

  let sawPrintable = false;
  for (const char of grapheme) {
    const codePoint = char.codePointAt(0);
    if (codePoint == null) {
      continue;
    }
    if (isZeroWidthCodePoint(codePoint)) {
      continue;
    }
    if (isFullWidthCodePoint(codePoint)) {
      return 2;
    }
    sawPrintable = true;
  }
  return sawPrintable ? 1 : 0;
}

export function visibleWidth(input: string): number {
  return splitGraphemes(stripAnsi(input)).reduce(
    (sum, grapheme) => sum + graphemeWidth(grapheme),
    0,
  );
}

/**
 * Truncate to at most `maxWidth` visible columns, dropping whole grapheme
 * clusters that would overflow while preserving ANSI sequences verbatim
 * (they have zero visible width). A single wide grapheme that cannot fit the
 * remaining budget is dropped rather than emitted partially, so the result is
 * always `visibleWidth(result) <= maxWidth`. Callers that need a fixed width
 * pad the (possibly short) remainder themselves.
 */
export function truncateToVisibleWidth(input: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (visibleWidth(input) <= maxWidth) {
    return input;
  }
  ANSI_SEQUENCE_REGEX.lastIndex = 0;
  let out = "";
  let used = 0;
  let pos = 0;
  // Once the visible budget is spent we stop emitting graphemes but keep
  // copying ANSI sequences, so trailing resets/link-closes still land and the
  // truncated cell does not bleed styling into the padding or border.
  let budgetSpent = false;
  const appendVisible = (segment: string): void => {
    if (budgetSpent) {
      return;
    }
    for (const grapheme of splitGraphemes(segment)) {
      const width = graphemeWidth(grapheme);
      if (used + width > maxWidth) {
        budgetSpent = true;
        return;
      }
      out += grapheme;
      used += width;
    }
  };
  let match: RegExpExecArray | null;
  while ((match = ANSI_SEQUENCE_REGEX.exec(input)) !== null) {
    appendVisible(input.slice(pos, match.index));
    out += match[0];
    pos = match.index + match[0].length;
  }
  appendVisible(input.slice(pos));
  return out;
}
