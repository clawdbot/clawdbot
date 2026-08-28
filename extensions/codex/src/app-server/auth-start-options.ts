import { homedir as readHomeDir } from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppServerStartOptions } from "./config.js";
import { normalizeCodexAppServerArgs } from "./launch-args.js";

const CODEX_APP_SERVER_HOME_DIRNAME = "codex-home";
const CODEX_EPHEMERAL_AUTH_STORE_OVERRIDE = 'cli_auth_credentials_store="ephemeral"';

export function resolveCodexAppServerHomeDir(agentDir: string): string {
  return path.join(path.resolve(agentDir), CODEX_APP_SERVER_HOME_DIRNAME);
}

/** Resolves the native user Codex home used by Desktop and the CLI. */
export function resolveCodexAppServerUserHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = readHomeDir,
): string {
  const configured = normalizeOptionalString(env.CODEX_HOME);
  return path.resolve(configured ?? path.join(homedir(), ".codex"));
}

/** Resolves the local CODEX_HOME used when starting one app-server connection. */
export function resolveCodexAppServerLocalHomeDir(
  startOptions: CodexAppServerStartOptions,
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = startOptions.env?.CODEX_HOME;
  if (configured?.trim()) {
    return configured;
  }
  return startOptions.homeScope === "user"
    ? resolveCodexAppServerUserHomeDir(env)
    : resolveCodexAppServerHomeDir(agentDir);
}

/** Forces OpenClaw-owned Codex auth to remain process-local. */
export function withEphemeralCodexAuthStore(params: {
  startOptions: CodexAppServerStartOptions;
  preparedAuth?: unknown;
  authProfileId?: string | null;
}): CodexAppServerStartOptions {
  const { startOptions } = params;
  if (!params.preparedAuth && params.authProfileId === null) {
    return startOptions;
  }
  const args = normalizeCodexAppServerArgs(startOptions.args, CODEX_EPHEMERAL_AUTH_STORE_OVERRIDE);
  return args === startOptions.args ? startOptions : { ...startOptions, args };
}
