/**
 * Core HTTP client for the QQ Open Platform REST API.
 *
 * Key improvements over the old `src/api.ts#apiRequest`:
 * - `ApiClient` is an **instance** — config (baseUrl, timeout, logger, UA)
 *   is injected via the constructor, eliminating module-level globals.
 * - Throws structured `ApiError` with httpStatus, bizCode, and path fields.
 * - Detects HTML error pages from CDN/gateway and returns user-friendly messages.
 * - `redactBodyKeys` replaces the hardcoded `file_data` redaction.
 */

import {
  readProviderTextResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { ApiError, type ApiClientConfig, type EngineLogger } from "../types.js";
import { formatErrorMessage } from "../utils/format.js";

const DEFAULT_BASE_URL = "https://api.sgroup.qq.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const FILE_UPLOAD_TIMEOUT_MS = 120_000;
const QQBOT_API_ERROR_BODY_LIMIT_BYTES = 8 * 1024;

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

function resolveQqbotApiSsrfPolicy(url: string): SsrFPolicy {
  return {
    hostnameAllowlist: [new URL(url).hostname],
    allowRfc2544BenchmarkRange: true,
  };
}

interface RequestOptions {
  /** Request timeout override in milliseconds. */
  timeoutMs?: number;
  /** Body keys to redact in debug logs (e.g. `['file_data']`). */
  redactBodyKeys?: string[];
  /**
   * Mark the request as a file-upload call.
   *
   * Triggers the longer `fileUploadTimeoutMs` (default 120s) instead of the
   * standard `defaultTimeoutMs` (default 30s). Prefer this flag over
   * inspecting the request path; it keeps the timeout policy independent of
   * route naming conventions.
   */
  uploadRequest?: boolean;
}

/**
 * Stateful HTTP client for the QQ Open Platform.
 *
 * Usage:
 * ```ts
 * const client = new ApiClient({ logger, userAgent: 'QQBotPlugin/1.0' });
 * const data = await client.request<{ url: string }>(token, 'GET', '/gateway');
 * ```
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly fileUploadTimeoutMs: number;
  private readonly logger?: EngineLogger;
  private readonly resolveUserAgent: () => string;

  constructor(config: ApiClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fileUploadTimeoutMs = config.fileUploadTimeoutMs ?? FILE_UPLOAD_TIMEOUT_MS;
    this.logger = config.logger;
    const ua = config.userAgent ?? "QQBotPlugin/unknown";
    this.resolveUserAgent = typeof ua === "function" ? ua : () => ua;
  }

  /**
   * Send an authenticated JSON request to the QQ Open Platform.
   *
   * @param accessToken - Bearer token (`QQBot {token}`).
   * @param method - HTTP method.
   * @param path - API path (appended to baseUrl).
   * @param body - Optional JSON body.
   * @param options - Optional request overrides.
   * @returns Parsed JSON response.
   * @throws {ApiError} On HTTP or parse errors.
   */
  async request<T = unknown>(
    accessToken: string,
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `QQBot ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": this.resolveUserAgent(),
    };

    const isFileUpload =
      options?.uploadRequest === true ||
      // Back-compat: legacy callers that predate the explicit `uploadRequest`
      // flag still get the long timeout when hitting file endpoints. New
      // code should always pass `uploadRequest: true` explicitly.
      path.includes("/files") ||
      path.includes("/upload_prepare") ||
      path.includes("/upload_part_finish");
    const timeout =
      options?.timeoutMs ?? (isFileUpload ? this.fileUploadTimeoutMs : this.defaultTimeoutMs);
    const guardedTimeoutMs = timeout > 0 ? timeout : 1;

    const fetchInit: RequestInit = {
      method,
      headers,
    };

    if (body) {
      fetchInit.body = JSON.stringify(body);
    }

    // Debug logging with optional body redaction.
    this.logger?.debug?.(`[qqbot:api] >>> ${method} ${url} (timeout: ${timeout}ms)`);
    if (body && this.logger?.debug) {
      const logBody = { ...(body as Record<string, unknown>) };
      for (const key of options?.redactBodyKeys ?? ["file_data"]) {
        if (typeof logBody[key] === "string") {
          logBody[key] = `<redacted ${logBody[key].length} chars>`;
        }
      }
      this.logger.debug(`[qqbot:api] >>> Body: ${JSON.stringify(logBody)}`);
    }

    let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
    try {
      guarded = await fetchWithSsrFGuard({
        url,
        init: fetchInit,
        auditContext: "qqbot-api",
        policy: resolveQqbotApiSsrfPolicy(url),
        timeoutMs: guardedTimeoutMs,
      });
    } catch (err) {
      if (isTimeoutError(err)) {
        this.logger?.error?.(`[qqbot:api] <<< Timeout after ${timeout}ms`);
        throw new ApiError(`Request timeout [${path}]: exceeded ${timeout}ms`, 0, path);
      }
      this.logger?.error?.(`[qqbot:api] <<< Network error: ${formatErrorMessage(err)}`);
      throw new ApiError(`Network error [${path}]: ${formatErrorMessage(err)}`, 0, path);
    }

    const res = guarded.response;
    try {
      // Log response status and trace ID.
      const traceId = res.headers.get("x-tps-trace-id") ?? "";
      this.logger?.info?.(
        `[qqbot:api] <<< Status: ${res.status} ${res.statusText}${traceId ? ` | TraceId: ${traceId}` : ""}`,
      );

      const readBody = async (limitBytes?: number): Promise<string> => {
        try {
          return limitBytes === undefined
            ? await readProviderTextResponse(res, "QQBot API response")
            : await readResponseTextLimited(res, limitBytes);
        } catch (err) {
          if (isTimeoutError(err)) {
            this.logger?.error?.(`[qqbot:api] <<< Timeout after ${timeout}ms`);
            throw new ApiError(`Request timeout [${path}]: exceeded ${timeout}ms`, 0, path);
          }
          throw new ApiError(
            `Failed to read response [${path}]: ${formatErrorMessage(err)}`,
            res.status,
            path,
          );
        }
      };

      const rawBody = res.ok ? await readBody() : await readBody(QQBOT_API_ERROR_BODY_LIMIT_BYTES);
      this.logger?.debug?.(`[qqbot:api] <<< Body: ${rawBody}`);

      // Detect non-JSON responses (HTML gateway errors, CDN rate-limit pages).
      const contentType = res.headers.get("content-type") ?? "";
      const isHtmlResponse =
        contentType.includes("text/html") || rawBody.trimStart().startsWith("<");

      if (!res.ok) {
        if (isHtmlResponse) {
          const statusHint =
            res.status === 502 || res.status === 503 || res.status === 504
              ? "调用发生异常，请稍候重试"
              : res.status === 429
                ? "请求过于频繁，已被限流"
                : `开放平台返回 HTTP ${res.status}`;
          throw new ApiError(`${statusHint}（${path}），请稍后重试`, res.status, path);
        }

        // JSON error response.
        try {
          const error = JSON.parse(rawBody) as {
            message?: string;
            code?: number;
            err_code?: number;
          };
          const bizCode = error.code ?? error.err_code;
          throw new ApiError(
            `API Error [${path}]: ${error.message ?? rawBody}`,
            res.status,
            path,
            bizCode,
            error.message,
          );
        } catch (parseErr) {
          if (parseErr instanceof ApiError) {
            throw parseErr;
          }
          throw new ApiError(
            `API Error [${path}] HTTP ${res.status}: ${truncateUtf16Safe(rawBody, 200)}`,
            res.status,
            path,
          );
        }
      }

      // Successful response but not JSON (extreme edge case).
      if (isHtmlResponse) {
        throw new ApiError(
          `QQ 服务端返回了非 JSON 响应（${path}），可能是临时故障，请稍后重试`,
          res.status,
          path,
        );
      }

      try {
        return JSON.parse(rawBody) as T;
      } catch {
        throw new ApiError(`开放平台响应格式异常（${path}），请稍后重试`, res.status, path);
      }
    } finally {
      await guarded.release();
    }
  }
}
