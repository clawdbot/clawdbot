/** MCP OAuth credential provider, flow coordinator, and login helpers. */
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  type OpenClawStateLeaseContext,
  withOpenClawStateLease,
} from "../state/openclaw-state-lease.js";
import {
  buildMcpHttpFetch,
  withoutMcpAuthorizationHeader,
  withSameOriginMcpHttpHeaders,
} from "./mcp-http-fetch.js";
import { requesterMcpOAuthStoreKeyPrefix, type McpOAuthIdentity } from "./mcp-oauth-identity.js";
import {
  bindMcpOAuthLeaseAssertion,
  createMcpOAuthClientProvider,
  type McpOAuthConfig,
  withMcpOAuthLeaseSignal,
} from "./mcp-oauth-provider.js";
import {
  clearMcpOAuthStore,
  consumeOAuthState,
  deleteMcpOAuthPendingAuthorization,
  deleteMcpOAuthPendingAuthorizationsByPrefix,
  listMcpOAuthStoreKeysByPrefix,
  readMcpOAuthStore,
  readMcpOAuthStoreReadOnly,
  updateMcpOAuthStore,
  writeMcpOAuthPendingAuthorization,
  type McpOAuthStore,
} from "./mcp-oauth-store.js";
import type { resolveMcpTransportConfig } from "./mcp-transport-config.js";

export type { McpOAuthConfig } from "./mcp-oauth-provider.js";

type ResolvedHttpMcpTransportConfig = Extract<
  NonNullable<ReturnType<typeof resolveMcpTransportConfig>>,
  { kind: "http" }
>;

type McpOAuthAuthorizationStartResult =
  | { status: "authorized" }
  | { status: "redirect"; authorizationUrl: string; redirectUrl: string; state: string };

/** Persisted OAuth authorization state for one principal and MCP server. */
export type McpOAuthPrincipalStatus =
  | { state: "authorized"; expiresAt?: number }
  | { state: "requires-authorization" }
  | { state: "pending-authorization" }
  | { state: "unauthenticated" };

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

function bindMcpOAuthTokensIssuer(store: McpOAuthStore): McpOAuthStore {
  const issuedBy = store.discoveryState?.authorizationServerUrl;
  if (
    !store.tokens?.refresh_token ||
    store.tokensAuthorizationServerUrl !== undefined ||
    issuedBy === undefined
  ) {
    return store;
  }
  return { ...store, tokensAuthorizationServerUrl: issuedBy };
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
    const bound = bindMcpOAuthTokensIssuer(next);
    delete bound.discoveryState;
    return bound;
  }
  return next;
}

type ResolveMcpOAuthAccessTokenParams = {
  identity: McpOAuthIdentity;
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
  const storeKey = params.identity.storeKey;
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
        throw mcpOAuthAdditionalAuthorizationError(params.identity.serverName);
      }
      if (store.pendingAuthorizationChallenge?.requiresAuthorization === true) {
        throw mcpOAuthAdditionalAuthorizationError(params.identity.serverName);
      }
      if (!tokens?.access_token) {
        if (params.allowMissingToken === true) {
          return undefined;
        }
        throw new Error(
          `MCP server "${params.identity.serverName}" requires OAuth authorization. Run openclaw mcp login ${params.identity.serverName}.`,
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
          `MCP server "${params.identity.serverName}" has expired OAuth credentials. Run openclaw mcp login ${params.identity.serverName}.`,
        );
      }

      const pendingChallenge = store.pendingAuthorizationChallenge;
      updateMcpOAuthStore(storeKey, bindMcpOAuthTokensIssuer, bindMcpOAuthLeaseAssertion(lease));
      const provider = createMcpOAuthClientProvider({
        identity: params.identity,
        config: params.config,
        lease,
      });
      const result = await auth(provider, {
        serverUrl: params.identity.serverUrl,
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
          `MCP server "${params.identity.serverName}" could not refresh OAuth credentials. Run openclaw mcp login ${params.identity.serverName}.`,
        );
      }
      return refreshedTokens.access_token;
    },
    params.signal,
  );
}

/** Persist a terminal resource rejection without overwriting newer credentials. */
export async function recordMcpOAuthAuthorizationRequired(params: {
  identity: McpOAuthIdentity;
  rejectedAccessToken: string;
  resourceMetadataUrl?: URL;
  scope?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const storeKey = params.identity.storeKey;
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
export async function clearMcpOAuthCredentials(identity: McpOAuthIdentity): Promise<void> {
  await clearMcpOAuthStoreKey(identity.storeKey);
}

async function clearMcpOAuthStoreKey(storeKey: string): Promise<void> {
  await withMcpOAuthLease(storeKey, async (lease) => {
    clearMcpOAuthStore(storeKey, bindMcpOAuthLeaseAssertion(lease));
  });
}

/** Clear operator and requester credentials bound to one configured server URL. */
export async function clearMcpOAuthServer(identity: McpOAuthIdentity): Promise<void> {
  await clearMcpOAuthStoreKey(identity.storeKey);
  await clearMcpOAuthRequesters(identity);
}

/** Clear requester credentials without changing the operator row for this server URL. */
export async function clearMcpOAuthRequesters(identity: McpOAuthIdentity): Promise<void> {
  const prefix = requesterMcpOAuthStoreKeyPrefix(identity.serverName, identity.serverUrl);
  const requesterKeys = listMcpOAuthStoreKeysByPrefix(prefix);
  for (const storeKey of requesterKeys) {
    await clearMcpOAuthStoreKey(storeKey);
  }
  deleteMcpOAuthPendingAuthorizationsByPrefix(prefix);
}

/** Count authorized requester principals for one configured server URL. */
export function countMcpOAuthPrincipals(identity: McpOAuthIdentity): number {
  const prefix = requesterMcpOAuthStoreKeyPrefix(identity.serverName, identity.serverUrl);
  return listMcpOAuthStoreKeysByPrefix(prefix).filter(
    (storeKey) => readMcpOAuthStoreReadOnly(storeKey).tokens !== undefined,
  ).length;
}

/** Reads stored OAuth credential presence without exposing values or creating state. */
export async function readMcpOAuthCredentialsStatus(
  identity: McpOAuthIdentity,
): Promise<McpOAuthPrincipalStatus> {
  const store = readMcpOAuthStoreReadOnly(identity.storeKey);
  if (store.pendingAuthorizationChallenge?.requiresAuthorization === true) {
    return { state: "requires-authorization" };
  }
  if (store.tokens) {
    return {
      state: "authorized",
      ...(store.tokenExpiresAt === undefined ? {} : { expiresAt: store.tokenExpiresAt }),
    };
  }
  if (
    store.clientInformation ||
    store.codeVerifier ||
    store.discoveryState ||
    store.lastAuthorizationUrl ||
    store.redirectUrl ||
    store.pendingAuthorizationChallenge
  ) {
    return { state: "pending-authorization" };
  }
  return { state: "unauthenticated" };
}

function buildMcpOAuthAuthorizationFetch(config: ResolvedHttpMcpTransportConfig): FetchLike {
  const fetchFn = buildMcpHttpFetch({
    sslVerify: config.sslVerify,
    clientCert: config.clientCert,
    clientKey: config.clientKey,
    resourceUrl: config.url,
    timeoutMs: config.requestTimeoutMs,
  });
  return withSameOriginMcpHttpHeaders({
    fetchFn,
    headers: withoutMcpAuthorizationHeader(config.headers),
    resourceUrl: config.url,
  });
}

async function runMcpOAuthAuthorizationAttempt(
  params: {
    identity: McpOAuthIdentity;
    config: McpOAuthConfig;
    fetchFn: FetchLike;
    authorizationCode?: string;
    resourceMetadataUrl?: URL;
    scope?: string;
    suppressStoredTokens?: boolean;
  },
  lease: OpenClawStateLeaseContext,
): Promise<"authorized" | "redirect"> {
  const provider = createMcpOAuthClientProvider({
    identity: params.identity,
    config: params.config,
    allowAuthorizationRedirect: true,
    suppressStoredTokens: params.suppressStoredTokens,
    lease,
  });
  const result = await auth(provider, {
    serverUrl: params.identity.serverUrl,
    authorizationCode: normalizeOptionalString(params.authorizationCode),
    resourceMetadataUrl: params.resourceMetadataUrl,
    scope: normalizeOptionalString(params.scope) ?? normalizeOptionalString(params.config?.scope),
    fetchFn: withMcpOAuthLeaseSignal(params.fetchFn, lease.signal),
  });
  lease.assertOwned();
  return result === "AUTHORIZED" ? "authorized" : "redirect";
}

export async function startMcpOAuthAuthorization(
  identity: McpOAuthIdentity,
  config: ResolvedHttpMcpTransportConfig,
  opts: { redirectUrl?: string },
): Promise<McpOAuthAuthorizationStartResult> {
  const storeKey = identity.storeKey;
  return await withMcpOAuthLease(storeKey, async (lease) => {
    const store = readMcpOAuthStore(storeKey);
    const pendingChallenge = store.pendingAuthorizationChallenge;
    const configuredRedirectUrl =
      normalizeOptionalString(opts.redirectUrl) ??
      normalizeOptionalString(config.oauth?.redirectUrl) ??
      store.redirectUrl;
    const oauthConfig: McpOAuthConfig = {
      ...config.oauth,
      ...(configuredRedirectUrl ? { redirectUrl: configuredRedirectUrl } : {}),
    };
    const attempt = {
      identity,
      config: oauthConfig,
      fetchFn: buildMcpOAuthAuthorizationFetch(config),
      resourceMetadataUrl: pendingChallenge?.resourceMetadataUrl
        ? new URL(pendingChallenge.resourceMetadataUrl)
        : undefined,
      scope: normalizeOptionalString(pendingChallenge?.scope),
      suppressStoredTokens: pendingChallenge?.requiresAuthorization === true,
    };
    let result: "authorized" | "redirect";
    try {
      result = await runMcpOAuthAuthorizationAttempt(attempt, lease);
    } catch (error) {
      if (
        !normalizeOptionalString(opts.redirectUrl) &&
        !normalizeOptionalString(config.oauth?.redirectUrl) &&
        isMcpOAuthRedirectRegistrationError(error)
      ) {
        result = await runMcpOAuthAuthorizationAttempt(
          {
            ...attempt,
            config: { ...config.oauth, redirectUrl: LOCALHOST_REDIRECT_URL },
          },
          lease,
        );
      } else {
        throw error;
      }
    }
    if (result === "authorized") {
      return { status: "authorized" };
    }
    const pending = readMcpOAuthStore(storeKey);
    const authorizationUrl = pending.lastAuthorizationUrl;
    const state = authorizationUrl ? new URL(authorizationUrl).searchParams.get("state") : null;
    if (!authorizationUrl || !pending.codeVerifier || !pending.redirectUrl || !state) {
      throw new Error("MCP OAuth authorization session was not persisted.");
    }
    writeMcpOAuthPendingAuthorization(storeKey, state, bindMcpOAuthLeaseAssertion(lease));
    return { status: "redirect", authorizationUrl, redirectUrl: pending.redirectUrl, state };
  });
}

export async function completeMcpOAuthAuthorization(
  identity: McpOAuthIdentity,
  config: ResolvedHttpMcpTransportConfig,
  input: { code: string },
): Promise<"authorized"> {
  const storeKey = identity.storeKey;
  return await withMcpOAuthLease<"authorized">(storeKey, async (lease) => {
    return await completeMcpOAuthAuthorizationUnderLease(identity, config, input, lease);
  });
}

function readMcpOAuthAuthorizationState(authorizationUrl: string | undefined): string | undefined {
  if (!authorizationUrl) {
    return undefined;
  }
  try {
    return normalizeOptionalString(new URL(authorizationUrl).searchParams.get("state"));
  } catch {
    return undefined;
  }
}

async function completeMcpOAuthAuthorizationUnderLease(
  identity: McpOAuthIdentity,
  config: ResolvedHttpMcpTransportConfig,
  input: { code: string },
  lease: OpenClawStateLeaseContext,
): Promise<"authorized"> {
  const storeKey = identity.storeKey;
  const store = readMcpOAuthStore(storeKey);
  if (!store.codeVerifier || !store.redirectUrl) {
    throw new Error("Missing MCP OAuth authorization session. Run the login flow again.");
  }
  const pendingChallenge = store.pendingAuthorizationChallenge;
  await runMcpOAuthAuthorizationAttempt(
    {
      identity,
      config: { ...config.oauth, redirectUrl: store.redirectUrl },
      fetchFn: buildMcpOAuthAuthorizationFetch(config),
      authorizationCode: input.code,
      resourceMetadataUrl: pendingChallenge?.resourceMetadataUrl
        ? new URL(pendingChallenge.resourceMetadataUrl)
        : undefined,
      scope: normalizeOptionalString(pendingChallenge?.scope),
      suppressStoredTokens: pendingChallenge?.requiresAuthorization === true,
    },
    lease,
  );
  const assertLeaseOwned = bindMcpOAuthLeaseAssertion(lease);
  updateMcpOAuthStore(
    storeKey,
    (current) => {
      const next = { ...current };
      delete next.codeVerifier;
      delete next.lastAuthorizationUrl;
      delete next.redirectUrl;
      return next;
    },
    assertLeaseOwned,
  );
  deleteMcpOAuthPendingAuthorization(storeKey, assertLeaseOwned);
  return "authorized";
}

/** Claims one callback state and completes its exchange under the same store lease. */
export async function completeOAuthCallback(
  identity: McpOAuthIdentity,
  config: ResolvedHttpMcpTransportConfig,
  input: { code: string; state: string },
): Promise<"authorized" | "expired"> {
  return await withMcpOAuthLease(identity.storeKey, async (lease) => {
    const assertLeaseOwned = bindMcpOAuthLeaseAssertion(lease);
    if (!consumeOAuthState(identity.storeKey, input.state, assertLeaseOwned)) {
      return "expired";
    }
    const store = readMcpOAuthStore(identity.storeKey);
    if (readMcpOAuthAuthorizationState(store.lastAuthorizationUrl) !== input.state) {
      return "expired";
    }
    return await completeMcpOAuthAuthorizationUnderLease(identity, config, input, lease);
  });
}
