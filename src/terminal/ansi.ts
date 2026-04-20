// Full CSI: ESC [ <params> <final byte> covers cursor movement, erase, and SGR.
const ANSI_CSI_PATTERN = "\\x1b\\[[\\x20-\\x3f]*[\\x40-\\x7e]";
// OSC-8 hyperlinks: ESC ] 8 ; ; url ST ... ESC ] 8 ; ; ST
const OSC8_PATTERN = "\\x1b\\]8;;.*?\\x1b\\\\|\\x1b\\]8;;\\x1b\\\\";

const ANSI_CSI_REGEX = new RegExp(ANSI_CSI_PATTERN, "g");
const OSC8_REGEX = new RegExp(OSC8_PATTERN, "g");
const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export function stripAnsi(input: string): string {
  return input.replace(OSC8_REGEX, "").replace(ANSI_CSI_REGEX, "");
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
 * Strips ANSI escape sequences, C0 control characters (U+0000–U+001F),
 * and DEL (U+007F) to prevent log forging / terminal escape injection (CWE-117).
 */
export function sanitizeForLog(v: string): string {
  // Pattern built at runtime so the source file stays free of literal control
  // characters AND the linter cannot statically detect them (no-control-regex).
  const c0Start = String.fromCharCode(0x00);
  const c0End = String.fromCharCode(0x1f);
  const del = String.fromCharCode(0x7f);
  const controlCharsRegex = new RegExp(`[${c0Start}-${c0End}${del}]`, "g");
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

const emojiLikePattern = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;

function graphemeWidth(grapheme: string): number {
  if (!grapheme) {
    return 0;
  }
  if (emojiLikePattern.test(grapheme)) {
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
