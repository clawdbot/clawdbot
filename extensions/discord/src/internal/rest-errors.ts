// Discord plugin module implements rest errors behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactIdentifier, redactSensitiveFieldValue } from "openclaw/plugin-sdk/logging-core";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import { parseDiscordRetryAfterBodySeconds } from "../retry-after.js";

const DISCORD_UNKNOWN_VOICE_STATE = 10065;
const DISCORD_ERROR_BODY_MAX_DEPTH = 64;
const DISCORD_ERROR_BODY_MAX_NODES = 10_000;
const DISCORD_ERROR_BODY_MAX_DEPTH_MARKER = "[Discord error body redacted: maximum depth exceeded]";
const DISCORD_ERROR_BODY_MAX_NODES_MARKER = "[Discord error body redacted: node limit exceeded]";
const DISCORD_ERROR_BODY_PRIORITY_KEYS = new Set(["message", "code", "retry_after", "global"]);
const DISCORD_RATE_LIMIT_SCOPES = new Set(["user", "global", "shared"]);

type DiscordErrorRedactionState = {
  seen: WeakSet<object>;
  remainingNodes: number;
};

function isSensitiveDiscordErrorKey(key: string): boolean {
  // An empty value isolates structured key handling from configured value patterns.
  return redactSensitiveFieldValue(key, "") !== "";
}

function reserveRedactedKey(
  key: string,
  usedKeys: Set<string>,
  collisionCounts: Map<string, number>,
): string {
  let count = (collisionCounts.get(key) ?? 0) + 1;
  let candidate = count === 1 ? key : `${key} [${count}]`;
  while (usedKeys.has(candidate)) {
    count += 1;
    candidate = `${key} [${count}]`;
  }
  collisionCounts.set(key, count);
  usedKeys.add(candidate);
  return candidate;
}

function redactDiscordErrorBody(
  body: unknown,
  fieldKey = "",
  sensitiveAncestorKey?: string,
  state: DiscordErrorRedactionState = {
    seen: new WeakSet<object>(),
    remainingNodes: DISCORD_ERROR_BODY_MAX_NODES,
  },
  depth = 0,
): unknown {
  if (state.remainingNodes <= 0) {
    return DISCORD_ERROR_BODY_MAX_NODES_MARKER;
  }
  state.remainingNodes -= 1;
  if (typeof body === "string") {
    return redactSensitiveFieldValue(sensitiveAncestorKey ?? fieldKey, body);
  }
  if (
    sensitiveAncestorKey &&
    (typeof body === "number" || typeof body === "boolean" || typeof body === "bigint")
  ) {
    return redactSensitiveFieldValue(sensitiveAncestorKey, String(body));
  }
  if (!body || typeof body !== "object") {
    return body;
  }
  // Error bodies are external input; discard over-deep content so malformed
  // nesting cannot escape redaction or replace DiscordError with a stack overflow.
  if (depth >= DISCORD_ERROR_BODY_MAX_DEPTH) {
    return DISCORD_ERROR_BODY_MAX_DEPTH_MARKER;
  }
  if (state.seen.has(body)) {
    return "[Circular]";
  }
  state.seen.add(body);
  let redacted: unknown;
  if (Array.isArray(body)) {
    const items: unknown[] = [];
    for (const entry of body) {
      if (state.remainingNodes <= 0) {
        items.push(DISCORD_ERROR_BODY_MAX_NODES_MARKER);
        break;
      }
      items.push(redactDiscordErrorBody(entry, fieldKey, sensitiveAncestorKey, state, depth + 1));
    }
    redacted = items;
  } else {
    const usedKeys = new Set<string>();
    const collisionCounts = new Map<string, number>();
    const entries: Array<[string, unknown]> = [];
    const appendEntry = (nestedKey: string): boolean => {
      if (state.remainingNodes <= 0) {
        return false;
      }
      const redactedKey = redactSensitiveFieldValue(sensitiveAncestorKey ?? "", nestedKey);
      const outputKey = reserveRedactedKey(redactedKey, usedKeys, collisionCounts);
      const nestedSensitiveKey = isSensitiveDiscordErrorKey(nestedKey)
        ? nestedKey
        : sensitiveAncestorKey;
      entries.push([
        outputKey,
        redactDiscordErrorBody(
          (body as Record<string, unknown>)[nestedKey],
          nestedKey,
          nestedSensitiveKey,
          state,
          depth + 1,
        ),
      ]);
      return true;
    };
    // Preserve canonical diagnostics before a verbose nested error tree can
    // consume the shared traversal budget.
    let truncated = false;
    for (const priorityKey of DISCORD_ERROR_BODY_PRIORITY_KEYS) {
      if (Object.hasOwn(body, priorityKey) && !appendEntry(priorityKey)) {
        truncated = true;
        break;
      }
    }
    if (!truncated) {
      for (const nestedKey in body) {
        if (!Object.hasOwn(body, nestedKey) || DISCORD_ERROR_BODY_PRIORITY_KEYS.has(nestedKey)) {
          continue;
        }
        if (!appendEntry(nestedKey)) {
          truncated = true;
          break;
        }
      }
    }
    if (truncated) {
      const markerKey = reserveRedactedKey(
        DISCORD_ERROR_BODY_MAX_NODES_MARKER,
        usedKeys,
        collisionCounts,
      );
      entries.push([markerKey, DISCORD_ERROR_BODY_MAX_NODES_MARKER]);
    }
    redacted = Object.fromEntries(entries);
  }
  state.seen.delete(body);
  return redacted;
}

export function readDiscordCode(body: unknown): number | undefined {
  const value =
    body && typeof body === "object" && "code" in body
      ? (body as { code?: unknown }).code
      : undefined;
  return parseStrictNonNegativeInteger(value);
}

export function readDiscordMessage(body: unknown, fallback: string): string {
  const value =
    body && typeof body === "object" && "message" in body
      ? (body as { message?: unknown }).message
      : undefined;
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function isUnknownDiscordVoiceStateError(err: unknown): boolean {
  const discordCode =
    err && typeof err === "object" && "discordCode" in err
      ? parseStrictNonNegativeInteger(err.discordCode)
      : undefined;
  return (
    discordCode === DISCORD_UNKNOWN_VOICE_STATE ||
    /unknown voice state/i.test(formatErrorMessage(err))
  );
}

export function readRetryAfter(body: unknown, response: Response, fallbackSeconds = 0): number {
  const bodyValue =
    body && typeof body === "object" && "retry_after" in body
      ? (body as { retry_after?: unknown }).retry_after
      : undefined;
  return (
    parseDiscordRetryAfterBodySeconds(bodyValue) ??
    parseRetryAfterHeaderSeconds(response.headers.get("Retry-After")) ??
    fallbackSeconds
  );
}

export function readDiscordRateLimitBucket(response: Response): string | null {
  const value = response.headers.get("X-RateLimit-Bucket")?.trim();
  // Response headers are untrusted and surface in diagnostics. Hash non-empty
  // bucket ids while retaining the stable equality Discord routing requires.
  return value ? redactIdentifier(value, { len: 32 }) : null;
}

function readDiscordRateLimitScope(response: Response): string | null {
  const value = response.headers.get("X-RateLimit-Scope");
  return value && DISCORD_RATE_LIMIT_SCOPES.has(value) ? value : null;
}

export class DiscordError extends Error {
  readonly status: number;
  readonly statusCode: number;
  readonly rawBody: unknown;
  readonly rawError: unknown;
  discordCode?: number;

  constructor(response: Response, body: unknown) {
    // Sanitize all user-visible/raw string fields at the shared boundary while
    // preserving numeric metadata consumed by retry and voice-state handling.
    const fallbackMessage = `Discord API request failed (${response.status})`;
    const redactedMessage = redactSensitiveFieldValue(
      "message",
      readDiscordMessage(body, fallbackMessage),
    );
    const redactedBody = redactDiscordErrorBody(body);
    super(redactedMessage);
    this.name = "DiscordError";
    this.status = response.status;
    this.statusCode = response.status;
    this.rawBody = redactedBody;
    this.rawError = redactedBody;
    // Classification consumes only a parsed non-negative integer and must not
    // depend on diagnostic depth/node truncation in the sanitized raw body.
    this.discordCode = readDiscordCode(body);
  }
}

export class RateLimitError extends DiscordError {
  readonly retryAfter: number;
  readonly scope: string | null;
  readonly bucket: string | null;

  constructor(
    response: Response,
    body: { message: string; retry_after: number; global: boolean; code?: number | string },
  ) {
    super(response, body);
    this.name = "RateLimitError";
    this.retryAfter = readRetryAfter(body, response, 1);
    this.scope = body.global ? "global" : readDiscordRateLimitScope(response);
    this.bucket = readDiscordRateLimitBucket(response);
  }
}
