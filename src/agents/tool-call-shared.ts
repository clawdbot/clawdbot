/**
 * Shared tool-call name validation helpers.
 * Keeps model-supplied tool names compact, normalized, and policy-checked
 * before routing them to any tool execution surface.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";

const TOOL_CALL_NAME_MAX_CHARS = 64;
const TOOL_CALL_NAME_RE = /^[A-Za-z0-9_:.-]+$/;
// A continuation snapshot is private child input. Transcript repair can retain
// only replay-safe descriptor metadata; the original filename is not needed to
// replay the parent tool call and must not escape the handoff boundary.
const CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS = ["encoding", "mimeType"] as const;
const LEGACY_CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS = [
  "name",
  ...CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS,
] as const;
type TranscriptToolCallSanitizeOptions = {
  preserveLegacyContinueDelegateAttachmentName?: boolean;
};
const TRANSCRIPT_TOOL_CALL_BLOCK_TYPES = new Set([
  "toolCall",
  "toolUse",
  "functionCall",
  "tool_call",
  "tool_use",
  "function_call",
]);

/** Return whether a transcript content block carries a persisted tool call. */
export function isTranscriptToolCallBlock(
  value: unknown,
): value is { type: string; name?: unknown; input?: unknown; arguments?: unknown } {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.type === "string" && TRANSCRIPT_TOOL_CALL_BLOCK_TYPES.has(value.type);
}

/** Normalize an optional iterable of allowed tool names for lookup. */
export function normalizeAllowedToolNames(allowedToolNames?: Iterable<string>): Set<string> | null {
  if (!allowedToolNames) {
    return null;
  }
  const normalized = new Set<string>();
  for (const name of allowedToolNames) {
    if (typeof name !== "string") {
      continue;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      continue;
    }
    normalized.add(normalizeLowercaseStringOrEmpty(trimmed));
  }
  return normalized.size > 0 ? normalized : null;
}

/** Return whether a model-supplied tool call name is syntactically and policy allowed. */
export function isAllowedToolCallName(
  name: unknown,
  allowedToolNames: Set<string> | null,
): boolean {
  if (typeof name !== "string") {
    return false;
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length > TOOL_CALL_NAME_MAX_CHARS || !TOOL_CALL_NAME_RE.test(trimmed)) {
    return false;
  }
  if (!allowedToolNames) {
    return true;
  }
  return allowedToolNames.has(normalizeLowercaseStringOrEmpty(trimmed));
}

function redactContinueDelegateAttachmentContent(
  value: unknown,
  options?: TranscriptToolCallSanitizeOptions,
): unknown {
  if (typeof value === "string") {
    // Some providers persist function-call arguments as serialized JSON. Keep
    // the exact string when it is not a matching object, but redact before the
    // canonical transcript writer stores a JSON-encoded continuation snapshot.
    try {
      const parsed = JSON.parse(value) as unknown;
      const redacted = redactContinueDelegateAttachmentContent(parsed, options);
      return redacted === parsed ? value : JSON.stringify(redacted);
    } catch {
      return value;
    }
  }
  if (!isRecord(value)) {
    return value;
  }
  const input = value;
  let sanitized = input;
  if (Object.hasOwn(input, "attachments")) {
    if (!Array.isArray(input.attachments)) {
      sanitized = { ...input };
      delete sanitized.attachments;
    } else {
      let changed = false;
      const attachments = input.attachments.map((attachment) => {
        if (
          isRedactedContinueDelegateAttachment(
            attachment,
            options?.preserveLegacyContinueDelegateAttachmentName === true,
          )
        ) {
          return attachment;
        }
        changed = true;
        return redactContinueDelegateAttachment(attachment);
      });
      if (changed) {
        sanitized = { ...input, attachments };
      }
    }
  }
  return sanitizeContinueDelegateAttachAs(
    sanitized,
    Array.isArray(sanitized.attachments) && sanitized.attachments.length > 0,
  );
}

function sanitizeContinueDelegateAttachAs(
  input: Record<string, unknown>,
  hasAttachments: boolean,
): Record<string, unknown> {
  const hasCamel = Object.hasOwn(input, "attachAs");
  const hasSnake = Object.hasOwn(input, "attach_as");
  if (!hasCamel && !hasSnake) {
    return input;
  }
  const key = hasCamel ? "attachAs" : "attach_as";
  const shadowKey = hasCamel ? "attach_as" : "attachAs";
  const attachAs = hasAttachments ? projectContinueDelegateAttachAs(input[key]) : undefined;
  if (attachAs === input[key] && !Object.hasOwn(input, shadowKey)) {
    return input;
  }
  const sanitized = { ...input };
  if (attachAs) {
    sanitized[key] = attachAs;
  } else {
    delete sanitized[key];
  }
  delete sanitized[shadowKey];
  return sanitized;
}

function projectContinueDelegateAttachAs(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const input = value;
  const hasCamel = Object.hasOwn(input, "mountPath");
  const hasSnake = Object.hasOwn(input, "mount_path");
  const key = hasCamel ? "mountPath" : hasSnake ? "mount_path" : undefined;
  if (!key || typeof input[key] !== "string" || input[key].trim().length === 0) {
    return undefined;
  }
  return Object.keys(input).length === 1 ? input : { [key]: input[key] };
}

function isRedactedContinueDelegateAttachment(value: unknown, allowLegacyName: boolean): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const attachment = value;
  if (attachment.content !== REDACTED_SENTINEL) {
    return false;
  }
  for (const key of Object.keys(attachment)) {
    if (key === "content") {
      continue;
    }
    const allowedKeys = allowLegacyName
      ? LEGACY_CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS
      : CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS;
    if (!allowedKeys.some((allowedKey) => allowedKey === key)) {
      return false;
    }
    const metadata = attachment[key];
    if (typeof metadata !== "string" || metadata.trim().length === 0) {
      return false;
    }
    if (key === "encoding" && metadata !== "utf8" && metadata !== "base64") {
      return false;
    }
  }
  return true;
}

function redactContinueDelegateAttachment(value: unknown): Record<string, unknown> {
  const redacted: Record<string, unknown> = { content: REDACTED_SENTINEL };
  if (!isRecord(value)) {
    return redacted;
  }
  const attachment = value;
  for (const key of CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS) {
    const metadata = attachment[key];
    if (typeof metadata !== "string" || metadata.trim().length === 0) {
      continue;
    }
    if (key === "encoding" && metadata !== "utf8" && metadata !== "base64") {
      continue;
    }
    redacted[key] = metadata;
  }
  return redacted;
}

/** Normalize a transcript tool-call name and redact continuation snapshot bytes. */
export function sanitizeTranscriptToolCallBlock<
  T extends {
    name?: unknown;
    input?: unknown;
    arguments?: unknown;
    partialArgs?: unknown;
    partialJson?: unknown;
  },
>(block: T, options?: TranscriptToolCallSanitizeOptions): T {
  // sessions_spawn payloads remain trusted transcript-owned state. Continuation
  // snapshots are durable queue input and are redacted once the call is recorded.
  const rawName = typeof block.name === "string" ? block.name : undefined;
  const trimmedName = rawName?.trim();
  const normalizedName = trimmedName ? trimmedName : undefined;
  const nameChanged = normalizedName !== undefined && rawName !== normalizedName;
  const isContinueDelegate = normalizedName?.toLowerCase() === "continue_delegate";
  const input = isContinueDelegate
    ? redactContinueDelegateAttachmentContent(block.input, options)
    : block.input;
  const args = isContinueDelegate
    ? redactContinueDelegateAttachmentContent(block.arguments, options)
    : block.arguments;
  const removePartialArgs = isContinueDelegate && Object.hasOwn(block, "partialArgs");
  const removePartialJson = isContinueDelegate && Object.hasOwn(block, "partialJson");

  if (
    !nameChanged &&
    input === block.input &&
    args === block.arguments &&
    !removePartialArgs &&
    !removePartialJson
  ) {
    return block;
  }
  // SAFETY: spreading block: T preserves every own enumerable property of T; the compiler cannot prove this for a generic T, but the resulting object always structurally satisfies T.
  const next = { ...block } as T;
  if (nameChanged) {
    next.name = normalizedName;
  }
  if ("input" in block) {
    next.input = input;
  }
  if ("arguments" in block) {
    next.arguments = args;
  }
  if (removePartialArgs) {
    delete next.partialArgs;
  }
  if (removePartialJson) {
    delete next.partialJson;
  }
  return next;
}
