/**
 * Browser permission routes.
 *
 * Grants required and optional browser permissions for an origin, preferring
 * Playwright context APIs when available and falling back to raw CDP.
 */
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatErrorMessage } from "../../infra/errors.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { resolveCdpControlPolicy } from "../cdp-reachability-policy.js";
import { withCdpSocket } from "../cdp.helpers.js";
import { getChromeWebSocketUrl } from "../chrome.js";
import { BrowserProfileUnavailableError, toBrowserErrorResponse } from "../errors.js";
import { getPwAiModule } from "../pw-ai-module.js";
import type { BrowserRouteContext } from "../server-context.js";
import type { ProfileContext } from "../server-context.js";
import { isProfileRestartRequiredError } from "../server-context.lifecycle.js";
import { readRouteTimerTimeoutMs } from "./route-numeric.js";
import type { BrowserRouteRegistrar } from "./types.js";
import {
  asyncBrowserRoute,
  getProfileContext,
  jsonBrowserError,
  jsonError,
  readHttpOrigin,
  runProfileRouteOperation,
  toStringOrEmpty,
} from "./utils.js";

const permissionRouteDeps = {
  getPwAiModule,
};

/** Test hook for replacing optional Playwright permission dependencies. */
export const testing = {
  setDepsForTest(deps: { getPwAiModule?: typeof getPwAiModule } | null) {
    permissionRouteDeps.getPwAiModule = deps?.getPwAiModule ?? getPwAiModule;
  },
};

type GrantPermissionsBody = {
  origin?: unknown;
  permissions?: unknown;
  optionalPermissions?: unknown;
  timeoutMs?: unknown;
  targetId?: unknown;
};

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
  return uniqueStrings(permissions);
}

async function grantPermissions(params: {
  profileCtx: ProfileContext;
  targetId?: string;
  wsUrl: string;
  origin: string;
  requiredPermissions: string[];
  optionalPermissions: string[];
  timeoutMs: number;
  ssrfPolicy?: SsrFPolicy;
  signal: AbortSignal;
}) {
  params.signal.throwIfAborted();
  const allPermissions = [
    ...new Set([...params.requiredPermissions, ...params.optionalPermissions]),
  ];
  const playwrightRequiredPermissions = params.requiredPermissions.map(toPlaywrightPermission);
  const canUsePlaywright =
    playwrightRequiredPermissions.every((value): value is string => Boolean(value)) &&
    params.requiredPermissions.length > 0;
  if (canUsePlaywright) {
    const pw = await permissionRouteDeps.getPwAiModule({ mode: "soft" });
    if (pw) {
      try {
        const page = await pw.getPageForTargetId({
          cdpUrl: params.profileCtx.profile.cdpUrl,
          targetId: params.targetId,
          ssrfPolicy: params.ssrfPolicy,
        });
        await page.context().grantPermissions(playwrightRequiredPermissions, {
          origin: params.origin,
        });
        return {
          grantedPermissions: params.requiredPermissions,
          unsupportedPermissions: params.optionalPermissions,
          grantMethod: "playwright",
        };
      } catch {
        params.signal.throwIfAborted();
        // Fall back to the raw CDP browser command below. Some routes call this
        // before a page exists, while attached browser profiles need Playwright.
      }
    }
  }
  params.signal.throwIfAborted();
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
  params.signal.throwIfAborted();
  return {
    grantedPermissions: allPermissions.filter((value) => !unsupportedPermissions.includes(value)),
    unsupportedPermissions,
    grantMethod: "cdp",
  };
}

function toPlaywrightPermission(permission: string): string | undefined {
  switch (permission) {
    case "audioCapture":
      return "microphone";
    case "videoCapture":
      return "camera";
    default:
      return undefined;
  }
}

/** Register permission grant endpoints on the browser control server. */
export function registerBrowserPermissionRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post(
    "/permissions/grant",
    asyncBrowserRoute(async (req, res) => {
      const body = (req.body ?? {}) as GrantPermissionsBody;
      const origin = readHttpOrigin(body.origin);
      if (!origin) {
        return jsonError(res, 400, "origin must be an http(s) origin");
      }
      const requiredPermissions = readPermissions(body.permissions);
      if (!requiredPermissions || requiredPermissions.length === 0) {
        return jsonError(res, 400, "permissions must be a non-empty string array");
      }
      const optionalPermissions = readPermissions(body.optionalPermissions ?? []) ?? [];
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      let timeoutMs: number;
      try {
        timeoutMs = readRouteTimerTimeoutMs(body.timeoutMs, "timeoutMs", { minMs: 1_000 }) ?? 5_000;
      } catch (err) {
        return jsonError(res, 400, formatErrorMessage(err));
      }

      const profileCtx = getProfileContext(req, ctx);
      if ("error" in profileCtx) {
        return jsonError(res, profileCtx.status, profileCtx.error);
      }

      try {
        const granted = await runProfileRouteOperation({
          profileCtx,
          signal: req.signal,
          run: async (signal) => {
            await profileCtx.ensureBrowserAvailable({ signal });
            const cdpPolicy = resolveCdpControlPolicy(
              profileCtx.profile,
              ctx.state().resolved.ssrfPolicy,
            );
            const wsUrl = await getChromeWebSocketUrl(
              profileCtx.profile.cdpUrl,
              timeoutMs,
              cdpPolicy,
            );
            signal.throwIfAborted();
            if (!wsUrl) {
              throw new BrowserProfileUnavailableError("browser CDP WebSocket unavailable");
            }
            return await grantPermissions({
              profileCtx,
              targetId,
              wsUrl,
              origin,
              requiredPermissions,
              optionalPermissions,
              timeoutMs,
              ssrfPolicy: cdpPolicy,
              signal,
            });
          },
        });
        return res.json({ ok: true, origin, ...granted });
      } catch (error) {
        if (isProfileRestartRequiredError(error)) {
          throw error;
        }
        const mapped = toBrowserErrorResponse(error);
        if (mapped) {
          return jsonBrowserError(res, mapped);
        }
        return jsonError(res, 500, error instanceof Error ? error.message : String(error));
      }
    }),
  );
}
export { testing as __testing };
