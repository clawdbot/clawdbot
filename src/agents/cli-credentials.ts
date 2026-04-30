import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import type { OAuthCredentials, OAuthProvider } from "./auth-profiles/types.js";

const log = createSubsystemLogger("agents/auth-profiles");

const CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH = ".claude/.credentials.json";
const CODEX_CLI_AUTH_FILENAME = "auth.json";
const MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH = ".minimax/oauth_creds.json";
const GEMINI_CLI_CREDENTIALS_RELATIVE_PATH = ".gemini/oauth_creds.json";

const CLAUDE_CLI_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_CLI_KEYCHAIN_ACCOUNT = "Claude Code";

type CachedValue<T> = {
  value: T | null;
  readAt: number;
  cacheKey: string;
  sourceFingerprint?: number | string | null;
};

let claudeCliCache: CachedValue<ClaudeCliCredential> | null = null;
let codexCliCache: CachedValue<CodexCliCredential> | null = null;
let minimaxCliCache: CachedValue<MiniMaxCliCredential> | null = null;
let geminiCliCache: CachedValue<GeminiCliCredential> | null = null;

export function resetCliCredentialCachesForTest(): void {
  claudeCliCache = null;
  codexCliCache = null;
  minimaxCliCache = null;
  geminiCliCache = null;
}

export type ClaudeCliCredential =
  | {
      type: "oauth";
      provider: "anthropic";
      access: string;
      refresh: string;
      expires: number;
    }
  | {
      type: "token";
      provider: "anthropic";
      token: string;
      expires: number;
    };

export type CodexCliCredential = {
  type: "oauth";
  provider: OAuthProvider;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  idToken?: string;
};

export type MiniMaxCliCredential = {
  type: "oauth";
  provider: "minimax-portal";
  access: string;
  refresh: string;
  expires: number;
};

export type GeminiCliCredential = {
  type: "oauth";
  provider: "google-gemini-cli";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
};

type ClaudeCliFileOptions = {
  homeDir?: string;
};

type ClaudeCliWriteOptions = ClaudeCliFileOptions & {
  platform?: NodeJS.Platform;
  writeKeychain?: (credentials: OAuthCredentials) => boolean;
  writeFile?: (credentials: OAuthCredentials, options?: ClaudeCliFileOptions) => boolean;
};

type ExecSyncFn = typeof execSync;
type ExecFileSyncFn = typeof execFileSync;

function resolveClaudeCliCredentialsPath(homeDir?: string) {
  const baseDir = homeDir ?? resolveUserPath("~");
  return path.join(baseDir, CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH);
}

function parseClaudeCliOauthCredential(claudeOauth: unknown): ClaudeCliCredential | null {
  if (!claudeOauth || typeof claudeOauth !== "object") {
    return null;
  }
  const accessToken = (claudeOauth as Record<string, unknown>).accessToken;
  const refreshToken = (claudeOauth as Record<string, unknown>).refreshToken;
  const expiresAt = (claudeOauth as Record<string, unknown>).expiresAt;

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
    };
  }
  return {
    type: "token",
    provider: "anthropic",
    token: accessToken,
    expires: expiresAt,
  };
}

function resolveCodexHomePath(codexHome?: string) {
  const configured = codexHome ?? process.env.CODEX_HOME;
  const home = configured ? resolveUserPath(configured) : resolveUserPath("~/.codex");
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

function resolveMiniMaxCliCredentialsPath(homeDir?: string) {
  const baseDir = homeDir ?? resolveUserPath("~");
  return path.join(baseDir, MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH);
}

function resolveGeminiCliCredentialsPath(homeDir?: string) {
  const baseDir = homeDir ?? resolveUserPath("~");
  return path.join(baseDir, GEMINI_CLI_CREDENTIALS_RELATIVE_PATH);
}

function readFileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function readCachedCliCredential<T>(options: {
  ttlMs: number;
  cache: CachedValue<T> | null;
  cacheKey: string;
  read: () => T | null;
  setCache: (next: CachedValue<T> | null) => void;
  readSourceFingerprint?: () => number | string | null;
}): T | null {
  const { ttlMs, cache, cacheKey, read, setCache, readSourceFingerprint } = options;
  if (ttlMs <= 0) {
    return read();
  }

  const now = Date.now();
  const sourceFingerprint = readSourceFingerprint?.();
  if (
    cache &&
    cache.cacheKey === cacheKey &&
    cache.sourceFingerprint === sourceFingerprint &&
    now - cache.readAt < ttlMs
  ) {
    return cache.value;
  }

  const value = read();
  const cachedSourceFingerprint = readSourceFingerprint?.();
  if (!readSourceFingerprint || cachedSourceFingerprint === sourceFingerprint) {
    setCache({
      value,
      readAt: now,
      cacheKey,
      sourceFingerprint: cachedSourceFingerprint,
    });
  } else {
    setCache(null);
  }
  return value;
}

function computeCodexKeychainAccount(codexHome: string) {
  const hash = createHash("sha256").update(codexHome).digest("hex");
  return `cli|${hash.slice(0, 16)}`;
}

function resolveCodexKeychainParams(options?: {
  codexHome?: string;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}) {
  return {
    platform: options?.platform ?? process.platform,
    execSyncImpl: options?.execSync ?? execSync,
    codexHome: resolveCodexHomePath(options?.codexHome),
  };
}

function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const payloadRaw = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadRaw) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

function decodeJwtIdentityClaims(token: string): { sub?: string; email?: string } {
  const parts = token.split(".");
  if (parts.length < 2) {
    return {};
  }
  try {
    const payloadRaw = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadRaw) as { sub?: unknown; email?: unknown };
    const sub = typeof payload.sub === "string" && payload.sub ? payload.sub : undefined;
    const email = typeof payload.email === "string" && payload.email ? payload.email : undefined;
    return { sub, email };
  } catch {
    return {};
  }
}

function readCodexKeychainAuthRecord(options?: {
  codexHome?: string;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
  allowKeychainPrompt?: boolean;
}): Record<string, unknown> | null {
  const { platform, execSyncImpl, codexHome } = resolveCodexKeychainParams(options);
  if (platform !== "darwin" || options?.allowKeychainPrompt === false) {
    return null;
  }
  const account = computeCodexKeychainAccount(codexHome);

  try {
    const secret = execSyncImpl(
      `security find-generic-password -s "Codex Auth" -a "${account}" -w`,
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();

    const parsed = JSON.parse(secret) as Record<string, unknown>;
    return parsed;
  } catch {
    return null;
  }
}

function readCodexKeychainCredentials(options?: {
  codexHome?: string;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
  allowKeychainPrompt?: boolean;
}): CodexCliCredential | null {
  const parsed = readCodexKeychainAuthRecord(options);
  if (!parsed) {
    return null;
  }
  const tokens = parsed.tokens as Record<string, unknown> | undefined;
  try {
    const accessToken = tokens?.access_token;
    const refreshToken = tokens?.refresh_token;
    if (typeof accessToken !== "string" || !accessToken) {
      return null;
    }
    if (typeof refreshToken !== "string" || !refreshToken) {
      return null;
    }

    // No explicit expiry stored; treat as fresh for an hour from last_refresh or now.
    const lastRefreshRaw = parsed.last_refresh;
    const lastRefresh =
      typeof lastRefreshRaw === "string" || typeof lastRefreshRaw === "number"
        ? new Date(lastRefreshRaw).getTime()
        : Date.now();
    const fallbackExpiry = Number.isFinite(lastRefresh)
      ? lastRefresh + 60 * 60 * 1000
      : Date.now() + 60 * 60 * 1000;
    const expires = decodeJwtExpiryMs(accessToken) ?? fallbackExpiry;
    const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : undefined;
    const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : undefined;

    log.info("read codex credentials from keychain", {
      source: "keychain",
      expires: new Date(expires).toISOString(),
    });

    return {
      type: "oauth",
      provider: "openai-codex" as OAuthProvider,
      access: accessToken,
      refresh: refreshToken,
      expires,
      accountId,
      idToken,
    };
  } catch {
    return null;
  }
}

function readPortalCliOauthCredentials<TProvider extends string>(
  credPath: string,
  provider: TProvider,
): { type: "oauth"; provider: TProvider; access: string; refresh: string; expires: number } | null {
  const raw = loadJsonFile(credPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const data = raw as Record<string, unknown>;
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresAt = data.expiry_date;

  if (typeof accessToken !== "string" || !accessToken) {
    return null;
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    return null;
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return null;
  }

  return {
    type: "oauth",
    provider,
    access: accessToken,
    refresh: refreshToken,
    expires: expiresAt,
  };
}

function readMiniMaxCliCredentials(options?: { homeDir?: string }): MiniMaxCliCredential | null {
  const credPath = resolveMiniMaxCliCredentialsPath(options?.homeDir);
  return readPortalCliOauthCredentials(credPath, "minimax-portal");
}

function readGeminiCliCredentials(options?: { homeDir?: string }): GeminiCliCredential | null {
  const credPath = resolveGeminiCliCredentialsPath(options?.homeDir);
  const raw = loadJsonFile(credPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const data = raw as Record<string, unknown>;
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresAt = data.expiry_date;

  if (typeof accessToken !== "string" || !accessToken) {
    return null;
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    return null;
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return null;
  }

  // Gemini CLI's login flow stores the openid id_token alongside the OAuth
  // tokens. Decode it once here to lift the Google account identity (sub,
  // email) onto the credential so the shared OAuth-identity encoder can key
  // the auth epoch on stable, non-secret identity material — matching the
  // Claude/Codex contract that #70132 codifies. Without this lift the encoder
  // collapses to a provider-keyed constant and stale bindings can survive a
  // re-login under a different Google account.
  const idTokenRaw = data.id_token;
  const identity =
    typeof idTokenRaw === "string" && idTokenRaw ? decodeJwtIdentityClaims(idTokenRaw) : {};

  return {
    type: "oauth",
    provider: "google-gemini-cli",
    access: accessToken,
    refresh: refreshToken,
    expires: expiresAt,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.sub ? { accountId: identity.sub } : {}),
  };
}

function readClaudeCliKeychainCredentials(
  execSyncImpl: ExecSyncFn = execSync,
): ClaudeCliCredential | null {
  try {
    const result = execSyncImpl(
      `security find-generic-password -s "${CLAUDE_CLI_KEYCHAIN_SERVICE}" -w`,
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );

    const data = JSON.parse(result.trim());
    return parseClaudeCliOauthCredential(data?.claudeAiOauth);
  } catch {
    return null;
  }
}

export function readClaudeCliCredentials(options?: {
  allowKeychainPrompt?: boolean;
  platform?: NodeJS.Platform;
  homeDir?: string;
  execSync?: ExecSyncFn;
}): ClaudeCliCredential | null {
  const platform = options?.platform ?? process.platform;
  if (platform === "darwin" && options?.allowKeychainPrompt !== false) {
    const keychainCreds = readClaudeCliKeychainCredentials(options?.execSync);
    if (keychainCreds) {
      log.info("read anthropic credentials from claude cli keychain", {
        type: keychainCreds.type,
      });
      return keychainCreds;
    }
  }

  const credPath = resolveClaudeCliCredentialsPath(options?.homeDir);
  const raw = loadJsonFile(credPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const data = raw as Record<string, unknown>;
  return parseClaudeCliOauthCredential(data.claudeAiOauth);
}

export function readClaudeCliCredentialsCached(options?: {
  allowKeychainPrompt?: boolean;
  ttlMs?: number;
  platform?: NodeJS.Platform;
  homeDir?: string;
  execSync?: ExecSyncFn;
}): ClaudeCliCredential | null {
  const platform = options?.platform ?? process.platform;
  const ttlMs = options?.ttlMs ?? 0;
  const credentialsPath = resolveClaudeCliCredentialsPath(options?.homeDir);
  const keychainIntent =
    platform === "darwin" && options?.allowKeychainPrompt !== false ? "keychain" : "file";
  return readCachedCliCredential({
    ttlMs,
    cache: claudeCliCache,
    cacheKey: `${credentialsPath}:${keychainIntent}`,
    read: () =>
      readClaudeCliCredentials({
        allowKeychainPrompt: options?.allowKeychainPrompt,
        platform,
        homeDir: options?.homeDir,
        execSync: options?.execSync,
      }),
    setCache: (next) => {
      claudeCliCache = next;
    },
  });
}

export function writeClaudeCliKeychainCredentials(
  newCredentials: OAuthCredentials,
  options?: { execFileSync?: ExecFileSyncFn },
): boolean {
  const execFileSyncImpl = options?.execFileSync ?? execFileSync;
  try {
    const existingResult = execFileSyncImpl(
      "security",
      ["find-generic-password", "-s", CLAUDE_CLI_KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );

    const existingData = JSON.parse(existingResult.trim());
    const existingOauth = existingData?.claudeAiOauth;
    if (!existingOauth || typeof existingOauth !== "object") {
      return false;
    }

    existingData.claudeAiOauth = {
      ...existingOauth,
      accessToken: newCredentials.access,
      refreshToken: newCredentials.refresh,
      expiresAt: newCredentials.expires,
    };

    const newValue = JSON.stringify(existingData);

    // Use execFileSync to avoid shell interpretation of user-controlled token values.
    // This prevents command injection via $() or backtick expansion in OAuth tokens.
    execFileSyncImpl(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        CLAUDE_CLI_KEYCHAIN_SERVICE,
        "-a",
        CLAUDE_CLI_KEYCHAIN_ACCOUNT,
        "-w",
        newValue,
      ],
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );

    log.info("wrote refreshed credentials to claude cli keychain", {
      expires: new Date(newCredentials.expires).toISOString(),
    });
    return true;
  } catch (error) {
    log.warn("failed to write credentials to claude cli keychain", {
      error: formatErrorMessage(error),
    });
    return false;
  }
}

export function writeClaudeCliFileCredentials(
  newCredentials: OAuthCredentials,
  options?: ClaudeCliFileOptions,
): boolean {
  const credPath = resolveClaudeCliCredentialsPath(options?.homeDir);

  if (!fs.existsSync(credPath)) {
    return false;
  }

  try {
    const raw = loadJsonFile(credPath);
    if (!raw || typeof raw !== "object") {
      return false;
    }

    const data = raw as Record<string, unknown>;
    const existingOauth = data.claudeAiOauth as Record<string, unknown> | undefined;
    if (!existingOauth || typeof existingOauth !== "object") {
      return false;
    }

    data.claudeAiOauth = {
      ...existingOauth,
      accessToken: newCredentials.access,
      refreshToken: newCredentials.refresh,
      expiresAt: newCredentials.expires,
    };

    saveJsonFile(credPath, data);
    log.info("wrote refreshed credentials to claude cli file", {
      expires: new Date(newCredentials.expires).toISOString(),
    });
    return true;
  } catch (error) {
    log.warn("failed to write credentials to claude cli file", {
      error: formatErrorMessage(error),
    });
    return false;
  }
}

export function writeClaudeCliCredentials(
  newCredentials: OAuthCredentials,
  options?: ClaudeCliWriteOptions,
): boolean {
  const platform = options?.platform ?? process.platform;
  const writeKeychain = options?.writeKeychain ?? writeClaudeCliKeychainCredentials;
  const writeFile =
    options?.writeFile ??
    ((credentials, fileOptions) => writeClaudeCliFileCredentials(credentials, fileOptions));

  if (platform === "darwin") {
    const didWriteKeychain = writeKeychain(newCredentials);
    if (didWriteKeychain) {
      return true;
    }
  }

  return writeFile(newCredentials, { homeDir: options?.homeDir });
}

export function readCodexCliCredentials(options?: {
  codexHome?: string;
  allowKeychainPrompt?: boolean;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}): CodexCliCredential | null {
  const keychain = readCodexKeychainCredentials({
    codexHome: options?.codexHome,
    allowKeychainPrompt: options?.allowKeychainPrompt,
    platform: options?.platform,
    execSync: options?.execSync,
  });
  if (keychain) {
    return keychain;
  }

  const authPath = path.join(resolveCodexHomePath(options?.codexHome), CODEX_CLI_AUTH_FILENAME);
  const raw = loadJsonFile(authPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const data = raw as Record<string, unknown>;
  const tokens = data.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== "object") {
    return null;
  }

  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;

  if (typeof accessToken !== "string" || !accessToken) {
    return null;
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    return null;
  }

  let fallbackExpiry: number;
  try {
    const stat = fs.statSync(authPath);
    fallbackExpiry = stat.mtimeMs + 60 * 60 * 1000;
  } catch {
    fallbackExpiry = Date.now() + 60 * 60 * 1000;
  }
  const expires = decodeJwtExpiryMs(accessToken) ?? fallbackExpiry;

  return {
    type: "oauth",
    provider: "openai-codex" as OAuthProvider,
    access: accessToken,
    refresh: refreshToken,
    expires,
    accountId: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
    idToken: typeof tokens.id_token === "string" ? tokens.id_token : undefined,
  };
}

export function readCodexCliCredentialsCached(options?: {
  codexHome?: string;
  allowKeychainPrompt?: boolean;
  ttlMs?: number;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}): CodexCliCredential | null {
  const platform = options?.platform ?? process.platform;
  const ttlMs = options?.ttlMs ?? 0;
  const authPath = path.join(resolveCodexHomePath(options?.codexHome), CODEX_CLI_AUTH_FILENAME);
  const keychainIntent =
    platform === "darwin" && options?.allowKeychainPrompt !== false ? "keychain" : "file";
  return readCachedCliCredential({
    ttlMs,
    cache: codexCliCache,
    cacheKey: `${platform}|${authPath}:${keychainIntent}`,
    read: () =>
      readCodexCliCredentials({
        codexHome: options?.codexHome,
        allowKeychainPrompt: options?.allowKeychainPrompt,
        platform: options?.platform,
        execSync: options?.execSync,
      }),
    setCache: (next) => {
      codexCliCache = next;
    },
    readSourceFingerprint: () => readFileMtimeMs(authPath),
  });
}

export function readMiniMaxCliCredentialsCached(options?: {
  ttlMs?: number;
  homeDir?: string;
}): MiniMaxCliCredential | null {
  const credPath = resolveMiniMaxCliCredentialsPath(options?.homeDir);
  return readCachedCliCredential({
    ttlMs: options?.ttlMs ?? 0,
    cache: minimaxCliCache,
    cacheKey: credPath,
    read: () => readMiniMaxCliCredentials({ homeDir: options?.homeDir }),
    setCache: (next) => {
      minimaxCliCache = next;
    },
    readSourceFingerprint: () => readFileMtimeMs(credPath),
  });
}

export function readGeminiCliCredentialsCached(options?: {
  ttlMs?: number;
  homeDir?: string;
}): GeminiCliCredential | null {
  const credPath = resolveGeminiCliCredentialsPath(options?.homeDir);
  return readCachedCliCredential({
    ttlMs: options?.ttlMs ?? 0,
    cache: geminiCliCache,
    cacheKey: credPath,
    read: () => readGeminiCliCredentials({ homeDir: options?.homeDir }),
    setCache: (next) => {
      geminiCliCache = next;
    },
    readSourceFingerprint: () => readFileMtimeMs(credPath),
  });
}
