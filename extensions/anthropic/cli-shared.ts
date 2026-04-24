import type {
  CliBackendConfig,
  CliBackendNormalizeConfigContext,
} from "openclaw/plugin-sdk/cli-backend";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
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
const CLAUDE_SAFE_SETTING_SOURCES = "user";
const CLAUDE_BYPASS_PERMISSION_MODE = "bypassPermissions";

export function isClaudeCliProvider(providerId: string): boolean {
  return normalizeOptionalLowercaseString(providerId) === CLAUDE_CLI_BACKEND_ID;
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

export function resolveClaudePermissionMode(context?: CliBackendNormalizeConfigContext): {
  mode?: string;
  overrideExisting: boolean;
} {
  return isOpenClawRequestedYolo(context)
    ? { mode: CLAUDE_BYPASS_PERMISSION_MODE, overrideExisting: false }
    : { overrideExisting: false };
}

export function normalizeClaudePermissionArgs(
  args?: string[],
  options?: { mode?: string; overrideExisting?: boolean },
): string[] | undefined {
  if (!args) {
    return options?.mode ? [CLAUDE_PERMISSION_MODE_ARG, options.mode] : args;
  }
  const normalized: string[] = [];
  let hasPermissionMode = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === CLAUDE_LEGACY_SKIP_PERMISSIONS_ARG) {
      continue;
    }
    if (arg === CLAUDE_PERMISSION_MODE_ARG) {
      const maybeValue = args[i + 1];
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
        i += 1;
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

export function normalizeClaudeSettingSourcesArgs(args?: string[]): string[] | undefined {
  if (!args) {
    return args;
  }
  const normalized: string[] = [];
  let hasSettingSources = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === CLAUDE_SETTING_SOURCES_ARG) {
      const maybeValue = args[i + 1];
      if (
        typeof maybeValue === "string" &&
        maybeValue.trim().length > 0 &&
        !maybeValue.startsWith("-")
      ) {
        hasSettingSources = true;
        normalized.push(arg, CLAUDE_SAFE_SETTING_SOURCES);
        i += 1;
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
