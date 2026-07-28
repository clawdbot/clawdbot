/** MCP OAuth credential provider, flow coordinator, and login helpers. */
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  type OpenClawStateLeaseContext,
  withOpenClawStateLease,
} from "../state/openclaw-state-lease.js";
import {
  bindMcpOAuthLeaseAssertion,
  createMcpOAuthClientProvider,
  type McpOAuthConfig,
  withMcpOAuthLeaseSignal,
} from "./mcp-oauth-provider.js";
import {
  clearMcpOAuthStore,
  readMcpOAuthStore,
  readMcpOAuthStoreReadOnly,
  resolveMcpOAuthStoreKey,
  updateMcpOAuthStore,
  type McpOAuthStore,
} from "./mcp-oauth-store.js";

export type { McpOAuthConfig } from "./mcp-oauth-provider.js";

/** Persisted OAuth credential presence and authorization state for one MCP server. */
export type McpOAuthCredentialsStatus = {
  hasTokens: boolean;
  requiresAuthorization: boolean;
  hasClientInformation: boolean;
  hasCodeVerifier: boolean;
  hasDiscoveryState: boolean;
  hasLastAuthorizationUrl: boolean;
};

const LOCALHOST_REDIRECT_URL = "http://localhost:8989/oauth/callback";
const TOKEN_EXPIRY_SKEW_MS = 30_000;
const MCP_OAUTH_LEASE_MS = 60_000;
const MCP_OAUTH_LEASE_WAIT_MS = 30_000;

function isMcpOAuthRedirectRegistrationError(error: unknown): boolean {
  return /invalid_client_metadata|redirect_uri/i.test(String(error));
}

async function withMcpOAuthLease<T>(
  storeKey: string,
  run: (lease: OpenClawStateLeaseContext) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return await withOpenClawStateLease(
    {
      scope: "core:mcp-oauth",
      key: storeKey,
      database: { scope: "shared" },
      leaseMs: MCP_OAUTH_LEASE_MS,
      waitMs: MCP_OAUTH_LEASE_WAIT_MS,
      ...(signal ? { signal } : {}),
    },
    run,
  );
}

function mcpOAuthAdditionalAuthorizationError(serverName: string): Error {
  return new Error(
    `MCP server "${serverName}" requires additional OAuth authorization. Run openclaw mcp login ${serverName}.`,
  );
}

function applyMcpOAuthAuthorizationChallenge(
  current: McpOAuthStore,
  params: {
    resourceMetadataUrl?: string;
    scope?: string;
    requiresAuthorization?: true;
  },
): McpOAuthStore {
  const next: McpOAuthStore = {
    ...current,
    pendingAuthorizationChallenge: {
      ...current.pendingAuthorizationChallenge,
      ...(params.resourceMetadataUrl ? { resourceMetadataUrl: params.resourceMetadataUrl } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.requiresAuthorization ? { requiresAuthorization: true } : {}),
    },
  };
  if (
    current.credentialState === undefined &&
    current.tokens === undefined &&
    current.clientInformation === undefined &&
    current.codeVerifier === undefined &&
    current.discoveryState === undefined &&
    current.lastAuthorizationUrl === undefined &&
    current.redirectUrl === undefined
  ) {
    next.credentialState = "uninitialized";
  }
  if (
    params.resourceMetadataUrl &&
    current.discoveryState?.resourceMetadataUrl !== params.resourceMetadataUrl
  ) {
    delete next.discoveryState;
  }
  return next;
}

type ResolveMcpOAuthAccessTokenParams = {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  fetchFn?: FetchLike;
  acceptUnknownExpiry?: boolean;
  rejectedAccessToken?: string;
  resourceMetadataUrl?: URL;
  scope?: string;
  allowMissingToken?: boolean;
  authorizationChallenge?: boolean;
  interactiveAuthorizationRequired?: boolean;
  signal?: AbortSignal;
};

/** Returns a current MCP-native OAuth token under one cross-process flow lease. */
export function resolveMcpOAuthAccessToken(
  params: ResolveMcpOAuthAccessTokenParams & { allowMissingToken: true },
): Promise<string | undefined>;
export function resolveMcpOAuthAccessToken(
  params: ResolveMcpOAuthAccessTokenParams,
): Promise<string>;
export async function resolveMcpOAuthAccessToken(
  params: ResolveMcpOAuthAccessTokenParams,
): Promise<string | undefined> {
  const storeKey = resolveMcpOAuthStoreKey(params.serverName, params.serverUrl);
  return await withMcpOAuthLease(
    storeKey,
    async (lease) => {
      const store = readMcpOAuthStore(storeKey);
      const tokens = store.tokens;
      const rejectedCurrentToken = params.rejectedAccessToken === tokens?.access_token;
      const challengeAppliesToCurrentState = !tokens?.access_token || rejectedCurrentToken;
      if (params.authorizationChallenge === true && challengeAppliesToCurrentState) {
        const resourceMetadataUrl = params.resourceMetadataUrl?.toString();
        const scope = normalizeOptionalString(params.scope);
        if (resourceMetadataUrl || scope || params.interactiveAuthorizationRequired === true) {
          updateMcpOAuthStore(
            storeKey,
            (current) =>
              applyMcpOAuthAuthorizationChallenge(current, {
                resourceMetadataUrl,
                scope,
                ...(params.interactiveAuthorizationRequired === true
                  ? { requiresAuthorization: true }
                  : {}),
              }),
            bindMcpOAuthLeaseAssertion(lease),
          );
        }
      }
      if (
        params.authorizationChallenge === true &&
        params.interactiveAuthorizationRequired === true &&
        challengeAppliesToCurrentState
      ) {
        throw mcpOAuthAdditionalAuthorizationError(params.serverName);
      }
      if (store.pendingAuthorizationChallenge?.requiresAuthorization === true) {
        throw mcpOAuthAdditionalAuthorizationError(params.serverName);
      }
      if (!tokens?.access_token) {
        if (params.allowMissingToken === true) {
          return undefined;
        }
        throw new Error(
          `MCP server "${params.serverName}" requires OAuth authorization. Run openclaw mcp login ${params.serverName}.`,
        );
      }

      const tokenIsFresh =
        store.tokenExpiresAt !== undefined &&
        store.tokenExpiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS;
      if (
        !rejectedCurrentToken &&
        (tokenIsFresh ||
          (store.tokenExpiresAt === undefined &&
            (params.acceptUnknownExpiry === true || !tokens.refresh_token)))
      ) {
        return tokens.access_token;
      }
      if (!tokens.refresh_token) {
        throw new Error(
          `MCP server "${params.serverName}" has expired OAuth credentials. Run openclaw mcp login ${params.serverName}.`,
        );
      }

      const pendingChallenge = store.pendingAuthorizationChallenge;
      const provider = createMcpOAuthClientProvider({ ...params, lease });
      const result = await auth(provider, {
        serverUrl: params.serverUrl,
        resourceMetadataUrl:
          params.resourceMetadataUrl ??
          (pendingChallenge?.resourceMetadataUrl
            ? new URL(pendingChallenge.resourceMetadataUrl)
            : undefined),
        scope:
          params.scope ??
          normalizeOptionalString(pendingChallenge?.scope) ??
          normalizeOptionalString(params.config?.scope),
        fetchFn: withMcpOAuthLeaseSignal(params.fetchFn, lease.signal),
      });
      lease.assertOwned();
      const refreshedTokens = await provider.tokens();
      if (result !== "AUTHORIZED" || !refreshedTokens?.access_token) {
        throw new Error(
          `MCP server "${params.serverName}" could not refresh OAuth credentials. Run openclaw mcp login ${params.serverName}.`,
        );
      }
      return refreshedTokens.access_token;
    },
    params.signal,
  );
}

/** Persist a terminal resource rejection without overwriting newer credentials. */
export async function recordMcpOAuthAuthorizationRequired(params: {
  serverName: string;
  serverUrl: string;
  rejectedAccessToken: string;
  resourceMetadataUrl?: URL;
  scope?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const storeKey = resolveMcpOAuthStoreKey(params.serverName, params.serverUrl);
  return await withMcpOAuthLease(
    storeKey,
    async (lease) => {
      const store = readMcpOAuthStore(storeKey);
      if (store.tokens?.access_token !== params.rejectedAccessToken) {
        return false;
      }
      let recorded = false;
      updateMcpOAuthStore(
        storeKey,
        (current) => {
          if (current.tokens?.access_token !== params.rejectedAccessToken) {
            return current;
          }
          recorded = true;
          return applyMcpOAuthAuthorizationChallenge(current, {
            resourceMetadataUrl: params.resourceMetadataUrl?.toString(),
            scope: normalizeOptionalString(params.scope),
            requiresAuthorization: true,
          });
        },
        bindMcpOAuthLeaseAssertion(lease),
      );
      return recorded;
    },
    params.signal,
  );
}

/** Deletes one OAuth session without racing an in-flight refresh or login. */
export async function clearMcpOAuthCredentials(params: {
  serverName: string;
  serverUrl: string;
}): Promise<void> {
  const storeKey = resolveMcpOAuthStoreKey(params.serverName, params.serverUrl);
  await withMcpOAuthLease(storeKey, async (lease) => {
    clearMcpOAuthStore(storeKey, bindMcpOAuthLeaseAssertion(lease));
  });
}

/** Reads stored OAuth credential presence without exposing values or creating state. */
export async function readMcpOAuthCredentialsStatus(params: {
  serverName: string;
  serverUrl: string;
}): Promise<McpOAuthCredentialsStatus> {
  const store = readMcpOAuthStoreReadOnly(
    resolveMcpOAuthStoreKey(params.serverName, params.serverUrl),
  );
  return {
    hasTokens: Boolean(store.tokens),
    requiresAuthorization: store.pendingAuthorizationChallenge?.requiresAuthorization === true,
    hasClientInformation: Boolean(store.clientInformation),
    hasCodeVerifier: Boolean(store.codeVerifier),
    hasDiscoveryState: Boolean(store.discoveryState),
    hasLastAuthorizationUrl: Boolean(store.lastAuthorizationUrl),
  };
}

async function runMcpOAuthLoginAttempt(
  params: {
    serverName: string;
    serverUrl: string;
    config?: McpOAuthConfig;
    authorizationCode?: string;
    fetchFn?: FetchLike;
    onAuthorizationUrl?: (url: URL) => void | Promise<void>;
    resourceMetadataUrl?: URL;
    scope?: string;
    forceAuthorization?: boolean;
  },
  lease: OpenClawStateLeaseContext,
): Promise<"authorized" | "redirect"> {
  const result = await auth(
    createMcpOAuthClientProvider({
      ...params,
      allowAuthorizationRedirect: true,
      suppressStoredTokens: params.forceAuthorization,
      lease,
    }),
    {
      serverUrl: params.serverUrl,
      authorizationCode: normalizeOptionalString(params.authorizationCode),
      resourceMetadataUrl: params.resourceMetadataUrl,
      scope: normalizeOptionalString(params.scope) ?? normalizeOptionalString(params.config?.scope),
      fetchFn: withMcpOAuthLeaseSignal(params.fetchFn, lease.signal),
    },
  );
  lease.assertOwned();
  return result === "AUTHORIZED" ? "authorized" : "redirect";
}

/** Runs both redirect-registration attempts under one OAuth session lease. */
export async function runMcpOAuthLogin(params: {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  authorizationCode?: string;
  fetchFn?: FetchLike;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}): Promise<"authorized" | "redirect"> {
  const storeKey = resolveMcpOAuthStoreKey(params.serverName, params.serverUrl);
  return await withMcpOAuthLease(storeKey, async (lease) => {
    const store = readMcpOAuthStore(storeKey);
    const pendingChallenge = store.pendingAuthorizationChallenge;
    const loginParams = {
      ...params,
      config: {
        ...params.config,
        redirectUrl: normalizeOptionalString(params.config?.redirectUrl) ?? store.redirectUrl,
      },
      resourceMetadataUrl: pendingChallenge?.resourceMetadataUrl
        ? new URL(pendingChallenge.resourceMetadataUrl)
        : undefined,
      scope: normalizeOptionalString(pendingChallenge?.scope),
      forceAuthorization: pendingChallenge?.requiresAuthorization === true,
    };
    try {
      return await runMcpOAuthLoginAttempt(loginParams, lease);
    } catch (error) {
      if (
        !normalizeOptionalString(params.authorizationCode) &&
        !normalizeOptionalString(params.config?.redirectUrl) &&
        isMcpOAuthRedirectRegistrationError(error)
      ) {
        const result = await runMcpOAuthLoginAttempt(
          {
            ...loginParams,
            config: { ...params.config, redirectUrl: LOCALHOST_REDIRECT_URL },
          },
          lease,
        );
        updateMcpOAuthStore(
          storeKey,
          (current) => ({ ...current, redirectUrl: LOCALHOST_REDIRECT_URL }),
          bindMcpOAuthLeaseAssertion(lease),
        );
        return result;
      }
      throw error;
    }
  });
}
