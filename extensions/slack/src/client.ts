// Slack plugin module implements client behavior.
import { createHash } from "node:crypto";
import { type WebClientOptions, WebClient } from "@slack/web-api";
import type { SlackLookupClientOptions } from "./client-options.js";
import {
  resolveSlackLookupClientOptions,
  resolveSlackReadClientOptions,
  resolveSlackWebClientOptions,
  resolveSlackWriteClientOptions,
  SLACK_DEFAULT_RETRY_OPTIONS,
  SLACK_WRITE_RETRY_OPTIONS,
} from "./client-options.js";

const SLACK_WRITE_CLIENT_CACHE_MAX = 32;
const SLACK_STARTUP_AUTH_TIMEOUT_MS = 10_000;
const SLACK_STARTUP_AUTH_RETRY_BUDGET_MS = 35_000;
const slackWriteClientCache = new Map<string, WebClient>();
let slackListenerUploadCompletionClientCache = new WeakMap<
  WebClient,
  { teamId: string; client: WebClient }
>();

type SlackWriteClientCacheOptions = Pick<WebClientOptions, "slackApiUrl" | "teamId">;
type SlackFetch = NonNullable<WebClientOptions["fetch"]>;

export {
  resolveSlackWebClientOptions,
  resolveSlackWriteClientOptions,
  SLACK_DEFAULT_RETRY_OPTIONS,
  SLACK_WRITE_RETRY_OPTIONS,
} from "./client-options.js";

export function createSlackWebClient(token: string, options: WebClientOptions = {}) {
  // Shared or mixed-operation clients stay timeout-free unless the caller opts in.
  // Slack can commit a mutation before a late response, so a default deadline is unsafe here.
  return new WebClient(token, resolveSlackWebClientOptions(options));
}

export function createSlackReadClient(token: string, options: WebClientOptions = {}) {
  return new WebClient(token, resolveSlackReadClientOptions(options));
}

function createSlackStartupAuthFetch(baseFetch: SlackFetch): SlackFetch {
  const deadline = Date.now() + SLACK_STARTUP_AUTH_RETRY_BUDGET_MS;
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (response.status !== 429) {
      return response;
    }
    const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    const remainingMs = Math.max(0, deadline - Date.now());
    if (!Number.isFinite(retryAfter) || retryAfter * 1000 <= remainingMs) {
      return response;
    }
    // Slack sleeps through Retry-After outside its per-attempt timeout. Wait only
    // within the startup budget, then let the retry policy terminate the call.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, remainingMs);
    });
    throw new Error("Slack startup auth retry budget exhausted after rate limit");
  };
}

export function createSlackStartupAuthClient(token: string, options: WebClientOptions = {}) {
  const resolvedOptions = resolveSlackWebClientOptions(options);
  const baseFetch = resolvedOptions.fetch;
  if (!baseFetch) {
    throw new Error("Slack startup auth fetch is unavailable");
  }
  return new WebClient(token, {
    ...resolvedOptions,
    fetch: createSlackStartupAuthFetch(baseFetch),
    retryConfig: {
      ...SLACK_DEFAULT_RETRY_OPTIONS,
      maxRetryTime: SLACK_STARTUP_AUTH_RETRY_BUDGET_MS,
    },
    timeout: SLACK_STARTUP_AUTH_TIMEOUT_MS,
  });
}

export function createSlackLookupClient(token: string, options: SlackLookupClientOptions = {}) {
  return new WebClient(token, resolveSlackLookupClientOptions(options));
}

export function createSlackWriteClient(token: string, options: WebClientOptions = {}) {
  return new WebClient(token, resolveSlackWriteClientOptions(options));
}

export function createSlackTokenCacheKey(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("base64url")}`;
}

function slackWriteClientCacheKey(token: string, options: SlackWriteClientCacheOptions): string {
  const tokenKey = createSlackTokenCacheKey(token);
  const apiScope = options.slackApiUrl ? `:api:${options.slackApiUrl}` : "";
  const teamScope = options.teamId ? `:team:${options.teamId.trim().toLowerCase()}` : "";
  return `${tokenKey}${apiScope}${teamScope}`;
}

export function getSlackWriteClient(
  token: string,
  options: SlackWriteClientCacheOptions = {},
): WebClient {
  const resolvedOptions = resolveSlackWriteClientOptions(options);
  const tokenKey = slackWriteClientCacheKey(token, resolvedOptions);
  const cached = slackWriteClientCache.get(tokenKey);
  if (cached) {
    slackWriteClientCache.delete(tokenKey);
    slackWriteClientCache.set(tokenKey, cached);
    return cached;
  }
  const client = new WebClient(token, resolvedOptions);
  if (slackWriteClientCache.size >= SLACK_WRITE_CLIENT_CACHE_MAX) {
    const oldestTokenKey = slackWriteClientCache.keys().next().value;
    if (oldestTokenKey) {
      slackWriteClientCache.delete(oldestTokenKey);
    }
  }
  slackWriteClientCache.set(tokenKey, client);
  return client;
}

export function getSlackListenerUploadCompletionClient(params: {
  listenerClient: WebClient;
  teamId: string;
  clientOptions?: WebClientOptions;
}): WebClient | undefined {
  const token = params.listenerClient.token?.trim();
  const teamId = params.teamId.trim().toUpperCase();
  if (!token || !teamId) {
    return undefined;
  }
  const cached = slackListenerUploadCompletionClientCache.get(params.listenerClient);
  if (cached) {
    // Bolt pools listener clients by authorized team. Reusing one for a
    // different team is invalid scope, not another completion-client key.
    return cached.teamId === teamId ? cached.client : undefined;
  }
  const headers = Object.fromEntries(
    Object.entries(params.clientOptions?.headers ?? {}).filter(
      ([name]) => name.toLowerCase() !== "authorization",
    ),
  );
  // Completion is one-shot. Clone Bolt's public transport options and team
  // scope, but never inherit its retry policy or request deadline.
  const client = new WebClient(
    token,
    resolveSlackWriteClientOptions({
      ...params.clientOptions,
      headers,
      slackApiUrl: params.listenerClient.slackApiUrl,
      teamId,
      retryConfig: SLACK_WRITE_RETRY_OPTIONS,
      timeout: 0,
    }),
  );
  slackListenerUploadCompletionClientCache.set(params.listenerClient, { teamId, client });
  return client;
}

export function clearSlackWriteClientCacheForTest(): void {
  slackWriteClientCache.clear();
  slackListenerUploadCompletionClientCache = new WeakMap();
}
