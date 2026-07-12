/** Silent-reply and heartbeat tokens plus helpers for suppressing token-only model output. */
import { escapeRegExp } from "../shared/regexp.js";
import {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "./continuation/targeting-pure.js";
import type { ContinuationSignal } from "./continuation/types.js";

/** Token that marks a heartbeat response as an acknowledgement with no user notification. */
export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
/** Token that marks an auto-reply response as intentionally silent. */
export const SILENT_REPLY_TOKEN = "NO_REPLY";
export const CONTINUE_WORK_TOKEN = "CONTINUE_WORK";

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

function stripEdgePunctuation(text: string): string {
  return text.replace(/^\p{P}+|\p{P}+$/gu, "");
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
  // Models sometimes wrap the token in punctuation. Preserve exact custom-token matching,
  // but keep symbols such as emoji substantive so they are still delivered.
  return (
    getSilentExactRegex(token).test(text) ||
    getSilentExactRegex(token).test(stripEdgePunctuation(text.trim()))
  );
}

type SilentReplyActionEnvelope = { action?: unknown };

function isSilentReplyJsonStringText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || !trimmed.includes(token)) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "string" && parsed.trim() === token;
  } catch {
    return false;
  }
}

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
  /^\s*<\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>[\s\S]*?<\s*\/\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\s*>\s*/i;
const openReasoningPrefixRe =
  /^\s*<\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/i;
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
    isSilentReplyJsonStringText(text, token) ||
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
  const tokenUpper = token.toUpperCase();
  if (!tokenUpper.startsWith(normalized)) {
    return false;
  }
  if (normalized.includes("_")) {
    return true;
  }
  // Full-token match is safe for any token.
  if (normalized === tokenUpper) {
    return true;
  }
  // For custom tokens containing non-letter characters (digits, hyphens),
  // only match if the prefix includes at least one non-letter character
  // from the token. Otherwise, a pure-letter prefix like "HE" for "HELP-QUIET"
  // would suppress natural language that happens to share that prefix (#100007).
  if (/[^A-Z_]/.test(tokenUpper)) {
    return /[^A-Z_]/.test(normalized);
  }
  return tokenUpper === SILENT_REPLY_TOKEN && normalized === "NO";
}

// ============================================================================
// Continuation signal parsing
// ============================================================================

export type { ContinuationSignal };

type DelegateDirectiveParse = { status: "applied" } | { status: "unknown" } | { status: "invalid" };

type DelegateDirectiveState = {
  silent?: boolean;
  silentWake?: boolean;
  postCompaction?: boolean;
  targetSessionKey?: string;
  targetSessionKeys?: string[];
  fanoutMode?: "tree" | "all";
  model?: string;
};

function splitDirectiveAssignment(segment: string): { key: string; value: string } | null {
  const separator = segment.indexOf("=");
  if (separator < 0) {
    return null;
  }
  return {
    key: segment.slice(0, separator).trim().toLowerCase(),
    value: segment.slice(separator + 1).trim(),
  };
}

function parseDelegateDirective(
  segment: string,
  state: DelegateDirectiveState,
): DelegateDirectiveParse {
  const normalized = segment.trim().toLowerCase();
  if (!normalized) {
    return { status: "invalid" };
  }
  if (normalized === "normal") {
    return { status: "applied" };
  }
  if (normalized === "silent-wake" || normalized === "silent wake") {
    state.silentWake = true;
    state.silent = undefined;
    return { status: "applied" };
  }
  if (normalized === "silent") {
    state.silent = true;
    return { status: "applied" };
  }
  // Post-compaction stages the delegate for release after the next compaction
  // seam instead of dispatching now or on a timer. Mirrors the tool-form
  // mode="post-compaction" branch (see continue-delegate-tool.ts) and is
  // exclusive with silent/silent-wake — staging applies silentAnnounce +
  // wakeOnReturn at release time.
  if (
    normalized === "post-compaction" ||
    normalized === "postcompaction" ||
    normalized === "post compaction"
  ) {
    state.postCompaction = true;
    state.silent = undefined;
    state.silentWake = undefined;
    return { status: "applied" };
  }

  const assignment = splitDirectiveAssignment(segment);
  if (!assignment) {
    return { status: "unknown" };
  }

  if (
    assignment.key === "target" ||
    assignment.key === "targetsessionkey" ||
    assignment.key === "target_session_key"
  ) {
    const targetSessionKey = normalizeContinuationTargetKey(assignment.value);
    if (!targetSessionKey) {
      return { status: "invalid" };
    }
    state.targetSessionKey = targetSessionKey;
    return { status: "applied" };
  }

  if (
    assignment.key === "targets" ||
    assignment.key === "targetsessionkeys" ||
    assignment.key === "target_session_keys"
  ) {
    const targetSessionKeys = normalizeContinuationTargetKeys(assignment.value.split(","));
    if (targetSessionKeys.length === 0) {
      return { status: "invalid" };
    }
    state.targetSessionKeys = targetSessionKeys;
    return { status: "applied" };
  }

  if (
    assignment.key === "fanout" ||
    assignment.key === "fanoutmode" ||
    assignment.key === "fanout_mode"
  ) {
    const fanoutMode = assignment.value.trim().toLowerCase();
    if (!CONTINUATION_DELEGATE_FANOUT_MODES.includes(fanoutMode as "tree" | "all")) {
      return { status: "invalid" };
    }
    state.fanoutMode = fanoutMode as "tree" | "all";
    return { status: "applied" };
  }

  if (assignment.key === "traceparent" || assignment.key === "trace_parent") {
    // Diagnostic context is runtime-owned. Consume the legacy/hidden directive
    // so it cannot become task text, but never let model output choose tracing.
    return { status: "applied" };
  }

  if (assignment.key === "model") {
    // Provider/model override forwarded to the spawned delegate. The model ref
    // is not validated here; unknown models resolve downstream at spawn time,
    // mirroring sessions_spawn. An empty value is malformed and rejects the token.
    // The "default" sentinel means "inherit the parent model" (no override),
    // matching the tool form's normalizeToolModelOverride so both surfaces agree.
    if (!assignment.value) {
      return { status: "invalid" };
    }
    if (assignment.value.toLowerCase() !== "default") {
      state.model = assignment.value;
    }
    return { status: "applied" };
  }

  return { status: "unknown" };
}

function parseDelegateBodyDirectives(taskBody: string): {
  taskBody: string;
  directives: DelegateDirectiveState;
} | null {
  const segments = taskBody.split("|").map((segment) => segment.trim());
  const directives: DelegateDirectiveState = {};
  while (segments.length > 1) {
    const segment = segments.at(-1) ?? "";
    const parsed = parseDelegateDirective(segment, directives);
    if (parsed.status === "unknown") {
      break;
    }
    if (parsed.status === "invalid") {
      return null;
    }
    segments.pop();
  }
  if (
    directives.fanoutMode &&
    (directives.targetSessionKey ||
      (directives.targetSessionKeys && directives.targetSessionKeys.length > 0))
  ) {
    return null;
  }
  return {
    taskBody: segments.join(" | ").trim(),
    directives,
  };
}

/**
 * Checks if the agent response ends with a continuation signal.
 * Returns the parsed signal or null if no continuation is requested.
 *
 * Formats:
 *   CONTINUE_WORK              → continue with default delay
 *   CONTINUE_WORK:30           → continue after 30 seconds
 *   [[CONTINUE_DELEGATE: task]]      → spawn sub-agent with task immediately
 *   [[CONTINUE_DELEGATE: task +30s]] → spawn sub-agent after 30-second delay
 *   [[CONTINUE_DELEGATE: task | target=session-key]]
 *   [[CONTINUE_DELEGATE: task | targets=key1,key2]]
 *   [[CONTINUE_DELEGATE: task | fanout=tree]]
 *
 * The `+Ns` suffix on DELEGATE specifies a timer offset before the sub-agent
 * spawns (delegate-as-scheduler pattern). Timers do not survive gateway restarts.
 *
 * DELEGATE uses bracket syntax ([[...]]) following the repo convention for tokens
 * that carry body content (see reply_to, tts, line directives). Brackets naturally
 * delimit the boundary, so multiline tasks work without ambiguity.
 */
export function parseContinuationSignal(text: string | undefined): ContinuationSignal | null {
  if (!text) {
    return null;
  }

  const trimmed = text.trim();

  // Check for [[CONTINUE_DELEGATE: task]] at end of response.
  // The bracket pair [[ ... ]] delimits the body, so multiline tasks are safe.
  // The negative lookahead (?!\]\]) prevents ]] inside the body from prematurely
  // closing the bracket, and ensures we match the LAST [[CONTINUE_DELEGATE:]] when
  // the same token appears mid-text earlier in the response.
  const delegateMatch = trimmed.match(
    /\[\[\s*CONTINUE_DELEGATE:\s*((?:(?!\]\])[\s\S])+?)\s*\]\]\s*$/,
  );
  const delegateBody = delegateMatch?.[1];
  if (delegateBody) {
    let taskBody = delegateBody.trim();
    const parsedBody = parseDelegateBodyDirectives(taskBody);
    if (!parsedBody) {
      return null;
    }
    taskBody = parsedBody.taskBody;
    const {
      silent,
      silentWake,
      postCompaction,
      targetSessionKey,
      targetSessionKeys,
      fanoutMode,
      model,
    } = parsedBody.directives;

    // Parse optional +Ns delay suffix (e.g. "+30s", "+5s")
    let delayMs: number | undefined;
    const delayMatch = taskBody.match(/\s+\+(\d+)s\s*$/);
    const delaySuffix = delayMatch?.[0];
    const delaySeconds = delayMatch?.[1];
    if (delaySuffix && delaySeconds) {
      delayMs = Number.parseInt(delaySeconds, 10) * 1000;
      taskBody = taskBody.slice(0, -delaySuffix.length).trimEnd();
    }
    if (taskBody) {
      // Truncate overly long task strings to prevent context-dumping patterns.
      // Same limit as the continue_delegate tool schema (4096 chars).
      const maxTaskLength = 4096;
      const truncatedTask =
        taskBody.length > maxTaskLength ? taskBody.slice(0, maxTaskLength) : taskBody;
      return {
        kind: "delegate",
        task: truncatedTask,
        delayMs,
        silent,
        silentWake,
        ...(postCompaction ? { postCompaction } : {}),
        ...(targetSessionKey ? { targetSessionKey } : {}),
        ...(targetSessionKeys && targetSessionKeys.length > 0 ? { targetSessionKeys } : {}),
        ...(fanoutMode ? { fanoutMode } : {}),
        ...(model ? { model } : {}),
      };
    }
  }

  // Check for [[CONTINUE_WORK]] or [[CONTINUE_WORK:<delay>]] at end of response.
  // This mirrors the bracket convention used by CONTINUE_DELEGATE and keeps
  // tool-less / light-context continuation surfaces from depending on the bare
  // token form alone. Keep this grammar narrow: only a terminal bracket token is
  // consumed, and bracket text elsewhere in the reply is left alone.
  const bracketWorkMatch = trimmed.match(/\[\[\s*CONTINUE_WORK(?::(\d+))?\s*\]\]\s*$/);
  if (bracketWorkMatch) {
    const delaySec = bracketWorkMatch[1] ? Number.parseInt(bracketWorkMatch[1], 10) : undefined;
    return {
      kind: "work",
      delayMs: delaySec !== undefined ? delaySec * 1000 : undefined,
    };
  }

  // Check for CONTINUE_WORK or CONTINUE_WORK:<delay> at end of response
  const workMatch = trimmed.match(/\bCONTINUE_WORK(?::(\d+))?\s*$/);
  if (workMatch) {
    const delaySec = workMatch[1] ? Number.parseInt(workMatch[1], 10) : undefined;
    return {
      kind: "work",
      delayMs: delaySec !== undefined ? delaySec * 1000 : undefined,
    };
  }

  return null;
}

/**
 * Strips the continuation signal from the response text, returning the
 * displayable text and the parsed signal separately.
 */
export function stripContinuationSignal(text: string): {
  text: string;
  signal: ContinuationSignal | null;
} {
  const signal = parseContinuationSignal(text);
  if (!signal) {
    return { text, signal: null };
  }

  let stripped: string;
  if (signal.kind === "delegate") {
    // Strip the [[CONTINUE_DELEGATE: ...]] bracket directive.
    // Mirrors the parser grammar exactly.
    stripped = text.replace(/\[\[\s*CONTINUE_DELEGATE:\s*(?:(?!\]\])[\s\S])+?\s*\]\]\s*$/, "");
  } else if (/\[\[\s*CONTINUE_WORK(?::\d+)?\s*\]\]\s*$/.test(text.trim())) {
    // Strip the bracket continue_work directive. Must run before the bare-token
    // replacement below: otherwise only the inner CONTINUE_WORK would be
    // removed and the display text would leak a dangling "[[".
    stripped = text.replace(/\[\[\s*CONTINUE_WORK(?::\d+)?\s*\]\]\s*$/, "");
  } else {
    // Only strip CONTINUE_WORK when it's the signal type parsed
    stripped = text.replace(/\bCONTINUE_WORK(?::\d+)?\s*$/, "");
  }
  stripped = stripped.trimEnd();

  return { text: stripped, signal };
}
