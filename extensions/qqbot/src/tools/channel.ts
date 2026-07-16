import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getAccessToken } from "../api.js";
import { listQQBotAccountIds, resolveQQBotAccount } from "../config.js";
import { debugError, debugLog } from "../utils/debug-log.js";

const API_BASE = "https://api.sgroup.qq.com";
const DEFAULT_TIMEOUT_MS = 30000;

interface ChannelApiParams {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}

const ChannelApiSchema = {
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

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

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

/**
 * Register the QQ channel API proxy tool.
 *
 * The tool acts as an authenticated HTTP proxy for the QQ Open Platform channel APIs.
 * Agents learn endpoint details from the skill docs and send requests through this proxy.
 */
export function registerChannelTool(api: OpenClawPluginApi): void {
  const cfg = api.config;
  if (!cfg) {
    debugLog("[qqbot-channel-api] No config available, skipping");
    return;
  }

  const accountIds = listQQBotAccountIds(cfg);
  if (accountIds.length === 0) {
    debugLog("[qqbot-channel-api] No QQBot accounts configured, skipping");
    return;
  }

  const firstAccountId = accountIds[0];
  const account = resolveQQBotAccount(cfg, firstAccountId);

  if (!account.appId || !account.clientSecret) {
    debugLog("[qqbot-channel-api] Account not fully configured, skipping");
    return;
  }

  api.registerTool(
    {
      name: "qqbot_channel_api",
      label: "QQBot Channel API",
      description:
        "Authenticated HTTP proxy for QQ Open Platform channel APIs. " +
        "Common endpoints: " +
        "list guilds GET /users/@me/guilds | " +
        "list channels GET /guilds/{guild_id}/channels | " +
        "get channel GET /channels/{channel_id} | " +
        "create channel POST /guilds/{guild_id}/channels | " +
        "list members GET /guilds/{guild_id}/members?after=0&limit=100 | " +
        "get member GET /guilds/{guild_id}/members/{user_id} | " +
        "list threads GET /channels/{channel_id}/threads | " +
        "create thread PUT /channels/{channel_id}/threads | " +
        "create announce POST /guilds/{guild_id}/announces | " +
        "create schedule POST /channels/{channel_id}/schedules. " +
        "See the qqbot-channel skill for full endpoint details.",
      parameters: ChannelApiSchema,
      async execute(_toolCallId, params) {
        const p = params as ChannelApiParams;
        if (!p.method) {
          return json({ error: "method is required" });
        }
        if (!p.path) {
          return json({ error: "path is required" });
        }

        const method = p.method.toUpperCase();
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
          return json({
            error: `Unsupported HTTP method: ${method}. Allowed values: GET, POST, PUT, PATCH, DELETE`,
          });
        }

        const pathError = validatePath(p.path);
        if (pathError) {
          return json({ error: pathError });
        }

        if ((method === "GET" || method === "DELETE") && p.body && Object.keys(p.body).length > 0) {
          debugLog(`[qqbot-channel-api] ${method} request with body, body will be ignored`);
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const url = buildUrl(p.path, p.query);
          const headers: Record<string, string> = {
            Authorization: `QQBot ${accessToken}`,
            "Content-Type": "application/json",
          };

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

          const fetchOptions: RequestInit = {
            method,
            headers,
            signal: controller.signal,
          };

          if (p.body && ["POST", "PUT", "PATCH"].includes(method)) {
            fetchOptions.body = JSON.stringify(p.body);
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
                path: p.path,
              });
            }
            debugError("[qqbot-channel-api] <<< Network error:", err);
            return json({
              error: `Network error: ${formatErrorMessage(err)}`,
              path: p.path,
            });
          } finally {
            clearTimeout(timeoutId);
          }

          debugLog(`[qqbot-channel-api] <<< Status: ${res.status} ${res.statusText}`);

          const rawBody = await res.text();
          if (!rawBody || rawBody.trim() === "") {
            if (res.ok) {
              return json({ success: true, status: res.status, path: p.path });
            }
            return json({
              error: `API returned ${res.status} ${res.statusText}`,
              status: res.status,
              path: p.path,
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
            debugError(`[qqbot-channel-api] Error [${method} ${p.path}]: ${errMsg}`);
            return json({
              error: errMsg,
              status: res.status,
              path: p.path,
              details: parsed,
            });
          }

          return json({
            success: true,
            status: res.status,
            path: p.path,
            data: parsed,
          });
        } catch (err) {
          return json({
            error: formatErrorMessage(err),
            path: p.path,
          });
        }
      },
    },
    { name: "qqbot_channel_api" },
  );
}
