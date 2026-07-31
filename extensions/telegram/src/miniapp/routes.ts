// Telegram Mini App HTTP routes.
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  issueDeviceBootstrapToken,
} from "openclaw/plugin-sdk/device-bootstrap";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveTelegramAccount } from "../accounts.js";
import { validateTelegramMiniAppInitData } from "./init-data.js";
import { isTelegramMiniAppOwner } from "./owner.js";
import { renderTelegramMiniAppPage, TELEGRAM_MINIAPP_EXPIRED_MESSAGE } from "./page.js";
import {
  resolveTelegramMiniAppUrls,
  TELEGRAM_MINIAPP_PATH_PREFIX,
  TELEGRAM_MINIAPP_URL_ERROR,
} from "./url.js";

const AUTH_PATH = `${TELEGRAM_MINIAPP_PATH_PREFIX}auth`;
const MAX_BODY_BYTES = 4096;
const REPLAY_CACHE_LIMIT = 1000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const replayCache = new Map<string, number>();
const rateLimit = new Map<string, { count: number; resetAtMs: number }>();

export function registerTelegramMiniAppRoutes(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: TELEGRAM_MINIAPP_PATH_PREFIX,
    match: "prefix",
    auth: "plugin",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "", "http://openclaw.local");
      if (url.pathname === TELEGRAM_MINIAPP_PATH_PREFIX) {
        await handlePage(req, res, url);
        return true;
      }
      if (url.pathname === AUTH_PATH) {
        await handleAuth(api, req, res);
        return true;
      }
      sendText(res, 404, "Not found");
      return true;
    },
  });
}

async function handlePage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== "GET") {
    sendText(res, 405, "Method not allowed");
    return;
  }
  const accountId = normalizeAccountId(url.searchParams.get("accountId") ?? DEFAULT_ACCOUNT_ID);
  const nonce = crypto.randomBytes(16).toString("base64url");
  sendHtml(
    res,
    200,
    renderTelegramMiniAppPage({
      accountId,
      scriptNonce: nonce,
    }),
    nonce,
  );
}

async function handleAuth(
  api: OpenClawPluginApi,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    sendText(res, 405, "Method not allowed");
    return;
  }
  const contentType = (req.headers["content-type"] ?? "").toLowerCase();
  if (contentType.split(";")[0]?.trim() !== "application/json") {
    sendText(res, 415, "Unsupported media type");
    return;
  }
  const ip = req.socket.remoteAddress ?? "unknown";
  if (!consumeRateLimit(ip)) {
    sendText(res, 429, "Too many requests");
    return;
  }

  const body = await readJsonBody(req);
  if (body === "too-large") {
    sendText(res, 413, "Payload too large");
    return;
  }
  if (!body) {
    sendText(res, 401, TELEGRAM_MINIAPP_EXPIRED_MESSAGE);
    return;
  }
  const accountId = normalizeAccountId(body.accountId ?? DEFAULT_ACCOUNT_ID);
  const cfg = currentConfig(api);
  const account = resolveTelegramAccount({ cfg, accountId });
  const validated = validateTelegramMiniAppInitData({
    initData: body.initData,
    botToken: account.token,
  });
  if (!validated) {
    sendText(res, 401, TELEGRAM_MINIAPP_EXPIRED_MESSAGE);
    return;
  }
  if (!(await isTelegramMiniAppOwner({ cfg, accountId, userId: validated.userId }))) {
    sendText(res, 403, "Restricted to the bot owner.");
    return;
  }

  let urls;
  try {
    urls = await resolveTelegramMiniAppUrls({ cfg });
  } catch {
    sendText(res, 503, TELEGRAM_MINIAPP_URL_ERROR);
    return;
  }
  if (!rememberReplay(validated.hash, validated.authDateMs + 300_000)) {
    sendText(res, 401, TELEGRAM_MINIAPP_EXPIRED_MESSAGE);
    return;
  }
  const issued = await issueDeviceBootstrapToken({
    profile: {
      roles: ["operator"],
      scopes: BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
      purpose: "control-ui",
    },
  });
  sendJson(res, 200, {
    bootstrapToken: issued.token,
    controlUiUrl: urls.controlUiUrl,
    gatewayUrl: urls.gatewayUrl,
  });
}

function currentConfig(api: OpenClawPluginApi): OpenClawConfig {
  return (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<{ initData: string; accountId?: string } | "too-large" | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      return "too-large";
    }
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      initData?: unknown;
      accountId?: unknown;
    };
    if (typeof parsed.initData !== "string") {
      return null;
    }
    return {
      initData: parsed.initData,
      ...(typeof parsed.accountId === "string" ? { accountId: parsed.accountId } : {}),
    };
  } catch {
    return null;
  }
}

function consumeRateLimit(ip: string): boolean {
  const now = Date.now();
  const current = rateLimit.get(ip);
  if (!current || current.resetAtMs <= now) {
    rateLimit.set(ip, { count: 1, resetAtMs: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_LIMIT_MAX;
}

function rememberReplay(hash: string, expiresAtMs: number): boolean {
  pruneReplayCache();
  if (replayCache.has(hash)) {
    return false;
  }
  replayCache.set(hash, expiresAtMs);
  while (replayCache.size > REPLAY_CACHE_LIMIT) {
    const first = replayCache.keys().next().value;
    if (!first) {
      return true;
    }
    replayCache.delete(first);
  }
  return true;
}

function pruneReplayCache(): void {
  const now = Date.now();
  for (const [hash, expiresAtMs] of replayCache) {
    if (expiresAtMs <= now) {
      replayCache.delete(hash);
    }
  }
}

function securityHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
    ...extra,
  };
}

function sendHtml(res: ServerResponse, status: number, body: string, nonce: string): void {
  res.writeHead(
    status,
    securityHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' https://telegram.org; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
    }),
  );
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, securityHeaders({ "Content-Type": "application/json; charset=utf-8" }));
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
  res.end(body);
}
