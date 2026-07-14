// Slack plugin module implements client behavior.
import { createHash } from "node:crypto";
import { type WebClientOptions, WebClient } from "@slack/web-api";
import type { SlackLookupClientOptions } from "./client-options.js";
import {
  resolveSlackLookupClientOptions,
  resolveSlackWebClientOptions,
  resolveSlackWriteClientOptions,
  SLACK_WRITE_RETRY_OPTIONS,
} from "./client-options.js";

const SLACK_WRITE_CLIENT_CACHE_MAX = 32;
const slackWriteClientCache = new Map<string, WebClient>();
let slackListenerUploadCompletionClientCache = new WeakMap<
  WebClient,
  { teamId: string; client: WebClient }
>();

type SlackWriteClientCacheOptions = Pick<WebClientOptions, "slackApiUrl">;

export {
  resolveSlackWebClientOptions,
  resolveSlackWriteClientOptions,
  SLACK_DEFAULT_RETRY_OPTIONS,
  SLACK_WRITE_RETRY_OPTIONS,
} from "./client-options.js";

export function createSlackWebClient(token: string, options: WebClientOptions = {}) {
  return new WebClient(token, resolveSlackWebClientOptions(options));
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
  return options.slackApiUrl ? `${tokenKey}:api:${options.slackApiUrl}` : tokenKey;
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
