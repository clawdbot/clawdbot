import type { RetryOptions, WebClientOptions } from "@slack/web-api";
import { HttpsProxyAgent } from "https-proxy-agent";
import { resolveEnvHttpProxyUrl } from "openclaw/plugin-sdk/fetch-runtime";

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

/**
 * Check whether a hostname is excluded from proxying by `NO_PROXY` / `no_proxy`.
 * Supports comma-separated entries with optional leading dots (e.g. `.slack.com`).
 */
function isHostExcludedByNoProxy(hostname: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.no_proxy ?? env.NO_PROXY;
  if (!raw) {
    return false;
  }
  const entries = raw
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const lower = hostname.toLowerCase();
  for (const entry of entries) {
    if (entry === "*") {
      return true;
    }
    // Strip optional wildcard/leading dot so `*.slack.com` and `.slack.com`
    // match both `slack.com` (apex) and Slack subdomains.
    const bare = entry.startsWith("*.")
      ? entry.slice(2)
      : entry.startsWith(".")
        ? entry.slice(1)
        : entry;
    if (lower === bare || lower.endsWith(`.${bare}`)) {
      return true;
    }
  }
  return false;
}

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
function resolveSlackProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxyUrl = resolveEnvHttpProxyUrl("https");
  if (!proxyUrl) {
    return undefined;
  }
  // Slack Socket Mode connects to these hosts; skip proxy if excluded.
  if (isHostExcludedByNoProxy("slack.com")) {
    return undefined;
  }
  try {
    return new HttpsProxyAgent(proxyUrl);
  } catch {
    // Malformed proxy URL; degrade gracefully to direct connection.
    return undefined;
  }
}

export function resolveSlackWebClientOptions(options: WebClientOptions = {}): WebClientOptions {
  return {
    ...options,
    agent: options.agent ?? resolveSlackProxyAgent(),
    retryConfig: options.retryConfig ?? SLACK_DEFAULT_RETRY_OPTIONS,
  };
}

export function resolveSlackWriteClientOptions(options: WebClientOptions = {}): WebClientOptions {
  return {
    ...options,
    agent: options.agent ?? resolveSlackProxyAgent(),
    retryConfig: options.retryConfig ?? SLACK_WRITE_RETRY_OPTIONS,
    maxRequestConcurrency: options.maxRequestConcurrency ?? 1,
  };
}
