/**
 * Browser storage and context mutation routes.
 *
 * Parses and applies cookies, local/session storage, geolocation, permissions,
 * and related browser-context mutations for the selected profile/tab.
 */
import {
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatErrorMessage } from "../../infra/errors.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  readBody,
  resolveTargetIdFromBody,
  resolveTargetIdFromQuery,
  withPlaywrightRouteContext,
} from "./agent.shared.js";
import { readOptionalRouteFiniteNumber, readRouteFiniteNumber } from "./route-numeric.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { asyncBrowserRoute, jsonError, toBoolean, toStringOrEmpty } from "./utils.js";

type StorageKind = "local" | "session";

type GeolocationOptions = {
  clear: boolean;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  origin?: string;
};

type CookieSetOptions = {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "None" | "Strict";
};

/** Parse the supported browser storage bucket names. */
export function parseStorageKind(raw: string): StorageKind | null {
  if (raw === "local" || raw === "session") {
    return raw;
  }
  return null;
}

/** Parse an optional storage mutation request from a route body. */
export function parseStorageMutationRequest(
  kindParam: unknown,
  body: Record<string, unknown>,
): { kind: StorageKind | null; targetId: string | undefined } {
  return {
    kind: parseStorageKind(toStringOrEmpty(kindParam)),
    targetId: resolveTargetIdFromBody(body),
  };
}

/** Parse a required storage mutation request and throw on invalid input. */
export function parseRequiredStorageMutationRequest(
  kindParam: unknown,
  body: Record<string, unknown>,
): { kind: StorageKind; targetId: string | undefined } | null {
  const parsed = parseStorageMutationRequest(kindParam, body);
  if (!parsed.kind) {
    return null;
  }
  return {
    kind: parsed.kind,
    targetId: parsed.targetId,
  };
}

function parseStorageMutationOrRespond(
  res: BrowserResponse,
  kindParam: unknown,
  body: Record<string, unknown>,
) {
  const parsed = parseRequiredStorageMutationRequest(kindParam, body);
  if (!parsed) {
    jsonError(res, 400, "kind must be local|session");
    return null;
  }
  return parsed;
}

function parseStorageMutationFromRequest(req: BrowserRequest, res: BrowserResponse) {
  const body = readBody(req);
  const parsed = parseStorageMutationOrRespond(res, req.params.kind, body);
  if (!parsed) {
    return null;
  }
  return { body, parsed };
}

function assertRange(
  value: number | undefined,
  fieldName: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value < min || value > max) {
    throw new Error(`${fieldName} must be between ${min} and ${max}.`);
  }
  return value;
}

/** Parse cookie options accepted by browser storage mutation routes. */
export function parseCookieSetOptions(cookie: Record<string, unknown>): CookieSetOptions {
  return {
    name: toStringOrEmpty(cookie.name),
    value: toStringOrEmpty(cookie.value),
    url: toStringOrEmpty(cookie.url) || undefined,
    domain: toStringOrEmpty(cookie.domain) || undefined,
    path: toStringOrEmpty(cookie.path) || undefined,
    expires: readOptionalRouteFiniteNumber(cookie.expires, "cookie.expires"),
    httpOnly: toBoolean(cookie.httpOnly) ?? undefined,
    secure: toBoolean(cookie.secure) ?? undefined,
    sameSite:
      cookie.sameSite === "Lax" || cookie.sameSite === "None" || cookie.sameSite === "Strict"
        ? cookie.sameSite
        : undefined,
  };
}

/** Parse geolocation override options accepted by context mutation routes. */
export function parseGeolocationOptions(body: Record<string, unknown>): GeolocationOptions {
  const clear = toBoolean(body.clear) ?? false;
  const origin = toStringOrEmpty(body.origin) || undefined;
  if (clear) {
    return { clear, origin };
  }
  const latitude = assertRange(
    readRouteFiniteNumber(body.latitude, "latitude"),
    "latitude",
    -90,
    90,
  );
  const longitude = assertRange(
    readRouteFiniteNumber(body.longitude, "longitude"),
    "longitude",
    -180,
    180,
  );
  const accuracy = readRouteFiniteNumber(body.accuracy, "accuracy");
  if (accuracy !== undefined && accuracy < 0) {
    throw new Error("accuracy must be non-negative.");
  }
  if (!clear && (latitude === undefined || longitude === undefined)) {
    throw new Error("latitude and longitude are required (or set clear=true)");
  }
  return { clear, latitude, longitude, accuracy, origin };
}

/** Register storage and browser-context mutation endpoints. */
export function registerBrowserAgentStorageRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.get(
    "/cookies",
    asyncBrowserRoute(async (req, res) => {
      const targetId = resolveTargetIdFromQuery(req.query);
      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "cookies",
        enforceCurrentUrlAllowed: true,
        run: async ({ cdpUrl, tab, pw }) => {
          const result = await pw.cookiesGetViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
          });
          res.json({ ok: true, targetId: tab.targetId, ...result });
        },
      });
    }),
  );

  app.post(
    "/cookies/set",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const cookie =
        body.cookie && typeof body.cookie === "object" && !Array.isArray(body.cookie)
          ? (body.cookie as Record<string, unknown>)
          : null;
      if (!cookie) {
        return jsonError(res, 400, "cookie is required");
      }
      let parsedCookie: CookieSetOptions;
      try {
        parsedCookie = parseCookieSetOptions(cookie);
      } catch (err) {
        return jsonError(res, 400, formatErrorMessage(err));
      }

      // Intentional: mutation routes are outside the tab-scoped read/export guard scope.
      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "cookies set",
        run: async ({ cdpUrl, tab, pw }) => {
          await pw.cookiesSetViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            cookie: parsedCookie,
          });
          res.json({ ok: true, targetId: tab.targetId });
        },
      });
    }),
  );

  app.post(
    "/cookies/clear",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);

      // Intentional: mutation routes are outside the tab-scoped read/export guard scope.
      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "cookies clear",
        run: async ({ cdpUrl, tab, pw }) => {
          await pw.cookiesClearViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
          });
          res.json({ ok: true, targetId: tab.targetId });
        },
      });
    }),
  );

  app.get(
    "/storage/:kind",
    asyncBrowserRoute(async (req, res) => {
      const kind = parseStorageKind(toStringOrEmpty(req.params.kind));
      if (!kind) {
        return jsonError(res, 400, "kind must be local|session");
      }
      const targetId = resolveTargetIdFromQuery(req.query);
      const key = toStringOrEmpty(req.query.key);

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "storage get",
        enforceCurrentUrlAllowed: true,
        run: async ({ cdpUrl, tab, pw }) => {
          const result = await pw.storageGetViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            kind,
            key: normalizeOptionalString(key),
          });
          res.json({ ok: true, targetId: tab.targetId, ...result });
        },
      });
    }),
  );

  app.post(
    "/storage/:kind/set",
    asyncBrowserRoute(async (req, res) => {
      const mutation = parseStorageMutationFromRequest(req, res);
      if (!mutation) {
        return;
      }
      const key = toStringOrEmpty(mutation.body.key);
      if (!key) {
        return jsonError(res, 400, "key is required");
      }
      const value = typeof mutation.body.value === "string" ? mutation.body.value : "";

      // Intentional: mutation routes are outside the tab-scoped read/export guard scope.
      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId: mutation.parsed.targetId,
        feature: "storage set",
        run: async ({ cdpUrl, tab, pw }) => {
          await pw.storageSetViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            kind: mutation.parsed.kind,
            key,
            value,
          });
          res.json({ ok: true, targetId: tab.targetId });
        },
      });
    }),
  );

  app.post(
    "/storage/:kind/clear",
    asyncBrowserRoute(async (req, res) => {
      const mutation = parseStorageMutationFromRequest(req, res);
      if (!mutation) {
        return;
      }

      // Intentional: mutation routes are outside the tab-scoped read/export guard scope.
      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId: mutation.parsed.targetId,
        feature: "storage clear",
        run: async ({ cdpUrl, tab, pw }) => {
          await pw.storageClearViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            kind: mutation.parsed.kind,
          });
          res.json({ ok: true, targetId: tab.targetId });
        },
      });
    }),
  );

  app.post(
    "/set/offline",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const offline = toBoolean(body.offline);
      if (offline === undefined) {
        return jsonError(res, 400, "offline is required");
      }

      // Intentional: mutation routes are outside the tab-scoped read/export guard scope.
      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "offline",
        run: async ({ cdpUrl, tab, pw }) => {
          await pw.setOfflineViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            offline,
          });
          res.json({ ok: true, targetId: tab.targetId });
        },
      });
    }),
  );

  app.post(
    "/set/headers",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const headers =
        body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)
          ? (body.headers as Record<string, unknown>)
          : null;
      if (!headers) {
        return jsonError(res, 400, "headers is required");
      }

      const parsed: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string") {
          parsed[k] = v;
        }
      }

      // Intentional: mutation routes are outside the tab-scoped read/export guard scope.
      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "headers",
        run: async ({ cdpUrl, tab, pw }) => {
          await pw.setExtraHTTPHeadersViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            headers: parsed,
          });
          res.json({ ok: true, targetId: tab.targetId });
        },
      });
    }),
  );

  app.post(
    "/set/credentials",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const clear = toBoolean(body.clear) ?? false;
      const username = toStringOrEmpty(body.username) || undefined;
      const password = readStringValue(body.password);

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "http credentials",
        run: async ({ cdpUrl, tab, pw }) => {
          await pw.setHttpCredentialsViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            username,
            password,
            clear,
          });
          res.json({ ok: true, targetId: tab.targetId });
        },
      });
    }),
  );

  app.post(
    "/set/geolocation",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      let geolocation: GeolocationOptions;
      try {
        geolocation = parseGeolocationOptions(body);
      } catch (err) {
        return jsonError(res, 400, formatErrorMessage(err));
      }

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "geolocation",
        run: async ({ cdpUrl, tab, pw }) => {
          await pw.setGeolocationViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            ...geolocation,
          });
          res.json({ ok: true, targetId: tab.targetId });
        },
      });
    }),
  );

  app.post(
    "/set/media",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const schemeRaw = toStringOrEmpty(body.colorScheme);
      const colorScheme =
        schemeRaw === "dark" || schemeRaw === "light" || schemeRaw === "no-preference"
          ? schemeRaw
          : schemeRaw === "none"
            ? null
            : undefined;
      if (colorScheme === undefined) {
        return jsonError(res, 400, "colorScheme must be dark|light|no-preference|none");
      }

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "media emulation",
        run: async ({ cdpUrl, tab, pw }) => {
          await pw.emulateMediaViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            colorScheme,
          });
          res.json({ ok: true, targetId: tab.targetId });
        },
      });
    }),
  );

  app.post(
    "/set/timezone",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const timezoneId = toStringOrEmpty(body.timezoneId);
      if (!timezoneId) {
        return jsonError(res, 400, "timezoneId is required");
      }

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "timezone",
        run: async ({ cdpUrl, tab, pw }) => {
          await pw.setTimezoneViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            timezoneId,
          });
          res.json({ ok: true, targetId: tab.targetId });
        },
      });
    }),
  );

  app.post(
    "/set/locale",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const locale = toStringOrEmpty(body.locale);
      if (!locale) {
        return jsonError(res, 400, "locale is required");
      }

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "locale",
        run: async ({ cdpUrl, tab, pw }) => {
          await pw.setLocaleViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            locale,
          });
          res.json({ ok: true, targetId: tab.targetId });
        },
      });
    }),
  );

  app.post(
    "/set/device",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const name = toStringOrEmpty(body.name);
      if (!name) {
        return jsonError(res, 400, "name is required");
      }

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "device emulation",
        run: async ({ cdpUrl, tab, pw }) => {
          await pw.setDeviceViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            name,
          });
          res.json({ ok: true, targetId: tab.targetId });
        },
      });
    }),
  );
}
