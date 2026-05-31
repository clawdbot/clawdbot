import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
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
import { sanitizeServerName } from "./agent-bundle-mcp-names.js";

type McpOAuthStore = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  lastAuthorizationUrl?: string;
  state?: string;
};

type McpOAuthConfig = {
  scope?: unknown;
  redirectUrl?: unknown;
  clientMetadataUrl?: unknown;
};

export type McpOAuthCredentialsStatus = {
  hasTokens: boolean;
  hasClientInformation: boolean;
  hasCodeVerifier: boolean;
  hasDiscoveryState: boolean;
  hasLastAuthorizationUrl: boolean;
};

const DEFAULT_REDIRECT_URL = "http://127.0.0.1:8989/oauth/callback";

function oauthStorePath(serverName: string, serverUrl: string): string {
  const safeServerName = sanitizeServerName(serverName, new Set<string>());
  const key = createHash("sha256").update(serverName).update("\0").update(serverUrl).digest("hex");
  return path.join(resolveStateDir(), "mcp-oauth", `${safeServerName}-${key.slice(0, 16)}.json`);
}

async function readStore(filePath: string): Promise<McpOAuthStore> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as McpOAuthStore;
  } catch {
    return {};
  }
}

async function writeStore(filePath: string, store: McpOAuthStore): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => {});
}

function buildOAuthClientMetadata(config: McpOAuthConfig): OAuthClientMetadata {
  const redirectUrl = normalizeOptionalString(config.redirectUrl) ?? DEFAULT_REDIRECT_URL;
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

export function createMcpOAuthClientProvider(params: {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  allowAuthorizationRedirect?: boolean;
}): OAuthClientProvider {
  const config = params.config ?? {};
  const filePath = oauthStorePath(params.serverName, params.serverUrl);
  const redirectUrl = normalizeOptionalString(config.redirectUrl) ?? DEFAULT_REDIRECT_URL;
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
      return redirectUrl;
    },
    clientMetadataUrl: normalizeOptionalString(config.clientMetadataUrl),
    get clientMetadata() {
      return buildOAuthClientMetadata(config);
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
      await writeStore(filePath, { ...store, tokens });
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

export async function clearMcpOAuthCredentials(params: {
  serverName: string;
  serverUrl: string;
}): Promise<void> {
  await fs.rm(oauthStorePath(params.serverName, params.serverUrl), { force: true });
}

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

export async function runMcpOAuthLogin(params: {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  authorizationCode?: string;
  fetchFn?: FetchLike;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}): Promise<"authorized" | "redirect"> {
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
}
