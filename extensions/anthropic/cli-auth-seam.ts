import { spawnSync } from "node:child_process";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import { CLAUDE_CLI_CLEAR_ENV } from "./cli-constants.js";

const CLAUDE_CLI_AUTH_METHODS = [
  "claude.ai",
  "api_key",
  "api_key_helper",
  "oauth_token",
  "third_party",
  "none",
] as const;

type ClaudeCliAuthStatus =
  | {
      status: "available";
      authMethod?: (typeof CLAUDE_CLI_AUTH_METHODS)[number];
      email?: string;
    }
  | { status: "missing" | "unreadable" };

/** Ask Claude CLI whether its own login is usable without reading token material. */
export function probeClaudeCliAuthStatus(params?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
}): ClaudeCliAuthStatus {
  const env = { ...(params?.env ?? process.env) };
  for (const name of CLAUDE_CLI_CLEAR_ENV) {
    delete env[name];
  }
  try {
    const program = resolveWindowsSpawnProgram({
      command: params?.command ?? "claude",
      env,
      packageName: "@anthropic-ai/claude-code",
    });
    const invocation = materializeWindowsSpawnProgram(program, ["auth", "status", "--json"]);
    const result = spawnSync(invocation.command, invocation.argv, {
      encoding: "utf8",
      env,
      maxBuffer: 64 * 1024,
      timeout: 3_000,
      shell: invocation.shell,
      windowsHide: invocation.windowsHide ?? true,
    });
    if (result.error || result.status === null) {
      return { status: "unreadable" };
    }
    if (result.status !== 0) {
      return { status: "missing" };
    }
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isRecord(parsed) || parsed.loggedIn !== true) {
      return { status: "missing" };
    }
    const authMethod = CLAUDE_CLI_AUTH_METHODS.find((method) => method === parsed.authMethod);
    const email = authMethod === "claude.ai" ? normalizeOptionalString(parsed.email) : undefined;
    return {
      status: "available",
      ...(authMethod ? { authMethod } : {}),
      ...(email && email.length <= 320 && !/[\r\n]/u.test(email) ? { email } : {}),
    };
  } catch {
    return { status: "unreadable" };
  }
}
