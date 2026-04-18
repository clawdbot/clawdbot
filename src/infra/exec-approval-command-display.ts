import { redactSensitiveText, resolveRedactOptions } from "../logging/redact.js";
import type { ExecApprovalRequestPayload } from "./exec-approvals.js";

// Escape control characters, Unicode format/line/paragraph separators, and non-ASCII space
// separators that can spoof approval prompts in common UIs. Ordinary ASCII space (U+0020) is
// intentionally excluded so normal command text renders unchanged.
const EXEC_APPROVAL_INVISIBLE_CHAR_REGEX =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]/gu;
const EXEC_APPROVAL_INVISIBLE_CHAR_SINGLE =
  /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]$/u;

// Hard cap on input the sanitizer will process at all. Above this size we return a constant
// marker without running any regex work, so an attacker cannot force unbounded CPU/memory.
const EXEC_APPROVAL_MAX_INPUT = 256 * 1024;
// Soft cap on displayed output. Truncation happens AFTER redaction so a secret near the
// cutoff is not partially exposed when the cut lands mid-token below a pattern's minimum
// length (e.g. `ghp_` needs 20+ trailing chars before the `\b` match).
const EXEC_APPROVAL_MAX_OUTPUT = 16 * 1024;
const EXEC_APPROVAL_TRUNCATION_MARKER = "…[truncated]";
const EXEC_APPROVAL_OVERSIZED_MARKER =
  "[exec approval command exceeds display size limit; full text suppressed]";

const BYPASS_MASK = "***";

function formatCodePointEscape(char: string): string {
  return `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? "FFFD"}}`;
}

function escapeInvisibles(text: string): string {
  return text.replace(EXEC_APPROVAL_INVISIBLE_CHAR_REGEX, formatCodePointEscape);
}

function truncateForDisplay(text: string): string {
  if (text.length <= EXEC_APPROVAL_MAX_OUTPUT) {
    return text;
  }
  return text.slice(0, EXEC_APPROVAL_MAX_OUTPUT) + EXEC_APPROVAL_TRUNCATION_MARKER;
}

// Build a boolean bitmap of positions in `text` that ANY redaction pattern would match.
// Patterns are applied independently to the raw text (not sequentially against a
// progressively-redacted view) so later patterns can still find matches that the in-place
// redaction would have replaced first. That is conservative — it may over-count overlapping
// matches — but that is acceptable for a coverage check. Indices are UTF-16 code-unit
// offsets, matching what `matchAll` returns and aligning with `String#length`.
function computeRedactionBitmap(text: string, patterns: RegExp[]): boolean[] {
  const bitmap: boolean[] = Array.from({ length: text.length }, () => false);
  for (const pattern of patterns) {
    const iter = pattern.flags.includes("g")
      ? new RegExp(pattern.source, pattern.flags)
      : new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of text.matchAll(iter)) {
      if (match.index === undefined) {
        continue;
      }
      const end = match.index + match[0].length;
      for (let i = match.index; i < end; i++) {
        bitmap[i] = true;
      }
    }
  }
  return bitmap;
}

// Iterate by full Unicode code point so astral-plane invisibles (e.g. U+E0061 TAG LATIN
// SMALL LETTER A, category Cf) are matched as single characters instead of being seen as a
// surrogate pair whose halves are category Cs and would escape the invisible-char regex.
function buildStrippedView(original: string): { stripped: string; strippedToOrig: number[] } {
  const strippedChars: string[] = [];
  const strippedToOrig: number[] = [];
  let offset = 0;
  for (const cp of original) {
    if (!EXEC_APPROVAL_INVISIBLE_CHAR_SINGLE.test(cp)) {
      strippedChars.push(cp);
      for (let k = 0; k < cp.length; k++) {
        strippedToOrig.push(offset + k);
      }
    }
    offset += cp.length;
  }
  return { stripped: strippedChars.join(""), strippedToOrig };
}

export function sanitizeExecApprovalDisplayText(commandText: string): string {
  if (commandText.length > EXEC_APPROVAL_MAX_INPUT) {
    // Refuse to display inputs above the hard cap; anything larger must be approved through
    // another channel. Running redaction on a multi-megabyte payload would be a DoS vector.
    return EXEC_APPROVAL_OVERSIZED_MARKER;
  }
  const rawRedacted = redactSensitiveText(commandText, { mode: "tools" });
  const { stripped, strippedToOrig } = buildStrippedView(commandText);
  const strippedRedacted = redactSensitiveText(stripped, { mode: "tools" });
  // Fast path: stripping invisibles did not expose any additional secret-like content, so the
  // raw-view redaction is sufficient. Preserve structure and show invisible-character spoof
  // attempts as `\u{...}` escapes.
  if (strippedRedacted === stripped) {
    return truncateForDisplay(escapeInvisibles(rawRedacted));
  }
  // Detect bypass by position-bitmap coverage. Run each redaction pattern independently on
  // both views and map stripped-view match positions back to original coordinates. If every
  // position the stripped view would mask is also masked by the raw view, the raw view
  // already covered everything — for example, an ordinary multi-line PEM private key where
  // raw produces `BEGIN/…redacted…/END` while stripped collapses to `***`. A real bypass
  // exists only when the stripped view masks at least one original position raw missed (e.g.
  // the tail of an `sk-` token whose prefix-boundary was broken by a spliced zero-width or
  // NBSP character).
  const { patterns } = resolveRedactOptions({ mode: "tools" });
  const rawMask = computeRedactionBitmap(commandText, patterns);
  const strippedMask = computeRedactionBitmap(stripped, patterns);
  let bypassDetected = false;
  for (let i = 0; i < strippedMask.length; i++) {
    if (strippedMask[i] && !rawMask[strippedToOrig[i]]) {
      bypassDetected = true;
      break;
    }
  }
  if (!bypassDetected) {
    return truncateForDisplay(escapeInvisibles(rawRedacted));
  }
  // Bypass path. Project the stripped-view mask back onto original positions, union with the
  // raw-view mask, and emit a rendering where each contiguous masked run becomes a single
  // `***` marker. Invisible characters that fall outside masked runs still render as visible
  // `\u{...}` escapes so multi-line structure and spliced invisibles stay readable. The
  // render loop advances by full code point so astral-plane invisibles are escaped as one
  // `\u{...}` token rather than two separate surrogate escapes (or, worse, passed through
  // unescaped because neither surrogate half matches the Cf regex).
  const unionMask = rawMask.slice();
  for (let i = 0; i < strippedMask.length; i++) {
    if (strippedMask[i]) {
      unionMask[strippedToOrig[i]] = true;
    }
  }
  let out = "";
  let i = 0;
  while (i < commandText.length) {
    if (unionMask[i]) {
      let j = i;
      while (j < commandText.length && unionMask[j]) {
        j++;
      }
      out += BYPASS_MASK;
      i = j;
      continue;
    }
    const codePoint = commandText.codePointAt(i) ?? 0xfffd;
    const cp = String.fromCodePoint(codePoint);
    out += EXEC_APPROVAL_INVISIBLE_CHAR_SINGLE.test(cp) ? formatCodePointEscape(cp) : cp;
    i += cp.length;
  }
  return truncateForDisplay(out);
}

function normalizePreview(commandText: string, commandPreview?: string | null): string | null {
  const previewRaw = commandPreview?.trim() ?? "";
  if (!previewRaw) {
    return null;
  }
  const preview = sanitizeExecApprovalDisplayText(previewRaw);
  if (preview === commandText) {
    return null;
  }
  return preview;
}

export function resolveExecApprovalCommandDisplay(request: ExecApprovalRequestPayload): {
  commandText: string;
  commandPreview: string | null;
} {
  const commandTextSource =
    request.command ||
    (request.host === "node" && request.systemRunPlan ? request.systemRunPlan.commandText : "");
  const commandText = sanitizeExecApprovalDisplayText(commandTextSource);
  const previewSource =
    request.commandPreview ??
    (request.host === "node" ? (request.systemRunPlan?.commandPreview ?? null) : null);
  return {
    commandText,
    commandPreview: normalizePreview(commandText, previewSource),
  };
}
