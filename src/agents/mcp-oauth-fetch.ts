import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpOAuthIdentity } from "./mcp-oauth-identity.js";
import {
  recordMcpOAuthAuthorizationRequired,
  resolveMcpOAuthAccessToken,
  type McpOAuthConfig,
} from "./mcp-oauth.js";

type McpOAuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function withBearerHeader(init: RequestInit, accessToken: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  return { ...init, headers };
}

async function toFetchInit(request: Request): Promise<RequestInit> {
  // Request exposes its body as a lengthless stream. Materialize it once so
  // the first send and OAuth retry share one body with a known byte length.
  const body = request.body ? await request.arrayBuffer() : undefined;
  return {
    method: request.method,
    headers: request.headers,
    body,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  };
}

/**
 * Own native OAuth retries above the MCP SDK transport. The SDK otherwise runs
 * refresh outside OpenClaw's cross-process OAuth lease on every 401/403.
 */
export function withMcpOAuthBearer(params: {
  fetchFn: FetchLike;
  authFetchFn: FetchLike;
  identity: McpOAuthIdentity;
  config?: McpOAuthConfig;
}): McpOAuthFetch {
  const resourceOrigin = new URL(params.identity.serverUrl).origin;
  return async (input, init) => {
    const source = input instanceof Request ? input.clone() : input;
    const request = new Request(source, init);
    const requestUrl = request.url;
    if (new URL(requestUrl).origin !== resourceOrigin) {
      return await params.fetchFn(requestUrl, await toFetchInit(request));
    }

    const accessToken = await resolveMcpOAuthAccessToken({
      identity: params.identity,
      config: params.config,
      fetchFn: params.authFetchFn,
      // Resource feedback can reject an unknown-expiry token. Avoid rotating it
      // before every request when the server omitted optional expires_in.
      acceptUnknownExpiry: true,
      allowMissingToken: true,
      signal: request.signal,
    });
    const fetchInit = await toFetchInit(request);
    const firstInit = accessToken ? withBearerHeader(fetchInit, accessToken) : fetchInit;
    const response = await params.fetchFn(requestUrl, firstInit);
    const challenge = extractWWWAuthenticateParams(response);
    const insufficientScope = response.status === 403 && challenge.error === "insufficient_scope";
    const shouldRetry = response.status === 401 || insufficientScope;
    if (!shouldRetry) {
      return response;
    }

    // Releasing the guarded body before OAuth network work prevents holding the
    // first request's dispatcher lease across discovery/refresh.
    await response.body?.cancel().catch(() => undefined);
    const nextAccessToken = await resolveMcpOAuthAccessToken({
      identity: params.identity,
      config: params.config,
      fetchFn: params.authFetchFn,
      acceptUnknownExpiry: true,
      authorizationChallenge: true,
      interactiveAuthorizationRequired: insufficientScope,
      rejectedAccessToken: accessToken,
      resourceMetadataUrl: challenge.resourceMetadataUrl,
      signal: request.signal,
      scope: challenge.scope,
    });
    const retryInit = withBearerHeader(fetchInit, nextAccessToken);
    const retryResponse = await params.fetchFn(requestUrl, retryInit);
    const retryChallenge = extractWWWAuthenticateParams(retryResponse);
    const retryInsufficientScope =
      retryResponse.status === 403 && retryChallenge.error === "insufficient_scope";
    if (retryResponse.status === 401 || retryInsufficientScope) {
      const rejectedAccessToken = nextAccessToken;
      await recordMcpOAuthAuthorizationRequired({
        identity: params.identity,
        rejectedAccessToken,
        resourceMetadataUrl: retryChallenge.resourceMetadataUrl ?? challenge.resourceMetadataUrl,
        scope: retryChallenge.scope ?? challenge.scope,
        signal: request.signal,
      });
    }
    return retryResponse;
  };
}
