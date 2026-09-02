/** Bundled Codex credential reads that may open the operator's Keychain. */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import {
  readCodexCliActiveApiKey,
  readCodexCliCredentialsCached,
} from "openclaw/plugin-sdk/provider-auth";

const CODEX_COMMAND_MAX_OUTPUT_BYTES = 16 * 1024;
const CODEX_STATUS_TIMEOUT_MS = 5_000;
// The first macOS read can wait for an operator to approve Keychain access.
// One shared deadline bounds status and Keychain commands together.
const CODEX_KEYCHAIN_PROMPT_TIMEOUT_MS = 60_000;

type CodexCredentialReadOptions = {
  codexHome: string;
  allowKeychainPrompt: boolean;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
};

async function codexKeychainAccount(codexHome: string): Promise<string> {
  // Codex hashes the canonical home when it exists and the raw path otherwise.
  // Matching that contract lets a symlinked CODEX_HOME reuse the same Keychain item.
  const accountHome = await realpath(codexHome).catch(() => codexHome);
  const hash = createHash("sha256").update(accountHome).digest("hex");
  return `cli|${hash.slice(0, 16)}`;
}

async function readCodexKeychainSecret(
  options: CodexCredentialReadOptions,
): Promise<string | null> {
  if ((options.platform ?? process.platform) !== "darwin" || !options.allowKeychainPrompt) {
    return null;
  }
  const result = await runCommandBuffered(
    [
      "security",
      "find-generic-password",
      "-s",
      "Codex Auth",
      "-a",
      await codexKeychainAccount(options.codexHome),
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
  return result.stdout.toString("utf8").trim() || null;
}

function credentialReadSignal(options: CodexCredentialReadOptions): AbortSignal | undefined {
  if ((options.platform ?? process.platform) !== "darwin" || !options.allowKeychainPrompt) {
    return options.signal;
  }
  const deadline = AbortSignal.timeout(CODEX_KEYCHAIN_PROMPT_TIMEOUT_MS);
  return options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
}

/** Reads Codex OAuth through the bundled migration owner without blocking the Gateway. */
export async function readCodexCliCredentialsAsync(options: CodexCredentialReadOptions) {
  const signal = credentialReadSignal(options);
  const keychainSecret = await readCodexKeychainSecret({ ...options, signal });
  return readCodexCliCredentialsCached({
    codexHome: options.codexHome,
    allowKeychainPrompt: Boolean(keychainSecret),
    ...(options.platform ? { platform: options.platform } : {}),
    ttlMs: 0,
    ...(keychainSecret ? { execSync: () => keychainSecret } : {}),
  });
}

/** Reads the active Codex API key through the bundled migration owner. */
export async function readCodexCliActiveApiKeyAsync(options: CodexCredentialReadOptions) {
  const signal = credentialReadSignal(options);
  const canPrompt =
    (options.platform ?? process.platform) === "darwin" && options.allowKeychainPrompt;
  const statusResult = await runCommandBuffered(["codex", "login", "status"], {
    timeoutMs: canPrompt ? CODEX_KEYCHAIN_PROMPT_TIMEOUT_MS : CODEX_STATUS_TIMEOUT_MS,
    maxCombinedOutputBytes: CODEX_COMMAND_MAX_OUTPUT_BYTES,
    baseEnv: process.env,
    env: { CODEX_HOME: options.codexHome },
    signal,
  });
  if (statusResult.termination !== "exit" || statusResult.code !== 0) {
    return null;
  }
  const status = [statusResult.stdout, statusResult.stderr]
    .map((value) => value.toString("utf8").trim())
    .filter(Boolean)
    .join("\n");
  if (!status.startsWith("Logged in using an API key")) {
    return null;
  }
  const keychainSecret = await readCodexKeychainSecret({ ...options, signal });
  return readCodexCliActiveApiKey({
    codexHome: options.codexHome,
    allowKeychainPrompt: Boolean(keychainSecret),
    ...(options.platform ? { platform: options.platform } : {}),
    execSync: (command) => (command.includes("login status") ? status : (keychainSecret ?? "")),
  });
}
