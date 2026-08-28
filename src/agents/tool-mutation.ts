/** Tool mutation and replay-safety classification. */
import { asOptionalObjectRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { isAutomationsToolName } from "./tools/automations-tool-name.js";

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
  "view_image",
  "ls",
  "memory_get",
  "pdf",
  "read",
  "search",
  "sessions_history",
  "sessions_list",
  "sessions_search",
  "tool_describe",
  "tool_search",
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

type ToolMutationState = {
  mutatingAction: boolean;
  replaySafe: boolean;
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
    case "portal":
      return action !== "list";
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
      return action === "list" || action === "inspect" || action === "read";
    case "transcripts":
      return action === "status";
    case "gateway":
      return action != null && GATEWAY_REPLAY_SAFE_ACTIONS.has(action);
    case "portal":
      return action === "list";
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

export function buildToolMutationState(
  toolName: string,
  args: unknown,
  options?: { ownerKey?: string },
): ToolMutationState {
  const ownerDeclaredMutation = options?.ownerKey !== undefined;
  return {
    mutatingAction: ownerDeclaredMutation || isMutatingToolCall(toolName, args),
    replaySafe: ownerDeclaredMutation ? false : isReplaySafeToolCall(toolName, args),
  };
}
