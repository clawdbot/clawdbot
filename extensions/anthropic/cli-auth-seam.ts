import { readClaudeCliCredentialsCached } from "openclaw/plugin-sdk/provider-auth";

export function readClaudeCliCredentialsForSetup() {
  return readClaudeCliCredentialsCached();
}

export function readClaudeCliCredentialsForSetupNonInteractive() {
  return readClaudeCliCredentialsCached({ allowKeychainPrompt: false });
}

export function readClaudeCliCredentialsForRuntime() {
  return readClaudeCliCredentialsCached({ allowKeychainPrompt: false });
}
