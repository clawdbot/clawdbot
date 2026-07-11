/**
 * MCP OAuth credential store and login helpers. Credentials are stored in the
 * private OpenClaw state directory with one hashed file per MCP server URL.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import { type FileLockOptions, withFileLock } from "../infra/file-lock.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
import { sanitizeServerName } from "./agent-bundle-mcp-names.js";

type McpOAuthStore = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokenExpiresAt?: number;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  lastAuthorizationUrl?: string;
  redirectUrl?: string;
  state?: string;
};

export type McpOAuthConfig = {
  scope?: unknown;
  redirectUrl?: unknown;
  clientMetadataUrl?: unknown;
};

/** Persisted OAuth credential presence flags for one MCP server. */
export type McpOAuthCredentialsStatus = {
  hasTokens: boolean;
  hasClientInformation: boolean;
  hasCodeVerifier: boolean;
  hasDiscoveryState: boolean;
  hasLastAuthorizationUrl: boolean;
};

const LEGACY_DEFAULT_REDIRECT_URL = "http://127.0.0.1:8989/oauth/callback";
const LOCALHOST_REDIRECT_URL = "http://localhost:8989/oauth/callback";
const TOKEN_EXPIRY_SKEW_MS = 30_000;
const MCP_OAUTH_LOCK_OPTIONS: FileLockOptions = {
  retries: { retries: 20, factor: 1.3, minTimeout: 25, maxTimeout: 500, randomize: true },
  stale: 60_000,
  staleRecovery: "fail-closed",
};
const MCP_OAUTH_STORE_QUEUES = resolveGlobalSingleton(
  Symbol.for("openclaw.mcp-oauth.store-writer-queues"),
  () => new Map<string, StoreWriterQueue>(),
);

function resolveTokenExpiresAt(tokens: OAuthTokens): number | undefined {
  const expiresIn = tokens.expires_in;
  return typeof expiresIn === "number" && Number.isFinite(expiresIn)
    ? Date.now() + expiresIn * 1000
    : undefined;
}

function isMcpOAuthRedirectRegistrationError(error: unknown): boolean {
  return /invalid_client_metadata|redirect_uri/i.test(String(error));
}

function oauthStorePath(serverName: string, serverUrl: string): string {
  const safeServerName = sanitizeServerName(serverName, new Set<string>());
  const key = createHash("sha256").update(serverName).update("\0").update(serverUrl).digest("hex");
  return path.join(resolveStateDir(), "mcp-oauth", `${safeServerName}-${key.slice(0, 16)}.json`);
}

async function readStore(filePath: string): Promise<McpOAuthStore> {
  try {
    return JSON.parse(await fsPromises.readFile(filePath, "utf-8")) as McpOAuthStore;
  } catch {
    return {};
  }
}

function readStoreSync(filePath: string): McpOAuthStore {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as McpOAuthStore;
  } catch {
    return {};
  }
}

async function writeStore(filePath: string, store: McpOAuthStore): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fsPromises.writeFile(filePath, JSON.stringify(store, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fsPromises.chmod(filePath, 0o600).catch(() => {});
}

async function withMcpOAuthStoreLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  return await runQueuedStoreWrite({
    queues: MCP_OAUTH_STORE_QUEUES,
    storePath: filePath,
    label: "withMcpOAuthStoreLock",
    fn: async () => {
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      return await withFileLock(filePath, MCP_OAUTH_LOCK_OPTIONS, fn);
    },
  });
}

function resolveOAuthRedirectUrl(config: McpOAuthConfig, store: McpOAuthStore = {}): string {
  return (
    normalizeOptionalString(config.redirectUrl) ??
    normalizeOptionalString(store.redirectUrl) ??
    LEGACY_DEFAULT_REDIRECT_URL
  );
}

function buildOAuthClientMetadata(
  config: McpOAuthConfig,
  store: McpOAuthStore = {},
): OAuthClientMetadata {
  const redirectUrl = resolveOAuthRedirectUrl(config, store);
  return {
    client_name: "OpenClaw MCP",
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(normalizeOptionalString(config.scope)
      ? { scope: normalizeOptionalString(config.scope) }
      : {}),
  };
}

/** Creates the MCP SDK OAuth provider backed by OpenClaw's private store. */
export function createMcpOAuthClientProvider(params: {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  allowAuthorizationRedirect?: boolean;
}): OAuthClientProvider {
  const config = params.config ?? {};
  const filePath = oauthStorePath(params.serverName, params.serverUrl);
  const allowAuthorizationRedirect =
    params.allowAuthorizationRedirect ?? Boolean(params.onAuthorizationUrl);
  const assertAuthorizationRedirectAllowed = () => {
    if (!allowAuthorizationRedirect) {
      throw new Error(
        `MCP server "${params.serverName}" requires OAuth authorization. Run openclaw mcp login ${params.serverName}.`,
      );
    }
  };
  return {
    get redirectUrl() {
      return resolveOAuthRedirectUrl(config, readStoreSync(filePath));
    },
    clientMetadataUrl: normalizeOptionalString(config.clientMetadataUrl),
    get clientMetadata() {
      return buildOAuthClientMetadata(config, readStoreSync(filePath));
    },
    async state() {
      assertAuthorizationRedirectAllowed();
      const store = await readStore(filePath);
      const state = randomUUID();
      await writeStore(filePath, { ...store, state });
      return state;
    },
    async clientInformation() {
      return (await readStore(filePath)).clientInformation;
    },
    async saveClientInformation(clientInformation) {
      const store = await readStore(filePath);
      await writeStore(filePath, { ...store, clientInformation });
    },
    async tokens() {
      return (await readStore(filePath)).tokens;
    },
    async saveTokens(tokens) {
      const store = await readStore(filePath);
      const tokenExpiresAt = resolveTokenExpiresAt(tokens);
      const nextStore = { ...store, tokens };
      if (tokenExpiresAt === undefined) {
        delete nextStore.tokenExpiresAt;
      } else {
        nextStore.tokenExpiresAt = tokenExpiresAt;
      }
      await writeStore(filePath, nextStore);
    },
    async redirectToAuthorization(authorizationUrl) {
      assertAuthorizationRedirectAllowed();
      const store = await readStore(filePath);
      await writeStore(filePath, { ...store, lastAuthorizationUrl: authorizationUrl.toString() });
      await params.onAuthorizationUrl?.(authorizationUrl);
    },
    async saveCodeVerifier(codeVerifier) {
      assertAuthorizationRedirectAllowed();
      const store = await readStore(filePath);
      await writeStore(filePath, { ...store, codeVerifier });
    },
    async codeVerifier() {
      const codeVerifier = (await readStore(filePath)).codeVerifier;
      if (!codeVerifier) {
        throw new Error("Missing MCP OAuth code verifier. Run the login flow again.");
      }
      return codeVerifier;
    },
    async invalidateCredentials(scope) {
      const store = await readStore(filePath);
      const next: McpOAuthStore = { ...store };
      if (scope === "all" || scope === "client") {
        delete next.clientInformation;
      }
      if (scope === "all" || scope === "tokens") {
        delete next.tokens;
      }
      if (scope === "all" || scope === "verifier") {
        delete next.codeVerifier;
      }
      if (scope === "all" || scope === "discovery") {
        delete next.discoveryState;
      }
      await writeStore(filePath, next);
    },
    async saveDiscoveryState(discoveryState) {
      const store = await readStore(filePath);
      await writeStore(filePath, { ...store, discoveryState });
    },
    async discoveryState() {
      return (await readStore(filePath)).discoveryState;
    },
  };
}

/** Returns a current MCP-native OAuth access token for external runtime projection. */
export async function resolveMcpOAuthAccessToken(params: {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  fetchFn?: FetchLike;
}): Promise<string> {
  const filePath = oauthStorePath(params.serverName, params.serverUrl);
  return await withMcpOAuthStoreLock(filePath, async () => {
    return await resolveMcpOAuthAccessTokenLocked(params, filePath);
  });
}

async function resolveMcpOAuthAccessTokenLocked(
  params: {
    serverName: string;
    serverUrl: string;
    config?: McpOAuthConfig;
    fetchFn?: FetchLike;
  },
  filePath: string,
): Promise<string> {
  const store = await readStore(filePath);
  const tokens = store.tokens;
  if (!tokens?.access_token) {
    throw new Error(
      `MCP server "${params.serverName}" requires OAuth authorization. Run openclaw mcp login ${params.serverName}.`,
    );
  }

  const tokenIsFresh =
    store.tokenExpiresAt !== undefined && store.tokenExpiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS;
  if (tokenIsFresh || (store.tokenExpiresAt === undefined && !tokens.refresh_token)) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) {
    throw new Error(
      `MCP server "${params.serverName}" has expired OAuth credentials. Run openclaw mcp login ${params.serverName}.`,
    );
  }

  const provider = createMcpOAuthClientProvider(params);
  const result = await auth(provider, {
    serverUrl: params.serverUrl,
    scope: normalizeOptionalString(params.config?.scope),
    fetchFn: params.fetchFn,
  });
  const refreshedTokens = await provider.tokens();
  if (result !== "AUTHORIZED" || !refreshedTokens?.access_token) {
    throw new Error(
      `MCP server "${params.serverName}" could not refresh OAuth credentials. Run openclaw mcp login ${params.serverName}.`,
    );
  }
  return refreshedTokens.access_token;
}

/** Deletes stored OAuth credentials for one MCP server. */
export async function clearMcpOAuthCredentials(params: {
  serverName: string;
  serverUrl: string;
}): Promise<void> {
  await fsPromises.rm(oauthStorePath(params.serverName, params.serverUrl), { force: true });
}

/** Reads stored OAuth credential presence without exposing credential values. */
export async function readMcpOAuthCredentialsStatus(params: {
  serverName: string;
  serverUrl: string;
}): Promise<McpOAuthCredentialsStatus> {
  const store = await readStore(oauthStorePath(params.serverName, params.serverUrl));
  return {
    hasTokens: Boolean(store.tokens),
    hasClientInformation: Boolean(store.clientInformation),
    hasCodeVerifier: Boolean(store.codeVerifier),
    hasDiscoveryState: Boolean(store.discoveryState),
    hasLastAuthorizationUrl: Boolean(store.lastAuthorizationUrl),
  };
}

async function runMcpOAuthLoginAttempt(params: {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  authorizationCode?: string;
  fetchFn?: FetchLike;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}): Promise<"authorized" | "redirect"> {
  const filePath = oauthStorePath(params.serverName, params.serverUrl);
  return await withMcpOAuthStoreLock(filePath, async () => {
    const result = await auth(
      createMcpOAuthClientProvider({
        ...params,
        allowAuthorizationRedirect: true,
      }),
      {
        serverUrl: params.serverUrl,
        authorizationCode: normalizeOptionalString(params.authorizationCode),
        scope: normalizeOptionalString(params.config?.scope),
        fetchFn: params.fetchFn,
      },
    );
    return result === "AUTHORIZED" ? "authorized" : "redirect";
  });
}

/** Runs the MCP OAuth login flow, returning whether it authorized or needs redirect. */
export async function runMcpOAuthLogin(params: {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  authorizationCode?: string;
  fetchFn?: FetchLike;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}): Promise<"authorized" | "redirect"> {
  const filePath = oauthStorePath(params.serverName, params.serverUrl);
  const store = await readStore(filePath);
  const loginParams = {
    ...params,
    config: {
      ...params.config,
      redirectUrl: normalizeOptionalString(params.config?.redirectUrl) ?? store.redirectUrl,
    },
  };
  try {
    return await runMcpOAuthLoginAttempt(loginParams);
  } catch (error) {
    if (
      !normalizeOptionalString(params.authorizationCode) &&
      !normalizeOptionalString(params.config?.redirectUrl) &&
      isMcpOAuthRedirectRegistrationError(error)
    ) {
      const result = await runMcpOAuthLoginAttempt({
        ...params,
        config: {
          ...params.config,
          redirectUrl: LOCALHOST_REDIRECT_URL,
        },
      });
      const retryStore = await readStore(filePath);
      await writeStore(filePath, { ...retryStore, redirectUrl: LOCALHOST_REDIRECT_URL });
      return result;
    }
    throw error;
  }
}
