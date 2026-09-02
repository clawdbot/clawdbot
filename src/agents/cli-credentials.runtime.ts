/** External CLI credential reads that may start bounded child processes. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runCommandBuffered } from "../process/exec.js";
import {
  computeCodexKeychainAccount,
  readCodexApiKeyStatus,
  resolveCodexActiveApiKey,
  resolveCodexCliHomePath,
  type CodexCliApiKeyCredential,
  type CodexCliCredentialRuntimeOptions,
} from "./cli-credentials.js";

const CODEX_COMMAND_MAX_OUTPUT_BYTES = 16 * 1024;
const CODEX_STATUS_TIMEOUT_MS = 5_000;
// The first macOS read can wait for an operator to approve Keychain access.
// The wizard's abort signal still kills an abandoned prompt immediately.
const CODEX_KEYCHAIN_PROMPT_TIMEOUT_MS = 60_000;

async function readCodexKeychainAuthRecord(
  options: CodexCliCredentialRuntimeOptions,
): Promise<Record<string, unknown> | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" || options.allowKeychainPrompt === false) {
    return null;
  }
  const codexHome = resolveCodexCliHomePath(options.codexHome);
  const result = await runCommandBuffered(
    [
      "security",
      "find-generic-password",
      "-s",
      "Codex Auth",
      "-a",
      computeCodexKeychainAccount(codexHome),
      "-w",
    ],
    {
      timeoutMs: CODEX_KEYCHAIN_PROMPT_TIMEOUT_MS,
      maxCombinedOutputBytes: CODEX_COMMAND_MAX_OUTPUT_BYTES,
      baseEnv: process.env,
      signal: options.signal,
    },
  );
  if (result.termination !== "exit" || result.code !== 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout.toString("utf8").trim());
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Reads the active Codex API key without blocking the Gateway event loop. */
export async function readCodexCliActiveApiKeyAsync(
  options: CodexCliCredentialRuntimeOptions = {},
): Promise<CodexCliApiKeyCredential | null> {
  const codexHome = resolveCodexCliHomePath(options.codexHome);
  const canPrompt =
    (options.platform ?? process.platform) === "darwin" && options.allowKeychainPrompt !== false;
  const deadline = canPrompt ? AbortSignal.timeout(CODEX_KEYCHAIN_PROMPT_TIMEOUT_MS) : undefined;
  const signal = deadline
    ? options.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline
    : options.signal;
  const result = await runCommandBuffered(["codex", "login", "status"], {
    timeoutMs: canPrompt ? CODEX_KEYCHAIN_PROMPT_TIMEOUT_MS : CODEX_STATUS_TIMEOUT_MS,
    maxCombinedOutputBytes: CODEX_COMMAND_MAX_OUTPUT_BYTES,
    baseEnv: process.env,
    env: { CODEX_HOME: codexHome },
    signal,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    return null;
  }
  const status = [result.stdout, result.stderr]
    .map((value) => value.toString("utf8").trim())
    .filter(Boolean)
    .join("\n");
  if (!readCodexApiKeyStatus(status)) {
    return null;
  }
  const keychainRecord = await readCodexKeychainAuthRecord({ ...options, codexHome, signal });
  return resolveCodexActiveApiKey(status, codexHome, keychainRecord);
}
