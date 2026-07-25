import crypto from "node:crypto";
import type { CliReusableSession, PreparedCliRunContext } from "./types.js";

function buildCliLogArgs(params: {
  args: string[];
  systemPromptArg?: string;
  modelArg?: string;
  imageArg?: string;
  argsPrompt?: string;
}): string[] {
  const logArgs: string[] = [];
  for (let i = 0; i < params.args.length; i += 1) {
    const arg = params.args[i] ?? "";
    if (arg === params.systemPromptArg) {
      const systemPromptValue = params.args[i + 1] ?? "";
      logArgs.push(arg, `<systemPrompt:${systemPromptValue.length} chars>`);
      i += 1;
      continue;
    }
    if (arg === params.modelArg) {
      logArgs.push(arg, params.args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === params.imageArg) {
      logArgs.push(arg, "<image>");
      i += 1;
      continue;
    }
    logArgs.push(arg);
  }
  if (params.argsPrompt) {
    const promptIndex = logArgs.indexOf(params.argsPrompt);
    if (promptIndex >= 0) {
      logArgs[promptIndex] = `<prompt:${params.argsPrompt.length} chars>`;
    }
  }
  return logArgs;
}
const CLI_ENV_AUTH_LOG_KEYS = [
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "AZURE_OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "OPENAI_API_KEY",
  "OPENAI_STEIPETE_API_KEY",
  "OPENROUTER_API_KEY",
] as const;
const CLI_ENV_RUNTIME_LOG_KEYS = ["GEMINI_CLI_HOME", "GEMINI_CLI_SYSTEM_SETTINGS_PATH"] as const;
export const CLAUDE_SELECTED_AUTH_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);
export const NODE_CLAUDE_FORWARD_ENV_KEYS = new Set(["CLAUDE_CODE_AUTO_COMPACT_WINDOW"]);
export function resolveNodeClaudeAuthEnv(context: PreparedCliRunContext): Record<string, string> {
  const secretInput = context.preparedBackend.secretInput;
  if (!secretInput) {
    return {};
  }
  const descriptorEnv = context.preparedBackend.env ?? {};
  const requestEnv = Object.hasOwn(descriptorEnv, "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR")
    ? "CLAUDE_CODE_OAUTH_TOKEN"
    : Object.hasOwn(descriptorEnv, "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR")
      ? "ANTHROPIC_API_KEY"
      : undefined;
  if (!requestEnv) {
    return {};
  }
  const data = secretInput.createData();
  try {
    return { [requestEnv]: data.toString("utf8") };
  } finally {
    data.fill(0);
  }
}
export const CLI_BACKEND_PRESERVE_ENV = "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV";
export function parseCliBackendPreserveEnv(raw: string | undefined): Set<string> {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return new Set();
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return new Set(
        Array.isArray(parsed)
          ? parsed.filter((entry): entry is string => typeof entry === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  }
  return new Set(
    trimmed
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}
function listPresentCliEnvKeys(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): string[] {
  return keys.filter((key) => {
    const value = env[key];
    return typeof value === "string" && value.length > 0;
  });
}
function formatCliEnvKeyList(keys: readonly string[]): string {
  return keys.length > 0 ? keys.join(",") : "none";
}
function buildCliEnvMcpLog(childEnv: Record<string, string>): string {
  return [
    `token=${childEnv.OPENCLAW_MCP_TOKEN ? "set" : "missing"}`,
    `capture=${childEnv.OPENCLAW_MCP_CLI_CAPTURE_KEY ? "set" : "missing"}`,
  ].join(" ");
}
function fingerprintCliSessionId(sessionId?: string): string {
  const trimmed = sessionId?.trim();
  if (!trimmed) {
    return "none";
  }
  return crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
}
function formatCliSessionReuseLogState(reusableSession: CliReusableSession): string {
  switch (reusableSession.mode) {
    case "reuse":
      return "reusable";
    case "reuse-with-drift":
      return `reusable-drift:${reusableSession.drift.reasons.join(",")}`;
    case "invalidate":
      return `invalidated:${reusableSession.invalidatedReason}`;
    case "none":
      return "none";
  }
  const exhaustive: never = reusableSession;
  return exhaustive;
}

/** Builds the compact execution summary logged before a CLI backend run. */
export function buildCliExecLogLine(params: {
  provider: string;
  model: string;
  promptChars: number;
  trigger?: string;
  useResume: boolean;
  cliSessionId?: string;
  resolvedSessionId?: string;
  reusableSession: CliReusableSession;
  hasHistoryPrompt: boolean;
}): string {
  return [
    `cli exec: provider=${params.provider}`,
    `model=${params.model}`,
    `promptChars=${params.promptChars}`,
    `trigger=${params.trigger ?? "unknown"}`,
    `useResume=${params.useResume ? "true" : "false"}`,
    `session=${params.cliSessionId ? "present" : "none"}`,
    `resumeSession=${params.useResume ? fingerprintCliSessionId(params.resolvedSessionId) : "none"}`,
    `reuse=${formatCliSessionReuseLogState(params.reusableSession)}`,
    `historyPrompt=${params.hasHistoryPrompt ? "present" : "none"}`,
  ].join(" ");
}

/** Summarizes auth-related env keys preserved or cleared for a CLI child process. */
export function buildCliEnvAuthLog(childEnv: Record<string, string>): string {
  const hostKeys = listPresentCliEnvKeys(process.env, CLI_ENV_AUTH_LOG_KEYS);
  const childKeys = listPresentCliEnvKeys(childEnv, CLI_ENV_AUTH_LOG_KEYS);
  const childKeySet = new Set(childKeys);
  const clearedKeys = hostKeys.filter((key) => !childKeySet.has(key));
  const runtimeHostKeys = listPresentCliEnvKeys(process.env, CLI_ENV_RUNTIME_LOG_KEYS);
  const runtimeChildKeys = listPresentCliEnvKeys(childEnv, CLI_ENV_RUNTIME_LOG_KEYS);
  const runtimeChildKeySet = new Set(runtimeChildKeys);
  const runtimeClearedKeys = runtimeHostKeys.filter((key) => !runtimeChildKeySet.has(key));
  return [
    `host=${formatCliEnvKeyList(hostKeys)}`,
    `child=${formatCliEnvKeyList(childKeys)}`,
    `cleared=${formatCliEnvKeyList(clearedKeys)}`,
    `runtimeHost=${formatCliEnvKeyList(runtimeHostKeys)}`,
    `runtimeChild=${formatCliEnvKeyList(runtimeChildKeys)}`,
    `runtimeCleared=${formatCliEnvKeyList(runtimeClearedKeys)}`,
  ].join(" ");
}

export function logCliInvocation(params: {
  args: string[];
  command: string;
  env: Record<string, string>;
  systemPromptArg?: string;
  modelArg?: string;
  imageArg?: string;
  argsPrompt?: string;
  log: (message: string) => void;
}): void {
  const logArgs = buildCliLogArgs(params);
  params.log(`cli argv: ${params.command} ${logArgs.join(" ")}`);
  params.log(`cli env auth: ${buildCliEnvAuthLog(params.env)}`);
  if (params.env.OPENCLAW_MCP_TOKEN) {
    params.log(`cli env mcp: ${buildCliEnvMcpLog(params.env)}`);
  }
}
