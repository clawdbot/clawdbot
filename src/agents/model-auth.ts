import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type Api,
  getEnvApiKey,
  getOAuthApiKey,
  type Model,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai";
import type { discoverAuthStorage } from "@mariozechner/pi-coding-agent";

import { CONFIG_DIR, resolveUserPath } from "../utils.js";

const OAUTH_FILENAME = "oauth.json";
const ANTIGRAVITY_STATE_FILENAME = "antigravity-state.json";
const DEFAULT_OAUTH_DIR = path.join(CONFIG_DIR, "credentials");
let oauthStorageConfigured = false;
let oauthStorageMigrated = false;

type OAuthStorage = Record<string, OAuthCredentials>;

interface AntigravityAccountState {
  lastUsed: number;
  errorCount: number;
  cooldownUntil: number;
}
type AntigravityState = Record<string, AntigravityAccountState>;

function resolveClawdbotOAuthPath(): string {
  const overrideDir =
    process.env.CLAWDBOT_OAUTH_DIR?.trim() || DEFAULT_OAUTH_DIR;
  return path.join(resolveUserPath(overrideDir), OAUTH_FILENAME);
}

function resolveAntigravityStatePath(): string {
  const oauthPath = resolveClawdbotOAuthPath();
  return path.join(path.dirname(oauthPath), ANTIGRAVITY_STATE_FILENAME);
}

function loadAntigravityState(): AntigravityState {
  const pathname = resolveAntigravityStatePath();
  if (!fsSync.existsSync(pathname)) return {};
  try {
    return JSON.parse(
      fsSync.readFileSync(pathname, "utf8"),
    ) as AntigravityState;
  } catch {
    return {};
  }
}

function saveAntigravityState(state: AntigravityState): void {
  const pathname = resolveAntigravityStatePath();
  fsSync.writeFileSync(pathname, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function getAntigravityAccounts(storage: OAuthStorage): string[] {
  return Object.keys(storage).filter(
    (k) => k === "google-antigravity" || k.startsWith("google-antigravity:"),
  );
}

export function markAntigravityFailure(accountKey: string) {
  const state = loadAntigravityState();
  const now = Date.now();
  const entry = state[accountKey] || {
    lastUsed: 0,
    errorCount: 0,
    cooldownUntil: 0,
  };

  entry.errorCount++;
  // Exponential backoff: 1min, 5min, 25min, max 1h
  const backoff = Math.min(
    60 * 60 * 1000,
    60 * 1000 * Math.pow(5, Math.min(entry.errorCount - 1, 3)),
  );
  entry.cooldownUntil = now + backoff;

  state[accountKey] = entry;
  saveAntigravityState(state);
}

export function markAntigravitySuccess(accountKey: string) {
  const state = loadAntigravityState();
  if (state[accountKey]) {
    state[accountKey].errorCount = 0;
    state[accountKey].cooldownUntil = 0;
    state[accountKey].lastUsed = Date.now();
    saveAntigravityState(state);
  } else {
    // Initialize state for new successful account
    state[accountKey] = {
      lastUsed: Date.now(),
      errorCount: 0,
      cooldownUntil: 0,
    };
    saveAntigravityState(state);
  }
}

export function getNextAntigravityAccount(
  storage: OAuthStorage,
  exclude: Set<string> = new Set(),
): string | null {
  const accounts = getAntigravityAccounts(storage);
  if (accounts.length === 0) return null;

  const state = loadAntigravityState();
  const now = Date.now();

  // Filter out excluded accounts
  const candidates = accounts.filter((a) => !exclude.has(a));
  if (candidates.length === 0) return null;

  // Filter out cooled down accounts
  const ready = candidates.filter((a) => {
    const s = state[a];
    return !s || s.cooldownUntil <= now;
  });

  // If all are cooled down, pick the one with earliest cooldown expiry
  if (ready.length === 0) {
    return candidates.sort((a, b) => {
      const sa = state[a]?.cooldownUntil ?? 0;
      const sb = state[b]?.cooldownUntil ?? 0;
      return sa - sb;
    })[0];
  }

  // Round robin: pick the one with oldest lastUsed
  return ready.sort((a, b) => {
    const sa = state[a]?.lastUsed ?? 0;
    const sb = state[b]?.lastUsed ?? 0;
    return sa - sb;
  })[0];
}

export async function getAntigravityApiKey(
  authStorage: ReturnType<typeof discoverAuthStorage>,
  excludeAccounts: Set<string> = new Set(),
): Promise<{ apiKey: string; accountKey: string } | null> {
  const oauthPath = resolveClawdbotOAuthPath();
  const storage = loadOAuthStorageAt(oauthPath);
  if (!storage) return null;

  const accountKey = getNextAntigravityAccount(storage, excludeAccounts);
  if (!accountKey) return null;

  try {
    // Construct temp storage with just the selected account as the "google-antigravity" provider
    // This tricks getOAuthApiKey into refreshing/using this specific account
    const creds = storage[accountKey];
    const tempStorage: OAuthStorage = { "google-antigravity": creds };

    const result = await getOAuthApiKey("google-antigravity", tempStorage);
    if (result?.apiKey) {
      // If credentials were refreshed, update the original storage
      if (result.newCredentials) {
        storage[accountKey] = result.newCredentials;
        saveOAuthStorageAt(oauthPath, storage);
      }
      return { apiKey: result.apiKey, accountKey };
    }
  } catch (err) {
    // If getting the key fails (e.g. refresh failed), mark it as failed immediately
    markAntigravityFailure(accountKey);
    throw err;
  }
  return null;
}

function loadOAuthStorageAt(pathname: string): OAuthStorage | null {
  if (!fsSync.existsSync(pathname)) return null;
  try {
    const content = fsSync.readFileSync(pathname, "utf8");
    const json = JSON.parse(content) as OAuthStorage;
    if (!json || typeof json !== "object") return null;
    return json;
  } catch {
    return null;
  }
}

function hasAnthropicOAuth(storage: OAuthStorage): boolean {
  const entry = storage.anthropic as
    | {
        refresh?: string;
        refresh_token?: string;
        refreshToken?: string;
        access?: string;
        access_token?: string;
        accessToken?: string;
      }
    | undefined;
  if (!entry) return false;
  const refresh =
    entry.refresh ?? entry.refresh_token ?? entry.refreshToken ?? "";
  const access = entry.access ?? entry.access_token ?? entry.accessToken ?? "";
  return Boolean(refresh.trim() && access.trim());
}

function saveOAuthStorageAt(pathname: string, storage: OAuthStorage): void {
  const dir = path.dirname(pathname);
  fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fsSync.writeFileSync(
    pathname,
    `${JSON.stringify(storage, null, 2)}\n`,
    "utf8",
  );
  fsSync.chmodSync(pathname, 0o600);
}

function legacyOAuthPaths(): string[] {
  const paths: string[] = [];
  const piOverride = process.env.PI_CODING_AGENT_DIR?.trim();
  if (piOverride) {
    paths.push(path.join(resolveUserPath(piOverride), OAUTH_FILENAME));
  }
  paths.push(path.join(os.homedir(), ".pi", "agent", OAUTH_FILENAME));
  paths.push(path.join(os.homedir(), ".claude", OAUTH_FILENAME));
  paths.push(path.join(os.homedir(), ".config", "claude", OAUTH_FILENAME));
  paths.push(path.join(os.homedir(), ".config", "anthropic", OAUTH_FILENAME));
  return Array.from(new Set(paths));
}

function importLegacyOAuthIfNeeded(destPath: string): void {
  if (fsSync.existsSync(destPath)) return;
  for (const legacyPath of legacyOAuthPaths()) {
    const storage = loadOAuthStorageAt(legacyPath);
    if (!storage || !hasAnthropicOAuth(storage)) continue;
    saveOAuthStorageAt(destPath, storage);
    return;
  }
}

export function ensureOAuthStorage(): void {
  if (oauthStorageConfigured) return;
  oauthStorageConfigured = true;
  const oauthPath = resolveClawdbotOAuthPath();
  importLegacyOAuthIfNeeded(oauthPath);
}

function isValidOAuthCredential(
  entry: OAuthCredentials | undefined,
): entry is OAuthCredentials {
  if (!entry) return false;
  return Boolean(
    entry.access?.trim() &&
      entry.refresh?.trim() &&
      Number.isFinite(entry.expires),
  );
}

function migrateOAuthStorageToAuthStorage(
  authStorage: ReturnType<typeof discoverAuthStorage>,
): void {
  if (oauthStorageMigrated) return;
  oauthStorageMigrated = true;
  const oauthPath = resolveClawdbotOAuthPath();
  const storage = loadOAuthStorageAt(oauthPath);
  if (!storage) return;
  for (const [provider, creds] of Object.entries(storage)) {
    if (!isValidOAuthCredential(creds)) continue;
    if (authStorage.get(provider)) continue;
    authStorage.set(provider, { type: "oauth", ...creds });
  }
}

function isOAuthProvider(provider: string): provider is OAuthProvider {
  return (
    provider === "anthropic" ||
    provider === "anthropic-oauth" ||
    provider === "google" ||
    provider === "openai" ||
    provider === "openai-compatible" ||
    provider === "openai-codex" ||
    provider === "github-copilot" ||
    provider === "google-gemini-cli" ||
    provider === "google-antigravity"
  );
}

export async function getApiKeyForModel(
  model: Model<Api>,
  authStorage: ReturnType<typeof discoverAuthStorage>,
): Promise<string> {
  ensureOAuthStorage();
  migrateOAuthStorageToAuthStorage(authStorage);
  const storedKey = await authStorage.getApiKey(model.provider);
  if (storedKey) return storedKey;
  if (model.provider === "anthropic") {
    const oauthEnv = process.env.ANTHROPIC_OAUTH_TOKEN;
    if (oauthEnv?.trim()) return oauthEnv.trim();
  }
  const envKey = getEnvApiKey(model.provider);
  if (envKey) return envKey;

  if (model.provider === "google-antigravity") {
    const result = await getAntigravityApiKey(authStorage);
    if (result) return result.apiKey;
    // Fall through if no account available
  }

  if (isOAuthProvider(model.provider)) {
    const oauthPath = resolveClawdbotOAuthPath();
    const storage = loadOAuthStorageAt(oauthPath);
    if (storage) {
      try {
        const result = await getOAuthApiKey(model.provider, storage);
        if (result?.apiKey) {
          storage[model.provider] = result.newCredentials;
          saveOAuthStorageAt(oauthPath, storage);
          return result.apiKey;
        }
      } catch {
        // fall through to error below
      }
    }
  }
  throw new Error(`No API key found for provider "${model.provider}"`);
}
