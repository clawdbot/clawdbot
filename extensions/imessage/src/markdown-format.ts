/**
 * Convert markdown bold/italic/underline/strikethrough markers in agent text
 * into typed-run formatting ranges that the imsg bridge's `sendMessage`
 * action understands. Returns the marker-stripped text plus an array of
 * ranges keyed by their start in the OUTPUT string.
 *
 * macOS 15+ recipients render typed runs natively; macOS 14 falls back to
 * client-side markdown rendering, so passing both raw markdown and ranges
 * would double up — callers should send the stripped `text` only.
 *
 * Supported markers:
 *  - `**bold**`
 *  - `*italic*` / `_italic_` (single-underscore enforces word boundaries)
 *  - `__underline__` (double-underscore also enforces word boundaries so
 *    Python identifiers like `__init__` are not mangled)
 *  - `~~strikethrough~~`
 *
 * Nesting:
 *  - `***bold-italic***` is parsed as `**` containing `*italic*`, yielding
 *    two ranges over the same span (one bold, one italic).
 *  - Other nested combinations (`**bold _underline_**`, etc.) are
 *    similarly parsed by recursing into the inner text of every marker
 *    pair we consume.
 *
 * Out of scope: escaped markers (`\*literal\*`), code spans (` `code` `),
 * and combining-character edge cases. The receiver's iMessage style
 * vocabulary covers only bold/italic/underline/strikethrough — there is
 * nowhere to render anything fancier, and over-eager parsing would mangle
 * plain-text emoji/punctuation that happens to look like markdown.
 */

export type IMessageFormatStyle = "bold" | "italic" | "underline" | "strikethrough";

export type IMessageFormatRange = {
  start: number;
  length: number;
  styles: IMessageFormatStyle[];
};

type Marker = {
  marker: string;
  styles: IMessageFormatStyle[];
  /**
   * When true, the marker only counts when both ends sit on a word
   * boundary. Single-underscore italics need this so `snake_case_var` is
   * left literal, and double-underscore underline needs it so Python
   * dunder names like `__init__` are not turned into underline.
   */
  requireWordBoundary: boolean;
};

// Order matters: longer/compound markers are tried first.
//  - `***...***` is bold+italic over the inner span.
//  - `___...___` is underline+italic.
//  - `~~`, `**`, `__` cover their own styles.
//  - `*` / `_` italic match last (with `_` enforcing word boundaries).
const MARKERS: readonly Marker[] = [
  { marker: "***", styles: ["bold", "italic"], requireWordBoundary: false },
  { marker: "___", styles: ["underline", "italic"], requireWordBoundary: true },
  { marker: "~~", styles: ["strikethrough"], requireWordBoundary: false },
  { marker: "**", styles: ["bold"], requireWordBoundary: false },
  { marker: "__", styles: ["underline"], requireWordBoundary: true },
  { marker: "*", styles: ["italic"], requireWordBoundary: false },
  { marker: "_", styles: ["italic"], requireWordBoundary: true },
];

function tryConsumeMarker(
  input: string,
  i: number,
  m: Marker,
): { close: number; inner: string } | null {
  if (!input.startsWith(m.marker, i)) {
    return null;
  }
  // For single-char markers, reject when the next char is the same so we
  // don't consume the leading half of a longer marker (e.g. `*` matching
  // the first asterisk of `**bold**`).
  if (m.marker.length === 1 && input[i + 1] === m.marker) {
    return null;
  }
  // For 2-char markers, reject when there's a third repeat — that's the
  // longer compound marker (`***`, `___`) which should match first.
  if (m.marker.length === 2 && input[i + 2] === m.marker[0]) {
    return null;
  }
  // For underscore markers we use a stricter rule than CommonMark: the
  // OUTSIDE of each marker must be whitespace, start-of-string, or
  // end-of-string. That keeps `def __init__(self)` literal (`(` after the
  // close is neither whitespace nor end-of-string) while `__under__ and`
  // still parses cleanly. Asterisk markers don't need this because they
  // don't appear inside identifiers.
  const isAtBoundary = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);
  if (m.requireWordBoundary && i > 0 && !isAtBoundary(input[i - 1])) {
    return null;
  }
  const startInner = i + m.marker.length;
  const close = input.indexOf(m.marker, startInner);
  if (close === -1 || close === startInner) {
    return null;
  }
  if (m.requireWordBoundary && !isAtBoundary(input[close + m.marker.length])) {
    return null;
  }
  const inner = input.slice(startInner, close);
  if (!inner.trim()) {
    return null;
  }
  return { close, inner };
}

function parseInternal(input: string, baseOffset: number, sink: IMessageFormatRange[]): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    let consumed = false;
    for (const m of MARKERS) {
      const hit = tryConsumeMarker(input, i, m);
      if (!hit) {
        continue;
      }
      // Recurse on the inner span so nested markers compose. The inner
      // ranges are emitted with offsets relative to the new base.
      const innerOffset = baseOffset + out.length;
      const innerStripped = parseInternal(hit.inner, innerOffset, sink);
      // Compound markers (`***`, `___`) emit multiple styles over the same
      // span — push them in order so callers see e.g. italic before bold.
      for (const style of m.styles) {
        sink.push({
          start: innerOffset,
          length: innerStripped.length,
          styles: [style],
        });
      }
      out += innerStripped;
      i = hit.close + m.marker.length;
      consumed = true;
      break;
    }
    if (!consumed) {
      out += input[i];
      i += 1;
    }
  }
  return out;
}

export function extractMarkdownFormatRuns(input: string): {
  text: string;
  ranges: IMessageFormatRange[];
} {
  const ranges: IMessageFormatRange[] = [];
  const text = parseInternal(input, 0, ranges);
  return { text, ranges };
}
