import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { asRecord } from "./tool-display-record.js";

const MUTATING_TOOL_NAMES = new Set([
  "write",
  "edit",
  "apply_patch",
  "exec",
  "bash",
  "process",
  "message",
  "sessions_spawn",
  "sessions_send",
  "cron",
  "gateway",
  "canvas",
  "nodes",
  "session_status",
]);

// File-mutation tools that operate on the same `path` target identity.
// Recovery is allowed across these even when the tool name differs (e.g.
// edit-fails-then-write-succeeds on the same path), because the user-visible
// invariant is "the file at this path is in the desired state."
//
// `apply_patch` is intentionally excluded: production `apply_patch` calls take
// only an opaque `input` patch string, so `buildToolActionFingerprint` cannot
// extract a `path=` segment from real call args. Including `apply_patch` here
// would only match handcrafted-fingerprint test inputs, not real recoveries.
const FILE_MUTATING_TOOL_NAMES = new Set(["edit", "write"]);

// Args aliases that identify the file target on a file-mutating call.
const FILE_TARGET_PATH_ARG_KEYS = ["path", "file_path", "filePath", "filepath", "file"] as const;
const FILE_TARGET_OLDPATH_ARG_KEYS = ["oldPath", "old_path"] as const;

const READ_ONLY_ACTIONS = new Set([
  "get",
  "list",
  "read",
  "status",
  "show",
  "fetch",
  "search",
  "query",
  "view",
  "poll",
  "log",
  "inspect",
  "check",
  "probe",
]);

const PROCESS_MUTATING_ACTIONS = new Set(["write", "send_keys", "submit", "paste", "kill"]);

const MESSAGE_MUTATING_ACTIONS = new Set([
  "send",
  "reply",
  "thread_reply",
  "threadreply",
  "edit",
  "delete",
  "react",
  "pin",
  "unpin",
]);

// Structured file-target identity for cross-tool same-target recovery.
// Carried alongside `actionFingerprint` so comparison does not have to
// re-parse the joined fingerprint string. Re-parsing was unsafe because
// `buildToolActionFingerprint` stores raw path values in a `|`-delimited
// string, so a path containing `|` could over-match (e.g. `/tmp/a|left` and
// `/tmp/a|right` would both extract as `path=/tmp/a`).
export type FileTarget = {
  path?: string;
  oldpath?: string;
};

type ToolMutationState = {
  mutatingAction: boolean;
  actionFingerprint?: string;
  fileTarget?: FileTarget;
};

type ToolActionRef = {
  toolName: string;
  meta?: string;
  actionFingerprint?: string;
  fileTarget?: FileTarget;
};

function normalizeActionName(value: unknown): string | undefined {
  const normalized = normalizeOptionalLowercaseString(value)?.replace(/[\s-]+/g, "_");
  return normalized || undefined;
}

function normalizeFingerprintValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalizeLowercaseStringOrEmpty(normalized) : undefined;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return normalizeLowercaseStringOrEmpty(String(value));
  }
  return undefined;
}

function appendFingerprintAlias(
  parts: string[],
  record: Record<string, unknown> | undefined,
  label: string,
  keys: string[],
): boolean {
  for (const key of keys) {
    const value = normalizeFingerprintValue(record?.[key]);
    if (!value) {
      continue;
    }
    parts.push(`${label}=${value}`);
    return true;
  }
  return false;
}

export function isLikelyMutatingToolName(toolName: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(toolName);
  if (!normalized) {
    return false;
  }
  return (
    MUTATING_TOOL_NAMES.has(normalized) ||
    normalized.endsWith("_actions") ||
    normalized.startsWith("message_") ||
    normalized.includes("send")
  );
}

export function isMutatingToolCall(toolName: string, args: unknown): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(toolName);
  const record = asRecord(args);
  const action = normalizeActionName(record?.action);

  switch (normalized) {
    case "write":
    case "edit":
    case "apply_patch":
    case "exec":
    case "bash":
    case "sessions_send":
      return true;
    case "process":
      return action != null && PROCESS_MUTATING_ACTIONS.has(action);
    case "message":
      return (
        (action != null && MESSAGE_MUTATING_ACTIONS.has(action)) ||
        typeof record?.content === "string" ||
        typeof record?.message === "string"
      );
    case "subagents":
      return action === "kill" || action === "steer";
    case "session_status":
      return typeof record?.model === "string" && record.model.trim().length > 0;
    default: {
      if (normalized === "cron" || normalized === "gateway" || normalized === "canvas") {
        return action == null || !READ_ONLY_ACTIONS.has(action);
      }
      if (normalized === "nodes") {
        return action == null || action !== "list";
      }
      if (normalized.endsWith("_actions")) {
        return action == null || !READ_ONLY_ACTIONS.has(action);
      }
      if (normalized.startsWith("message_") || normalized.includes("send")) {
        return true;
      }
      return false;
    }
  }
}

export function buildToolActionFingerprint(
  toolName: string,
  args: unknown,
  meta?: string,
): string | undefined {
  if (!isMutatingToolCall(toolName, args)) {
    return undefined;
  }
  const normalizedTool = normalizeLowercaseStringOrEmpty(toolName);
  const record = asRecord(args);
  const action = normalizeActionName(record?.action);
  const parts = [`tool=${normalizedTool}`];
  if (action) {
    parts.push(`action=${action}`);
  }
  let hasStableTarget = false;
  hasStableTarget =
    appendFingerprintAlias(parts, record, "path", [
      "path",
      "file_path",
      "filePath",
      "filepath",
      "file",
    ]) || hasStableTarget;
  hasStableTarget =
    appendFingerprintAlias(parts, record, "oldpath", ["oldPath", "old_path"]) || hasStableTarget;
  hasStableTarget =
    appendFingerprintAlias(parts, record, "newpath", ["newPath", "new_path"]) || hasStableTarget;
  hasStableTarget =
    appendFingerprintAlias(parts, record, "to", ["to", "target"]) || hasStableTarget;
  hasStableTarget =
    appendFingerprintAlias(parts, record, "messageid", ["messageId", "message_id"]) ||
    hasStableTarget;
  hasStableTarget =
    appendFingerprintAlias(parts, record, "sessionkey", ["sessionKey", "session_key"]) ||
    hasStableTarget;
  hasStableTarget =
    appendFingerprintAlias(parts, record, "jobid", ["jobId", "job_id"]) || hasStableTarget;
  hasStableTarget = appendFingerprintAlias(parts, record, "id", ["id"]) || hasStableTarget;
  hasStableTarget = appendFingerprintAlias(parts, record, "model", ["model"]) || hasStableTarget;
  const normalizedMeta = normalizeOptionalLowercaseString(meta?.trim().replace(/\s+/g, " "));
  // Meta text often carries volatile details (for example "N chars").
  // Prefer stable arg-derived keys for matching; only fall back to meta
  // when no stable target key is available.
  if (normalizedMeta && !hasStableTarget) {
    parts.push(`meta=${normalizedMeta}`);
  }
  return parts.join("|");
}

function isFileMutatingToolName(rawName: string): boolean {
  return FILE_MUTATING_TOOL_NAMES.has(normalizeLowercaseStringOrEmpty(rawName));
}

function readArgFingerprintValue(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const normalized = normalizeFingerprintValue(record[key]);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

export function extractFileTarget(toolName: string, args: unknown): FileTarget | undefined {
  if (!isFileMutatingToolName(toolName)) {
    return undefined;
  }
  const record = asRecord(args);
  const path = readArgFingerprintValue(record, FILE_TARGET_PATH_ARG_KEYS);
  const oldpath = readArgFingerprintValue(record, FILE_TARGET_OLDPATH_ARG_KEYS);
  if (!path && !oldpath) {
    return undefined;
  }
  return {
    ...(path !== undefined ? { path } : {}),
    ...(oldpath !== undefined ? { oldpath } : {}),
  };
}

function fileTargetsEqual(a: FileTarget, b: FileTarget): boolean {
  return (a.path ?? "") === (b.path ?? "") && (a.oldpath ?? "") === (b.oldpath ?? "");
}

export function buildToolMutationState(
  toolName: string,
  args: unknown,
  meta?: string,
): ToolMutationState {
  const actionFingerprint = buildToolActionFingerprint(toolName, args, meta);
  const fileTarget = extractFileTarget(toolName, args);
  return {
    mutatingAction: actionFingerprint != null,
    actionFingerprint,
    ...(fileTarget !== undefined ? { fileTarget } : {}),
  };
}

export function isSameToolMutationAction(existing: ToolActionRef, next: ToolActionRef): boolean {
  if (existing.actionFingerprint != null || next.actionFingerprint != null) {
    // For mutating flows, fail closed: only clear when both fingerprints exist
    // and either match exactly or describe the same file-mutation target.
    if (existing.actionFingerprint == null || next.actionFingerprint == null) {
      return false;
    }
    if (existing.actionFingerprint === next.actionFingerprint) {
      return true;
    }
    // Cross-tool recovery: a successful file-mutation on the same `path`
    // clears an unresolved file-mutation failure even when the tool name
    // differs (e.g. edit→write self-heal). Compared structurally on
    // `fileTarget` so paths containing `|` cannot over-match.
    if (
      isFileMutatingToolName(existing.toolName) &&
      isFileMutatingToolName(next.toolName) &&
      existing.fileTarget !== undefined &&
      next.fileTarget !== undefined &&
      fileTargetsEqual(existing.fileTarget, next.fileTarget)
    ) {
      return true;
    }
    return false;
  }
  return existing.toolName === next.toolName && (existing.meta ?? "") === (next.meta ?? "");
}
