/** Reads credentials stored by external CLI runtimes that retain ownership. */
import fs from "node:fs";
import path from "node:path";
import { resolveOsHomeRelativePath } from "../infra/home-dir.js";
import { loadJsonFileThroughSymlink } from "../infra/json-file.js";

const MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH = ".minimax/oauth_creds.json";
const GEMINI_CLI_CREDENTIALS_RELATIVE_PATH = ".gemini/oauth_creds.json";

type CachedValue<T> = {
  value: T | null;
  readAt: number;
  cacheKey: string;
  sourceFingerprint?: number | string | null;
};

let minimaxCliCache: CachedValue<MiniMaxCliCredential> | null = null;
let geminiCliCache: CachedValue<GeminiCliCredential> | null = null;

/** Clears in-memory CLI credential caches for isolated tests. */
function resetCliCredentialCachesForTest(): void {
  minimaxCliCache = null;
  geminiCliCache = null;
}

type MiniMaxCliCredential = {
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

function resolveMiniMaxCliCredentialsPath(homeDir?: string): string {
  return path.join(
    resolveOsHomeRelativePath(homeDir ?? "~"),
    MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH,
  );
}

function resolveGeminiCliCredentialsPath(homeDir?: string): string {
  return path.join(resolveOsHomeRelativePath(homeDir ?? "~"), GEMINI_CLI_CREDENTIALS_RELATIVE_PATH);
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

function readCliOauthTokenFields(
  data: Record<string, unknown>,
): { access: string; refresh: string; expires: number } | null {
  const access = data.access_token;
  const refresh = data.refresh_token;
  const expires = data.expiry_date;
  return typeof access === "string" &&
    access &&
    typeof refresh === "string" &&
    refresh &&
    typeof expires === "number" &&
    Number.isFinite(expires)
    ? { access, refresh, expires }
    : null;
}

function readPortalCliOauthCredentials<TProvider extends string>(
  credentialPath: string,
  provider: TProvider,
): { type: "oauth"; provider: TProvider; access: string; refresh: string; expires: number } | null {
  const raw = loadJsonFileThroughSymlink(credentialPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const tokens = readCliOauthTokenFields(raw as Record<string, unknown>);
  return tokens ? { type: "oauth", provider, ...tokens } : null;
}

function readMiniMaxCliCredentials(options?: { homeDir?: string }): MiniMaxCliCredential | null {
  return readPortalCliOauthCredentials(
    resolveMiniMaxCliCredentialsPath(options?.homeDir),
    "minimax-portal",
  );
}

function decodeJwtIdentityClaims(token: string): { sub?: string; email?: string } {
  const payload = token.split(".")[1];
  if (!payload) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const record = parsed as { sub?: unknown; email?: unknown };
    return {
      ...(typeof record.sub === "string" && record.sub ? { sub: record.sub } : {}),
      ...(typeof record.email === "string" && record.email ? { email: record.email } : {}),
    };
  } catch {
    return {};
  }
}

function readGeminiCliCredentials(options?: { homeDir?: string }): GeminiCliCredential | null {
  const raw = loadJsonFileThroughSymlink(resolveGeminiCliCredentialsPath(options?.homeDir));
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const tokens = readCliOauthTokenFields(raw as Record<string, unknown>);
  if (!tokens) {
    return null;
  }
  const idToken = (raw as Record<string, unknown>).id_token;
  const identity = typeof idToken === "string" && idToken ? decodeJwtIdentityClaims(idToken) : {};
  return {
    type: "oauth",
    provider: "google-gemini-cli",
    ...tokens,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.sub ? { accountId: identity.sub } : {}),
  };
}

/** Reads MiniMax CLI OAuth with optional short-lived cache and file fingerprinting. */
export function readMiniMaxCliCredentialsCached(options?: {
  ttlMs?: number;
  homeDir?: string;
}): MiniMaxCliCredential | null {
  const credentialPath = resolveMiniMaxCliCredentialsPath(options?.homeDir);
  return readCachedCliCredential({
    ttlMs: options?.ttlMs ?? 0,
    cache: minimaxCliCache,
    cacheKey: credentialPath,
    read: () => readMiniMaxCliCredentials({ homeDir: options?.homeDir }),
    setCache: (next) => {
      minimaxCliCache = next;
    },
    readSourceFingerprint: () => readFileMtimeMs(credentialPath),
  });
}

/** Reads Gemini CLI OAuth with optional short-lived cache and file fingerprinting. */
export function readGeminiCliCredentialsCached(options?: {
  ttlMs?: number;
  homeDir?: string;
}): GeminiCliCredential | null {
  const credentialPath = resolveGeminiCliCredentialsPath(options?.homeDir);
  return readCachedCliCredential({
    ttlMs: options?.ttlMs ?? 0,
    cache: geminiCliCache,
    cacheKey: credentialPath,
    read: () => readGeminiCliCredentials({ homeDir: options?.homeDir }),
    setCache: (next) => {
      geminiCliCache = next;
    },
    readSourceFingerprint: () => readFileMtimeMs(credentialPath),
  });
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cliCredentialsTestApi")] = {
    resetCaches: resetCliCredentialCachesForTest,
  };
}
