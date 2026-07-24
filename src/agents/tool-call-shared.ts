/**
 * Shared tool-call name validation helpers.
 * Keeps model-supplied tool names compact, normalized, and policy-checked
 * before routing them to any tool execution surface.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const TOOL_CALL_NAME_MAX_CHARS = 64;
const TOOL_CALL_NAME_RE = /^[A-Za-z0-9_:.-]+$/;
const REDACTED_CONTINUE_DELEGATE_ATTACHMENT_CONTENT = "__OPENCLAW_REDACTED__";

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

function redactContinueDelegateAttachmentContent(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.attachments)) {
    return value;
  }
  let changed = false;
  const attachments = input.attachments.map((attachment) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      return attachment;
    }
    const item = attachment as Record<string, unknown>;
    if (!("content" in item)) {
      return attachment;
    }
    changed = true;
    return { ...item, content: REDACTED_CONTINUE_DELEGATE_ATTACHMENT_CONTENT };
  });
  return changed ? { ...input, attachments } : value;
}

/** Normalize a transcript tool-call name and redact continuation snapshot bytes. */
export function sanitizeTranscriptToolCallBlock<
  T extends { name?: unknown; input?: unknown; arguments?: unknown },
>(block: T): T {
  // sessions_spawn payloads remain trusted transcript-owned state. Continuation
  // snapshots are durable queue input and are redacted once the call is recorded.
  const rawName = typeof block.name === "string" ? block.name : undefined;
  const trimmedName = rawName?.trim();
  const normalizedName = trimmedName ? trimmedName : undefined;
  const nameChanged = normalizedName !== undefined && rawName !== normalizedName;
  const isContinueDelegate = normalizedName?.toLowerCase() === "continue_delegate";
  const input = isContinueDelegate
    ? redactContinueDelegateAttachmentContent(block.input)
    : block.input;
  const args = isContinueDelegate
    ? redactContinueDelegateAttachmentContent(block.arguments)
    : block.arguments;

  if (!nameChanged && input === block.input && args === block.arguments) {
    return block;
  }
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
  return next;
}
