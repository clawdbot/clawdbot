import fs from "node:fs/promises";
import type { SystemRunApprovalPlan } from "../infra/exec-approvals.js";

const MAX_ARG_COUNT = 128;
const MAX_ARG_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MIN_IDLE_TIMEOUT_MS = 1_000;
const MAX_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// Mirror the Claude flags produced by extensions/anthropic/cli-shared.ts and
// cli-backend.ts. Node execution intentionally excludes file/plugin/MCP/tool
// flags so gateway-local paths can never escape onto the remote host.
const BARE_ARGS = new Set([
  "-p",
  "--print",
  "--include-partial-messages",
  "--verbose",
  "--fork-session",
  "--safe-mode",
  "--bare",
  "--no-chrome",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--exclude-dynamic-system-prompt-sections",
  "--include-hook-events",
  "--replay-user-messages",
]);

const VALUE_ARGS = new Set([
  "--output-format",
  "--input-format",
  "--setting-sources",
  "--permission-mode",
  "--resume",
  "-r",
  "--session-id",
  "--model",
  "--effort",
  "--max-turns",
  "--fallback-model",
  "--prompt-suggestions",
  "--max-budget-usd",
  // Native tool policy projected from the gateway. --allowedTools stays
  // rejected: Claude reads it as auto-approval, which must not bypass this
  // node's own approval surface. The gateway always sends these as one
  // comma-joined value (resolveClaudeCliToolAvailabilityArgs); a multi-token
  // variadic form fails closed as an unsupported argument.
  "--tools",
  "--disallowedTools",
]);

const ENV_ALLOWLIST = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "TERM",
]);
const CLEAR_ENV_ALLOWLIST = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CONFIG_DIR",
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
]);

export type ClaudeCliNodeRunParams = {
  argv: string[];
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  clearEnv?: string[];
  systemPrompt?: string;
  agentId?: string;
  sessionKey?: string;
  approvalDecision?: "allow-once" | "allow-always";
  systemRunPlan?: SystemRunApprovalPlan;
  idleTimeoutMs: number;
  timeoutMs: number;
};

export type ClaudeCliNodeRunResult = {
  exitCode: number;
  stderrTail: string;
  truncated: boolean;
  timeoutKind?: "hard" | "idle";
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decodeJson(raw?: string | null): unknown {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("INVALID_REQUEST: paramsJSON malformed JSON");
  }
}

function requireBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`INVALID_REQUEST: ${label} must be a bounded string`);
  }
  return value;
}

/** Claude CLI session ids are bounded, non-option argv values. */
export function validateClaudeSessionId(value: unknown): string {
  const sessionId = requireBoundedString(value, "threadId", MAX_ARG_BYTES).trim();
  if (!sessionId || sessionId.startsWith("-")) {
    throw new Error("INVALID_REQUEST: threadId must be a Claude session id");
  }
  return sessionId;
}

function validateArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARG_COUNT) {
    throw new Error("INVALID_REQUEST: argv must be a bounded non-empty array");
  }
  const args = value.map((entry, index) =>
    requireBoundedString(entry, `argv[${index}]`, MAX_ARG_BYTES),
  );
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const equalsIndex = arg.indexOf("=");
    const name = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;
    if (BARE_ARGS.has(arg)) {
      continue;
    }
    if (!VALUE_ARGS.has(name)) {
      throw new Error(`INVALID_REQUEST: unsupported Claude CLI argument: ${arg || "<empty>"}`);
    }
    if (equalsIndex > 0) {
      const inlineValue = arg.slice(equalsIndex + 1);
      if (!inlineValue || inlineValue.startsWith("-")) {
        throw new Error(
          `INVALID_REQUEST: Claude CLI argument requires a non-option value: ${name}`,
        );
      }
      if (name === "--permission-mode" && inlineValue === "bypassPermissions") {
        throw new Error("INVALID_REQUEST: bypassPermissions is not allowed for node agent runs");
      }
      continue;
    }
    if (index + 1 >= args.length) {
      throw new Error(`INVALID_REQUEST: Claude CLI argument requires a value: ${name}`);
    }
    if (args[index + 1]?.startsWith("-")) {
      throw new Error(`INVALID_REQUEST: Claude CLI argument requires a non-option value: ${name}`);
    }
    if (name === "--permission-mode" && args[index + 1] === "bypassPermissions") {
      throw new Error("INVALID_REQUEST: bypassPermissions is not allowed for node agent runs");
    }
    index += 1;
  }
  return args;
}

function validateTimeout(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`INVALID_REQUEST: ${label} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

/** Decode the narrow, binary-free request accepted by the Claude node command. */
export async function decodeClaudeCliNodeRunParams(
  raw?: string | null,
): Promise<ClaudeCliNodeRunParams> {
  if (Buffer.byteLength(raw ?? "", "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("INVALID_REQUEST: Claude CLI request is too large");
  }
  const value = asRecord(decodeJson(raw));
  if (!value) {
    throw new Error("INVALID_REQUEST: Claude CLI params must be an object");
  }
  const allowed = new Set([
    "argv",
    "stdin",
    "cwd",
    "env",
    "clearEnv",
    "systemPrompt",
    "agentId",
    "sessionKey",
    "approvalDecision",
    "systemRunPlan",
    "idleTimeoutMs",
    "timeoutMs",
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`INVALID_REQUEST: unknown Claude CLI parameter: ${unknown}`);
  }
  const argv = validateArgs(value.argv);
  const stdin =
    value.stdin === undefined
      ? undefined
      : requireBoundedString(value.stdin, "stdin", MAX_REQUEST_BYTES);
  const systemPrompt =
    value.systemPrompt === undefined
      ? undefined
      : requireBoundedString(value.systemPrompt, "systemPrompt", MAX_REQUEST_BYTES);
  const agentId =
    value.agentId === undefined
      ? undefined
      : requireBoundedString(value.agentId, "agentId", MAX_ARG_BYTES);
  const sessionKey =
    value.sessionKey === undefined
      ? undefined
      : requireBoundedString(value.sessionKey, "sessionKey", MAX_ARG_BYTES);
  const approvalDecision =
    value.approvalDecision === "allow-once" || value.approvalDecision === "allow-always"
      ? value.approvalDecision
      : undefined;
  if (value.approvalDecision !== undefined && !approvalDecision) {
    throw new Error("INVALID_REQUEST: approvalDecision is invalid");
  }
  const systemRunPlan =
    value.systemRunPlan === undefined ? undefined : asRecord(value.systemRunPlan);
  if (value.systemRunPlan !== undefined && !systemRunPlan) {
    throw new Error("INVALID_REQUEST: systemRunPlan must be an object");
  }
  const cwd =
    value.cwd === undefined ? undefined : requireBoundedString(value.cwd, "cwd", MAX_ARG_BYTES);
  if (cwd) {
    const stat = await fs.stat(cwd).catch(() => undefined);
    if (!stat?.isDirectory()) {
      throw new Error("INVALID_REQUEST: cwd must be an existing directory on the node");
    }
  }
  let env: Record<string, string> | undefined;
  if (value.env !== undefined) {
    const envValue = asRecord(value.env);
    if (!envValue) {
      throw new Error("INVALID_REQUEST: env must be an object");
    }
    env = {};
    for (const [key, candidate] of Object.entries(envValue)) {
      if (!ENV_ALLOWLIST.has(key)) {
        throw new Error(`INVALID_REQUEST: environment key is not allowed: ${key}`);
      }
      env[key] = requireBoundedString(candidate, `env.${key}`, MAX_ARG_BYTES);
    }
    if (Object.hasOwn(env, "ANTHROPIC_API_KEY") && Object.hasOwn(env, "CLAUDE_CODE_OAUTH_TOKEN")) {
      throw new Error("INVALID_REQUEST: exactly one Claude credential may be provided");
    }
  }
  let clearEnv: string[] | undefined;
  if (value.clearEnv !== undefined) {
    if (!Array.isArray(value.clearEnv) || value.clearEnv.length > CLEAR_ENV_ALLOWLIST.size) {
      throw new Error("INVALID_REQUEST: clearEnv must be a bounded array");
    }
    clearEnv = [];
    for (const candidate of value.clearEnv) {
      const key = requireBoundedString(candidate, "clearEnv entry", MAX_ARG_BYTES);
      if (!CLEAR_ENV_ALLOWLIST.has(key)) {
        throw new Error(`INVALID_REQUEST: clearEnv key is not allowed: ${key}`);
      }
      if (!clearEnv.includes(key)) {
        clearEnv.push(key);
      }
    }
  }
  return {
    argv,
    ...(stdin !== undefined ? { stdin } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(approvalDecision ? { approvalDecision } : {}),
    ...(systemRunPlan ? { systemRunPlan: systemRunPlan as SystemRunApprovalPlan } : {}),
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    ...(clearEnv ? { clearEnv } : {}),
    idleTimeoutMs: validateTimeout(
      value.idleTimeoutMs,
      "idleTimeoutMs",
      MIN_IDLE_TIMEOUT_MS,
      MAX_IDLE_TIMEOUT_MS,
    ),
    timeoutMs: validateTimeout(value.timeoutMs, "timeoutMs", 1, MAX_TIMEOUT_MS),
  };
}
