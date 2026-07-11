/**
 * Reads and refreshes credentials stored by external CLI runtimes such as
 * Claude Code, Codex, Gemini, and MiniMax.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
  timestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { resolveOsHomeRelativePath } from "../infra/home-dir.js";
import { loadJsonFile } from "../infra/json-file.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OAuthProvider } from "./auth-profiles/types.js";

const log = createSubsystemLogger("agents/auth-profiles");

const CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH = ".claude/.credentials.json";
const CODEX_CLI_AUTH_FILENAME = "auth.json";
const MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH = ".minimax/oauth_creds.json";
const GEMINI_CLI_CREDENTIALS_RELATIVE_PATH = ".gemini/oauth_creds.json";
const CODEX_CLI_FALLBACK_EXPIRY_MS = 60 * 60 * 1000;

const CLAUDE_CLI_KEYCHAIN_SERVICE = "Claude Code-credentials";
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

/** Clears in-memory CLI credential caches for isolated tests. */
export function resetCliCredentialCachesForTest(): void {
  claudeCliCache = null;
  codexCliCache = null;
  minimaxCliCache = null;
  geminiCliCache = null;
}

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
    }
  | {
      type: "token";
      provider: "anthropic";
      token: string;
      expires: number;
      subscriptionType?: string;
      rateLimitTier?: string;
    };

/** Credential shape parsed from Codex CLI storage. */
export type CodexCliCredential = {
  type: "oauth";
  provider: OAuthProvider;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  idToken?: string;
};

/** Credential shape parsed from MiniMax portal CLI storage. */
export type MiniMaxCliCredential = {
  type: "oauth";
  provider: "minimax-portal";
  access: string;
  refresh: string;
  expires: number;
};

/** Credential shape parsed from Gemini CLI storage. */
export type GeminiCliCredential = {
  type: "oauth";
  provider: "google-gemini-cli";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
};

type ExecSyncFn = typeof execSync;

function resolveClaudeCliCredentialsPath(homeDir?: string) {
  const baseDir = resolveOsHomeRelativePath(homeDir ?? "~");
  return path.join(baseDir, CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH);
}

function parseClaudeCliOauthCredential(claudeOauth: unknown): ClaudeCliCredential | null {
  if (!claudeOauth || typeof claudeOauth !== "object") {
    return null;
  }
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

function resolveCodexHomePath(codexHome?: string) {
  const configured = codexHome ?? process.env.CODEX_HOME;
  // External CLI state belongs to the OS user, not OpenClaw's relocatable
  // home. Otherwise an isolated OPENCLAW_HOME hides an already logged-in CLI.
  const home = resolveOsHomeRelativePath(configured || "~/.codex");
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

function codexAuthJsonUsesChatGptTokens(data: Record<string, unknown>): boolean {
  const authMode = typeof data.auth_mode === "string" ? data.auth_mode.toLowerCase() : undefined;
  if (authMode) {
    return authMode === "chatgpt" || authMode === "chatgptauthtokens";
  }
  return typeof data.OPENAI_API_KEY !== "string";
}

function resolveMiniMaxCliCredentialsPath(homeDir?: string) {
  const baseDir = resolveOsHomeRelativePath(homeDir ?? "~");
  return path.join(baseDir, MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH);
}

function resolveGeminiCliCredentialsPath(homeDir?: string) {
  const baseDir = resolveOsHomeRelativePath(homeDir ?? "~");
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
  const encodedPayload = parts.at(1);
  if (!encodedPayload) {
    return null;
  }
  try {
    const payloadRaw = Buffer.from(encodedPayload, "base64url").toString("utf8");
    const payload = JSON.parse(payloadRaw) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= 0) {
      return null;
    }
    return asDateTimestampMs(payload.exp * 1000) ?? null;
  } catch {
    return null;
  }
}

function decodeJwtIdentityClaims(token: string): { sub?: string; email?: string } {
  const parts = token.split(".");
  if (parts.length < 2) {
    return {};
  }
  const encodedPayload = parts.at(1);
  if (!encodedPayload) {
    return {};
  }
  try {
    const payloadRaw = Buffer.from(encodedPayload, "base64url").toString("utf8");
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

function resolveCodexFallbackExpiryMs(nowMs?: number): number | undefined {
  const baseMs = nowMs === undefined ? undefined : Math.floor(nowMs);
  return resolveExpiresAtMsFromDurationMs(CODEX_CLI_FALLBACK_EXPIRY_MS, { nowMs: baseMs });
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
    const fallbackExpiry =
      resolveCodexFallbackExpiryMs(lastRefresh) ?? resolveCodexFallbackExpiryMs();
    const expires = decodeJwtExpiryMs(accessToken) ?? fallbackExpiry;
    if (expires === undefined) {
      return null;
    }
    const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : undefined;
    const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : undefined;

    log.info("read codex credentials from keychain", {
      source: "keychain",
      expires: timestampMsToIsoString(expires),
    });

    return {
      type: "oauth",
      provider: "openai" as OAuthProvider,
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

function readCliOauthTokenFields(
  data: Record<string, unknown>,
): { access: string; refresh: string; expires: number } | null {
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

  return { access: accessToken, refresh: refreshToken, expires: expiresAt };
}

function readPortalCliOauthCredentials<TProvider extends string>(
  credPath: string,
  provider: TProvider,
): { type: "oauth"; provider: TProvider; access: string; refresh: string; expires: number } | null {
  const raw = loadJsonFile(credPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const tokens = readCliOauthTokenFields(raw as Record<string, unknown>);
  return tokens ? { type: "oauth", provider, ...tokens } : null;
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
  const tokens = readCliOauthTokenFields(data);
  if (!tokens) {
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
    ...tokens,
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

/** Reads Claude CLI credentials from macOS Keychain or the CLI credential file. */
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

/** @deprecated Anthropic provider-owned CLI credential helper; do not use from third-party plugins. */
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

/** Reads Codex CLI OAuth credentials from Keychain or CODEX_HOME auth.json. */
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
  if (!codexAuthJsonUsesChatGptTokens(data)) {
    return null;
  }
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

  let fallbackExpiry: number | undefined;
  try {
    const stat = fs.statSync(authPath);
    fallbackExpiry = resolveCodexFallbackExpiryMs(stat.mtimeMs);
  } catch {
    fallbackExpiry = resolveCodexFallbackExpiryMs();
  }
  const expires = decodeJwtExpiryMs(accessToken) ?? fallbackExpiry;
  if (expires === undefined) {
    return null;
  }

  return {
    type: "oauth",
    provider: "openai" as OAuthProvider,
    access: accessToken,
    refresh: refreshToken,
    expires,
    accountId: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
    idToken: typeof tokens.id_token === "string" ? tokens.id_token : undefined,
  };
}

/** Reads Codex CLI credentials with optional short-lived cache and file fingerprinting. */
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

/** Reads MiniMax CLI credentials with optional short-lived cache. */
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

/** Reads Gemini CLI credentials with optional short-lived cache. */
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
