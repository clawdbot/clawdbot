/** Appends channel-supplied prompt context to the user-role body under a marked label. */
import { truncateUtf16Safe } from "../../utils.js";
import { INBOUND_CONTEXT_MARKER, markInboundContextLabel } from "./inbound-context-marker.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";

/**
 * The fixed marker lets strippers recognize OpenClaw-injected context; it is not
 * a trust guardrail. Trust guidance travels with each entry instead
 * (`buildChannelMetadata` wraps entries in `wrapExternalContent`, whose SECURITY
 * NOTICE carries the do-not-obey clause).
 */
export function appendChannelPromptContext(base: string, channelPromptContext?: string[]): string {
  if (!Array.isArray(channelPromptContext) || channelPromptContext.length === 0) {
    return base;
  }
  const entries = channelPromptContext
    .map((entry) => normalizeInboundTextNewlines(entry))
    .filter((entry) => Boolean(entry));
  if (entries.length === 0) {
    return base;
  }
  // The string form is one model-visible context block like the fenced JSON
  // blocks, so it shares their cumulative budget (MAX_CONTEXT_JSON_BLOCK_CHARS):
  // it reaches the prompt through prompt-prelude.ts, outside the inbound
  // context assembly budget, so without this bound a plugin supplying thousands
  // of strings floods the prompt prelude in full. Keep the head like
  // truncateContextJsonString does, and flag the drop.
  const kept: string[] = [];
  const header = markInboundContextLabel("Context:");
  // Charge the exact model-visible framing as well as entry content. The
  // direct string path bypasses the inbound assembly budget, so delimiters
  // must not create a second unbounded channel. `[header, ...kept].join("\n")`
  // renders one separator before every kept line (the header is always first),
  // and the exhaustion marker needs a line of its own, so both are reserved
  // before any entry is retained.
  let budgetRemaining =
    MAX_CONTEXT_JSON_BLOCK_CHARS -
    header.length -
    (BUDGET_TRUNCATION_MARKER.length + LINE_SEPARATOR_CHARS);
  let budgetExhausted = false;
  for (const entry of entries) {
    const renderedLength = entry.length + LINE_SEPARATOR_CHARS;
    if (renderedLength <= budgetRemaining) {
      budgetRemaining -= renderedLength;
      kept.push(entry);
      continue;
    }
    // Head-keep whatever still fits on its own line beside the reserved
    // marker, like truncateContextJsonString does, and flag the drop.
    const available = budgetRemaining - LINE_SEPARATOR_CHARS - STRING_TRUNCATION_SUFFIX.length;
    if (available > 0) {
      kept.push(`${truncateUtf16Safe(entry, available).trimEnd()}${STRING_TRUNCATION_SUFFIX}`);
    }
    budgetExhausted = true;
    break;
  }
  if (budgetExhausted) {
    kept.push(BUDGET_TRUNCATION_MARKER);
  }
  const block = [header, ...kept].join("\n");
  return [base, block].filter(Boolean).join("\n\n");
}

export const MAX_CONTEXT_JSON_STRING_CHARS = 2_000;
// Same untrusted-entry budget as inbound-meta.ts (MAX_UNTRUSTED_HISTORY_ENTRIES):
// repeated channel-supplied entries are capped at that count.
const MAX_CONTEXT_JSON_ARRAY_ENTRIES = 20;
// The largest first-party payload (the Conversation info block) carries ~25 keys;
// 50 leaves headroom while bounding channel-controlled key fan-out.
const MAX_CONTEXT_JSON_OBJECT_KEYS = 50;
// The deepest first-party payload nests 2 levels (measured: Conversation info,
// reply chain); 8 leaves 4x headroom while bounding channel-controlled nesting.
const MAX_CONTEXT_JSON_DEPTH = 8;
// The largest measured first-party block is a 10-link reply chain at ~19k
// serialized chars (each body already capped at MAX_CONTEXT_JSON_STRING_CHARS);
// 50k is ~2.6x that while bounding the cumulative fan-out the per-container caps
// alone allow (50 keys x 20 entries x 2,000 chars would otherwise serialize ~2 MB
// into a single block). The string-form block in appendChannelPromptContext
// shares this budget: both forms are one model-visible context block each.
const MAX_CONTEXT_JSON_BLOCK_CHARS = 50_000;

const DEPTH_TRUNCATION_MARKER = "…[truncated: max depth reached]";
const BUDGET_TRUNCATION_MARKER = "…[truncated: context budget exhausted]";
const STRING_TRUNCATION_SUFFIX = "…[truncated]";
// One char per `join("\n")` separator in the string-context block.
const LINE_SEPARATOR_CHARS = 1;
// Chars formatContextJsonBlock renders around the serialized payload:
// "```json" + "```" plus the three newlines `join("\n")` inserts.
const JSON_BLOCK_FENCE_CHARS = "```json".length + "```".length + 3;
// Punctuation JSON.stringify adds around the budgeted values of the ROOT
// container only. Nested containers are already charged exactly, because a
// parent commits `serializedLength(sanitized)` for the whole retained subtree.
// The root pays for its own braces, one colon and one comma per retained key,
// and the exhaustion marker property appended after the budget loop.
const MAX_ROOT_JSON_PUNCTUATION_CHARS =
  2 + MAX_CONTEXT_JSON_OBJECT_KEYS * 2 + BUDGET_TRUNCATION_MARKER.length + 8;

export function neutralizeMarkdownFences(value: string): string {
  return value.replaceAll("```", "`\u200b``");
}

function truncateContextJsonString(value: string): string {
  if (value.length <= MAX_CONTEXT_JSON_STRING_CHARS) {
    return value;
  }
  return `${truncateUtf16Safe(value, Math.max(0, MAX_CONTEXT_JSON_STRING_CHARS - 14)).trimEnd()}…[truncated]`;
}

/** Serialized length as JSON.stringify would emit it (undefined-safe). */
function serializedLength(value: unknown): number {
  const serialized: string | undefined = JSON.stringify(value);
  return serialized?.length ?? 0;
}

/**
 * Cumulative serialized-character budget shared across one block's recursion.
 * The per-container caps bound fan-out; this bounds the total, which they
 * cannot (50 keys x 20 entries x 2,000 chars passes every per-level cap).
 */
type ContextJsonBudget = { remaining: number };

function sanitizeContextJsonValue(
  value: unknown,
  budget: ContextJsonBudget,
  depth: number,
): unknown {
  if (typeof value === "string") {
    return neutralizeMarkdownFences(truncateContextJsonString(value));
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_CONTEXT_JSON_DEPTH) {
      return DEPTH_TRUNCATION_MARKER;
    }
    const kept = value.slice(0, MAX_CONTEXT_JSON_ARRAY_ENTRIES);
    const result: unknown[] = [];
    let omitted = value.length - kept.length;
    let budgetExhausted = false;
    for (const entry of kept) {
      if (budget.remaining <= 0) {
        omitted += 1;
        budgetExhausted = true;
        continue;
      }
      // Sanitize against a scratch budget; this parent commits the retained
      // element's serialized size exactly once below.
      const scratch: ContextJsonBudget = { remaining: budget.remaining };
      const sanitized = sanitizeContextJsonValue(entry, scratch, depth + 1);
      const entrySize = serializedLength(sanitized);
      if (entrySize > budget.remaining) {
        omitted += 1;
        budgetExhausted = true;
        continue;
      }
      budget.remaining -= entrySize;
      result.push(sanitized);
    }
    // Keep the head like truncateContextJsonString does, and flag the drop.
    if (budgetExhausted) {
      result.push(BUDGET_TRUNCATION_MARKER);
    } else if (omitted > 0) {
      result.push(`…[truncated: ${omitted} more ${omitted === 1 ? "entry" : "entries"}]`);
    }
    return result;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_CONTEXT_JSON_DEPTH) {
    return DEPTH_TRUNCATION_MARKER;
  }
  const entries = Object.entries(value);
  const kept = entries.slice(0, MAX_CONTEXT_JSON_OBJECT_KEYS);
  const result: Array<readonly [string, unknown]> = [];
  let omitted = entries.length - kept.length;
  let budgetExhausted = false;
  for (const [key, entry] of kept) {
    if (budget.remaining <= 0) {
      omitted += 1;
      budgetExhausted = true;
      continue;
    }
    // Keys are channel-controlled text too: cap them like string values and
    // charge them to the budget so key fan-out cannot bypass the total.
    const safeKey = neutralizeMarkdownFences(truncateContextJsonString(key));
    // Reserve the nested value against a scratch budget: the recursion debits
    // as it works, and the property is committed to the shared budget only
    // when accepted whole. Debiting the shared budget during recursion and
    // then again for the retained value would charge nested containers twice
    // and drop properties that actually fit.
    const scratch: ContextJsonBudget = { remaining: budget.remaining };
    const sanitized = sanitizeContextJsonValue(entry, scratch, depth + 1);
    // Reserve the property's serialized size before appending: JSON.stringify
    // emits the key with quotes and escapes (a key of N raw chars can emit ~2N
    // chars), so charging raw key length would let escaped keys push the block
    // to nearly twice the budget while the counter stays under it.
    const propertySize = serializedLength(safeKey) + serializedLength(sanitized);
    if (propertySize > budget.remaining) {
      omitted += 1;
      budgetExhausted = true;
      continue;
    }
    budget.remaining -= propertySize;
    result.push([safeKey, sanitized] as const);
  }
  // Truncation flag mirrors the sibling `history_truncated: true` convention.
  if (budgetExhausted) {
    result.push([BUDGET_TRUNCATION_MARKER, true] as const);
  } else if (omitted > 0) {
    result.push([`…[truncated: ${omitted} more ${omitted === 1 ? "key" : "keys"}]`, true] as const);
  }
  return Object.fromEntries(result);
}

const INBOUND_CONTEXT_MARKER_SUFFIX = ` ${INBOUND_CONTEXT_MARKER}`;

/**
 * Caps the label like any other channel-controlled string. Structured-context
 * entries carry their own label (`ChannelStructuredContext.label`), normalized
 * on the way here but not length-bounded, and the block renders it whole: a
 * label longer than the budget drives `remaining` negative while still being
 * emitted, so the stated per-block cap would not hold.
 *
 * The provenance marker is re-appended after the cut. Strippers key on that
 * trailing marker rather than on label text (`inbound-context-marker.ts`), so
 * truncating it away would silently stop detection.
 */
function truncateContextJsonLabel(label: string): string {
  if (label.length <= MAX_CONTEXT_JSON_STRING_CHARS) {
    return label;
  }
  const suffix = label.endsWith(INBOUND_CONTEXT_MARKER_SUFFIX) ? INBOUND_CONTEXT_MARKER_SUFFIX : "";
  const head = label.slice(0, label.length - suffix.length);
  const available = Math.max(
    0,
    MAX_CONTEXT_JSON_STRING_CHARS - suffix.length - STRING_TRUNCATION_SUFFIX.length,
  );
  return `${truncateUtf16Safe(head, available).trimEnd()}${STRING_TRUNCATION_SUFFIX}${suffix}`;
}

export function formatContextJsonBlock(label: string, payload: unknown): string {
  // Reserve everything the block renders around the budgeted payload (the
  // label line, the fences, the newlines, and the root container's own
  // punctuation) so the rendered block stays at or below the stated cap.
  const boundedLabel = truncateContextJsonLabel(label);
  const budget: ContextJsonBudget = {
    remaining:
      MAX_CONTEXT_JSON_BLOCK_CHARS -
      boundedLabel.length -
      JSON_BLOCK_FENCE_CHARS -
      MAX_ROOT_JSON_PUNCTUATION_CHARS,
  };
  return [
    boundedLabel,
    "```json",
    JSON.stringify(sanitizeContextJsonValue(payload, budget, 0)),
    "```",
  ].join("\n");
}
