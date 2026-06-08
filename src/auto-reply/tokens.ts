/** Silent-reply and heartbeat tokens plus helpers for suppressing token-only model output. */
import { escapeRegExp } from "../shared/regexp.js";

/** Token that marks a heartbeat response as an acknowledgement with no user notification. */
export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
/** Token that marks an auto-reply response as intentionally silent. */
export const SILENT_REPLY_TOKEN = "NO_REPLY";

const HARMONY_CHANNEL_MARKER_RE = /^\s*(?:set-thought\s+)?<[\w]*\|[^>]*>\s*$/;
const BOX_DRAWING_HR_ONLY_RE = /^\s*─{3,}\s*$/;

export function isInternalFormattingArtifact(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return HARMONY_CHANNEL_MARKER_RE.test(text) || BOX_DRAWING_HR_ONLY_RE.test(text);
}

const silentExactRegexByToken = new Map<string, RegExp>();
const silentTrailingRegexByToken = new Map<string, RegExp>();
const silentLeadingAttachedRegexByToken = new Map<string, RegExp>();

function getSilentExactRegex(token: string): RegExp {
  const cached = silentExactRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  const regex = new RegExp(`^\\s*${escaped}(?:\\s+${escaped})*\\s*$`, "i");
  silentExactRegexByToken.set(token, regex);
  return regex;
}

function getSilentTrailingRegex(token: string): RegExp {
  const cached = silentTrailingRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  const regex = new RegExp(`(?:^|\\s+|\\*+)${escaped}\\s*$`, "i");
  silentTrailingRegexByToken.set(token, regex);
  return regex;
}

/** Returns true only for token-only silent replies. */
export function isSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  // Match only token-only replies, including repeated tokens separated by whitespace.
  // This prevents substantive replies ending with NO_REPLY from being suppressed (#19537).
  return getSilentExactRegex(token).test(text);
}

type SilentReplyActionEnvelope = { action?: unknown };

function isSilentReplyEnvelopeText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed || !trimmed.startsWith("{") || !trimmed.endsWith("}") || !trimmed.includes(token)) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as SilentReplyActionEnvelope;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const keys = Object.keys(parsed);
    return (
      keys.length === 1 &&
      keys[0] === "action" &&
      typeof parsed.action === "string" &&
      parsed.action.trim() === token
    );
  } catch {
    return false;
  }
}

const taggedReasoningPrefixRe =
  /^\s*<\s*(?:(?:antml:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>[\s\S]*?<\s*\/\s*(?:(?:antml:)?(?:think(?:ing)?|thought)|antthinking)\s*>\s*/i;
const openReasoningPrefixRe =
  /^\s*<\s*(?:(?:antml:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/i;
const plainReasoningPrefixRe = /^\s*(?:think(?:ing)?|thought|analysis|reasoning)\s*:?\s*\r?\n/i;

function stripLeadingReasoningBlocks(text: string): string {
  let current = text;
  while (true) {
    const next = current.replace(taggedReasoningPrefixRe, "");
    if (next === current) {
      return current;
    }
    current = next;
  }
}

function stripFinalSilentToken(text: string, token: string): string | null {
  const escaped = escapeRegExp(token);
  const stripped = text.replace(new RegExp(`(?:^|[\\s*.])${escaped}\\s*$`, "i"), "").trim();
  return stripped === text.trim() ? null : stripped;
}

const silentIntentTextRe =
  /^\s*(?:i|i'll|i\s+will|i'm|i\s+am|we|we'll|we\s+will|the\s+assistant|assistant|the\s+bot|bot|openclaw)\s+(?:(?:will\s+)?(?:stay|remain|keep|be)\s+(?:quiet|silent)(?:\s+(?:here|for\s+now|on\s+this|in\s+this\s+(?:chat|thread|channel|conversation)))?|(?:do\s+not|don't|dont|will\s+not|won't|would\s+not|should\s+not)\s+(?:reply|respond)(?:\s+(?:here|for\s+now|on\s+this|in\s+this\s+(?:chat|thread|channel|conversation)))?|(?:have|has)\s+nothing\s+(?:to|for)\s+(?:say|add|reply|respond))(?:[.!?]+)?\s*$/i;

function hasSilentIntentFinalSilentToken(text: string, token: string): boolean {
  const withoutToken = stripFinalSilentToken(text, token);
  if (withoutToken === null) {
    return false;
  }
  return !withoutToken || silentIntentTextRe.test(withoutToken);
}

const substantiveAnswerCueRe =
  /\b(?:answer|here(?:'s|\s+is)|tell\s+them|you\s+(?:should|can|could|need|must)|please|try|use|send|service\s+is|resolved|retry|yes|no,|sure)\b/i;
const bareReasoningPlaceholderRe =
  /^\s*(?:(?:internal|private)\s+)?(?:reasoning|thinking|thoughts?|analysis)(?:\s+notes?)?\s*$/i;

function hasPlainReasoningFinalSilentToken(text: string, token: string): boolean {
  const withoutToken = stripFinalSilentToken(text, token);
  if (withoutToken === null) {
    return false;
  }
  if (!withoutToken || silentIntentTextRe.test(withoutToken)) {
    return true;
  }
  const lines = withoutToken
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const finalLine = lines.at(-1);
  const previousLines = lines.slice(0, -1).join("\n");
  return (
    Boolean(
      finalLine &&
      silentIntentTextRe.test(finalLine) &&
      previousLines &&
      !substantiveAnswerCueRe.test(previousLines),
    ) || bareReasoningPlaceholderRe.test(withoutToken)
  );
}

function isReasoningPrefixedSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const withoutLeadingReasoningBlocks = stripLeadingReasoningBlocks(trimmed);
  if (withoutLeadingReasoningBlocks !== trimmed) {
    return (
      isSilentReplyText(withoutLeadingReasoningBlocks, token) ||
      hasSilentIntentFinalSilentToken(withoutLeadingReasoningBlocks, token)
    );
  }

  if (openReasoningPrefixRe.test(trimmed)) {
    const withoutOpenReasoningPrefix = trimmed.replace(openReasoningPrefixRe, "");
    return (
      isSilentReplyText(withoutOpenReasoningPrefix, token) ||
      hasPlainReasoningFinalSilentToken(withoutOpenReasoningPrefix, token)
    );
  }
  if (!plainReasoningPrefixRe.test(trimmed)) {
    return false;
  }
  const withoutPlainReasoningPrefix = trimmed.replace(plainReasoningPrefixRe, "");
  return (
    isSilentReplyText(withoutPlainReasoningPrefix, token) ||
    hasPlainReasoningFinalSilentToken(withoutPlainReasoningPrefix, token)
  );
}

/** Returns true for token-only, JSON-envelope, or reasoning-prefixed silent payload text. */
export function isSilentReplyPayloadText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  return (
    isSilentReplyText(text, token) ||
    isSilentReplyEnvelopeText(text, token) ||
    isReasoningPrefixedSilentReplyText(text, token)
  );
}

/**
 * Strip a trailing silent reply token from mixed-content text.
 * Returns the remaining text with the token removed (trimmed).
 * If the result is empty, the entire message should be treated as silent.
 */
export function stripSilentToken(text: string, token: string = SILENT_REPLY_TOKEN): string {
  return text.replace(getSilentTrailingRegex(token), "").trim();
}

const silentLeadingRegexByToken = new Map<string, RegExp>();

function getSilentLeadingAttachedRegex(token: string): RegExp {
  const cached = silentLeadingAttachedRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  // Match one or more leading occurrences of the token where the final token
  // is glued directly to visible word-start content (for example
  // `NO_REPLYhello`), without treating punctuation-start text like
  // `NO_REPLY: explanation` as a silent prefix.
  const regex = new RegExp(`^\\s*(?:${escaped}\\s+)*${escaped}(?=[\\p{L}\\p{N}])`, "iu");
  silentLeadingAttachedRegexByToken.set(token, regex);
  return regex;
}

function getSilentLeadingRegex(token: string): RegExp {
  const cached = silentLeadingRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  // Match one or more leading occurrences of the token, each optionally followed by whitespace
  const regex = new RegExp(`^(?:\\s*${escaped})+\\s*`, "i");
  silentLeadingRegexByToken.set(token, regex);
  return regex;
}

/**
 * Strip leading silent reply tokens from text.
 * Handles cases like "NO_REPLYThe user is saying..." where the token
 * is not separated from the following text.
 */
export function stripLeadingSilentToken(text: string, token: string = SILENT_REPLY_TOKEN): string {
  return text.replace(getSilentLeadingRegex(token), "").trim();
}

/**
 * Check whether text starts with one or more leading silent reply tokens where
 * the final token is glued directly to visible content.
 */
export function startsWithSilentToken(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  return getSilentLeadingAttachedRegex(token).test(text);
}

export function isSilentReplyPrefixText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trimStart();
  if (!trimmed) {
    return false;
  }
  // Guard against suppressing natural-language "No..." text while still
  // catching uppercase lead fragments like "NO" from streamed NO_REPLY.
  if (trimmed !== trimmed.toUpperCase()) {
    return false;
  }
  const normalized = trimmed.toUpperCase();
  if (!normalized) {
    return false;
  }
  if (normalized.length < 2) {
    return false;
  }
  if (/[^A-Z_]/.test(normalized)) {
    return false;
  }
  const tokenUpper = token.toUpperCase();
  if (!tokenUpper.startsWith(normalized)) {
    return false;
  }
  if (normalized.includes("_")) {
    return true;
  }
  // Keep underscore guard for generic tokens to avoid suppressing unrelated
  // uppercase words (e.g. HEART/HE with HEARTBEAT_OK). Only allow bare "NO"
  // because NO_REPLY streaming can transiently emit that fragment.
  return tokenUpper === SILENT_REPLY_TOKEN && normalized === "NO";
}
