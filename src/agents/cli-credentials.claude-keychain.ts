import { execSync } from "node:child_process";

const CLAUDE_CLI_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const CLAUDE_CLI_KEYCHAIN_TIMEOUT_MS = 2_000;

type ExecSyncFn = typeof execSync;

export function readClaudeCliKeychainPayload(
  execSyncImpl: ExecSyncFn = execSync,
  timeout = 5000,
): Record<string, unknown> | null {
  try {
    const result = execSyncImpl(
      `security find-generic-password -s "${CLAUDE_CLI_KEYCHAIN_SERVICE}" -w`,
      { encoding: "utf8", timeout, stdio: ["pipe", "pipe", "pipe"] },
    );
    const parsed = JSON.parse(result.trim());
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function hasClaudeCliKeychainItem(execSyncImpl: ExecSyncFn = execSync): boolean {
  try {
    execSyncImpl(`security find-generic-password -s "${CLAUDE_CLI_KEYCHAIN_SERVICE}"`, {
      encoding: "utf8",
      timeout: CLAUDE_CLI_KEYCHAIN_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}
