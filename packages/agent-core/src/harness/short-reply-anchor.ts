// Agent Core module implements the short-reply anchor directive.
//
// Background
// ==========
// When a user answers with a very short selection like "2", "yes", or
// "that one", the model has to resolve the referent. In long transcripts
// (especially after one or more compaction summaries) a stronger/older
// enumerated list can out-rank the assistant's most recent list and the
// model happily binds the short reply to the stale referent.
//
// This module produces a deterministic, ephemeral system-prompt suffix
// that only fires when the trailing user message actually looks like a
// short selection reply. It costs zero tokens on every other turn.
//
// The fix is at the framework layer (not a workspace-file suggestion)
// because the failure mode is a property of how the LLM resolves
// coreference across the assembled context, not of any one deployment.

import type { Message, TextContent, UserMessage } from "@openclaw/llm-core";

/** Max characters of user text we still consider a "short reply". */
export const SHORT_REPLY_MAX_CHARS = 40;

/**
 * Ephemeral system-prompt suffix appended when the trailing user turn is a
 * short selection. Instructs the model to bind the reply to the most recent
 * assistant turn (or ask for clarification) instead of reaching back to an
 * earlier enumerated list that survived in the context window.
 *
 * Exported so tests and downstream tooling can assert on the exact string.
 */
export const SHORT_REPLY_ANCHOR_DIRECTIVE = [
  "<short_reply_anchor>",
  "The user's most recent turn is a very short selection or acknowledgement",
  '(for example "2", "yes", "that one", "the second"). Resolve it against',
  "the assistant's MOST RECENT turn only — typically the last enumerated",
  "list, question, or set of options the assistant offered. Do not reach",
  "back to earlier turns, tool results, or compaction summaries to pick a",
  "referent, even if an older list feels like a better match.",
  "",
  "If the most recent assistant turn does not contain a plausible referent",
  "for the short reply, ask the user for clarification rather than guess.",
  "Never silently bind the reply to a stale list.",
  "</short_reply_anchor>",
].join("\n");

// Case-insensitive short-selection lexicon. Kept intentionally narrow: we
// want false negatives (do nothing) rather than false positives (nudge the
// model when the user actually wrote a substantive reply).
const SHORT_SELECTION_PATTERNS: readonly RegExp[] = [
  // Bare digits, 1–2 digits, with optional trailing punctuation. Covers "2", "2.", "12)".
  /^\d{1,2}[.)!?]?$/,
  // Ordinal words on their own or with "one" / "option".
  /^(?:the\s+)?(?:first|second|third|fourth|fifth|last|other|next|previous)(?:\s+one|\s+option)?[.!?]?$/,
  // Deictic selection.
  /^(?:this|that|these|those)(?:\s+one)?[.!?]?$/,
  // Yes/no family and short acknowledgements.
  /^(?:y|n|yes|no|yep|nope|yeah|nah|ok|okay|k|sure|please|do it|go|go ahead|sounds good|works for me)[.!?]?$/,
  // Quantifier picks.
  /^(?:both|all|none|neither|either)[.!?]?$/,
  // Letter picks like "a", "b." or "option c".
  /^(?:option\s+)?[a-e][.)!?]?$/,
];

/**
 * True when the given user text should be treated as a short selection reply.
 *
 * Exported so downstream code (custom `transformContext` implementations,
 * tests) can share the classifier instead of drifting from it.
 */
export function matchesShortSelectionReply(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > SHORT_REPLY_MAX_CHARS) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  for (const pattern of SHORT_SELECTION_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }
  return false;
}

function extractUserText(message: UserMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push((block as TextContent).text);
    }
  }
  return parts.join("\n");
}

/**
 * True when `messages` contains at least one assistant turn ahead of the
 * given index. Without a prior assistant turn there is no "most recent list"
 * for the anchor to point at, so the directive would be noise.
 */
function hasPriorAssistantTurn(messages: readonly Message[], userIndex: number): boolean {
  for (let i = userIndex - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") {
      return true;
    }
  }
  return false;
}

/**
 * Locate the last "real" user message (skipping OpenClaw runtime-context
 * carrier messages, which are volatile per-turn framing rather than the
 * human's actual reply).
 */
function findTrailingUserMessage(
  messages: readonly Message[],
): { message: UserMessage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "user") {
      continue;
    }
    const userMessage = message as UserMessage;
    if (userMessage.runtimeContextCarrier) {
      continue;
    }
    return { message: userMessage, index: i };
  }
  return undefined;
}

/**
 * Returns `true` when the given messages array ends in a short-selection
 * user reply that a coreference-resolving model could plausibly bind to a
 * stale earlier list.
 */
export function shouldApplyShortReplyAnchor(messages: readonly Message[]): boolean {
  const trailing = findTrailingUserMessage(messages);
  if (!trailing) {
    return false;
  }
  if (!hasPriorAssistantTurn(messages, trailing.index)) {
    return false;
  }
  return matchesShortSelectionReply(extractUserText(trailing.message));
}

/**
 * Append {@link SHORT_REPLY_ANCHOR_DIRECTIVE} to `systemPrompt` when the
 * trailing user message is a short selection reply. Otherwise returns
 * `systemPrompt` unchanged.
 *
 * This is applied at the LLM-call boundary and does not mutate persisted
 * transcript state; the directive is ephemeral and rebuilt each turn.
 */
export function applyShortReplyAnchor(
  systemPrompt: string,
  messages: readonly Message[],
): string {
  if (!shouldApplyShortReplyAnchor(messages)) {
    return systemPrompt;
  }
  if (systemPrompt.length === 0) {
    return SHORT_REPLY_ANCHOR_DIRECTIVE;
  }
  return `${systemPrompt}\n\n${SHORT_REPLY_ANCHOR_DIRECTIVE}`;
}
