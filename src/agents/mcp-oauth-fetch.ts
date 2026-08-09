import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  recordMcpOAuthAuthorizationRequired,
  resolveMcpOAuthAccessToken,
  type McpOAuthConfig,
} from "./mcp-oauth.js";

type McpOAuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function withBearerHeader(request: Request, accessToken: string): Request {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  return new Request(request, { headers });
}

async function toFetchInit(request: Request): Promise<RequestInit & { duplex?: "half" }> {
  const streamBody = request.body ?? undefined;
  // Fetch rejects keepalive requests whose body is exposed as a stream. Buffer
  // the payload before reserializing the Request with its original semantics.
  const body = request.keepalive && streamBody ? await request.arrayBuffer() : streamBody;
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
    ...(streamBody && !request.keepalive ? { duplex: "half" as const } : {}),
  };
}

async function dispatchRequest(fetchFn: FetchLike, request: Request): Promise<Response> {
  return await fetchFn(request.url, await toFetchInit(request));
}

/**
 * Own native OAuth retries above the MCP SDK transport. The SDK otherwise runs
 * refresh outside OpenClaw's cross-process OAuth lease on every 401/403.
 */
export function withMcpOAuthBearer(params: {
  fetchFn: FetchLike;
  authFetchFn: FetchLike;
  serverName: string;
  resourceUrl: string;
  config?: McpOAuthConfig;
}): McpOAuthFetch {
  const resourceOrigin = new URL(params.resourceUrl).origin;
  return async (input, init) => {
    const source = input instanceof Request ? input.clone() : input;
    const request = new Request(source, init);
    if (new URL(request.url).origin !== resourceOrigin) {
      return await dispatchRequest(params.fetchFn, request);
    }

    const accessToken = await resolveMcpOAuthAccessToken({
      serverName: params.serverName,
      serverUrl: params.resourceUrl,
      config: params.config,
      fetchFn: params.authFetchFn,
      // Resource feedback can reject an unknown-expiry token. Avoid rotating it
      // before every request when the server omitted optional expires_in.
      acceptUnknownExpiry: true,
      allowMissingToken: true,
      signal: request.signal,
    });
    const retryRequest = request.clone();
    const firstRequest = accessToken ? withBearerHeader(request, accessToken) : request;
    const response = await dispatchRequest(params.fetchFn, firstRequest);
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
      serverName: params.serverName,
      serverUrl: params.resourceUrl,
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
    const authorizedRetry = withBearerHeader(retryRequest, nextAccessToken);
    const retryResponse = await dispatchRequest(params.fetchFn, authorizedRetry);
    const retryChallenge = extractWWWAuthenticateParams(retryResponse);
    const retryInsufficientScope =
      retryResponse.status === 403 && retryChallenge.error === "insufficient_scope";
    if (retryResponse.status === 401 || retryInsufficientScope) {
      const rejectedAccessToken = nextAccessToken;
      await recordMcpOAuthAuthorizationRequired({
        serverName: params.serverName,
        serverUrl: params.resourceUrl,
        rejectedAccessToken,
        resourceMetadataUrl: retryChallenge.resourceMetadataUrl ?? challenge.resourceMetadataUrl,
        scope: retryChallenge.scope ?? challenge.scope,
        signal: request.signal,
      });
    }
    return retryResponse;
  };
}
