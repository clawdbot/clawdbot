import { withCdpSocket } from "../cdp.helpers.js";
import { getChromeWebSocketUrl } from "../chrome.js";
import type { BrowserRouteContext } from "../server-context.js";
import type { BrowserRouteRegistrar } from "./types.js";
import {
  asyncBrowserRoute,
  getProfileContext,
  jsonError,
  toNumber,
  toStringOrEmpty,
} from "./utils.js";

type GrantPermissionsBody = {
  origin?: unknown;
  permissions?: unknown;
  optionalPermissions?: unknown;
  timeoutMs?: unknown;
};

function readOrigin(raw: unknown): string | null {
  const value = toStringOrEmpty(raw);
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function readPermissions(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const permissions = raw
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  if (permissions.length !== raw.length) {
    return null;
  }
  return [...new Set(permissions)];
}

async function grantPermissions(params: {
  wsUrl: string;
  origin: string;
  requiredPermissions: string[];
  optionalPermissions: string[];
  timeoutMs: number;
}) {
  const allPermissions = [
    ...new Set([...params.requiredPermissions, ...params.optionalPermissions]),
  ];
  let unsupportedPermissions: string[] = [];
  await withCdpSocket(
    params.wsUrl,
    async (send) => {
      try {
        await send("Browser.grantPermissions", {
          origin: params.origin,
          permissions: allPermissions,
        });
        return;
      } catch (error) {
        if (params.optionalPermissions.length === 0) {
          throw error;
        }
      }
      await send("Browser.grantPermissions", {
        origin: params.origin,
        permissions: params.requiredPermissions,
      });
      unsupportedPermissions = params.optionalPermissions;
    },
    { commandTimeoutMs: params.timeoutMs },
  );
  return {
    grantedPermissions: allPermissions.filter((value) => !unsupportedPermissions.includes(value)),
    unsupportedPermissions,
  };
}

export function registerBrowserPermissionRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post(
    "/permissions/grant",
    asyncBrowserRoute(async (req, res) => {
      const profileCtx = getProfileContext(req, ctx);
      if ("error" in profileCtx) {
        return jsonError(res, profileCtx.status, profileCtx.error);
      }

      const body = (req.body ?? {}) as GrantPermissionsBody;
      const origin = readOrigin(body.origin);
      if (!origin) {
        return jsonError(res, 400, "origin must be an http(s) origin");
      }
      const requiredPermissions = readPermissions(body.permissions);
      if (!requiredPermissions || requiredPermissions.length === 0) {
        return jsonError(res, 400, "permissions must be a non-empty string array");
      }
      const optionalPermissions = readPermissions(body.optionalPermissions ?? []) ?? [];
      const timeoutMs = Math.max(1_000, toNumber(body.timeoutMs) ?? 5_000);

      try {
        await profileCtx.ensureBrowserAvailable();
        const wsUrl = await getChromeWebSocketUrl(
          profileCtx.profile.cdpUrl,
          timeoutMs,
          ctx.state().resolved.ssrfPolicy,
        );
        if (!wsUrl) {
          return jsonError(res, 409, "browser CDP WebSocket unavailable");
        }
        const granted = await grantPermissions({
          wsUrl,
          origin,
          requiredPermissions,
          optionalPermissions,
          timeoutMs,
        });
        return res.json({ ok: true, origin, ...granted });
      } catch (error) {
        return jsonError(res, 500, error instanceof Error ? error.message : String(error));
      }
    }),
  );
}
