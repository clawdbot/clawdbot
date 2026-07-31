import nodePath from "node:path";
/**
 * Tool mutation classification and fingerprinting.
 *
 * Identifies mutating tool calls and file targets so retry/recovery logic can reason about side effects.
 */
import { asOptionalObjectRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { extractApplyPatchTargets } from "./apply-patch-paths.js";
import { isLikelyMutatingToolName } from "./tool-mutation-names.js";
import { isAutomationsToolName } from "./tools/automations-tool-name.js";

export { isLikelyMutatingToolName };

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
const FILE_TARGET_TOOL_NAMES = new Set(["edit", "read", "write"]);

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
  "runs",
]);

const PROCESS_MUTATING_ACTIONS = new Set([
  "write",
  "send_keys",
  "submit",
  "paste",
  "kill",
  "clear",
  "remove",
]);

const PROCESS_REPLAY_SAFE_ACTIONS = new Set(["list", "log"]);

const MESSAGE_READ_ONLY_ACTIONS = new Set([
  "reactions",
  "read",
  "list_pins",
  "permissions",
  "thread_list",
  "search",
  "sticker_search",
  "member_info",
  "role_info",
  "emoji_list",
  "channel_info",
  "channel_list",
  "voice_status",
  "event_list",
]);

const REPLAY_SAFE_TOOL_NAMES = new Set([
  "agents_list",
  "conversations_list",
  "find",
  "get_goal",
  "glob",
  "grep",
  "image",
  "ls",
  "memory_get",
  "memory_search",
  "pdf",
  "read",
  "search",
  "sessions_history",
  "sessions_list",
  "sessions_search",
  "tool_describe",
  "tool_search",
  "update_plan",
  "web_fetch",
  "web_search",
  "x_search",
]);

const BROWSER_READ_ONLY_ACTIONS = new Set(["console", "profiles", "snapshot", "status", "tabs"]);
const COMPUTER_REPLAY_SAFE_ACTIONS = new Set(["screenshot", "wait"]);
const MOBILE_UI_REPLAY_SAFE_ACTIONS = new Set(["observe"]);
const GATEWAY_REPLAY_SAFE_ACTIONS = new Set(["config.get", "config.schema.lookup"]);
const NODES_REPLAY_SAFE_ACTIONS = new Set(["status", "describe", "pending"]);

const READ_ONLY_SHELL_COMMANDS = new Set([
  "cat",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "stat",
  "tail",
  "wc",
]);

const READ_ONLY_GH_PR_SUBCOMMANDS = new Set(["checks", "diff", "list", "status", "view"]);
const READ_ONLY_GH_ISSUE_SUBCOMMANDS = new Set(["list", "status", "view"]);

const UNSAFE_RG_FLAGS = new Set(["--hostname-bin", "--pre", "--pre-glob", "--search-zip", "-z"]);
const UNSAFE_RG_VALUE_FLAGS = ["--hostname-bin", "--pre", "--pre-glob"] as const;
const SHELL_EXPANSION_CHARS = new Set(["$", "*", "?", "[", "]", "{", "}", "~"]);

// Structured file-target identity for cross-tool same-target recovery.
// Carried alongside `actionFingerprint` so comparison does not have to
// re-parse the joined fingerprint string. Re-parsing was unsafe because
// `buildToolActionFingerprint` stores raw path values in a `|`-delimited
// string, so a path containing `|` could over-match (e.g. `/tmp/a|left` and
// `/tmp/a|right` would both extract as `path=/tmp/a`).
export type FileTarget = {
  path?: string;
  oldpath?: string;
  expected?: "present" | "absent" | "unknown";
};

type ApplyPatchResultSummary = {
  added: string[];
  modified: string[];
  deleted: string[];
};

type ToolMutationState = {
  mutatingAction: boolean;
  replaySafe: boolean;
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

function readShellCommand(record: Record<string, unknown> | undefined): string | undefined {
  const command = record?.command ?? record?.cmd;
  if (typeof command !== "string") {
    return undefined;
  }
  const trimmed = command.trim();
  return trimmed || undefined;
}

function tokenizeSimpleShellCommand(command: string): string[] | undefined {
  if (/[;&|<>\n\r`]/.test(command) || command.includes("\\")) {
    return undefined;
  }
  for (const char of SHELL_EXPANSION_CHARS) {
    if (command.includes(char)) {
      return undefined;
    }
  }
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) {
    return undefined;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens.length > 0 ? tokens : undefined;
}

function isReadOnlySedCommand(tokens: readonly string[]): boolean {
  const args = tokens.slice(1);
  if (args.some((token) => token === "--in-place" || token.startsWith("--in-place="))) {
    return false;
  }
  if (args.some((token) => token.startsWith("-") && token !== "-" && token.includes("i"))) {
    return false;
  }
  // `sed -e 'w /tmp/out'` and mixed scripts are easy to misclassify. Only
  // allow the simple line-print shape that agents use for file inspection.
  if (args.some((token) => token === "-e" || token === "--expression")) {
    return false;
  }
  let sawSuppressAutoPrint = false;
  let expression: string | undefined;
  for (const token of args) {
    if (token === "--in-place" || token.startsWith("--in-place=")) {
      return false;
    }
    if (token === "--quiet" || token === "--silent") {
      sawSuppressAutoPrint = true;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      if (token.includes("i")) {
        return false;
      }
      if (token.includes("n")) {
        sawSuppressAutoPrint = true;
      }
      continue;
    }
    expression ??= token;
    break;
  }
  return sawSuppressAutoPrint && expression != null && /^(\d+|\$)(,(\d+|\$))?p$/.test(expression);
}

function hasUnsafeRipgrepFlag(tokens: readonly string[]): boolean {
  return tokens.some((token) => {
    const normalized = normalizeLowercaseStringOrEmpty(token);
    return (
      UNSAFE_RG_FLAGS.has(normalized) ||
      UNSAFE_RG_VALUE_FLAGS.some((flag) => normalized.startsWith(`${flag}=`))
    );
  });
}

function isReadOnlyGhCommand(tokens: readonly string[]): boolean {
  if (
    tokens.some((token) => {
      const normalized = normalizeLowercaseStringOrEmpty(token);
      return (
        normalized === "--web" ||
        normalized.startsWith("--web=") ||
        /^-[a-z]*w[a-z]*(?:=.*)?$/.test(normalized)
      );
    })
  ) {
    return false;
  }
  const area = normalizeLowercaseStringOrEmpty(tokens[1]);
  const action = normalizeLowercaseStringOrEmpty(tokens[2]);
  if (area === "search") {
    return action.length > 0;
  }
  if (area === "pr") {
    return READ_ONLY_GH_PR_SUBCOMMANDS.has(action);
  }
  if (area === "issue") {
    return READ_ONLY_GH_ISSUE_SUBCOMMANDS.has(action);
  }
  return false;
}

function isPlainReadOnlyShellCommand(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  const tokens = tokenizeSimpleShellCommand(command);
  if (!tokens) {
    return false;
  }
  const executable = normalizeLowercaseStringOrEmpty(tokens[0]);
  if (executable === "rg" && hasUnsafeRipgrepFlag(tokens)) {
    return false;
  }
  if (READ_ONLY_SHELL_COMMANDS.has(executable)) {
    return true;
  }
  if (executable === "sed") {
    return isReadOnlySedCommand(tokens);
  }
  if (executable === "gh") {
    return isReadOnlyGhCommand(tokens);
  }
  return false;
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

export function isMutatingToolCall(toolName: string, args: unknown): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(toolName);
  const record = asRecord(args);
  const action = normalizeActionName(record?.action);

  switch (normalized) {
    case "write":
    case "edit":
    case "apply_patch":
    case "sessions_spawn":
    case "sessions_send":
    case "conversations_send":
    case "conversations_turn":
    case "create_goal":
    case "update_goal":
      return true;
    case "exec":
    case "bash":
      return !isPlainReadOnlyShellCommand(readShellCommand(record));
    case "process":
      return action != null && PROCESS_MUTATING_ACTIONS.has(action);
    case "message":
      // Message actions are an extensible plugin surface. Only known lookup
      // actions are replay-safe; missing and future actions fail closed.
      return action == null || !MESSAGE_READ_ONLY_ACTIONS.has(action);
    case "sessions":
      return action !== "group_list";
    case "computer":
      return action == null || !COMPUTER_REPLAY_SAFE_ACTIONS.has(action);
    case "mobile_ui":
      return action == null || !MOBILE_UI_REPLAY_SAFE_ACTIONS.has(action);
    case "subagents":
      return action === "cancel" || action === "kill" || action === "steer";
    case "session_status":
      return typeof record?.model === "string" && record.model.trim().length > 0;
    case "gateway":
      return action == null || !GATEWAY_REPLAY_SAFE_ACTIONS.has(action);
    case "nodes":
      return action == null || !NODES_REPLAY_SAFE_ACTIONS.has(action);
    default: {
      if (isAutomationsToolName(normalized) || normalized === "canvas") {
        return action == null || !READ_ONLY_ACTIONS.has(action);
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

/** Return true only for tool calls whose structured contract proves replay safety. */
export function isReplaySafeToolCall(toolName: string, args: unknown): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(toolName);
  const record = asRecord(args);
  const action = normalizeActionName(record?.action);
  if (REPLAY_SAFE_TOOL_NAMES.has(normalized)) {
    return true;
  }
  switch (normalized) {
    case "exec":
    case "bash":
      return false;
    case "process":
      return action != null && PROCESS_REPLAY_SAFE_ACTIONS.has(action);
    case "message":
      return action != null && MESSAGE_READ_ONLY_ACTIONS.has(action);
    case "subagents":
      return action == null || action === "list";
    case "sessions":
      return action === "group_list";
    case "session_status":
      return !isMutatingToolCall(normalized, args);
    case "browser":
      return action != null && BROWSER_READ_ONLY_ACTIONS.has(action);
    case "computer":
      return action != null && COMPUTER_REPLAY_SAFE_ACTIONS.has(action);
    case "mobile_ui":
      return action != null && MOBILE_UI_REPLAY_SAFE_ACTIONS.has(action);
    case "skill_workshop":
      return action === "list" || action === "inspect";
    case "transcripts":
      return action === "status";
    case "gateway":
      return action != null && GATEWAY_REPLAY_SAFE_ACTIONS.has(action);
    case "nodes":
      return action != null && NODES_REPLAY_SAFE_ACTIONS.has(action);
    default: {
      if (isAutomationsToolName(normalized) || normalized === "canvas") {
        return action != null && READ_ONLY_ACTIONS.has(action);
      }
      return false;
    }
  }
}

function buildToolActionFingerprint(
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

function normalizeFileTargetValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() ? value : undefined;
}

export function buildToolFileTarget(toolName: string, args: unknown): FileTarget | undefined {
  if (!FILE_TARGET_TOOL_NAMES.has(normalizeLowercaseStringOrEmpty(toolName))) {
    return undefined;
  }
  const record = asRecord(args);
  const path = FILE_TARGET_PATH_ARG_KEYS.map((key) => normalizeFileTargetValue(record?.[key])).find(
    Boolean,
  );
  const oldpath = FILE_TARGET_OLDPATH_ARG_KEYS.map((key) =>
    normalizeFileTargetValue(record?.[key]),
  ).find(Boolean);
  if (!path && !oldpath) {
    return undefined;
  }
  return {
    ...(path !== undefined ? { path } : {}),
    ...(oldpath !== undefined ? { oldpath } : {}),
  };
}

function toApplyPatchDisplayPath(path: string, cwd: string): string {
  const relative = nodePath.relative(cwd, path);
  if (!relative || relative === "") {
    return nodePath.basename(path);
  }
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    relative.startsWith("..\\") ||
    nodePath.isAbsolute(relative)
  ) {
    return path;
  }
  return relative;
}

/**
 * Best-effort pre-execution targets for apply_patch failure recovery.
 * Successful calls use their authoritative result summary instead.
 */
export function buildToolInputFileTargets(
  toolName: string,
  args: unknown,
  cwd = process.cwd(),
): FileTarget[] | undefined {
  if (normalizeLowercaseStringOrEmpty(toolName) !== "apply_patch") {
    return undefined;
  }
  const targets = extractApplyPatchTargets(args, { cwd });
  if (targets.length === 0) {
    return undefined;
  }
  return targets.map((target) => ({
    path: toApplyPatchDisplayPath(target.path, cwd),
    expected: target.expected,
  }));
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return value;
}

function readApplyPatchResultSummary(result: unknown): ApplyPatchResultSummary | undefined {
  const details = asRecord(result)?.details;
  const summary = asRecord(details)?.summary;
  const summaryRecord = asRecord(summary);
  const added = readStringArray(summaryRecord?.added);
  const modified = readStringArray(summaryRecord?.modified);
  const deleted = readStringArray(summaryRecord?.deleted);
  if (!added || !modified || !deleted) {
    return undefined;
  }
  return { added, modified, deleted };
}

/**
 * Extract file targets that require content read-back after apply_patch has
 * resolved and applied its envelope. A successful delete result is already
 * authoritative absence evidence, so deleted paths are intentionally excluded.
 */
export function buildToolResultFileTargets(
  toolName: string,
  result: unknown,
  options: { includeDeleted?: boolean } = {},
): FileTarget[] | undefined {
  if (normalizeLowercaseStringOrEmpty(toolName) !== "apply_patch") {
    return undefined;
  }
  const summary = readApplyPatchResultSummary(result);
  if (!summary) {
    return undefined;
  }
  const targets: FileTarget[] = [];
  const seen = new Set<string>();
  for (const rawPath of [...summary.added, ...summary.modified]) {
    const path = normalizeFileTargetValue(rawPath);
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    targets.push({ path });
  }
  if (options.includeDeleted) {
    for (const rawPath of summary.deleted) {
      const path = normalizeFileTargetValue(rawPath);
      if (!path || seen.has(path)) {
        continue;
      }
      seen.add(path);
      targets.push({ path, expected: "absent" });
    }
  }
  return targets;
}

export function mergeFileTargets(
  ...groups: Array<readonly FileTarget[] | undefined>
): FileTarget[] | undefined {
  const targets: FileTarget[] = [];
  let foundGroup = false;
  for (const group of groups) {
    if (group === undefined) {
      continue;
    }
    foundGroup = true;
    for (const target of group) {
      const existingIndex = targets.findIndex((candidate) => isSameFileTarget(candidate, target));
      if (existingIndex >= 0) {
        targets[existingIndex] = target;
      } else {
        targets.push(target);
      }
    }
  }
  return foundGroup ? targets : undefined;
}

export function isSameFileTarget(
  a: FileTarget,
  b: FileTarget,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): boolean {
  const normalizeIdentity = (value: string | undefined) => {
    if (!value) {
      return "";
    }
    const pathApi = platform === "win32" ? nodePath.win32 : nodePath.posix;
    const normalized = pathApi.isAbsolute(value)
      ? pathApi.normalize(value)
      : pathApi.resolve(cwd, value);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return (
    normalizeIdentity(a.path) === normalizeIdentity(b.path) &&
    normalizeIdentity(a.oldpath) === normalizeIdentity(b.oldpath)
  );
}

export function buildToolMutationState(
  toolName: string,
  args: unknown,
  meta?: string,
): ToolMutationState {
  const actionFingerprint = buildToolActionFingerprint(toolName, args, meta);
  const fileTarget = isFileMutatingToolName(toolName)
    ? buildToolFileTarget(toolName, args)
    : undefined;
  return {
    mutatingAction: actionFingerprint != null,
    replaySafe: isReplaySafeToolCall(toolName, args),
    actionFingerprint,
    ...(fileTarget !== undefined ? { fileTarget } : {}),
  };
}

export function isSameToolMutationAction(
  existing: ToolActionRef,
  next: ToolActionRef,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (
    isFileMutatingToolName(existing.toolName) &&
    isFileMutatingToolName(next.toolName) &&
    existing.fileTarget !== undefined &&
    next.fileTarget !== undefined
  ) {
    // File identity is platform-sensitive, while legacy fingerprints normalize
    // string values to lowercase. Resolve the structured target first so a
    // fingerprint collision cannot merge distinct files on macOS or Linux.
    return isSameFileTarget(existing.fileTarget, next.fileTarget, platform);
  }
  if (existing.actionFingerprint != null || next.actionFingerprint != null) {
    // For mutating flows, fail closed: only clear when both fingerprints exist
    // and either match exactly or describe the same file-mutation target.
    if (existing.actionFingerprint == null || next.actionFingerprint == null) {
      return false;
    }
    if (existing.actionFingerprint === next.actionFingerprint) {
      return true;
    }
    return false;
  }
  return existing.toolName === next.toolName && (existing.meta ?? "") === (next.meta ?? "");
}
