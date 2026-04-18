import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

type MatrixTarget = { kind: "room"; id: string } | { kind: "user"; id: string };
const MATRIX_PREFIX = "matrix:";
const ROOM_PREFIX = "room:";
const CHANNEL_PREFIX = "channel:";
const USER_PREFIX = "user:";

function stripKnownPrefixes(raw: string, prefixes: readonly string[]): string {
  let normalized = raw.trim();
  while (normalized) {
    const lowered = normalizeLowercaseStringOrEmpty(normalized);
    const matched = prefixes.find((prefix) => lowered.startsWith(prefix));
    if (!matched) {
      return normalized;
    }
    normalized = normalized.slice(matched.length).trim();
  }
  return normalized;
}

export function resolveMatrixTargetIdentity(raw: string): MatrixTarget | null {
  const normalized = stripKnownPrefixes(raw, [MATRIX_PREFIX]);
  if (!normalized) {
    return null;
  }
  const lowered = normalizeLowercaseStringOrEmpty(normalized);
  if (lowered.startsWith(USER_PREFIX)) {
    const id = normalized.slice(USER_PREFIX.length).trim();
    return id ? { kind: "user", id } : null;
  }
  if (lowered.startsWith(ROOM_PREFIX)) {
    const id = normalized.slice(ROOM_PREFIX.length).trim();
    return id ? { kind: "room", id } : null;
  }
  if (lowered.startsWith(CHANNEL_PREFIX)) {
    const id = normalized.slice(CHANNEL_PREFIX.length).trim();
    return id ? { kind: "room", id } : null;
  }
  if (isMatrixQualifiedUserId(normalized)) {
    return { kind: "user", id: normalized };
  }
  return { kind: "room", id: normalized };
}

export function isMatrixQualifiedUserId(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.startsWith("@") && trimmed.includes(":");
}

export function normalizeMatrixResolvableTarget(raw: string): string {
  return stripKnownPrefixes(raw, [MATRIX_PREFIX, ROOM_PREFIX, CHANNEL_PREFIX]);
}

export function normalizeMatrixMessagingTarget(raw: string): string | undefined {
  const normalized = stripKnownPrefixes(raw, [
    MATRIX_PREFIX,
    ROOM_PREFIX,
    CHANNEL_PREFIX,
    USER_PREFIX,
  ]);
  return normalized || undefined;
}

export function normalizeMatrixDirectoryUserId(raw: string): string | undefined {
  const normalized = stripKnownPrefixes(raw, [MATRIX_PREFIX, USER_PREFIX]);
  if (!normalized || normalized === "*") {
    return undefined;
  }
  return isMatrixQualifiedUserId(normalized) ? `user:${normalized}` : normalized;
}

export function normalizeMatrixDirectoryGroupId(raw: string): string | undefined {
  const normalized = stripKnownPrefixes(raw, [MATRIX_PREFIX]);
  if (!normalized || normalized === "*") {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(normalized);
  if (lowered.startsWith(ROOM_PREFIX) || lowered.startsWith(CHANNEL_PREFIX)) {
    return normalized;
  }
  if (normalized.startsWith("!")) {
    return `room:${normalized}`;
  }
  return normalized;
}

export function resolveMatrixDirectUserId(params: {
  from?: string;
  to?: string;
  chatType?: string;
}): string | undefined {
  if (params.chatType !== "direct") {
    return undefined;
  }
  const roomId = normalizeMatrixResolvableTarget(params.to ?? "");
  if (!roomId.startsWith("!")) {
    return undefined;
  }
  const userId = stripKnownPrefixes(params.from ?? "", [MATRIX_PREFIX, USER_PREFIX]);
  return isMatrixQualifiedUserId(userId) ? userId : undefined;
}
