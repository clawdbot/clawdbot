import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";

const CLAUDE_CLI_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const CLAUDE_CLI_KEYCHAIN_TIMEOUT_MS = 2_000;
const CLAUDE_CLI_KEYCHAIN_DEFAULT_TIMEOUT_MS = 5_000;

type ExecSyncFn = typeof execSync;

const execFileAsync = promisify(execFile);

function parseClaudeCliKeychainPayload(raw: string): Record<string, unknown> | null {
  const parsed = JSON.parse(raw.trim());
  return parsed && typeof parsed === "object" ? parsed : null;
}

export function readClaudeCliKeychainPayload(
  execSyncImpl: ExecSyncFn = execSync,
  timeout = CLAUDE_CLI_KEYCHAIN_DEFAULT_TIMEOUT_MS,
): Record<string, unknown> | null {
  try {
    const result = execSyncImpl(
      `security find-generic-password -s "${CLAUDE_CLI_KEYCHAIN_SERVICE}" -w`,
      { encoding: "utf8", timeout, stdio: ["pipe", "pipe", "pipe"] },
    );
    return parseClaudeCliKeychainPayload(result);
  } catch {
    return null;
  }
}

/**
 * Async twin of readClaudeCliKeychainPayload for callers on a request path.
 *
 * `security` blocks for the full timeout when the Keychain is locked, which is
 * the steady state for a headless macOS host, so a request-path caller must not
 * reach the synchronous reader and stall the event loop.
 */
export async function readClaudeCliKeychainPayloadAsync(
  timeout = CLAUDE_CLI_KEYCHAIN_DEFAULT_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", CLAUDE_CLI_KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", timeout },
    );
    return parseClaudeCliKeychainPayload(stdout);
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
