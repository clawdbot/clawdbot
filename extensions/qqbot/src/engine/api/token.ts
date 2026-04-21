/**
 * Token management for the QQ Open Platform.
 *
 * All state (cache, singleflight promises, background refresh controllers)
 * is encapsulated in the `TokenManager` class instance — no module-level
 * globals, fully supporting multi-account concurrent operation.
 */

import type { EngineLogger } from "../types.js";
import { formatErrorMessage } from "../utils/format.js";

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

interface CachedToken {
  token: string;
  expiresAt: number;
  appId: string;
}

export interface BackgroundRefreshOptions {
  refreshAheadMs?: number;
  randomOffsetMs?: number;
  minRefreshIntervalMs?: number;
  retryDelayMs?: number;
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

    loop().catch((err) => {
      this.refreshControllers.delete(appId);
      this.logger?.error?.(`[qqbot:token:${appId}] Background refresh crashed: ${err}`);
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

  /** Check whether background refresh is running. */
  isBackgroundRefreshRunning(appId?: string): boolean {
    if (appId) {
      return this.refreshControllers.has(appId);
    }
    return this.refreshControllers.size > 0;
  }

  // ---- Internal ----

  private async doFetchToken(appId: string, clientSecret: string): Promise<string> {
    this.logger?.debug?.(`[qqbot:token:${appId}] >>> POST ${TOKEN_URL}`);

    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": this.resolveUserAgent(),
        },
        body: JSON.stringify({ appId, clientSecret }),
      });
    } catch (err) {
      this.logger?.error?.(`[qqbot:token:${appId}] Network error: ${formatErrorMessage(err)}`);
      throw new Error(`Network error getting access_token: ${formatErrorMessage(err)}`, {
        cause: err,
      });
    }

    const traceId = response.headers.get("x-tps-trace-id") ?? "";
    this.logger?.debug?.(
      `[qqbot:token:${appId}] <<< ${response.status}${traceId ? ` | TraceId: ${traceId}` : ""}`,
    );

    let data: { access_token?: string; expires_in?: number };
    try {
      const rawBody = await response.text();
      const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"');
      this.logger?.debug?.(`[qqbot:token:${appId}] <<< Body: ${logBody}`);
      data = JSON.parse(rawBody);
    } catch (err) {
      throw new Error(`Failed to parse access_token response: ${formatErrorMessage(err)}`, {
        cause: err,
      });
    }

    if (!data.access_token) {
      throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
    }

    const expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
    this.cache.set(appId, { token: data.access_token, expiresAt, appId });
    this.logger?.debug?.(
      `[qqbot:token:${appId}] Cached, expires at: ${new Date(expiresAt).toISOString()}`,
    );

    return data.access_token;
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
