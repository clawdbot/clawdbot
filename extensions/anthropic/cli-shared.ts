/**
 * Shared Claude CLI backend normalization for args, thinking, and isolated runs.
 */
import type {
  CliBackendConfig,
  CliBackendNormalizeConfigContext,
  CliBackendResolveExecutionArgsContext,
} from "openclaw/plugin-sdk/cli-backend";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";
export {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CLAUDE_CLI_MODEL_ALIASES,
  CLAUDE_CLI_SESSION_ID_FIELDS,
} from "./cli-constants.js";

// Claude Code honors provider-routing, auth, and config-root env before
// consulting its local login state, so inherited shell overrides must not
// steer OpenClaw-managed Claude CLI runs toward a different provider,
// endpoint, token source, plugin/config tree, or telemetry bootstrap mode.
/** Environment variables removed before launching OpenClaw-managed Claude CLI runs. */
export const CLAUDE_CLI_CLEAR_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CONFIG_DIR",
  // Re-injected per run from OpenClaw's canonical context budget.
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_USE_COWORK_PLUGINS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
] as const;

const CLAUDE_LEGACY_SKIP_PERMISSIONS_ARG = "--dangerously-skip-permissions";
const CLAUDE_PERMISSION_MODE_ARG = "--permission-mode";
const CLAUDE_SETTING_SOURCES_ARG = "--setting-sources";
const CLAUDE_SETTINGS_ARG = "--settings";
const CLAUDE_EFFORT_ARG = "--effort";
const CLAUDE_BARE_ARG = "--bare";
const CLAUDE_SAFE_MODE_ARG = "--safe-mode";
const CLAUDE_DISABLE_SLASH_COMMANDS_ARG = "--disable-slash-commands";
const CLAUDE_CHROME_ARG = "--chrome";
const CLAUDE_NO_CHROME_ARG = "--no-chrome";
const CLAUDE_TOOLS_ARG = "--tools";
const CLAUDE_ALLOWED_TOOLS_ARG = "--allowedTools";
const CLAUDE_DISALLOWED_TOOLS_ARG = "--disallowedTools";
const CLAUDE_MCP_CONFIG_ARG = "--mcp-config";
const CLAUDE_STRICT_MCP_CONFIG_ARG = "--strict-mcp-config";
const CLAUDE_NO_SESSION_PERSISTENCE_ARG = "--no-session-persistence";
const CLAUDE_MAX_TURNS_ARG = "--max-turns";
const CLAUDE_SESSION_ID_ARG = "--session-id";
const CLAUDE_RESUME_ARG = "--resume";
const CLAUDE_RESUME_SESSION_AT_ARG = "--resume-session-at";
const CLAUDE_RESUME_SHORT_ARG = "-r";
const CLAUDE_CONTINUE_ARG = "--continue";
const CLAUDE_CONTINUE_SHORT_ARG = "-c";
const CLAUDE_FORK_SESSION_ARG = "--fork-session";
const CLAUDE_SAFE_SETTING_SOURCES = "user";
const CLAUDE_BYPASS_PERMISSION_MODE = "bypassPermissions";
const CLAUDE_DEFAULT_PERMISSION_MODE = "default";
const CLAUDE_NO_TOOLS_VALUE = "";
const CLAUDE_DENY_MCP_TOOLS_VALUE = "mcp__*";
const CLAUDE_SYSTEM_AGENT_MCP_TOOL = "mcp__openclaw__openclaw";
const CLAUDE_SYSTEM_AGENT_SETTINGS =
  '{"disableAllHooks":true,"enabledPlugins":{},"autoMemoryEnabled":false,"claudeMdExcludes":["**/CLAUDE.md","**/CLAUDE.local.md","**/.claude/rules/**"]}';

type ClaudeCliEffort = "low" | "medium" | "high" | "xhigh" | "max";
type ClaudeCliEffortArgAction =
  | { mode: "preserve" }
  | { mode: "omit" }
  | { mode: "set"; effort: ClaudeCliEffort };

/** Explicit thinking opt-out for Claude CLI routes unsupported by Claude Code. */
export const CLAUDE_CLI_OFF_THINKING_PROFILE = {
  levels: [{ id: "off" }],
  defaultLevel: "off",
} as const;

/** Return whether a provider id refers to the Claude CLI backend. */
export function isClaudeCliProvider(providerId: string): boolean {
  return normalizeOptionalLowercaseString(providerId) === CLAUDE_CLI_BACKEND_ID;
}

/** Map OpenClaw's effective context budget to Claude Code's native compactor. */
export function resolveClaudeCliAutoCompactEnv(
  contextTokenBudget: number | undefined,
): Record<string, string> | undefined {
  if (typeof contextTokenBudget !== "number" || !Number.isFinite(contextTokenBudget)) {
    return undefined;
  }
  const normalizedBudget = Math.floor(contextTokenBudget);
  if (normalizedBudget <= 0) {
    return undefined;
  }
  return {
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(normalizedBudget),
  };
}

function isOpenClawRequestedYolo(context?: CliBackendNormalizeConfigContext): boolean {
  const agentExec = context?.agentId
    ? context.config?.agents?.list?.find((agent) => agent.id === context.agentId)?.tools?.exec
    : undefined;
  const exec = agentExec ?? context?.config?.tools?.exec;
  const security = exec?.security ?? "full";
  const ask = exec?.ask ?? "off";
  return security === "full" && ask === "off";
}

/** Resolve Claude permission mode from OpenClaw exec security settings. */
function resolveClaudePermissionMode(context?: CliBackendNormalizeConfigContext): {
  mode?: string;
  overrideExisting: boolean;
} {
  return isOpenClawRequestedYolo(context)
    ? { mode: CLAUDE_BYPASS_PERMISSION_MODE, overrideExisting: false }
    : { overrideExisting: false };
}

/** Normalize Claude permission arguments, removing legacy skip-permissions flags. */
function normalizeClaudePermissionArgs(
  args?: string[],
  options?: { mode?: string; overrideExisting?: boolean },
): string[] | undefined {
  if (!args) {
    return options?.mode ? [CLAUDE_PERMISSION_MODE_ARG, options.mode] : args;
  }
  const normalized: string[] = [];
  let hasPermissionMode = false;
  let skipNext = false;
  for (const [index, arg] of args.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === CLAUDE_LEGACY_SKIP_PERMISSIONS_ARG) {
      continue;
    }
    if (arg === CLAUDE_PERMISSION_MODE_ARG) {
      const maybeValue = args.at(index + 1);
      if (
        typeof maybeValue === "string" &&
        maybeValue.trim().length > 0 &&
        !maybeValue.startsWith("-")
      ) {
        hasPermissionMode = true;
        if (!options?.overrideExisting) {
          normalized.push(arg);
          normalized.push(maybeValue);
        }
        skipNext = true;
      }
      continue;
    }
    if (arg.startsWith(`${CLAUDE_PERMISSION_MODE_ARG}=`)) {
      const maybeValue = arg.slice(`${CLAUDE_PERMISSION_MODE_ARG}=`.length).trim();
      if (maybeValue.length > 0 && !maybeValue.startsWith("-")) {
        hasPermissionMode = true;
        if (!options?.overrideExisting) {
          normalized.push(`${CLAUDE_PERMISSION_MODE_ARG}=${maybeValue}`);
        }
      }
      continue;
    }
    normalized.push(arg);
  }
  if (options?.mode && (!hasPermissionMode || options.overrideExisting)) {
    normalized.push(CLAUDE_PERMISSION_MODE_ARG, options.mode);
  }
  return normalized;
}

/** Ensure Claude CLI setting sources stay restricted to user settings. */
function normalizeClaudeSettingSourcesArgs(args?: string[]): string[] | undefined {
  if (!args) {
    return args;
  }
  const normalized: string[] = [];
  let hasSettingSources = false;
  let skipNext = false;
  for (const [index, arg] of args.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === CLAUDE_SETTING_SOURCES_ARG) {
      const maybeValue = args.at(index + 1);
      if (
        typeof maybeValue === "string" &&
        maybeValue.trim().length > 0 &&
        !maybeValue.startsWith("-")
      ) {
        hasSettingSources = true;
        normalized.push(arg, CLAUDE_SAFE_SETTING_SOURCES);
        skipNext = true;
      }
      continue;
    }
    if (arg.startsWith(`${CLAUDE_SETTING_SOURCES_ARG}=`)) {
      hasSettingSources = true;
      normalized.push(`${CLAUDE_SETTING_SOURCES_ARG}=${CLAUDE_SAFE_SETTING_SOURCES}`);
      continue;
    }
    normalized.push(arg);
  }
  if (!hasSettingSources) {
    normalized.push(CLAUDE_SETTING_SOURCES_ARG, CLAUDE_SAFE_SETTING_SOURCES);
  }
  return normalized;
}

/** Resolve whether a run preserves, removes, or sets a Claude CLI effort override. */
function resolveClaudeCliEffortArgAction(thinkingLevel?: string | null): ClaudeCliEffortArgAction {
  switch (normalizeOptionalLowercaseString(thinkingLevel)) {
    case "minimal":
    case "low":
      return { mode: "set", effort: "low" };
    case "adaptive":
      // Adaptive runs delegate effort to Claude Code, so no static override may survive.
      return { mode: "omit" };
    case "medium":
      return { mode: "set", effort: "medium" };
    case "high":
      return { mode: "set", effort: "high" };
    case "xhigh":
      return { mode: "set", effort: "xhigh" };
    case "max":
      return { mode: "set", effort: "max" };
    default:
      return { mode: "preserve" };
  }
}

function stripClaudeEffortArgs(args: readonly string[]): string[] {
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === CLAUDE_EFFORT_ARG) {
      const maybeValue = args[i + 1];
      if (
        typeof maybeValue === "string" &&
        maybeValue.trim().length > 0 &&
        !maybeValue.startsWith("-")
      ) {
        i += 1;
      }
      continue;
    }
    if (arg.startsWith(`${CLAUDE_EFFORT_ARG}=`)) {
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

const CLAUDE_SIDE_QUESTION_VARIADIC_VALUE_ARGS = new Set([
  CLAUDE_ALLOWED_TOOLS_ARG,
  "--allowed-tools",
  CLAUDE_DISALLOWED_TOOLS_ARG,
  "--disallowed-tools",
  CLAUDE_TOOLS_ARG,
  CLAUDE_MCP_CONFIG_ARG,
]);

const CLAUDE_TOOL_AVAILABILITY_ARGS = new Set([
  CLAUDE_TOOLS_ARG,
  CLAUDE_ALLOWED_TOOLS_ARG,
  "--allowed-tools",
  CLAUDE_DISALLOWED_TOOLS_ARG,
  "--disallowed-tools",
]);

const CLAUDE_SYSTEM_AGENT_VARIADIC_VALUE_ARGS = new Set([
  ...CLAUDE_TOOL_AVAILABILITY_ARGS,
  "--add-dir",
  "--file",
]);

const CLAUDE_SYSTEM_AGENT_VALUE_ARGS = new Set([
  CLAUDE_PERMISSION_MODE_ARG,
  CLAUDE_SETTING_SOURCES_ARG,
  CLAUDE_SETTINGS_ARG,
  "--agent",
  "--agents",
  "--managed-settings",
  "--plugin-dir",
  "--plugin-dir-no-mcp",
  "--plugin-url",
  "--system-prompt",
  "--system-prompt-file",
  "--append-system-prompt",
  "--append-system-prompt-file",
]);

const CLAUDE_SYSTEM_AGENT_BARE_ARGS = new Set([
  CLAUDE_BARE_ARG,
  CLAUDE_SAFE_MODE_ARG,
  CLAUDE_DISABLE_SLASH_COMMANDS_ARG,
  CLAUDE_CHROME_ARG,
  CLAUDE_NO_CHROME_ARG,
  CLAUDE_STRICT_MCP_CONFIG_ARG,
  CLAUDE_LEGACY_SKIP_PERMISSIONS_ARG,
  "--allow-dangerously-skip-permissions",
  "--ide",
]);

const CLAUDE_SIDE_QUESTION_VALUE_ARGS = new Set([
  CLAUDE_PERMISSION_MODE_ARG,
  CLAUDE_SESSION_ID_ARG,
  CLAUDE_RESUME_ARG,
  CLAUDE_RESUME_SESSION_AT_ARG,
  CLAUDE_RESUME_SHORT_ARG,
  CLAUDE_MAX_TURNS_ARG,
]);

const CLAUDE_SIDE_QUESTION_BARE_ARGS = new Set([
  CLAUDE_CONTINUE_ARG,
  CLAUDE_CONTINUE_SHORT_ARG,
  CLAUDE_FORK_SESSION_ARG,
  CLAUDE_BARE_ARG,
  CLAUDE_SAFE_MODE_ARG,
  CLAUDE_STRICT_MCP_CONFIG_ARG,
  CLAUDE_NO_SESSION_PERSISTENCE_ARG,
]);

function stripClaudeArgs(
  args: readonly string[],
  policy: {
    bare?: ReadonlySet<string>;
    variadicValue?: ReadonlySet<string>;
    value?: ReadonlySet<string>;
  },
): string[] {
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const equalsIndex = arg.indexOf("=");
    const argName = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;
    if (policy.bare?.has(argName)) {
      continue;
    }
    if (policy.variadicValue?.has(argName)) {
      if (equalsIndex < 0) {
        while (typeof args[i + 1] === "string" && !args[i + 1]?.startsWith("-")) {
          i += 1;
        }
      }
      continue;
    }
    if (policy.value?.has(argName)) {
      if (equalsIndex < 0) {
        const maybeValue = args[i + 1];
        if (typeof maybeValue === "string" && !maybeValue.startsWith("-")) {
          i += 1;
        }
      }
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

function stripClaudeSideQuestionConflictingArgs(args: readonly string[]): string[] {
  return stripClaudeArgs(args, {
    bare: CLAUDE_SIDE_QUESTION_BARE_ARGS,
    variadicValue: CLAUDE_SIDE_QUESTION_VARIADIC_VALUE_ARGS,
    value: CLAUDE_SIDE_QUESTION_VALUE_ARGS,
  });
}

function resolveClaudeCliSideQuestionExecutionArgs(baseArgs: readonly string[]): string[] {
  return [
    ...stripClaudeSideQuestionConflictingArgs(stripClaudeEffortArgs(baseArgs)),
    CLAUDE_SAFE_MODE_ARG,
    CLAUDE_TOOLS_ARG,
    CLAUDE_NO_TOOLS_VALUE,
    CLAUDE_DISALLOWED_TOOLS_ARG,
    CLAUDE_DENY_MCP_TOOLS_VALUE,
    CLAUDE_STRICT_MCP_CONFIG_ARG,
    CLAUDE_NO_SESSION_PERSISTENCE_ARG,
    CLAUDE_MAX_TURNS_ARG,
    "1",
    CLAUDE_PERMISSION_MODE_ARG,
    CLAUDE_DEFAULT_PERMISSION_MODE,
  ];
}

function resolveClaudeCliToolAvailabilityArgs(
  baseArgs: readonly string[],
  availability: NonNullable<CliBackendResolveExecutionArgsContext["toolAvailability"]>,
): string[] {
  const normalized = stripClaudeArgs(baseArgs, {
    variadicValue: CLAUDE_TOOL_AVAILABILITY_ARGS,
  });
  normalized.push(CLAUDE_TOOLS_ARG, availability.native.join(","));
  if (availability.mcp.length > 0) {
    normalized.push(CLAUDE_ALLOWED_TOOLS_ARG, availability.mcp.join(","));
  } else {
    normalized.push(CLAUDE_DISALLOWED_TOOLS_ARG, CLAUDE_DENY_MCP_TOOLS_VALUE);
  }
  return normalized;
}

function isSystemAgentToolAvailability(
  availability: NonNullable<CliBackendResolveExecutionArgsContext["toolAvailability"]>,
): boolean {
  return availability.mcp.length === 1 && availability.mcp[0] === CLAUDE_SYSTEM_AGENT_MCP_TOOL;
}

function resolveClaudeCliSystemAgentExecutionArgs(baseArgs: readonly string[]): string[] {
  const normalized = stripClaudeArgs(baseArgs, {
    bare: CLAUDE_SYSTEM_AGENT_BARE_ARGS,
    variadicValue: CLAUDE_SYSTEM_AGENT_VARIADIC_VALUE_ARGS,
    value: CLAUDE_SYSTEM_AGENT_VALUE_ARGS,
  });
  // Safe mode also suppresses explicit MCP, while bare mode drops OAuth. Empty
  // setting sources plus restrictive flag settings isolate user customizations;
  // machine-admin policy remains part of the trusted host boundary.
  normalized.push(
    CLAUDE_SETTING_SOURCES_ARG,
    "",
    CLAUDE_SETTINGS_ARG,
    CLAUDE_SYSTEM_AGENT_SETTINGS,
    CLAUDE_DISABLE_SLASH_COMMANDS_ARG,
    CLAUDE_NO_CHROME_ARG,
    CLAUDE_STRICT_MCP_CONFIG_ARG,
    CLAUDE_TOOLS_ARG,
    CLAUDE_NO_TOOLS_VALUE,
    CLAUDE_ALLOWED_TOOLS_ARG,
    CLAUDE_SYSTEM_AGENT_MCP_TOOL,
  );
  return normalized;
}

/** Resolve final Claude CLI execution args for one backend invocation. */
export function resolveClaudeCliExecutionArgs(
  context: CliBackendResolveExecutionArgsContext,
): string[] {
  const executionArgs = (() => {
    if (context.executionMode === "side-question") {
      return resolveClaudeCliSideQuestionExecutionArgs(context.baseArgs);
    }
    const action = resolveClaudeCliEffortArgAction(context.thinkingLevel);
    switch (action.mode) {
      case "preserve":
        return [...context.baseArgs];
      case "omit":
        return stripClaudeEffortArgs(context.baseArgs);
      case "set":
        return [...stripClaudeEffortArgs(context.baseArgs), CLAUDE_EFFORT_ARG, action.effort];
      default:
        return action satisfies never;
    }
  })();
  if (!context.toolAvailability) {
    return executionArgs;
  }
  return isSystemAgentToolAvailability(context.toolAvailability)
    ? resolveClaudeCliSystemAgentExecutionArgs(executionArgs)
    : resolveClaudeCliToolAvailabilityArgs(executionArgs, context.toolAvailability);
}

/** Normalize Claude CLI backend config before registration or execution. */
export function normalizeClaudeBackendConfig(
  config: CliBackendConfig,
  context?: CliBackendNormalizeConfigContext,
): CliBackendConfig {
  const output = config.output ?? "jsonl";
  const input = config.input ?? "stdin";
  const permission = resolveClaudePermissionMode(context);
  return {
    ...config,
    args: normalizeClaudePermissionArgs(normalizeClaudeSettingSourcesArgs(config.args), permission),
    resumeArgs: normalizeClaudePermissionArgs(
      normalizeClaudeSettingSourcesArgs(config.resumeArgs),
      permission,
    ),
    output,
    liveSession:
      config.liveSession ?? (output === "jsonl" && input === "stdin" ? "claude-stdio" : undefined),
    input,
  };
}
