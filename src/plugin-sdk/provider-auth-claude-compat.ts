import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { asNonArrayRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveOsHomeRelativePath } from "../infra/home-dir.js";
import { loadJsonFileThroughSymlink } from "../infra/json-file.js";

const CLAUDE_CLI_CREDENTIALS_FILE = ".credentials.json";
const CLAUDE_CLI_USER_SETTINGS_FILE = "settings.json";
const CLAUDE_CLI_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_CLI_KEYCHAIN_TIMEOUT_MS = 2_000;
const CLAUDE_CLI_KEYCHAIN_ACCOUNT_FALLBACK = "claude-code-user";
const MACOS_SECURITY_PATH = "/usr/bin/security";
// Pinned Claude SDK YK() accepts this exact ASCII set and otherwise uses the fallback.
const SAFE_KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/u;

/** Retired Claude CLI credential shape kept only for source compatibility. */
type ClaudeCliCredential =
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

type ClaudeCliCredentialReadOptions = {
  allowKeychainPrompt?: boolean;
  tryKeychainWithoutPrompt?: boolean;
  onStoredCredentialUnreadable?: () => void;
  ttlMs?: number;
  platform?: NodeJS.Platform;
  homeDir?: string;
  execSync?: typeof execSync;
};

type ClaudeCliCache = {
  value: ClaudeCliCredential | null;
  readAt: number;
  cacheKey: string;
  sourceFingerprint: string;
};

let claudeCliCache: ClaudeCliCache | null = null;

function resolveClaudeCliConfigDir(homeDir?: string): string {
  if (homeDir !== undefined) {
    return path.join(resolveOsHomeRelativePath(homeDir), ".claude");
  }
  const configuredDir = process.env.CLAUDE_CONFIG_DIR;
  return configuredDir
    ? path.resolve(configuredDir)
    : path.join(resolveOsHomeRelativePath("~"), ".claude");
}

function resolveClaudeCliPath(homeDir: string | undefined, fileName: string): string {
  return path.join(resolveClaudeCliConfigDir(homeDir), fileName);
}

function resolveClaudeCliCredentialsPath(homeDir?: string): string {
  if (homeDir !== undefined) {
    return path.join(resolveClaudeCliConfigDir(homeDir), CLAUDE_CLI_CREDENTIALS_FILE);
  }
  const secureStorageDir = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secureStorageDir === undefined) {
    return resolveClaudeCliPath(undefined, CLAUDE_CLI_CREDENTIALS_FILE);
  }
  // Claude treats an explicit empty override as the default credential store,
  // even when CLAUDE_CONFIG_DIR points at a separate settings directory.
  const credentialDir = secureStorageDir
    ? path.resolve(secureStorageDir)
    : path.join(resolveOsHomeRelativePath("~"), ".claude");
  return path.join(credentialDir, CLAUDE_CLI_CREDENTIALS_FILE);
}

function resolveClaudeCliAccountPath(homeDir?: string): string {
  if (homeDir !== undefined) {
    return path.join(resolveOsHomeRelativePath(homeDir), ".claude.json");
  }
  const configuredDir = process.env.CLAUDE_CONFIG_DIR;
  return configuredDir
    ? path.join(path.resolve(configuredDir), ".claude.json")
    : path.join(resolveOsHomeRelativePath("~"), ".claude.json");
}

function resolveClaudeCliKeychainService(homeDir?: string): string {
  if (homeDir !== undefined) {
    return CLAUDE_CLI_KEYCHAIN_SERVICE;
  }
  const secureStorageDir = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const selectedDir = secureStorageDir !== undefined ? secureStorageDir : configDir;
  if (!selectedDir) {
    return CLAUDE_CLI_KEYCHAIN_SERVICE;
  }
  // Claude Code normalizes this selector before hashing its Keychain service suffix.
  // Keep byte-for-byte parity or decomposed Unicode config paths query a different item.
  const suffix = createHash("sha256")
    .update(selectedDir.normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  return `${CLAUDE_CLI_KEYCHAIN_SERVICE}-${suffix}`;
}

function readFileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function parseClaudeCliOauthCredential(value: unknown): ClaudeCliCredential | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = asNonArrayRecord(value);
  const accessToken = data.accessToken;
  const refreshToken = data.refreshToken;
  const expiresAt = data.expiresAt;
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    // The shipped token variant is access-only (no refresh token), not expiry-free.
    // Both public credential variants require a finite expiry for safe reuse.
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= 0
  ) {
    return null;
  }
  const subscriptionType =
    typeof data.subscriptionType === "string" && data.subscriptionType.trim()
      ? data.subscriptionType.trim()
      : undefined;
  const rateLimitTier =
    typeof data.rateLimitTier === "string" && data.rateLimitTier.trim()
      ? data.rateLimitTier.trim()
      : undefined;
  const plan = {
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(rateLimitTier ? { rateLimitTier } : {}),
  };
  return typeof refreshToken === "string" && refreshToken
    ? {
        type: "oauth",
        provider: "anthropic",
        access: accessToken,
        refresh: refreshToken,
        expires: expiresAt,
        ...plan,
      }
    : {
        type: "token",
        provider: "anthropic",
        token: accessToken,
        expires: expiresAt,
        ...plan,
      };
}

function readClaudeAccountEmail(homeDir?: string): string | undefined {
  const raw = loadJsonFileThroughSymlink(resolveClaudeCliAccountPath(homeDir));
  const account = asNonArrayRecord(raw).oauthAccount;
  const email = asNonArrayRecord(account).emailAddress;
  return typeof email === "string" && email.trim() ? email.trim() : undefined;
}

function withClaudeAccountEmail(
  credential: ClaudeCliCredential | null,
  homeDir?: string,
): ClaudeCliCredential | null {
  if (!credential || credential.type === "api_key_helper") {
    return credential;
  }
  if (
    path.dirname(resolveClaudeCliCredentialsPath(homeDir)) !== resolveClaudeCliConfigDir(homeDir)
  ) {
    // oauthAccount is config-scoped, so it cannot identify a credential selected
    // from an independent secure-storage root.
    return credential;
  }
  const email = readClaudeAccountEmail(homeDir);
  return email ? { ...credential, email } : credential;
}

function readClaudeApiKeyHelper(homeDir?: string): ClaudeCliCredential | null {
  const raw = loadJsonFileThroughSymlink(
    resolveClaudeCliPath(homeDir, CLAUDE_CLI_USER_SETTINGS_FILE),
  );
  const helper = asNonArrayRecord(raw).apiKeyHelper;
  return typeof helper === "string" && helper.trim()
    ? {
        type: "api_key_helper",
        provider: "anthropic",
        helperHash: createHash("sha256").update(helper.trim()).digest("hex"),
      }
    : null;
}

function readClaudeKeychain(
  execSyncImpl: typeof execSync,
  timeout: number | undefined,
  service: string,
): Record<string, unknown> | null {
  try {
    const account = resolveClaudeCliKeychainAccount();
    const result = execSyncImpl(
      `${MACOS_SECURITY_PATH} find-generic-password -a "${account}" -w -s "${service}"`,
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        ...(timeout === undefined ? {} : { timeout }),
      },
    );
    const parsed: unknown = JSON.parse(result.trim());
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasClaudeKeychainItem(execSyncImpl: typeof execSync, service: string): boolean {
  try {
    const account = resolveClaudeCliKeychainAccount();
    execSyncImpl(`${MACOS_SECURITY_PATH} find-generic-password -a "${account}" -s "${service}"`, {
      encoding: "utf8",
      timeout: CLAUDE_CLI_KEYCHAIN_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function resolveClaudeCliKeychainAccount(): string {
  let account: string | undefined;
  try {
    account = process.env.USER || userInfo().username;
  } catch {
    account = undefined;
  }
  return account && SAFE_KEYCHAIN_ACCOUNT_PATTERN.test(account)
    ? account
    : CLAUDE_CLI_KEYCHAIN_ACCOUNT_FALLBACK;
}

function readClaudeCliCredentials(
  options: ClaudeCliCredentialReadOptions,
): ClaudeCliCredential | null {
  const helper = readClaudeApiKeyHelper(options.homeDir);
  if (helper) {
    return helper;
  }

  const platform = options.platform ?? process.platform;
  const execSyncImpl = options.execSync ?? execSync;
  const keychainService = resolveClaudeCliKeychainService(options.homeDir);
  const tryKeychain = platform === "darwin" && options.allowKeychainPrompt !== false;
  if (tryKeychain) {
    const payload = readClaudeKeychain(
      execSyncImpl,
      options.tryKeychainWithoutPrompt ? CLAUDE_CLI_KEYCHAIN_TIMEOUT_MS : undefined,
      keychainService,
    );
    const credential = parseClaudeCliOauthCredential(payload?.claudeAiOauth);
    if (credential) {
      return withClaudeAccountEmail(credential, options.homeDir);
    }
  }

  const credentialsPath = resolveClaudeCliCredentialsPath(options.homeDir);
  const raw = loadJsonFileThroughSymlink(credentialsPath);
  const credential = withClaudeAccountEmail(
    parseClaudeCliOauthCredential(asNonArrayRecord(raw).claudeAiOauth),
    options.homeDir,
  );
  if (credential) {
    return credential;
  }
  if (
    options.onStoredCredentialUnreadable &&
    options.tryKeychainWithoutPrompt &&
    (fs.existsSync(credentialsPath) ||
      (platform === "darwin" && hasClaudeKeychainItem(execSyncImpl, keychainService)))
  ) {
    options.onStoredCredentialUnreadable();
  }
  return null;
}

/**
 * @deprecated Claude CLI owns native login. Kept functional for shipped Plugin SDK callers only.
 * Scheduled for removal after v2026.10.
 */
export function readClaudeCliCredentialsCached(
  options: ClaudeCliCredentialReadOptions = {},
): ClaudeCliCredential | null {
  const platform = options.platform ?? process.platform;
  const ttlMs = options.ttlMs ?? 0;
  const credentialsPath = resolveClaudeCliCredentialsPath(options.homeDir);
  const settingsPath = resolveClaudeCliPath(options.homeDir, CLAUDE_CLI_USER_SETTINGS_FILE);
  const accountPath = resolveClaudeCliAccountPath(options.homeDir);
  const keychainService = resolveClaudeCliKeychainService(options.homeDir);
  const keychainIntent =
    platform !== "darwin"
      ? "file"
      : options.allowKeychainPrompt === false
        ? options.tryKeychainWithoutPrompt
          ? "keychain-presence"
          : "file"
        : options.tryKeychainWithoutPrompt
          ? "keychain-bounded"
          : "keychain";
  const unreadableIntent =
    options.onStoredCredentialUnreadable && options.tryKeychainWithoutPrompt ? "notify" : "silent";
  const cacheKey = `${credentialsPath}:${settingsPath}:${accountPath}:${keychainIntent}:${keychainService}:${unreadableIntent}`;
  const sourceFingerprint = `${readFileMtimeMs(credentialsPath) ?? "missing"}:${readFileMtimeMs(settingsPath) ?? "missing"}:${readFileMtimeMs(accountPath) ?? "missing"}`;
  const now = Date.now();
  if (
    ttlMs > 0 &&
    claudeCliCache?.cacheKey === cacheKey &&
    claudeCliCache.sourceFingerprint === sourceFingerprint &&
    now - claudeCliCache.readAt < ttlMs
  ) {
    return claudeCliCache.value;
  }

  const value = readClaudeCliCredentials({ ...options, platform });
  const nextFingerprint = `${readFileMtimeMs(credentialsPath) ?? "missing"}:${readFileMtimeMs(settingsPath) ?? "missing"}:${readFileMtimeMs(accountPath) ?? "missing"}`;
  claudeCliCache =
    ttlMs > 0 && nextFingerprint === sourceFingerprint
      ? { value, readAt: now, cacheKey, sourceFingerprint: nextFingerprint }
      : null;
  return value;
}
