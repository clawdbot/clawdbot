import path from "node:path";
import type { CodexAppServerStartOptions } from "./config.js";

const CODEX_APP_SERVER_HOME_DIRNAME = "codex-home";
const CODEX_EPHEMERAL_AUTH_STORE_OVERRIDE = 'cli_auth_credentials_store="ephemeral"';

export function resolveCodexAppServerHomeDir(agentDir: string): string {
  return path.join(path.resolve(agentDir), CODEX_APP_SERVER_HOME_DIRNAME);
}

/** Forces OpenClaw-owned Codex auth to remain process-local. */
export function withEphemeralCodexAuthStore(params: {
  startOptions: CodexAppServerStartOptions;
  preparedAuth?: unknown;
  authProfileId?: string | null;
}): CodexAppServerStartOptions {
  const { startOptions } = params;
  const managedCodexCli =
    startOptions.commandSource === "managed" || startOptions.commandSource === "resolved-managed";
  if (!managedCodexCli || (!params.preparedAuth && params.authProfileId === null)) {
    return startOptions;
  }
  if (
    startOptions.args.at(-2) === "-c" &&
    startOptions.args.at(-1) === CODEX_EPHEMERAL_AUTH_STORE_OVERRIDE
  ) {
    return startOptions;
  }
  return {
    ...startOptions,
    args: [...startOptions.args, "-c", CODEX_EPHEMERAL_AUTH_STORE_OVERRIDE],
  };
}
