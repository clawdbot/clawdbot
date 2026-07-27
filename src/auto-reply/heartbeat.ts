/** Heartbeat prompt defaults, token stripping, task parsing, and due-time helpers. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { escapeRegExp } from "../shared/regexp.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

// Default heartbeat prompt (used when config.agents.defaults.heartbeat.prompt is unset).
// Keep it tight and avoid encouraging the model to invent/rehash "open loops" from prior chat context.
export const HEARTBEAT_CRON_TASK_GUIDANCE =
  "Recurring tasks are cron jobs; create or change their schedules with cron tools or the openclaw cron CLI, not heartbeat scratch.";
const HEARTBEAT_CONTEXT_PROMPT = `Follow the heartbeat monitor scratch context when provided. ${HEARTBEAT_CRON_TASK_GUIDANCE} Do not infer or repeat old tasks from prior chats.`;
/** Default prompt for heartbeat turns when config does not override it. */
export const HEARTBEAT_PROMPT = `${HEARTBEAT_CONTEXT_PROMPT} If nothing needs attention, reply HEARTBEAT_OK.`;
export const HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS =
  "Use heartbeat_respond to report the wake outcome. Set notify=false when nothing needs the user's attention. Set notify=true with notificationText only when the user should be interrupted.";
export const HEARTBEAT_RESPONSE_TOOL_PROMPT = `${HEARTBEAT_CONTEXT_PROMPT} ${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS}`;
export const HEARTBEAT_TRANSCRIPT_PROMPT = "[OpenClaw heartbeat poll]";
export const DEFAULT_HEARTBEAT_EVERY = "30m";
export const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;

function stripLeadingHtmlCommentScaffolding(
  line: string,
  state: { inHtmlComment: boolean },
): string {
  let remaining = line;
  while (state.inHtmlComment || remaining.trimStart().startsWith("<!--")) {
    const searchText = state.inHtmlComment ? remaining : remaining.trimStart();
    const commentEnd = searchText.indexOf("-->");
    if (commentEnd === -1) {
      state.inHtmlComment = true;
      return "";
    }

    state.inHtmlComment = false;
    if (searchText === remaining) {
      remaining = remaining.slice(commentEnd + 3);
    } else {
      const leadingWidth = remaining.length - searchText.length;
      remaining = remaining.slice(0, leadingWidth) + searchText.slice(commentEnd + 3);
    }
  }
  return remaining;
}

function stripHeartbeatHtmlComments(content: string): string[] {
  const state = { inHtmlComment: false };
  return content.split("\n").map((line) => stripLeadingHtmlCommentScaffolding(line, state));
}

/**
 * Check if heartbeat scratch is "effectively empty" - meaning it has no actionable tasks.
 * This allows skipping heartbeat API calls when no tasks are configured.
 *
 * A file is considered effectively empty if it contains only:
 * - Whitespace / empty lines
 * - Markdown/HTML comments
 * - Markdown ATX headers (`#`, `##`, ...)
 * - One-line HTML comments (`<!-- ... -->`)
 * - Markdown fence markers such as ``` or ```markdown
 * - Empty list item stubs (`- `, `- [ ]`, `* `, `+ `)
 *
 * Note: Missing scratch returns false (not effectively empty) so the model can
 * still decide what to do. This function applies only when a scratch row exists.
 */
export function isHeartbeatContentEffectivelyEmpty(content: string | undefined | null): boolean {
  if (content === undefined || content === null) {
    return false;
  }
  if (typeof content !== "string") {
    return false;
  }

  const lines = stripHeartbeatHtmlComments(content);
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines
    if (!trimmed) {
      continue;
    }
    // Skip single-line HTML comments used by the bundled runtime template.
    if (/^<!--.*-->$/.test(trimmed)) {
      continue;
    }
    // Skip markdown header lines (# followed by space or EOL, ## etc)
    // This intentionally does NOT skip lines like "#TODO" or "#hashtag" which might be content
    // (Those aren't valid markdown headers - ATX headers require space after #)
    if (/^#+(\s|$)/.test(trimmed)) {
      continue;
    }
    if (/^<!--.*-->$/.test(trimmed)) {
      continue;
    }
    // Skip empty markdown list items like "- [ ]" or "* [ ]" or just "- "
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) {
      continue;
    }
    // Ignore markdown fence markers and HTML comments that only document the
    // workspace template; neither carries heartbeat task semantics.
    if (/^```[A-Za-z0-9_-]*$/.test(trimmed) || /^<!--.*-->$/.test(trimmed)) {
      continue;
    }
    // Found a non-empty, non-comment line - there's actionable content
    return false;
  }
  // All lines were either empty or comments
  return true;
}

/** Resolves configured heartbeat prompt text with the built-in default fallback. */
export function resolveHeartbeatPrompt(raw?: string): string {
  const trimmed = normalizeOptionalString(raw) ?? "";
  return trimmed || HEARTBEAT_PROMPT;
}

function appendHeartbeatResponseToolInstructions(prompt: string): string {
  const trimmed = normalizeOptionalString(prompt) ?? "";
  if (!trimmed) {
    return HEARTBEAT_RESPONSE_TOOL_PROMPT;
  }
  if (trimmed.includes(HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS)) {
    return trimmed;
  }
  return `${trimmed}\n\n${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS}`;
}

/** Resolves heartbeat prompt text and guarantees heartbeat_respond tool instructions are present. */
export function resolveHeartbeatPromptForResponseTool(raw?: string): string {
  const trimmed = normalizeOptionalString(raw) ?? "";
  return trimmed
    ? appendHeartbeatResponseToolInstructions(trimmed)
    : HEARTBEAT_RESPONSE_TOOL_PROMPT;
}

type StripHeartbeatMode = "heartbeat" | "message";

function stripTokenAtEdges(raw: string): { text: string; didStrip: boolean } {
  let text = raw.trim();
  if (!text) {
    return { text: "", didStrip: false };
  }

  const token = HEARTBEAT_TOKEN;
  const tokenAtEndWithOptionalTrailingPunctuation = new RegExp(
    `${escapeRegExp(token)}[^\\w]{0,4}$`,
  );
  if (!text.includes(token)) {
    return { text, didStrip: false };
  }

  let didStrip = false;
  let changed = true;
  while (changed) {
    changed = false;
    const next = text.trim();
    if (next.startsWith(token)) {
      const after = next.slice(token.length).trimStart();
      text = after;
      didStrip = true;
      changed = true;
      continue;
    }
    // Strip the token when it appears at the end of the text.
    // Also strip up to 4 trailing non-word characters the model may have appended
    // (e.g. ".", "!!!", "---"). Keep trailing punctuation only when real
    // sentence text exists before the token.
    if (tokenAtEndWithOptionalTrailingPunctuation.test(next)) {
      const idx = next.lastIndexOf(token);
      const before = next.slice(0, idx).trimEnd();
      if (!before) {
        text = "";
      } else {
        const after = next.slice(idx + token.length).trimStart();
        text = `${before}${after}`.trimEnd();
      }
      didStrip = true;
      changed = true;
    }
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  return { text: collapsed, didStrip };
}

/** Strips HEARTBEAT_OK acknowledgements and decides whether visible notification is needed. */
export function stripHeartbeatToken(
  raw?: string,
  opts: { mode?: StripHeartbeatMode; maxAckChars?: number } = {},
) {
  if (!raw) {
    return { shouldSkip: true, text: "", didStrip: false };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { shouldSkip: true, text: "", didStrip: false };
  }

  const mode: StripHeartbeatMode = opts.mode ?? "message";
  const maxAckCharsRaw = opts.maxAckChars;
  const parsedAckChars =
    typeof maxAckCharsRaw === "string" ? Number(maxAckCharsRaw) : maxAckCharsRaw;
  const maxAckChars = Math.max(
    0,
    typeof parsedAckChars === "number" && Number.isFinite(parsedAckChars)
      ? parsedAckChars
      : DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );

  // Normalize lightweight markup so HEARTBEAT_OK wrapped in HTML/Markdown
  // (e.g., <b>HEARTBEAT_OK</b> or **HEARTBEAT_OK**) still strips.
  const stripMarkup = (text: string) =>
    text
      // Drop HTML tags.
      .replace(/<[^>]*>/g, " ")
      // Decode common nbsp variant.
      .replace(/&nbsp;/gi, " ")
      // Remove markdown-ish wrappers at the edges.
      .replace(/^[*`~_]+/, "")
      .replace(/[*`~_]+$/, "");

  const trimmedNormalized = stripMarkup(trimmed);
  const hasToken = trimmed.includes(HEARTBEAT_TOKEN) || trimmedNormalized.includes(HEARTBEAT_TOKEN);
  if (!hasToken) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  const strippedOriginal = stripTokenAtEdges(trimmed);
  const strippedNormalized = stripTokenAtEdges(trimmedNormalized);
  const picked =
    strippedOriginal.didStrip && strippedOriginal.text ? strippedOriginal : strippedNormalized;
  if (!picked.didStrip) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  if (!picked.text) {
    return { shouldSkip: true, text: "", didStrip: true };
  }

  const rest = picked.text.trim();
  if (mode === "heartbeat") {
    if (rest.length <= maxAckChars) {
      return { shouldSkip: true, text: "", didStrip: true };
    }
  }

  return { shouldSkip: false, text: rest, didStrip: true };
}
