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
const DEFAULT_OAUTH_DIR = path.join(CONFIG_DIR, "credentials");
let oauthStorageConfigured = false;
let oauthStorageMigrated = false;

type OAuthStorage = Record<string, OAuthCredentials>;

function resolveClawdbotOAuthPath(): string {
  const overrideDir =
    process.env.CLAWDBOT_OAUTH_DIR?.trim() || DEFAULT_OAUTH_DIR;
  return path.join(resolveUserPath(overrideDir), OAUTH_FILENAME);
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

export function hydrateAuthStorage(
  authStorage: ReturnType<typeof discoverAuthStorage>,
): void {
  ensureOAuthStorage();
  migrateOAuthStorageToAuthStorage(authStorage);
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
