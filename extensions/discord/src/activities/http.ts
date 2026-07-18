import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logError } from "openclaw/plugin-sdk/logging-core";
import { resolveRequestClientIp } from "openclaw/plugin-sdk/webhook-ingress";
import { parseDiscordActivityCustomId } from "../component-custom-id.js";
import { resolveActivityUserAuthorized } from "./allowlist.js";
import {
  DISCORD_TOKEN_URL,
  DISCORD_USER_URL,
  fetchDiscordJson,
  fetchWithSsrFGuard,
  type FetchGuard,
  normalizeInstanceId,
  resolveActivityInstanceChannel,
} from "./discord-api.js";
import { TokenRateLimiter } from "./rate-limit.js";
import type { DiscordActivitiesRuntime } from "./runtime.js";
import {
  DISCORD_ACTIVITY_ROUTE_PREFIX,
  DISCORD_ACTIVITY_SHELL_CSP,
  DISCORD_ACTIVITY_SHELL_HTML,
  DISCORD_ACTIVITY_SHELL_JS,
} from "./shell.js";

const BODY_MAX_BYTES = 8 * 1024;
const WIDGET_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const DOC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const DISCORD_ACTIVITY_WIDGET_CSP =
  // Discord is an ancestor of the same-origin Activity shell, so every frame ancestor must pass.
  // The one-time document capability and nested sandbox remain the embedding boundary.
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; " +
  "connect-src 'none'; frame-ancestors *";

type DiscordActivityHttpDeps = {
  runtime: DiscordActivitiesRuntime;
  vendorAssetPath: string;
  fetchGuard?: FetchGuard;
  now?: () => number;
  readVendorAsset?: (assetPath: string) => Promise<Buffer>;
  logError?: (message: string) => void;
};

type DiscordOauthUser = {
  id?: string;
  username?: string;
  discriminator?: string;
};

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function respond(
  res: ServerResponse,
  statusCode: number,
  body: string | Buffer,
  contentType: string,
  headers?: Record<string, string>,
): true {
  res.statusCode = statusCode;
  setCommonHeaders(res);
  res.setHeader("Content-Type", contentType);
  for (const [key, value] of Object.entries(headers ?? {})) {
    res.setHeader(key, value);
  }
  res.end(body);
  return true;
}

function respondJson(res: ServerResponse, statusCode: number, body: unknown): true {
  return respond(res, statusCode, `${JSON.stringify(body)}\n`, "application/json; charset=utf-8");
}

function notFound(res: ServerResponse, widgetDocument = false): true {
  // Indistinguishable 404s prevent document-capability probes from revealing widget state.
  return respond(
    res,
    404,
    "not found",
    "text/plain; charset=utf-8",
    widgetDocument ? { "Content-Security-Policy": DISCORD_ACTIVITY_WIDGET_CSP } : undefined,
  );
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += data.byteLength;
    if (total > BODY_MAX_BYTES) {
      return null;
    }
    chunks.push(data);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function extractApplicationId(req: IncomingMessage): string | undefined {
  for (const header of [readHeader(req, "origin"), readHeader(req, "referer")]) {
    if (!header) {
      continue;
    }
    try {
      const match = new URL(header).hostname.match(/^(\d+)\.discordsays\.com$/i);
      if (match?.[1]) {
        return match[1];
      }
    } catch {}
  }
  return undefined;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const authorization = readHeader(req, "authorization")?.trim();
  const match = authorization?.match(/^Bearer\s+([A-Za-z0-9_-]{43})$/i);
  return match?.[1];
}

function widgetIdFromCustomId(customId: string): string | undefined {
  if (WIDGET_ID_PATTERN.test(customId)) {
    return customId;
  }
  return parseDiscordActivityCustomId(customId)?.widgetId;
}

export function createDiscordActivityHttpHandler(deps: DiscordActivityHttpDeps): {
  handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
} {
  const fetchGuard = deps.fetchGuard ?? fetchWithSsrFGuard;
  const limiter = new TokenRateLimiter(deps.now ?? Date.now);
  const readVendorAsset = deps.readVendorAsset ?? ((assetPath: string) => fs.readFile(assetPath));
  const reportError = deps.logError ?? logError;
  let vendorAsset: Promise<Buffer> | undefined;
  let pendingLaunchFailureLogged = false;

  function logPendingLaunchFailure(error: unknown): void {
    if (pendingLaunchFailureLogged) {
      return;
    }
    pendingLaunchFailureLogged = true;
    reportError(`discord activity: failed to consume pending launch: ${String(error)}`);
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<true> {
    const cfg = deps.runtime.currentConfig();
    const sourceIp =
      resolveRequestClientIp(
        req,
        cfg.gateway?.trustedProxies,
        cfg.gateway?.allowRealIpFallback === true,
      ) ?? "unknown";
    if (!limiter.allowKey(sourceIp)) {
      return respondJson(res, 429, { error: "too many token requests" });
    }
    const applicationId = extractApplicationId(req);
    const account = deps.runtime.resolveHttpAccount(applicationId);
    if (!account) {
      return respondJson(res, 503, { error: "Discord Activities is not fully configured" });
    }
    const body = await readJsonBody(req);
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!code) {
      return respondJson(res, 401, { error: "invalid authorization code" });
    }
    const reservation = limiter.reserveGlobal();
    if (reservation === null) {
      return respondJson(res, 429, { error: "too many token requests" });
    }
    let completed = false;
    try {
      let tokenResponse: Awaited<ReturnType<typeof fetchDiscordJson>>;
      try {
        tokenResponse = await fetchDiscordJson({
          fetchGuard,
          fetchImpl: account.proxyFetch,
          url: DISCORD_TOKEN_URL,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: account.applicationId,
              client_secret: account.clientSecret,
              code,
            }),
          },
          auditContext: "discord.activities.oauth.token",
        });
      } catch {
        return respondJson(res, 503, { error: "Discord token exchange unavailable" });
      }
      const granted =
        typeof tokenResponse.body?.access_token === "string"
          ? tokenResponse.body.access_token.trim()
          : "";
      if (!tokenResponse.ok || !granted) {
        return respondJson(res, 401, { error: "invalid authorization code" });
      }
      let userResponse: Awaited<ReturnType<typeof fetchDiscordJson>>;
      try {
        userResponse = await fetchDiscordJson({
          fetchGuard,
          fetchImpl: account.proxyFetch,
          url: DISCORD_USER_URL,
          init: { headers: { Authorization: `Bearer ${granted}` } },
          auditContext: "discord.activities.oauth.user",
        });
      } catch {
        return respondJson(res, 503, { error: "Discord user lookup unavailable" });
      }
      const user: DiscordOauthUser = {
        id: typeof userResponse.body?.id === "string" ? userResponse.body.id : undefined,
        username:
          typeof userResponse.body?.username === "string" ? userResponse.body.username : undefined,
        discriminator:
          typeof userResponse.body?.discriminator === "string"
            ? userResponse.body.discriminator
            : undefined,
      };
      if (!userResponse.ok || !user.id) {
        return respondJson(res, 401, { error: "Discord user lookup failed" });
      }
      if (!resolveActivityUserAuthorized(account.config, { ...user, id: user.id })) {
        return respondJson(res, 403, { error: "Discord user is not allowlisted" });
      }
      const minted = await deps.runtime.store.createSession({
        discordUserId: user.id,
        accountId: account.accountId,
      });
      completed = true;
      return respondJson(res, 200, {
        access_token: granted,
        session_token: minted,
      });
    } finally {
      if (!completed) {
        limiter.releaseGlobal(reservation);
      }
    }
  }

  async function handleWidget(req: IncomingMessage, res: ServerResponse, url: URL): Promise<true> {
    const token = bearerToken(req);
    const session = token ? await deps.runtime.store.lookupSession(token) : undefined;
    if (!session) {
      return respondJson(res, 401, { error: "invalid session" });
    }
    const customId = url.searchParams.get("custom_id")?.trim() ?? "";
    const instanceId = normalizeInstanceId(url.searchParams.get("instance_id"));
    const account = deps.runtime.resolveAccount(session.accountId);
    const channelId =
      instanceId && account
        ? await resolveActivityInstanceChannel({
            fetchGuard,
            applicationId: account.applicationId,
            instanceId,
            discordUserId: session.discordUserId,
            botAuth: account.botAuth,
            proxyFetch: account.proxyFetch,
          })
        : undefined;
    if (!channelId) {
      return respondJson(res, 404, { error: "widget not found" });
    }
    let resolved: {
      id: string;
      widget: NonNullable<Awaited<ReturnType<typeof deps.runtime.store.lookupWidget>>>;
    } | null = null;
    // Prefer an explicit ID, then the click-time launch record, then the newest posted widget.
    const requestedWidgetId = widgetIdFromCustomId(customId);
    if (requestedWidgetId) {
      const widget = await deps.runtime.store.lookupWidget(requestedWidgetId);
      // A parseable ID is an explicit widget selection. Missing or foreign widgets fail closed
      // instead of silently opening unrelated pending or newest-widget state.
      if (widget?.accountId !== session.accountId || widget.channelId !== channelId) {
        return respondJson(res, 404, { error: "widget not found" });
      }
      resolved = { id: requestedWidgetId, widget };
      // Awaited like every sibling store call on this path (sessions, widgets): the local
      // KV either answers or the process is wedged; per-call budgets here would be asymmetric.
      try {
        await deps.runtime.store.retirePendingLaunch(
          session.accountId,
          channelId,
          session.discordUserId,
          requestedWidgetId,
        );
      } catch (error) {
        logPendingLaunchFailure(error);
      }
    } else {
      try {
        const pendingLaunch = await deps.runtime.store.consumePendingLaunch(
          session.accountId,
          channelId,
          session.discordUserId,
        );
        if (pendingLaunch) {
          const widget = await deps.runtime.store.lookupWidget(pendingLaunch.widgetId);
          if (widget?.accountId === session.accountId && widget.channelId === channelId) {
            resolved = { id: pendingLaunch.widgetId, widget };
          }
        }
      } catch (error) {
        logPendingLaunchFailure(error);
      }
      // Some Discord clients omit the launch custom ID. Prefer the most recently posted channel
      // widget while keeping older widgets addressable through buttons that preserve custom IDs.
      resolved ??= await deps.runtime.store.latestPostedWidgetForChannel(
        session.accountId,
        channelId,
      );
    }
    if (!resolved) {
      return respondJson(res, 404, { error: "widget not found" });
    }
    const docToken = await deps.runtime.store.createDocToken({
      widgetId: resolved.id,
      accountId: session.accountId,
    });
    return respondJson(res, 200, {
      id: resolved.id,
      title: resolved.widget.title,
      docUrl: `${DISCORD_ACTIVITY_ROUTE_PREFIX}/api/widget/${encodeURIComponent(resolved.id)}/doc?wt=${encodeURIComponent(docToken)}`,
    });
  }

  async function handleDocument(
    res: ServerResponse,
    widgetId: string,
    token: string,
  ): Promise<true> {
    if (!WIDGET_ID_PATTERN.test(widgetId) || !DOC_TOKEN_PATTERN.test(token)) {
      return notFound(res, true);
    }
    // Consume before lookup: a valid capability is single-use even if its widget was evicted.
    const capability = await deps.runtime.store.consumeDocToken(token);
    if (!capability || capability.widgetId !== widgetId) {
      return notFound(res, true);
    }
    const widget = await deps.runtime.store.lookupWidget(widgetId);
    if (!widget || widget.accountId !== capability.accountId) {
      return notFound(res, true);
    }
    return respond(res, 200, widget.html, "text/html; charset=utf-8", {
      "Content-Security-Policy": DISCORD_ACTIVITY_WIDGET_CSP,
    });
  }

  return {
    async handleHttpRequest(req, res) {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (
        url.pathname !== DISCORD_ACTIVITY_ROUTE_PREFIX &&
        !url.pathname.startsWith(`${DISCORD_ACTIVITY_ROUTE_PREFIX}/`)
      ) {
        return false;
      }
      const relative = url.pathname.slice(DISCORD_ACTIVITY_ROUTE_PREFIX.length) || "/";
      if (req.method === "GET" && (relative === "/" || relative === "/index.html")) {
        return respond(res, 200, DISCORD_ACTIVITY_SHELL_HTML, "text/html; charset=utf-8", {
          "Content-Security-Policy": DISCORD_ACTIVITY_SHELL_CSP,
        });
      }
      if (req.method === "GET" && relative === "/shell.js") {
        return respond(res, 200, DISCORD_ACTIVITY_SHELL_JS, "text/javascript; charset=utf-8");
      }
      if (req.method === "GET" && relative === "/vendor/embedded-app-sdk.mjs") {
        const pendingAsset = (vendorAsset ??= readVendorAsset(deps.vendorAssetPath));
        try {
          return respond(res, 200, await pendingAsset, "text/javascript; charset=utf-8");
        } catch {
          // Clear only the failed read. A later request may already have installed a retry.
          if (vendorAsset === pendingAsset) {
            vendorAsset = undefined;
          }
          return notFound(res);
        }
      }
      if (req.method === "POST" && relative === "/api/token") {
        return await handleToken(req, res);
      }
      if (req.method === "GET" && relative === "/api/widget") {
        return await handleWidget(req, res, url);
      }
      const documentMatch = relative.match(/^\/api\/widget\/([^/]+)\/doc$/);
      if (req.method === "GET" && documentMatch?.[1]) {
        let widgetId: string;
        try {
          widgetId = decodeURIComponent(documentMatch[1]);
        } catch {
          return notFound(res, true);
        }
        return await handleDocument(res, widgetId, url.searchParams.get("wt") ?? "");
      }
      return notFound(res);
    },
  };
}
