/**
 * QQ Channel API proxy tool core logic.
 * QQ 频道 API 代理工具核心逻辑。
 *
 * Provides an authenticated HTTP proxy for the QQ Open Platform channel
 * APIs. The caller (old tools/channel.ts shell) resolves the access
 * token and passes it in; this module handles URL building, path
 * validation, fetch, and structured response formatting.
 */

import { formatErrorMessage } from "../utils/format.js";
import { debugLog, debugError } from "../utils/log.js";

const API_BASE = "https://api.sgroup.qq.com";
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Channel API call parameters.
 * 频道 API 调用参数。
 */
export interface ChannelApiParams {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}

/**
 * JSON Schema for AI tool parameters (used by framework registration).
 * AI Tool 参数的 JSON Schema 定义（供框架注册使用）。
 */
export const ChannelApiSchema = {
  type: "object",
  properties: {
    method: {
      type: "string",
      description: "HTTP method. Allowed values: GET, POST, PUT, PATCH, DELETE.",
      enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    },
    path: {
      type: "string",
      description:
        "API path without the host. Replace placeholders with concrete values. " +
        "Examples: /users/@me/guilds, /guilds/{guild_id}/channels, /channels/{channel_id}.",
    },
    body: {
      type: "object",
      description:
        "JSON request body for POST/PUT/PATCH requests. GET/DELETE usually do not need it.",
    },
    query: {
      type: "object",
      description:
        "URL query parameters as key/value pairs appended to the path. " +
        'For example, { "limit": "100", "after": "0" } becomes ?limit=100&after=0.',
      additionalProperties: { type: "string" },
    },
  },
  required: ["method", "path"],
} as const;

/**
 * Build the full API URL from base + path + query params.
 * 拼接 API 基地址 + 路径 + 查询参数。
 */
function buildUrl(path: string, query?: Record<string, string>): string {
  let url = `${API_BASE}${path}`;
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, value);
      }
    }
    const qs = params.toString();
    if (qs) {
      url += `?${qs}`;
    }
  }
  return url;
}

/**
 * Validate API path format; returns an error string or null if valid.
 * 校验 API 路径格式，返回错误描述或 null（合法）。
 */
function validatePath(path: string): string | null {
  if (!path.startsWith("/")) {
    return "path must start with /";
  }
  if (path.includes("..") || path.includes("//")) {
    return "path must not contain .. or //";
  }
  if (!/^\/[a-zA-Z0-9\-._~:@!$&'()*+,;=/%]+$/.test(path) && path !== "/") {
    return "path contains unsupported characters";
  }
  return null;
}

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/**
 * Options provided by the caller when executing a channel API request.
 * 执行频道 API 请求时由调用方提供的选项。
 */
interface ChannelApiExecuteOptions {
  accessToken: string;
}

/**
 * Execute a channel API proxy request.
 * 执行频道 API 代理请求。
 *
 * The caller provides the access token; this function handles
 * URL building, path validation, HTTP fetch, and structured
 * response formatting suitable for AI tool output.
 */
export async function executeChannelApi(
  params: ChannelApiParams,
  options: ChannelApiExecuteOptions,
) {
  if (!params.method) {
    return json({ error: "method is required" });
  }
  if (!params.path) {
    return json({ error: "path is required" });
  }

  const method = params.method.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return json({
      error: `Unsupported HTTP method: ${method}. Allowed values: GET, POST, PUT, PATCH, DELETE`,
    });
  }

  const pathError = validatePath(params.path);
  if (pathError) {
    return json({ error: pathError });
  }

  if (
    (method === "GET" || method === "DELETE") &&
    params.body &&
    Object.keys(params.body).length > 0
  ) {
    debugLog(`[qqbot-channel-api] ${method} request with body, body will be ignored`);
  }

  try {
    const url = buildUrl(params.path, params.query);
    const headers: Record<string, string> = {
      Authorization: `QQBot ${options.accessToken}`,
      "Content-Type": "application/json",
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };

    if (params.body && ["POST", "PUT", "PATCH"].includes(method)) {
      fetchOptions.body = JSON.stringify(params.body);
    }

    debugLog(`[qqbot-channel-api] >>> ${method} ${url} (timeout: ${DEFAULT_TIMEOUT_MS}ms)`);

    let res: Response;
    try {
      res = await fetch(url, fetchOptions);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        debugError(`[qqbot-channel-api] <<< Request timeout after ${DEFAULT_TIMEOUT_MS}ms`);
        return json({
          error: `Request timed out after ${DEFAULT_TIMEOUT_MS}ms`,
          path: params.path,
        });
      }
      debugError("[qqbot-channel-api] <<< Network error:", err);
      return json({
        error: `Network error: ${formatErrorMessage(err)}`,
        path: params.path,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    debugLog(`[qqbot-channel-api] <<< Status: ${res.status} ${res.statusText}`);

    const rawBody = await res.text();
    if (!rawBody || rawBody.trim() === "") {
      if (res.ok) {
        return json({ success: true, status: res.status, path: params.path });
      }
      return json({
        error: `API returned ${res.status} ${res.statusText}`,
        status: res.status,
        path: params.path,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = rawBody;
    }

    if (!res.ok) {
      const errMsg =
        typeof parsed === "object" && parsed && "message" in parsed
          ? String((parsed as { message?: unknown }).message)
          : `${res.status} ${res.statusText}`;
      debugError(`[qqbot-channel-api] Error [${method} ${params.path}]: ${errMsg}`);
      return json({
        error: errMsg,
        status: res.status,
        path: params.path,
        details: parsed,
      });
    }

    return json({
      success: true,
      status: res.status,
      path: params.path,
      data: parsed,
    });
  } catch (err) {
    return json({
      error: formatErrorMessage(err),
      path: params.path,
    });
  }
}
