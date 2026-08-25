/** Retired Claude CLI credential shape kept only for source compatibility. */
export type ClaudeCliCredential =
  | {
      type: "oauth";
      provider: "anthropic";
      access: string;
      refresh: string;
      expires: number;
      subscriptionType?: string;
      rateLimitTier?: string;
      email?: string;
    }
  | {
      type: "token";
      provider: "anthropic";
      token: string;
      expires: number;
      subscriptionType?: string;
      rateLimitTier?: string;
      email?: string;
    }
  | {
      type: "api_key_helper";
      provider: "anthropic";
      helperHash: string;
    };

export type ClaudeCliCredentialReadOptions = {
  allowKeychainPrompt?: boolean;
  tryKeychainWithoutPrompt?: boolean;
  onStoredCredentialUnreadable?: () => void;
  ttlMs?: number;
  platform?: NodeJS.Platform;
  homeDir?: string;
  execSync?: typeof import("node:child_process").execSync;
};

/**
 * @deprecated Claude CLI owns its native login. This returns null without reading credentials.
 * Scheduled for removal after v2026.10.
 */
export function readClaudeCliCredentialsCached(
  _options?: ClaudeCliCredentialReadOptions,
): ClaudeCliCredential | null {
  return null;
}
