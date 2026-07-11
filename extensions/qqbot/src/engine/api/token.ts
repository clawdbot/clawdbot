/**
 * Token management for the QQ Open Platform.
 *
 * All state (cache, singleflight promises, background refresh controllers)
 * is encapsulated in the `TokenManager` class instance — no module-level
 * globals, fully supporting multi-account concurrent operation.
 */

import {
  asDateTimestampMs,
  parseStrictPositiveInteger,
  resolveExpiresAtMsFromDurationSeconds,
  resolveTimestampMsToIsoString,
} from "openclaw/plugin-sdk/number-runtime";
import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import type { EngineLogger } from "../types.js";
import { formatErrorMessage } from "../utils/format.js";

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const DEFAULT_TOKEN_EXPIRES_IN_SECONDS = 7200;
const QQBOT_TOKEN_RESPONSE_LIMIT_BYTES = 8 * 1024;
const QQBOT_TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Host-scoped SSRF policy for the QQ Bot token endpoint.
 *
 * `TOKEN_URL` is a hard-coded `https://bots.qq.com/...` constant, so this
 * relaxation only ever applies to that single host. Fake-IP proxy stacks
 * (sing-box, Clash, Surge, WSL2 DNS, etc.) routinely map `bots.qq.com` into
 * the RFC 2544 benchmark range `198.18.0.0/15`, which the default SSRF
 * guard blocks. We mirror the existing media-path pattern
 * (`QQBOT_MEDIA_SSRF_POLICY` in `../utils/file-utils.ts`) so the relaxation
 * stays narrowly host-scoped instead of weakening the global default.
 *
 * See https://github.com/openclaw/openclaw/issues/88984.
 */
const QQBOT_TOKEN_SSRF_POLICY: SsrFPolicy = {
  hostnameAllowlist: ["bots.qq.com"],
  allowRfc2544BenchmarkRange: true,
};

interface CachedToken {
  token: string;
  expiresAt: number;
  appId: string;
}

interface BackgroundRefreshOptions {
  refreshAheadMs?: number;
  randomOffsetMs?: number;
  minRefreshIntervalMs?: number;
  retryDelayMs?: number;
}

function resolveTokenExpiresInSeconds(value: unknown): number {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed !== undefined) {
    return parsed;
  }
  if (value == null || (typeof value === "number" && !Number.isFinite(value))) {
    return DEFAULT_TOKEN_EXPIRES_IN_SECONDS;
  }
  return 0;
}

/**
 * Per-appId token manager with caching, singleflight, and background refresh.
 *
 * Usage:
 * ```ts
 * const tm = new TokenManager({ logger, userAgent: 'QQBotPlugin/1.0' });
 * const token = await tm.getAccessToken('appId', 'secret');
 * ```
 */
export class TokenManager {
  private readonly cache = new Map<string, CachedToken>();
  private readonly fetchPromises = new Map<string, Promise<string>>();
  private readonly refreshControllers = new Map<string, AbortController>();
  private readonly logger?: EngineLogger;
  private readonly resolveUserAgent: () => string;

  constructor(config?: { logger?: EngineLogger; userAgent?: string | (() => string) }) {
    this.logger = config?.logger;
    const ua = config?.userAgent ?? "QQBotPlugin/unknown";
    this.resolveUserAgent = typeof ua === "function" ? ua : () => ua;
  }

  /**
   * Obtain an access token with caching and singleflight semantics.
   *
   * When multiple callers request a token for the same appId concurrently,
   * only one actual HTTP request is made — the others await the same promise.
   */
  async getAccessToken(appId: string, clientSecret: string): Promise<string> {
    const normalizedId = appId.trim();
    const cached = this.cache.get(normalizedId);

    // Refresh slightly before expiry without making short-lived tokens unusable.
    const refreshAheadMs = cached
      ? Math.min(5 * 60 * 1000, (cached.expiresAt - Date.now()) / 3)
      : 0;

    if (cached && Date.now() < cached.expiresAt - refreshAheadMs) {
      return cached.token;
    }

    // Singleflight: reuse an in-progress fetch.
    let pending = this.fetchPromises.get(normalizedId);
    if (pending) {
      this.logger?.debug?.(`[qqbot:token:${normalizedId}] Fetch in progress, reusing promise`);
      return pending;
    }

    pending = (async () => {
      try {
        return await this.doFetchToken(normalizedId, clientSecret);
      } finally {
        this.fetchPromises.delete(normalizedId);
      }
    })();

    this.fetchPromises.set(normalizedId, pending);
    return pending;
  }

  /** Clear the cached token for one appId, or all. */
  clearCache(appId?: string): void {
    if (appId) {
      this.cache.delete(appId.trim());
      this.logger?.debug?.(`[qqbot:token:${appId}] Cache cleared`);
    } else {
      this.cache.clear();
      this.logger?.debug?.(`[token] All caches cleared`);
    }
  }

  /** Return token status for diagnostics. */
  getStatus(appId: string): {
    status: "valid" | "expired" | "refreshing" | "none";
    expiresAt: number | null;
  } {
    if (this.fetchPromises.has(appId)) {
      return { status: "refreshing", expiresAt: this.cache.get(appId)?.expiresAt ?? null };
    }
    const cached = this.cache.get(appId);
    if (!cached) {
      return { status: "none", expiresAt: null };
    }
    const remaining = cached.expiresAt - Date.now();
    const isValid = remaining > Math.min(5 * 60 * 1000, remaining / 3);
    return { status: isValid ? "valid" : "expired", expiresAt: cached.expiresAt };
  }

  /** Start a background token refresh loop for one appId. */
  startBackgroundRefresh(
    appId: string,
    clientSecret: string,
    options?: BackgroundRefreshOptions,
  ): void {
    if (this.refreshControllers.has(appId)) {
      this.logger?.info?.(`[qqbot:token:${appId}] Background refresh already running`);
      return;
    }

    const {
      refreshAheadMs = 5 * 60 * 1000,
      randomOffsetMs = 30 * 1000,
      minRefreshIntervalMs = 60 * 1000,
      retryDelayMs = 5 * 1000,
    } = options ?? {};

    const controller = new AbortController();
    this.refreshControllers.set(appId, controller);
    const { signal } = controller;

    const loop = async () => {
      this.logger?.info?.(`[qqbot:token:${appId}] Background refresh started`);

      while (!signal.aborted) {
        try {
          await this.getAccessToken(appId, clientSecret);
          const cached = this.cache.get(appId);

          if (cached) {
            const expiresIn = cached.expiresAt - Date.now();
            const randomOffset = Math.random() * randomOffsetMs;
            const refreshIn = Math.max(
              expiresIn - refreshAheadMs - randomOffset,
              minRefreshIntervalMs,
            );
            this.logger?.debug?.(
              `[qqbot:token:${appId}] Next refresh in ${Math.round(refreshIn / 1000)}s`,
            );
            await this.abortableSleep(refreshIn, signal);
          } else {
            await this.abortableSleep(minRefreshIntervalMs, signal);
          }
        } catch (err) {
          if (signal.aborted) {
            break;
          }
          this.logger?.error?.(
            `[qqbot:token:${appId}] Background refresh failed: ${formatErrorMessage(err)}`,
          );
          await this.abortableSleep(retryDelayMs, signal);
        }
      }

      this.refreshControllers.delete(appId);
      this.logger?.info?.(`[qqbot:token:${appId}] Background refresh stopped`);
    };

    loop().catch((err: unknown) => {
      this.refreshControllers.delete(appId);
      this.logger?.error?.(
        `[qqbot:token:${appId}] Background refresh crashed: ${formatErrorMessage(err)}`,
      );
    });
  }

  /** Stop background refresh for one appId, or all. */
  stopBackgroundRefresh(appId?: string): void {
    if (appId) {
      const ctrl = this.refreshControllers.get(appId);
      if (ctrl) {
        ctrl.abort();
        this.refreshControllers.delete(appId);
      }
    } else {
      for (const ctrl of this.refreshControllers.values()) {
        ctrl.abort();
      }
      this.refreshControllers.clear();
    }
  }

  // ---- Internal ----

  private async doFetchToken(appId: string, clientSecret: string): Promise<string> {
    this.logger?.debug?.(`[qqbot:token:${appId}] >>> POST ${TOKEN_URL}`);

    let response: Response;
    let release: (() => Promise<void>) | undefined;
    try {
      const guarded = await fetchWithSsrFGuard({
        url: TOKEN_URL,
        auditContext: "qqbot-token",
        capture: false,
        policy: QQBOT_TOKEN_SSRF_POLICY,
        timeoutMs: QQBOT_TOKEN_REQUEST_TIMEOUT_MS,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": this.resolveUserAgent(),
          },
          body: JSON.stringify({ appId, clientSecret }),
        },
      });
      response = guarded.response;
      release = guarded.release;
    } catch (err) {
      this.logger?.error?.(`[qqbot:token:${appId}] Network error: ${formatErrorMessage(err)}`);
      throw new Error(`Network error getting access_token: ${formatErrorMessage(err)}`, {
        cause: err,
      });
    }

    try {
      const traceId = response.headers.get("x-tps-trace-id") ?? "";
      this.logger?.debug?.(
        `[qqbot:token:${appId}] <<< ${response.status}${traceId ? ` | TraceId: ${traceId}` : ""}`,
      );

      let rawBody: string;
      try {
        rawBody = await readResponseTextLimited(response, QQBOT_TOKEN_RESPONSE_LIMIT_BYTES);
      } catch (err) {
        throw new Error(`Failed to read access_token response: ${formatErrorMessage(err)}`, {
          cause: err,
        });
      }
      const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"');
      this.logger?.debug?.(`[qqbot:token:${appId}] <<< Body: ${logBody}`);

      let data: { access_token?: string; expires_in?: unknown };
      try {
        data = JSON.parse(rawBody);
      } catch {
        throw new Error("QQBot access_token response was malformed JSON");
      }

      if (!data.access_token) {
        throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
      }

      const nowMs = asDateTimestampMs(Date.now());
      if (nowMs === undefined) {
        this.logger?.debug?.(`[qqbot:token:${appId}] Not cached: invalid process clock`);
        return data.access_token;
      }
      const expiresAt =
        resolveExpiresAtMsFromDurationSeconds(resolveTokenExpiresInSeconds(data.expires_in), {
          nowMs,
        }) ?? nowMs;
      this.cache.set(appId, { token: data.access_token, expiresAt, appId });
      this.logger?.debug?.(
        `[qqbot:token:${appId}] Cached, expires at: ${resolveTimestampMsToIsoString(expiresAt)}`,
      );

      return data.access_token;
    } finally {
      await release?.();
    }
  }

  private abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("Aborted"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
