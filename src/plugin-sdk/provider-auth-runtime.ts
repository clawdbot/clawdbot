// Public runtime auth helpers for provider plugins.

import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureAuthProfileStoreForLocalUpdate } from "../agents/auth-profiles/store.js";
import type { OAuthCredential } from "../agents/auth-profiles/types.js";
import { writePrivateSecretFileAtomic } from "../infra/secret-file.js";

export { resolveEnvApiKey } from "../agents/model-auth-env.js";
export {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../agents/api-key-rotation.js";
export { NON_ENV_SECRETREF_MARKER } from "../agents/model-auth-markers.js";
export {
  requireApiKey,
  resolveAwsSdkEnvVarName,
  type ResolvedProviderAuth,
} from "../agents/model-auth-runtime-shared.js";
export type { ProviderPreparedRuntimeAuth } from "../plugins/types.js";
export type { ResolvedProviderRuntimeAuth } from "../plugins/runtime/model-auth-types.js";

export const CODEX_AUTH_ENV_CLEAR_KEYS = ["OPENAI_API_KEY"] as const;

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

export type PreparedCodexAuthBridge = {
  codexHome: string;
  clearEnv: string[];
};

export type OAuthCallbackResult = { code: string; state: string };

export function generateOAuthState(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function parseOAuthCallbackInput(
  input: string,
  messages: {
    missingState?: string;
    invalidInput?: string;
  } = {},
): OAuthCallbackResult | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: "No input provided" };
  }

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) {
      return { error: "Missing 'code' parameter in URL" };
    }
    if (!state) {
      return { error: messages.missingState ?? "Missing 'state' parameter in URL" };
    }
    return { code, state };
  } catch {
    return { error: messages.invalidInput ?? "Paste the full redirect URL, not just the code." };
  }
}

export async function waitForLocalOAuthCallback(params: {
  expectedState: string;
  timeoutMs: number;
  port: number;
  callbackPath: string;
  redirectUri: string;
  successTitle: string;
  progressMessage?: string;
  hostname?: string;
  onProgress?: (message: string) => void;
}): Promise<OAuthCallbackResult> {
  const hostname = params.hostname ?? "localhost";
  const escapedSuccessTitle = escapeHtmlText(params.successTitle);

  return new Promise<OAuthCallbackResult>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const server = createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url ?? "/", `http://${hostname}:${params.port}`);
        if (requestUrl.pathname !== params.callbackPath) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain");
          res.end("Not found");
          return;
        }

        const error = requestUrl.searchParams.get("error");
        const code = requestUrl.searchParams.get("code")?.trim();
        const state = requestUrl.searchParams.get("state")?.trim();

        if (error) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end(`Authentication failed: ${error}`);
          finish(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || !state) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end("Missing code or state");
          finish(new Error("Missing OAuth code or state"));
          return;
        }

        if (state !== params.expectedState) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end("Invalid state");
          finish(new Error("OAuth state mismatch"));
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          "<!doctype html><html><head><meta charset='utf-8'/></head>" +
            `<body><h2>${escapedSuccessTitle}</h2>` +
            "<p>You can close this window and return to OpenClaw.</p></body></html>",
        );

        finish(undefined, { code, state });
      } catch (err) {
        finish(err instanceof Error ? err : new Error("OAuth callback failed"));
      }
    });

    const finish = (err?: Error, result?: OAuthCallbackResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      try {
        server.close();
      } catch {
        // ignore close errors
      }
      if (err) {
        reject(err);
      } else if (result) {
        resolve(result);
      }
    };

    server.once("error", (err) => {
      finish(err instanceof Error ? err : new Error("OAuth callback server error"));
    });

    server.listen(params.port, hostname, () => {
      params.onProgress?.(
        params.progressMessage ?? `Waiting for OAuth callback on ${params.redirectUri}...`,
      );
    });

    timeout = setTimeout(() => {
      finish(new Error("OAuth callback timeout"));
    }, params.timeoutMs);
  });
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function isCodexBridgeableOAuthCredential(value: unknown): value is OAuthCredential {
  return Boolean(
    value &&
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "provider" in value &&
    "access" in value &&
    "refresh" in value &&
    value.type === "oauth" &&
    value.provider === OPENAI_CODEX_PROVIDER_ID &&
    typeof value.access === "string" &&
    value.access.trim().length > 0 &&
    typeof value.refresh === "string" &&
    value.refresh.trim().length > 0,
  );
}

type CodexAuthBridgeRecord = {
  auth_mode?: unknown;
  tokens?: {
    id_token?: unknown;
    access_token?: unknown;
    refresh_token?: unknown;
    account_id?: unknown;
  };
  last_refresh?: unknown;
  OPENAI_API_KEY?: unknown;
};

type CodexAuthBridgeMaterial = {
  accountId?: string;
  idToken?: string;
  lastRefresh?: string | number;
  openaiApiKey?: string;
};

export function resolveCodexAuthBridgeHome(params: {
  agentDir: string;
  bridgeDir: string;
  profileId: string;
}): string {
  const digest = crypto.createHash("sha256").update(params.profileId).digest("hex").slice(0, 16);
  return path.join(params.agentDir, params.bridgeDir, "codex", digest);
}

export function buildCodexAuthBridgeFile(
  credential: OAuthCredential,
  material: Partial<CodexAuthBridgeMaterial> = {},
): string {
  const lastRefresh =
    normalizeCodexAuthLastRefresh(material.lastRefresh) ?? new Date().toISOString();
  const openaiApiKey = readCodexAuthString(material.openaiApiKey);
  const idToken = readCodexAuthString(credential.idToken) ?? readCodexAuthString(material.idToken);
  const accountId =
    readCodexAuthString(credential.accountId) ?? readCodexAuthString(material.accountId);
  return `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      ...(openaiApiKey ? { OPENAI_API_KEY: openaiApiKey } : {}),
      tokens: {
        ...(idToken ? { id_token: idToken } : {}),
        access_token: credential.access,
        refresh_token: credential.refresh,
        ...(accountId ? { account_id: accountId } : {}),
      },
      last_refresh: lastRefresh,
    },
    null,
    2,
  )}\n`;
}

export async function prepareCodexAuthBridge(params: {
  agentDir: string;
  bridgeDir: string;
  profileId: string;
  sourceCodexHome?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PreparedCodexAuthBridge | undefined> {
  const store = ensureAuthProfileStoreForLocalUpdate(params.agentDir);
  const credential = store.profiles[params.profileId];
  if (!isCodexBridgeableOAuthCredential(credential)) {
    return undefined;
  }

  const codexHome = resolveCodexAuthBridgeHome(params);
  const material = resolveCodexAuthBridgeMaterial({
    credential,
    sourceCodexHome: params.sourceCodexHome,
    env: { ...process.env, ...params.env },
  });
  await writePrivateSecretFileAtomic({
    rootDir: params.agentDir,
    filePath: path.join(codexHome, "auth.json"),
    content: buildCodexAuthBridgeFile(credential, material),
  });

  return {
    codexHome,
    clearEnv: [...CODEX_AUTH_ENV_CLEAR_KEYS],
  };
}

function resolveCodexAuthBridgeMaterial(params: {
  credential: OAuthCredential;
  sourceCodexHome?: string;
  env?: NodeJS.ProcessEnv;
}): Partial<CodexAuthBridgeMaterial> {
  const source = readCodexAuthBridgeSourceFile({
    codexHome: params.sourceCodexHome,
    env: params.env,
  });
  if (!source || source.auth_mode !== "chatgpt") {
    return {};
  }

  const tokens = source.tokens;
  if (!tokens || typeof tokens !== "object") {
    return {};
  }
  const access = readCodexAuthString(tokens.access_token);
  const refresh = readCodexAuthString(tokens.refresh_token);
  if (!access || !refresh) {
    return {};
  }

  const accountId = readCodexAuthString(tokens.account_id);
  if (!codexAuthSourceMatchesCredential(params.credential, { access, refresh, accountId })) {
    return {};
  }
  const idToken = readCodexAuthString(tokens.id_token);
  const lastRefresh = normalizeCodexAuthLastRefresh(source.last_refresh);
  const openaiApiKey = readCodexAuthString(source.OPENAI_API_KEY);

  return {
    ...(accountId ? { accountId } : {}),
    ...(idToken ? { idToken } : {}),
    ...(lastRefresh ? { lastRefresh } : {}),
    ...(openaiApiKey ? { openaiApiKey } : {}),
  };
}

function codexAuthSourceMatchesCredential(
  credential: OAuthCredential,
  source: { access: string; refresh: string; accountId?: string },
): boolean {
  if (credential.access === source.access && credential.refresh === source.refresh) {
    return true;
  }
  const credentialAccountId = credential.accountId?.trim();
  const sourceAccountId = source.accountId?.trim();
  return Boolean(credentialAccountId && sourceAccountId && credentialAccountId === sourceAccountId);
}

function readCodexAuthBridgeSourceFile(params: {
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
}): CodexAuthBridgeRecord | undefined {
  const codexHome = resolveSourceCodexHome(params);
  if (!codexHome) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as CodexAuthBridgeRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveSourceCodexHome(params: {
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const configured = params.codexHome?.trim() || params.env?.CODEX_HOME?.trim();
  if (configured) {
    return resolveTildePath(configured);
  }
  const home = os.homedir();
  return home ? path.join(home, ".codex") : undefined;
}

function resolveTildePath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function readCodexAuthString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeCodexAuthLastRefresh(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return readCodexAuthString(value);
}

type ResolveApiKeyForProvider = typeof import("../agents/model-auth.js").resolveApiKeyForProvider;
type GetRuntimeAuthForModel =
  typeof import("../plugins/runtime/runtime-model-auth.runtime.js").getRuntimeAuthForModel;
type RuntimeModelAuthModule = typeof import("../plugins/runtime/runtime-model-auth.runtime.js");
const RUNTIME_MODEL_AUTH_CANDIDATES = [
  "./runtime-model-auth.runtime",
  "../plugins/runtime/runtime-model-auth.runtime",
] as const;
const RUNTIME_MODEL_AUTH_EXTENSIONS = [".js", ".ts", ".mjs", ".mts", ".cjs", ".cts"] as const;

function resolveRuntimeModelAuthModuleHref(): string {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  for (const relativeBase of RUNTIME_MODEL_AUTH_CANDIDATES) {
    for (const ext of RUNTIME_MODEL_AUTH_EXTENSIONS) {
      const candidate = path.resolve(baseDir, `${relativeBase}${ext}`);
      if (fs.existsSync(candidate)) {
        return pathToFileURL(candidate).href;
      }
    }
  }
  throw new Error(`Unable to resolve runtime model auth module from ${import.meta.url}`);
}

async function loadRuntimeModelAuthModule(): Promise<RuntimeModelAuthModule> {
  return (await import(resolveRuntimeModelAuthModuleHref())) as RuntimeModelAuthModule;
}

export async function resolveApiKeyForProvider(
  params: Parameters<ResolveApiKeyForProvider>[0],
): Promise<Awaited<ReturnType<ResolveApiKeyForProvider>>> {
  const { resolveApiKeyForProvider } = await loadRuntimeModelAuthModule();
  return resolveApiKeyForProvider(params);
}

export async function getRuntimeAuthForModel(
  params: Parameters<GetRuntimeAuthForModel>[0],
): Promise<Awaited<ReturnType<GetRuntimeAuthForModel>>> {
  const { getRuntimeAuthForModel } = await loadRuntimeModelAuthModule();
  return getRuntimeAuthForModel(params);
}
