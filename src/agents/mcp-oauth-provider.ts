/** MCP SDK OAuth provider backed by canonical OpenClaw state. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
import {
  readMcpOAuthStore,
  resolveMcpOAuthStoreKey,
  updateMcpOAuthStore,
  type McpOAuthStore,
} from "./mcp-oauth-store.js";

export type McpOAuthConfig = {
  scope?: unknown;
  redirectUrl?: unknown;
  clientMetadataUrl?: unknown;
};

const LEGACY_DEFAULT_REDIRECT_URL = "http://127.0.0.1:8989/oauth/callback";

function resolveTokenExpiresAt(tokens: OAuthTokens): number | undefined {
  const expiresIn = tokens.expires_in;
  return typeof expiresIn === "number" && Number.isFinite(expiresIn)
    ? Date.now() + expiresIn * 1000
    : undefined;
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

export function bindMcpOAuthLeaseAssertion(
  lease: OpenClawStateLeaseContext | undefined,
): ((database: DatabaseSync) => void) | undefined {
  return lease ? (database) => lease.assertOwnedInTransaction(database) : undefined;
}

/** Bind OAuth network work to the lease that fences its persisted side effects. */
export function withMcpOAuthLeaseSignal(
  fetchFn: FetchLike | undefined,
  leaseSignal: AbortSignal,
): FetchLike {
  const baseFetch: FetchLike = fetchFn ?? ((url, init) => fetch(url, init));
  return async (url, init) => {
    const requestSignal = init?.signal;
    const signal = requestSignal ? AbortSignal.any([requestSignal, leaseSignal]) : leaseSignal;
    return await baseFetch(url, { ...init, signal });
  };
}

function sameMcpOAuthAuthorizationServer(a: string, b: string): boolean {
  return URL.canParse(a) && URL.canParse(b) && new URL(a).href === new URL(b).href;
}

function beginMcpOAuthAuthorization(store: McpOAuthStore): McpOAuthStore {
  const next = { ...store };
  if (next.credentialState === "uninitialized") {
    delete next.credentialState;
  }
  return next;
}

/** Creates the MCP SDK OAuth provider backed by canonical shared SQLite state. */
export function createMcpOAuthClientProvider(params: {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  allowAuthorizationRedirect?: boolean;
  suppressStoredTokens?: boolean;
  lease?: OpenClawStateLeaseContext;
}): OAuthClientProvider {
  const config = params.config ?? {};
  const storeKey = resolveMcpOAuthStoreKey(params.serverName, params.serverUrl);
  const assertOwnedInTransaction = bindMcpOAuthLeaseAssertion(params.lease);
  const updateStore = (update: (store: McpOAuthStore) => McpOAuthStore) =>
    updateMcpOAuthStore(storeKey, update, assertOwnedInTransaction);
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
      return resolveOAuthRedirectUrl(config, readMcpOAuthStore(storeKey));
    },
    clientMetadataUrl: normalizeOptionalString(config.clientMetadataUrl),
    get clientMetadata() {
      return buildOAuthClientMetadata(config, readMcpOAuthStore(storeKey));
    },
    state() {
      assertAuthorizationRedirectAllowed();
      // State validates one browser round trip. It is not reusable persisted state.
      return randomUUID();
    },
    clientInformation() {
      return readMcpOAuthStore(storeKey).clientInformation;
    },
    saveClientInformation(clientInformation) {
      updateStore((store) => ({ ...beginMcpOAuthAuthorization(store), clientInformation }));
    },
    tokens() {
      if (params.suppressStoredTokens) {
        return undefined;
      }
      const store = readMcpOAuthStore(storeKey);
      const discoveredAuthorizationServerUrl = store.discoveryState?.authorizationServerUrl;
      if (!store.tokens?.refresh_token || discoveredAuthorizationServerUrl === undefined) {
        return store.tokens;
      }
      return store.tokensAuthorizationServerUrl !== undefined &&
        sameMcpOAuthAuthorizationServer(
          discoveredAuthorizationServerUrl,
          store.tokensAuthorizationServerUrl,
        )
        ? store.tokens
        : undefined;
    },
    saveTokens(tokens) {
      updateStore((store) => {
        const next: McpOAuthStore = { ...store, tokens };
        delete next.credentialState;
        delete next.pendingAuthorizationChallenge;
        const issuedBy = store.discoveryState?.authorizationServerUrl;
        if (issuedBy === undefined) {
          delete next.tokensAuthorizationServerUrl;
        } else {
          next.tokensAuthorizationServerUrl = issuedBy;
        }
        const tokenExpiresAt = resolveTokenExpiresAt(tokens);
        if (tokenExpiresAt === undefined) {
          delete next.tokenExpiresAt;
        } else {
          next.tokenExpiresAt = tokenExpiresAt;
        }
        return next;
      });
    },
    async redirectToAuthorization(authorizationUrl) {
      assertAuthorizationRedirectAllowed();
      updateStore((store) => ({
        ...beginMcpOAuthAuthorization(store),
        lastAuthorizationUrl: authorizationUrl.toString(),
      }));
      await params.onAuthorizationUrl?.(authorizationUrl);
    },
    saveCodeVerifier(codeVerifier) {
      assertAuthorizationRedirectAllowed();
      updateStore((store) => ({ ...beginMcpOAuthAuthorization(store), codeVerifier }));
    },
    codeVerifier() {
      const codeVerifier = readMcpOAuthStore(storeKey).codeVerifier;
      if (!codeVerifier) {
        throw new Error("Missing MCP OAuth code verifier. Run the login flow again.");
      }
      return codeVerifier;
    },
    invalidateCredentials(scope) {
      updateStore((store) => {
        const next: McpOAuthStore = { ...store };
        if (scope === "all" || scope === "client") {
          delete next.clientInformation;
        }
        if ((scope === "all" || scope === "tokens") && params.suppressStoredTokens !== true) {
          delete next.tokens;
          delete next.tokenExpiresAt;
          delete next.tokensAuthorizationServerUrl;
          next.credentialState = "cleared";
        }
        if (scope === "all" || scope === "verifier") {
          delete next.codeVerifier;
        }
        if (scope === "all" || scope === "discovery") {
          delete next.discoveryState;
        }
        return next;
      });
    },
    saveDiscoveryState(discoveryState) {
      updateStore((store) => ({ ...beginMcpOAuthAuthorization(store), discoveryState }));
    },
    discoveryState() {
      return readMcpOAuthStore(storeKey).discoveryState;
    },
  };
}
