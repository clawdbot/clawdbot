// Slack plugin module implements client options behavior.
import type { Agent } from "node:http";
import type { RetryOptions, WebClientOptions } from "@slack/web-api";
import { createNodeProxyAgent } from "openclaw/plugin-sdk/fetch-runtime";

export type SlackLookupClientOptions = Pick<WebClientOptions, "agent" | "slackApiUrl" | "timeout">;

export const SLACK_DEFAULT_RETRY_OPTIONS: RetryOptions = {
  retries: 2,
  factor: 2,
  minTimeout: 500,
  maxTimeout: 3000,
  randomize: true,
};

export const SLACK_WRITE_RETRY_OPTIONS: RetryOptions = {
  retries: 0,
};

const SLACK_LOOKUP_TIMEOUT_MS = 30_000;

const SLACK_LOOKUP_RETRY_OPTIONS: RetryOptions = {
  retries: 0,
};

/**
 * Build an HTTPS proxy agent from env vars (HTTPS_PROXY, HTTP_PROXY, etc.)
 * for use as the `agent` option in Slack WebClient and Socket Mode connections.
 *
 * When set, this agent is forwarded through @slack/bolt -> @slack/socket-mode ->
 * SlackWebSocket as the `httpAgent`, which the `ws` library uses to tunnel the
 * WebSocket upgrade request through the proxy. This fixes Socket Mode in
 * environments where outbound traffic must go through an HTTP CONNECT proxy.
 *
 * Respects `NO_PROXY` / `no_proxy`; if `*.slack.com` (or a matching pattern)
 * appears in the exclusion list, returns `undefined` so the connection is direct.
 *
 * Returns `undefined` when no proxy env var is configured or when Slack hosts
 * are excluded by `NO_PROXY`.
 */
function resolveSlackProxyAgent(targetUrl: string): Agent | undefined {
  try {
    return createNodeProxyAgent({
      mode: "env",
      targetUrl,
    });
  } catch {
    // Malformed proxy URL; degrade gracefully to direct connection.
    return undefined;
  }
}

function resolveSlackApiUrlFromEnv(): string | undefined {
  return process.env.SLACK_API_URL?.trim() || undefined;
}

function applySlackApiUrlAndProxyOptions(options: WebClientOptions): void {
  const slackApiUrl = options.slackApiUrl ?? resolveSlackApiUrlFromEnv();
  const proxyTargetUrl = slackApiUrl ?? "https://slack.com/";
  options.agent ??= resolveSlackProxyAgent(proxyTargetUrl);
  if (slackApiUrl !== undefined) {
    options.slackApiUrl = slackApiUrl;
  } else {
    delete options.slackApiUrl;
  }
}

export function resolveSlackWebClientOptions(options: WebClientOptions = {}): WebClientOptions {
  const resolved: WebClientOptions = Object.assign({}, options);
  applySlackApiUrlAndProxyOptions(resolved);
  resolved.retryConfig ??= SLACK_DEFAULT_RETRY_OPTIONS;
  return resolved;
}

export function resolveSlackWriteClientOptions(options: WebClientOptions = {}): WebClientOptions {
  const resolved: WebClientOptions = Object.assign({}, options);
  applySlackApiUrlAndProxyOptions(resolved);
  resolved.retryConfig ??= SLACK_WRITE_RETRY_OPTIONS;
  return resolved;
}

export function resolveSlackLookupClientOptions(
  options: SlackLookupClientOptions = {},
): WebClientOptions {
  const resolved: WebClientOptions = Object.assign({}, options);
  applySlackApiUrlAndProxyOptions(resolved);
  // Slack otherwise sleeps through the full Retry-After window after receiving 429,
  // outside the Axios request timeout.
  resolved.rejectRateLimitedCalls = true;
  resolved.retryConfig = SLACK_LOOKUP_RETRY_OPTIONS;
  resolved.timeout ??= SLACK_LOOKUP_TIMEOUT_MS;
  return resolved;
}
