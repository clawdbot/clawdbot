/**
 * Claude Code CLI credential reading.
 *
 * Split out of cli-credentials.ts, which sits at its line budget. Holds the
 * credential shape, the storage precedence Claude Code itself uses, and both
 * the synchronous and request-safe asynchronous readers.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveOsHomeRelativePath } from "../infra/home-dir.js";
import { loadJsonFileThroughSymlink } from "../infra/json-file.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  CLAUDE_CLI_KEYCHAIN_TIMEOUT_MS,
  hasClaudeCliKeychainItem,
  readClaudeCliKeychainPayload,
  readClaudeCliKeychainPayloadAsync,
} from "./cli-credentials.claude-keychain.js";

const log = createSubsystemLogger("agents/auth-profiles");

type ExecSyncFn = typeof import("node:child_process").execSync;

const CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH = ".claude/.credentials.json";
const CLAUDE_CLI_USER_SETTINGS_RELATIVE_PATH = ".claude/settings.json";

/** Credential shape parsed from Claude Code CLI storage. */
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

export function resolveClaudeCliCredentialsPath(homeDir?: string) {
  const baseDir = resolveOsHomeRelativePath(homeDir ?? "~");
  return path.join(baseDir, CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH);
}

export function resolveClaudeCliUserSettingsPath(homeDir?: string) {
  // Managed Claude CLI launches clear CLAUDE_CONFIG_DIR, so auth discovery
  // inspects the canonical user settings tree that the child will use.
  const baseDir = resolveOsHomeRelativePath(homeDir ?? "~");
  return path.join(baseDir, CLAUDE_CLI_USER_SETTINGS_RELATIVE_PATH);
}

function parseClaudeCliOauthCredential(claudeOauth: unknown): ClaudeCliCredential | null {
  if (!claudeOauth || typeof claudeOauth !== "object") {
    return null;
  }
  // SAFETY: guarded above as a non-null object; every field is re-validated below.
  const data = claudeOauth as Record<string, unknown>;
  const accessToken = data.accessToken;
  const refreshToken = data.refreshToken;
  const expiresAt = data.expiresAt;
  // Plan metadata (e.g. subscriptionType "max", rateLimitTier "default_max_20x")
  // lets usage surfaces label subscription windows without another API call.
  const subscriptionType =
    typeof data.subscriptionType === "string" && data.subscriptionType.trim()
      ? data.subscriptionType.trim()
      : undefined;
  const rateLimitTier =
    typeof data.rateLimitTier === "string" && data.rateLimitTier.trim()
      ? data.rateLimitTier.trim()
      : undefined;
  const planFields = {
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(rateLimitTier ? { rateLimitTier } : {}),
  };

  if (typeof accessToken !== "string" || !accessToken) {
    return null;
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return null;
  }
  if (typeof refreshToken === "string" && refreshToken) {
    return {
      type: "oauth",
      provider: "anthropic",
      access: accessToken,
      refresh: refreshToken,
      expires: expiresAt,
      ...planFields,
    };
  }
  return {
    type: "token",
    provider: "anthropic",
    token: accessToken,
    expires: expiresAt,
    ...planFields,
  };
}

function readClaudeCliUserApiKeyHelperCredential(homeDir?: string): ClaudeCliCredential | null {
  const raw = loadJsonFileThroughSymlink(resolveClaudeCliUserSettingsPath(homeDir));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  // SAFETY: raw is a non-null, non-array object per the guard above.
  const helper = (raw as Record<string, unknown>).apiKeyHelper;
  return typeof helper === "string" && helper.trim().length > 0
    ? {
        type: "api_key_helper",
        provider: "anthropic",
        helperHash: createHash("sha256").update(helper.trim()).digest("hex"),
      }
    : null;
}

// The CLI login flow writes the account identity to the config file next to
// the credential store, so the pair describes one login. Capturing it here
// keeps usage surfaces from re-reading ambient config at fetch time, where a
// later account switch could mislabel another credential's quota.
function readClaudeCliAccountEmail(homeDir?: string): string | undefined {
  const baseDir = resolveOsHomeRelativePath(homeDir ?? "~");
  const raw = loadJsonFileThroughSymlink(path.join(baseDir, ".claude.json"));
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  // SAFETY: raw is a non-null object here; oauthAccount stays unknown until checked.
  const account = (raw as { oauthAccount?: unknown }).oauthAccount;
  if (!account || typeof account !== "object") {
    return undefined;
  }
  // SAFETY: account is a non-null object here; emailAddress stays unknown until checked.
  const email = (account as { emailAddress?: unknown }).emailAddress;
  return typeof email === "string" && email.trim() ? email.trim() : undefined;
}

function withClaudeAccountEmail(
  cliLogin: ClaudeCliCredential | null,
  homeDir?: string,
): ClaudeCliCredential | null {
  if (!cliLogin) {
    return null;
  }
  if (cliLogin.type === "api_key_helper") {
    return cliLogin;
  }
  const email = readClaudeCliAccountEmail(homeDir);
  return email ? { ...cliLogin, email } : cliLogin;
}

export type ClaudeCliCredentialSourceOptions = {
  allowKeychainPrompt?: boolean;
  tryKeychainWithoutPrompt?: boolean;
  onStoredCredentialUnreadable?: () => void;
  platform?: NodeJS.Platform;
  homeDir?: string;
  execSync?: ExecSyncFn;
};

function shouldReadClaudeCliKeychain(
  options: ClaudeCliCredentialSourceOptions | undefined,
  platform: NodeJS.Platform,
): boolean {
  return (
    platform === "darwin" &&
    (options?.allowKeychainPrompt !== false || options?.tryKeychainWithoutPrompt === true)
  );
}

function claudeCliKeychainTimeoutMs(
  options: ClaudeCliCredentialSourceOptions | undefined,
): number | undefined {
  return options?.tryKeychainWithoutPrompt ? CLAUDE_CLI_KEYCHAIN_TIMEOUT_MS : undefined;
}

// Shared tail of both readers. Only the Keychain lookup differs between the
// synchronous and asynchronous paths, so its payload arrives already resolved.
function resolveClaudeCliCredential(
  keychainPayload: Record<string, unknown> | null,
  options: ClaudeCliCredentialSourceOptions | undefined,
  platform: NodeJS.Platform,
): ClaudeCliCredential | null {
  const keychainCreds = parseClaudeCliOauthCredential(keychainPayload?.claudeAiOauth);
  if (keychainCreds) {
    log.info("read anthropic credentials from claude cli keychain", { type: keychainCreds.type });
    return withClaudeAccountEmail(keychainCreds, options?.homeDir);
  }
  const credPath = resolveClaudeCliCredentialsPath(options?.homeDir);
  const raw = loadJsonFileThroughSymlink(credPath);
  const fileCredential =
    raw && typeof raw === "object"
      ? withClaudeAccountEmail(
          parseClaudeCliOauthCredential(
            // SAFETY: raw is a non-null object per the ternary guard above.
            (raw as Record<string, unknown>).claudeAiOauth,
          ),
          options?.homeDir,
        )
      : null;
  if (fileCredential) {
    return fileCredential;
  }
  // The existence probe is a second synchronous `security` spawn with its own
  // timeout, so it runs only when a caller consumes the signal.
  const onStoredCredentialUnreadable = options?.onStoredCredentialUnreadable;
  if (
    options?.tryKeychainWithoutPrompt &&
    onStoredCredentialUnreadable &&
    (fs.existsSync(credPath) ||
      (platform === "darwin" && hasClaudeCliKeychainItem(options.execSync)))
  ) {
    onStoredCredentialUnreadable();
  }
  return null;
}

/** Reads Claude CLI credentials in Claude Code's credential precedence order. */
export function readClaudeCliCredentials(
  options?: ClaudeCliCredentialSourceOptions,
): ClaudeCliCredential | null {
  const helperAuth = readClaudeCliUserApiKeyHelperCredential(options?.homeDir);
  if (helperAuth) {
    return helperAuth;
  }
  const platform = options?.platform ?? process.platform;
  const keychainPayload = shouldReadClaudeCliKeychain(options, platform)
    ? readClaudeCliKeychainPayload(options?.execSync, claudeCliKeychainTimeoutMs(options))
    : null;
  return resolveClaudeCliCredential(keychainPayload, options, platform);
}

/**
 * Uncached, non-blocking twin for callers that run inside a request.
 *
 * The macOS Keychain lookup is spawned asynchronously so a locked Keychain
 * cannot stall the event loop. Caching is deliberately absent: the Keychain
 * exposes no mtime to fingerprint, so a cached value could not be invalidated.
 */
export async function readClaudeCliCredentialsUncachedAsync(
  options?: ClaudeCliCredentialSourceOptions,
): Promise<ClaudeCliCredential | null> {
  const helperAuth = readClaudeCliUserApiKeyHelperCredential(options?.homeDir);
  if (helperAuth) {
    return helperAuth;
  }
  const platform = options?.platform ?? process.platform;
  const keychainPayload = shouldReadClaudeCliKeychain(options, platform)
    ? await readClaudeCliKeychainPayloadAsync(claudeCliKeychainTimeoutMs(options))
    : null;
  return resolveClaudeCliCredential(keychainPayload, options, platform);
}
