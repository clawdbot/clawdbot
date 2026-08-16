/**
 * Claude CLI auth seam. Setup may prompt for keychain-backed credentials while
 * runtime paths stay non-interactive.
 */
import { readClaudeCliCredentialsCached } from "openclaw/plugin-sdk/provider-auth";

/** Read Claude CLI credentials for interactive setup paths. */
export function readClaudeCliCredentialsForSetup() {
  return readClaudeCliCredentialsCached();
}

/** Read Claude CLI credentials for setup checks that must not prompt. */
export function readClaudeCliCredentialsForSetupNonInteractive() {
  let unreadable = false;
  const credential = readClaudeCliCredentialsCached({
    allowKeychainPrompt: false,
    tryKeychainWithoutPrompt: true,
    ttlMs: 0,
    onStoredCredentialUnreadable: () => {
      unreadable = true;
    },
  });
  return credential
    ? ({ status: "available", credential } as const)
    : ({ status: unreadable ? "unreadable" : "missing" } as const);
}

/** Read Claude CLI credentials for runtime without keychain prompts. */
export function readClaudeCliCredentialsForRuntime() {
  return readClaudeCliCredentialsCached({ allowKeychainPrompt: false });
}
