/** Explicit Codex migration reads. Normal runtime auth uses Codex app-server status only. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";

const CODEX_AUTH_FILE = "auth.json";
const CODEX_COMMAND_MAX_OUTPUT_BYTES = 16 * 1024;
const CODEX_STATUS_TIMEOUT_MS = 5_000;
const CODEX_KEYCHAIN_PROMPT_TIMEOUT_MS = 60_000;
const CODEX_FALLBACK_EXPIRY_MS = 60 * 60 * 1000;

export type CodexCliCredential = {
  type: "oauth";
  provider: "openai";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  idToken?: string;
};

export type CodexCliApiKeyCredential = {
  type: "api_key";
  provider: "openai";
  key: string;
};

export type CodexCredentialReadOptions = {
  codexHome: string;
  allowKeychainPrompt: boolean;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
};

async function canonicalCodexHome(codexHome: string): Promise<string> {
  return await realpath(codexHome).catch(() => codexHome);
}

function keychainAccount(codexHome: string): string {
  return `cli|${createHash("sha256").update(codexHome).digest("hex").slice(0, 16)}`;
}

function commandSignal(options: CodexCredentialReadOptions): AbortSignal | undefined {
  if (options.signal) {
    return options.signal;
  }
  if ((options.platform ?? process.platform) !== "darwin" || !options.allowKeychainPrompt) {
    return undefined;
  }
  const deadline = AbortSignal.timeout(CODEX_KEYCHAIN_PROMPT_TIMEOUT_MS);
  return deadline;
}

async function readKeychainRecord(
  options: CodexCredentialReadOptions,
): Promise<Record<string, unknown> | undefined> {
  if ((options.platform ?? process.platform) !== "darwin" || !options.allowKeychainPrompt) {
    return undefined;
  }
  const home = await canonicalCodexHome(options.codexHome);
  const signal = commandSignal(options);
  const result = await runCommandBuffered(
    ["security", "find-generic-password", "-s", "Codex Auth", "-a", keychainAccount(home), "-w"],
    {
      timeoutMs: CODEX_KEYCHAIN_PROMPT_TIMEOUT_MS,
      maxCombinedOutputBytes: CODEX_COMMAND_MAX_OUTPUT_BYTES,
      baseEnv: process.env,
      ...(signal ? { signal } : {}),
    },
  );
  if (result.termination !== "exit" || result.code !== 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout.toString("utf8").trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function readAuthFile(codexHome: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await fs.readFile(path.join(codexHome, CODEX_AUTH_FILE), "utf8"),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function jwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const exp =
      parsed && typeof parsed === "object" ? (parsed as { exp?: unknown }).exp : undefined;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function parseOAuth(data: Record<string, unknown>): CodexCliCredential | undefined {
  const authMode = typeof data.auth_mode === "string" ? data.auth_mode.toLowerCase() : undefined;
  if (authMode && authMode !== "chatgpt" && authMode !== "chatgptauthtokens") {
    return undefined;
  }
  const tokens = data.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return undefined;
  }
  const access = (tokens as { access_token?: unknown }).access_token;
  const refresh = (tokens as { refresh_token?: unknown }).refresh_token;
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) {
    return undefined;
  }
  const lastRefresh = typeof data.last_refresh === "string" ? Date.parse(data.last_refresh) : NaN;
  const expires =
    jwtExpiry(access) ??
    (Number.isFinite(lastRefresh)
      ? lastRefresh + CODEX_FALLBACK_EXPIRY_MS
      : Date.now() + CODEX_FALLBACK_EXPIRY_MS);
  const accountId = (tokens as { account_id?: unknown }).account_id;
  const idToken = (tokens as { id_token?: unknown }).id_token;
  return {
    type: "oauth",
    provider: "openai",
    access,
    refresh,
    expires,
    ...(typeof accountId === "string" ? { accountId } : {}),
    ...(typeof idToken === "string" ? { idToken } : {}),
  };
}

function parseApiKey(data: Record<string, unknown>): CodexCliApiKeyCredential | undefined {
  const authMode = typeof data.auth_mode === "string" ? data.auth_mode.toLowerCase() : undefined;
  if (authMode && authMode !== "apikey" && authMode !== "api_key") {
    return undefined;
  }
  const key = typeof data.OPENAI_API_KEY === "string" ? data.OPENAI_API_KEY.trim() : "";
  return key ? { type: "api_key", provider: "openai", key } : undefined;
}

/** Reads Codex OAuth only for an explicit, operator-requested migration. */
export async function readCodexCliCredentialsAsync(
  options: CodexCredentialReadOptions,
): Promise<CodexCliCredential | undefined> {
  const home = await canonicalCodexHome(options.codexHome);
  const keychain = await readKeychainRecord({ ...options, codexHome: home });
  if (keychain) {
    const credential = parseOAuth(keychain);
    if (credential) {
      return credential;
    }
  }
  const file = await readAuthFile(home);
  return file ? parseOAuth(file) : undefined;
}

/** Reads a Codex API key only for an explicit, operator-requested migration. */
export async function readCodexCliActiveApiKeyAsync(
  options: CodexCredentialReadOptions,
): Promise<CodexCliApiKeyCredential | undefined> {
  const home = await canonicalCodexHome(options.codexHome);
  const signal = commandSignal(options);
  const statusResult = await runCommandBuffered(["codex", "login", "status"], {
    timeoutMs: options.allowKeychainPrompt
      ? CODEX_KEYCHAIN_PROMPT_TIMEOUT_MS
      : CODEX_STATUS_TIMEOUT_MS,
    maxCombinedOutputBytes: CODEX_COMMAND_MAX_OUTPUT_BYTES,
    baseEnv: process.env,
    env: { CODEX_HOME: home },
    ...(signal ? { signal } : {}),
  });
  const status = [statusResult.stdout, statusResult.stderr]
    .map((value) => value.toString("utf8").trim())
    .filter(Boolean)
    .join("\n");
  if (
    statusResult.termination !== "exit" ||
    statusResult.code !== 0 ||
    !status.includes("Logged in using an API key")
  ) {
    return undefined;
  }
  const keychain = await readKeychainRecord({ ...options, codexHome: home, signal });
  if (keychain) {
    const credential = parseApiKey(keychain);
    if (credential) {
      return credential;
    }
  }
  const file = await readAuthFile(home);
  return file ? parseApiKey(file) : undefined;
}
