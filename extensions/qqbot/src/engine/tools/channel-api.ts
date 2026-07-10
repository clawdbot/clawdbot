/**
 * QQ Channel API proxy tool core logic.
 * QQ 频道 API 代理工具核心逻辑。
 *
 * Provides an authenticated HTTP proxy for the QQ Open Platform channel
 * APIs. The caller (old tools/channel.ts shell) resolves the access
 * token and passes it in; this module handles URL building, path
 * validation, fetch, and structured response formatting.
 */

import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  readProviderTextResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { jsonResult as json } from "openclaw/plugin-sdk/tool-results";
import { formatErrorMessage } from "../utils/format.js";
import { debugLog, debugError } from "../utils/log.js";

const API_BASE = "https://api.sgroup.qq.com";
const DEFAULT_TIMEOUT_MS = 30000;
const CHANNEL_API_ERROR_BODY_LIMIT_BYTES = 8 * 1024;

function resolveChannelApiSsrfPolicy(url: string): SsrFPolicy {
  return {
    hostnameAllowlist: [new URL(url).hostname],
    allowRfc2544BenchmarkRange: true,
  };
}

/**
 * Channel API call parameters.
 * 频道 API 调用参数。
 */
export interface ChannelApiParams {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  confirmed?: boolean;
  bulkConfirmed?: boolean;
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
      description:
        "HTTP method. Allowed values: GET, POST, PUT, PATCH, DELETE. " +
        "Use DELETE and other mutating methods only after explicit user intent and target confirmation.",
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
        "JSON request body for POST/PUT/PATCH requests. GET/DELETE usually do not need it. " +
        "For write requests, include only fields the user explicitly asked to change.",
    },
    query: {
      type: "object",
      description:
        "URL query parameters as key/value pairs appended to the path. " +
        'For example, { "limit": "100", "after": "0" } becomes ?limit=100&after=0.',
      additionalProperties: { type: "string" },
    },
    confirmed: {
      type: "boolean",
      description:
        "Required true for DELETE requests after the user confirms the exact QQ resource to delete.",
    },
    bulkConfirmed: {
      type: "boolean",
      description:
        "Required true in addition to confirmed for bulk DELETE requests such as deleting all announcements.",
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
  for (const segment of path.split("/").slice(1)) {
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      return "path contains invalid percent encoding";
    }
    if (decodedSegment.includes("/") || decodedSegment.includes("\\")) {
      return "path contains encoded path separators";
    }
    if (decodedSegment === "." || decodedSegment === "..") {
      return "path must not contain . or .. segments";
    }
  }
  return null;
}

function decodePathSegments(path: string): string[] | null {
  try {
    return path
      .replace(/\/+$/, "")
      .split("/")
      .slice(1)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

type ChannelApiPathTarget =
  | { kind: "guild-list" }
  | { kind: "guild"; id: string }
  | { kind: "channel"; id: string }
  | { kind: "unverified" };

function resolvePathTarget(path: string): ChannelApiPathTarget {
  const segments = decodePathSegments(path);
  if (!segments || segments.length === 0) {
    return { kind: "unverified" };
  }

  const [scope, firstId, second] = segments;
  if (
    scope?.toLowerCase() === "users" &&
    firstId?.toLowerCase() === "@me" &&
    second?.toLowerCase() === "guilds"
  ) {
    return { kind: "guild-list" };
  }
  if (scope?.toLowerCase() === "guilds" && firstId) {
    return { kind: "guild", id: firstId };
  }
  if (scope?.toLowerCase() === "channels" && firstId) {
    return { kind: "channel", id: firstId };
  }
  return { kind: "unverified" };
}

function validateConfiguredTargetScope(
  path: string,
  options: ChannelApiExecuteOptions,
): string | null {
  if (!options.cfg) {
    return null;
  }

  const basePolicy = resolveChannelGroupPolicy({
    cfg: options.cfg,
    channel: "qqbot",
    accountId: options.accountId,
    groupIdCaseInsensitive: true,
  });
  if (!basePolicy.allowlistEnabled && basePolicy.allowed) {
    return null;
  }

  const target = resolvePathTarget(path);
  if (target.kind === "guild-list") {
    return basePolicy.allowed
      ? null
      : "QQ channel API guild listing is unavailable while qqbot groups are scoped.";
  }
  if (target.kind === "unverified") {
    return basePolicy.allowed
      ? null
      : "QQ channel API path target cannot be verified against configured qqbot groups.";
  }

  return basePolicy.allowed
    ? null
    : `QQ channel API ${target.kind} paths are unavailable while qqbot groups are scoped.`;
}

function isBulkAnnouncementDeletePath(path: string): boolean {
  const segments = decodePathSegments(path);
  return Boolean(
    segments &&
    segments.length === 4 &&
    segments[0]?.toLowerCase() === "guilds" &&
    segments[2]?.toLowerCase() === "announces" &&
    segments[3]?.toLowerCase() === "all",
  );
}

function validateDeleteConfirmation(params: ChannelApiParams): string | null {
  if (params.method.toUpperCase() !== "DELETE") {
    return null;
  }
  if (!params.confirmed) {
    return "DELETE requests require confirmed=true after the user confirms the exact QQ resource.";
  }
  if (isBulkAnnouncementDeletePath(params.path) && !params.bulkConfirmed) {
    return "Deleting all announcements requires bulkConfirmed=true after a separate bulk-delete confirmation.";
  }
  return null;
}

/**
 * Options provided by the caller when executing a channel API request.
 * 执行频道 API 请求时由调用方提供的选项。
 */
interface ChannelApiExecuteOptions {
  accessToken: string;
  cfg?: OpenClawConfig;
  accountId?: string | null;
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

  const scopeError = validateConfiguredTargetScope(params.path, options);
  if (scopeError) {
    return json({ error: scopeError, path: params.path });
  }

  const confirmationError = validateDeleteConfirmation({ ...params, method });
  if (confirmationError) {
    return json({ error: confirmationError, path: params.path });
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
    let release: (() => Promise<void>) | undefined;
    try {
      const guarded = await fetchWithSsrFGuard({
        url,
        init: fetchOptions,
        auditContext: "qqbot-channel-api",
        policy: resolveChannelApiSsrfPolicy(url),
      });
      res = guarded.response;
      release = guarded.release;
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

    try {
      debugLog(`[qqbot-channel-api] <<< Status: ${res.status} ${res.statusText}`);

      const rawBody = res.ok
        ? await readProviderTextResponse(res, "QQ channel API response")
        : await readResponseTextLimited(res, CHANNEL_API_ERROR_BODY_LIMIT_BYTES);
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
    } finally {
      await release?.();
    }
  } catch (err) {
    return json({
      error: formatErrorMessage(err),
      path: params.path,
    });
  }
}
