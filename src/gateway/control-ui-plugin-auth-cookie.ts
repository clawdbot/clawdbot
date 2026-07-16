// Control UI plugin-tab cookie auth lets an authenticated UI open gateway-auth plugin iframes.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS,
  CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE,
  CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY,
  CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY,
} from "./control-ui-contract.js";
import type { ControlUiPluginTabAuthGrant } from "./control-ui-plugin-tabs.js";
import { isOperatorScope, type OperatorScope } from "./operator-scopes.js";
import { resolvePluginRoutePathContext } from "./server/plugins-http/path-context.js";

// Cookies are hostname-scoped, never port-scoped. The suffix prevents trusted
// same-host Gateways from overwriting one another; it does not isolate them.
// Do not cohost mutually untrusted services on the Gateway's cookie hostname.
const CONTROL_UI_PLUGIN_AUTH_COOKIE_PREFIX = `__openclaw_plugin_tab_auth_${randomBytes(8).toString("hex")}`;
const CONTROL_UI_PLUGIN_AUTH_COOKIE_SCOPE = "plugin-tab";
const controlUiPluginAuthCookieSecret = randomBytes(32);

type PluginAuthCookiePayload = {
  scope: typeof CONTROL_UI_PLUGIN_AUTH_COOKIE_SCOPE;
  pluginId: string;
  scopes: OperatorScope[];
  path: string;
  match: "exact" | "prefix";
  generation: string;
  exp: number;
};

function signPayload(encodedPayload: string): string {
  return createHmac("sha256", controlUiPluginAuthCookieSecret)
    .update(encodedPayload)
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function readCookieHeaderValues(
  header: string | string[] | undefined,
  namePrefix: string,
): string[] {
  const raw = Array.isArray(header) ? header.join(";") : header;
  const values: string[] = [];
  for (const part of raw?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key.startsWith(`${namePrefix}_`)) {
      values.push(value);
    }
  }
  return values;
}

function cookieNameForPlugin(pluginId: string): string {
  const pluginKey = createHash("sha256").update(pluginId).digest("hex");
  return `${CONTROL_UI_PLUGIN_AUTH_COOKIE_PREFIX}_${pluginKey}`;
}

function hasInvalidCookiePathCharacter(path: string): boolean {
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (character === ";" || code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function normalizeCookiePath(path: string): string | undefined {
  if (!path.startsWith("/") || path.startsWith("//") || hasInvalidCookiePathCharacter(path)) {
    return undefined;
  }
  try {
    const normalized = new URL(path, "http://localhost").pathname;
    return normalized === path ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function createControlUiPluginAuthCookie(
  grant: ControlUiPluginTabAuthGrant,
  params: {
    generation: string | undefined;
    nowMs?: number;
  },
) {
  const path = normalizeCookiePath(grant.path);
  if (!path || !grant.pluginId || !params.generation) {
    return undefined;
  }
  const now = asDateTimestampMs(params.nowMs ?? Date.now());
  if (now === undefined) {
    return undefined;
  }
  const exp = asDateTimestampMs(now + CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS);
  if (exp === undefined) {
    return undefined;
  }
  const payload: PluginAuthCookiePayload = {
    scope: CONTROL_UI_PLUGIN_AUTH_COOKIE_SCOPE,
    pluginId: grant.pluginId,
    scopes: grant.scopes.filter(isOperatorScope),
    path,
    match: grant.match,
    generation: params.generation,
    exp,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = signPayload(encodedPayload);
  // The sandboxed frame has an opaque origin, so descendant requests are
  // cross-site for cookie purposes even when the panel URL is same-host.
  // CHIPS cannot be used here: its cross-site-ancestor key prevents nested
  // opaque frames from receiving the grant. HTTP auth limits it to safe reads.
  return `${cookieNameForPlugin(grant.pluginId)}=v1.${encodedPayload}.${sig}; Path=${path}; HttpOnly; Secure; SameSite=None; Max-Age=${Math.ceil(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 1000)}`;
}

export function setControlUiPluginAuthCookie(
  res: ServerResponse,
  grants: readonly ControlUiPluginTabAuthGrant[],
  params: {
    generation: string | undefined;
    nowMs?: number;
  },
) {
  const issuedGrants: ControlUiPluginTabAuthGrant[] = [];
  const cookiesToAdd = grants.flatMap((grant) => {
    const cookie = createControlUiPluginAuthCookie(grant, {
      generation: params.generation,
      nowMs: params.nowMs,
    });
    if (!cookie) {
      return [];
    }
    issuedGrants.push(grant);
    return [cookie];
  });
  if (cookiesToAdd.length === 0) {
    return issuedGrants;
  }
  const existing = typeof res.getHeader === "function" ? res.getHeader("Set-Cookie") : undefined;
  const cookies = Array.isArray(existing)
    ? [...existing, ...cookiesToAdd]
    : typeof existing === "string"
      ? [existing, ...cookiesToAdd]
      : cookiesToAdd;
  res.setHeader("Set-Cookie", cookies);
  return issuedGrants;
}

function grantPathMatchesRequest(
  grantPath: string,
  match: "exact" | "prefix",
  requestPath: string,
): boolean {
  if (match === "exact") {
    return requestPath === grantPath;
  }
  return (
    requestPath === grantPath ||
    (requestPath.startsWith(grantPath) &&
      (grantPath.endsWith("/") || requestPath.at(grantPath.length) === "/"))
  );
}

export function resolveControlUiPluginAuthCookieGrants(
  req: IncomingMessage,
  params: {
    requestPath: string;
    generation: string | undefined;
    nowMs?: number;
  },
): ControlUiPluginTabAuthGrant[] {
  const now = asDateTimestampMs(params.nowMs ?? Date.now());
  if (now === undefined) {
    return [];
  }
  const requestPath = normalizeCookiePath(params.requestPath);
  if (!requestPath || !params.generation) {
    return [];
  }
  const requestPathContext = resolvePluginRoutePathContext(requestPath);
  if (requestPathContext.malformedEncoding || requestPathContext.decodePassLimitReached) {
    return [];
  }
  const grants: ControlUiPluginTabAuthGrant[] = [];
  for (const value of readCookieHeaderValues(
    req.headers.cookie,
    CONTROL_UI_PLUGIN_AUTH_COOKIE_PREFIX,
  )) {
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") {
      continue;
    }
    const [, encodedPayload, sig] = parts;
    if (!encodedPayload || !sig || !safeEqual(sig, signPayload(encodedPayload))) {
      continue;
    }
    try {
      const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as
        | PluginAuthCookiePayload
        | undefined;
      if (
        payload?.scope !== CONTROL_UI_PLUGIN_AUTH_COOKIE_SCOPE ||
        payload.exp <= now ||
        payload.generation !== params.generation ||
        typeof payload.pluginId !== "string" ||
        payload.pluginId.length === 0 ||
        !Array.isArray(payload.scopes) ||
        typeof payload.path !== "string" ||
        normalizeCookiePath(payload.path) !== payload.path ||
        (payload.match !== "exact" && payload.match !== "prefix")
      ) {
        continue;
      }
      const grantPathContext = resolvePluginRoutePathContext(payload.path);
      if (
        grantPathContext.malformedEncoding ||
        grantPathContext.decodePassLimitReached ||
        !grantPathMatchesRequest(
          grantPathContext.canonicalPath,
          payload.match,
          requestPathContext.canonicalPath,
        )
      ) {
        continue;
      }
      const grant = {
        pluginId: payload.pluginId,
        path: payload.path,
        match: payload.match,
        scopes: payload.scopes.filter(isOperatorScope),
      };
      grants.push(grant);
    } catch {
      continue;
    }
  }
  return grants.toSorted((left, right) => right.path.length - left.path.length);
}

/**
 * Confirms that the browser actually sent a grant from inside the opaque
 * sandbox. Secure contexts can still block third-party cookies, so bootstrap
 * acknowledgement alone is not enough to mount the plugin frame.
 */
export function respondControlUiPluginAuthCookieProbe(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const nonce = url.searchParams.get(CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY);
  if (nonce === null) {
    return false;
  }
  const targetOrigin = url.searchParams.get(CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY);
  let validTargetOrigin = false;
  if (targetOrigin) {
    try {
      const parsedOrigin = new URL(targetOrigin);
      validTargetOrigin =
        parsedOrigin.origin === targetOrigin &&
        (parsedOrigin.protocol === "https:" || parsedOrigin.protocol === "http:");
    } catch {
      validTargetOrigin = false;
    }
  }
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(nonce) || !validTargetOrigin) {
    res.statusCode = 400;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Invalid plugin frame auth probe");
    return true;
  }
  res.statusCode = 200;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  );
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const message = JSON.stringify({ type: CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE, nonce });
  res.end(
    `<!doctype html><script>parent.postMessage(${message}, ${JSON.stringify(targetOrigin)})</script>`,
  );
  return true;
}
