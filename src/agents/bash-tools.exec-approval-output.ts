// Formats command output for the model continuation sent after an approved async exec
// completes. This is deliberately separate from the compact background `notifyOnExit`
// notification path: a notification is a glance, a continuation is what the agent must
// work from, so it keeps whitespace and stays large enough to be useful.

import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

// The continuation re-enters the run as a user follow-up, so it bypasses the live
// tool-result guard in attempt-context-guards. Bound it here at the same order of
// magnitude as DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS so one long-running command cannot
// flood the resumed context.
const MAX_UTF16_UNITS = 16_000;

// Command output usually opens with context and closes with the result or error, so keep
// both ends rather than a single window.
const HEAD_SHARE = 0.75;

// Intentionally reports no omission count. Output can already be capped at capture time
// (bash-process-registry `trimWithCap` drops the head at DEFAULT_MAX_OUTPUT and leaves no
// marker), so an exact number here would describe only this cut while reading as though
// nothing else was lost. "may" is the strongest honest claim available at this boundary.
const TRUNCATION_MARKER =
  "[... truncated to fit the continuation budget; more output may have been dropped when it was captured ...]";

/** Backs a cut off to a line break so a generated stream header is never split. */
function alignHeadToLineBreak(text: string): string {
  const lastBreak = text.lastIndexOf("\n");
  return lastBreak > text.length / 2 ? text.slice(0, lastBreak) : text;
}

/** Advances a cut past a line break so a generated stream header is never split. */
function alignTailToLineBreak(text: string): string {
  const firstBreak = text.indexOf("\n");
  return firstBreak >= 0 && firstBreak < text.length / 2 ? text.slice(firstBreak + 1) : text;
}

function capContinuationOutput(text: string): string {
  if (text.length <= MAX_UTF16_UNITS) {
    return text;
  }
  // The marker and its two surrounding newlines are spent from the same budget so the
  // rendered result never exceeds the cap.
  const cutBudget = MAX_UTF16_UNITS - TRUNCATION_MARKER.length - 2;
  const headBudget = Math.floor(cutBudget * HEAD_SHARE);
  const head = alignHeadToLineBreak(truncateUtf16Safe(text, headBudget));
  const tail = alignTailToLineBreak(sliceUtf16Safe(text, text.length - (cutBudget - headBudget)));
  return `${head}\n${TRUNCATION_MARKER}\n${tail}`;
}

/**
 * Renders approved exec output for the agent continuation, preserving whitespace exactly.
 *
 * Streams are emitted in the given order and labelled only when more than one carries
 * content, so the common single-stream case stays byte-identical to the command output.
 * The node payload supplies separate fields, so this order is not a claim about
 * chronological stdout/stderr interleaving.
 */
export function formatExecApprovalContinuationOutput(
  streams: readonly { label: string; value?: string | null }[],
): string {
  const present = streams.filter((stream) => (stream.value ?? "") !== "");
  const [only] = present;
  if (!only) {
    return "";
  }
  const rendered =
    present.length === 1
      ? (only.value ?? "")
      : present.map((stream) => `[${stream.label}]\n${stream.value ?? ""}`).join("\n");
  return capContinuationOutput(rendered);
}
