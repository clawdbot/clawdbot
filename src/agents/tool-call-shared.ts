import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const TOOL_CALL_NAME_MAX_CHARS = 64;
const TOOL_CALL_NAME_RE = /^[A-Za-z0-9_:.-]+$/;

export const REDACTED_SESSIONS_SPAWN_ATTACHMENT_CONTENT = "__OPENCLAW_REDACTED__";
export const SESSIONS_SPAWN_ATTACHMENT_METADATA_KEYS = ["name", "encoding", "mimeType"] as const;

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

export function isRedactedSessionsSpawnAttachment(item: unknown): boolean {
  if (!item || typeof item !== "object") {
    return false;
  }
  const attachment = item as Record<string, unknown>;
  if (attachment.content !== REDACTED_SESSIONS_SPAWN_ATTACHMENT_CONTENT) {
    return false;
  }
  for (const key of Object.keys(attachment)) {
    if (key === "content") {
      continue;
    }
    if (!(SESSIONS_SPAWN_ATTACHMENT_METADATA_KEYS as readonly string[]).includes(key)) {
      return false;
    }
    if (typeof attachment[key] !== "string" || attachment[key].trim().length === 0) {
      return false;
    }
  }
  return true;
}

type SessionsSpawnAttachmentToolCallBlock = {
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
};

export function hasUnredactedSessionsSpawnAttachments(
  block: SessionsSpawnAttachmentToolCallBlock,
): boolean {
  const rawName = typeof block.name === "string" ? block.name.trim() : "";
  if (normalizeLowercaseStringOrEmpty(rawName) !== "sessions_spawn") {
    return false;
  }
  for (const payload of [block.arguments, block.input]) {
    if (!payload || typeof payload !== "object") {
      continue;
    }
    const attachments = (payload as { attachments?: unknown }).attachments;
    if (!Array.isArray(attachments)) {
      continue;
    }
    for (const attachment of attachments) {
      if (!isRedactedSessionsSpawnAttachment(attachment)) {
        return true;
      }
    }
  }
  return false;
}
