/**
 * Shared browser route helpers.
 *
 * Centralizes body/query parsing, profile resolution, error mapping, Playwright
 * availability checks, and tab-context guards for route modules.
 */
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveBrowserNavigationProxyMode } from "../browser-proxy-mode.js";
import { redactCdpErrorText } from "../cdp.helpers.js";
import { toBrowserErrorResponse } from "../errors.js";
import {
  assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy,
} from "../navigation-guard.js";
import type { PwAiModule } from "../pw-ai-module.js";
import { getPwAiModule as getPwAiModuleBase } from "../pw-ai-module.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import type { BrowserRequest, BrowserResponse } from "./types.js";
import { getProfileContext, jsonBrowserError, jsonError } from "./utils.js";

export const SELECTOR_UNSUPPORTED_MESSAGE = [
  "Error: 'selector' is not supported. Use 'ref' from snapshot instead.",
  "",
  "Example workflow:",
  "1. snapshot action to get page state with refs",
  '2. act with ref: "e123" to interact with element',
  "",
  "This is more reliable for modern SPAs.",
].join("\n");

/** Return a safe object body for routes that accept JSON payloads. */
export function readBody(req: BrowserRequest): Record<string, unknown> {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return body;
}

/** Read an optional targetId from a request body. */
export function resolveTargetIdFromBody(body: Record<string, unknown>): string | undefined {
  const targetId = normalizeOptionalString(body.targetId) ?? "";
  return targetId || undefined;
}

/** Read an optional targetId from a query object. */
export function resolveTargetIdFromQuery(query: Record<string, unknown>): string | undefined {
  const targetId = normalizeOptionalString(query.targetId) ?? "";
  return targetId || undefined;
}

/** Map route-level browser errors to HTTP JSON responses. */
export function handleRouteError(ctx: BrowserRouteContext, res: BrowserResponse, err: unknown) {
  const mapped = ctx.mapTabError(err);
  if (mapped) {
    return jsonBrowserError(res, mapped);
  }
  const browserMapped = toBrowserErrorResponse(err);
  if (browserMapped) {
    return jsonBrowserError(res, browserMapped);
  }
  jsonError(res, 500, redactCdpErrorText(String(err)));
}

/** Resolve the requested browser profile and respond with JSON on failure. */
export function resolveProfileContext(
  req: BrowserRequest,
  res: BrowserResponse,
  ctx: BrowserRouteContext,
): ProfileContext | null {
  const profileCtx = getProfileContext(req, ctx);
  if ("error" in profileCtx) {
    jsonError(res, profileCtx.status, profileCtx.error);
    return null;
  }
  return profileCtx;
}

/** Build navigation guard policy for a profile and current resolved config. */
export function browserNavigationPolicyForProfile(
  ctx: BrowserRouteContext,
  profileCtx: ProfileContext,
) {
  return withBrowserNavigationPolicy(ctx.state().resolved.ssrfPolicy, {
    browserProxyMode: resolveBrowserNavigationProxyMode({
      resolved: ctx.state().resolved,
      profile: profileCtx.profile,
    }),
  });
}

/** Load the optional Playwright bridge module in soft-fail mode. */
export async function getPwAiModule(): Promise<PwAiModule | null> {
  return await getPwAiModuleBase({ mode: "soft" });
}

/** Require Playwright support for a route feature, returning a 501 when absent. */
export async function requirePwAi(
  res: BrowserResponse,
  feature: string,
): Promise<PwAiModule | null> {
  const mod = await getPwAiModule();
  if (mod) {
    return mod;
  }
  jsonError(
    res,
    501,
    [
      `Playwright is not available in this gateway build; '${feature}' is unsupported.`,
      "Reinstall or update OpenClaw so the core browser runtime dependency is present, then restart the gateway. In Docker, also install Chromium with the bundled playwright-core CLI.",
      "Docs: /tools/browser-control#playwright-requirement",
    ].join("\n"),
  );
  return null;
}

type RouteTabContext = {
  profileCtx: ProfileContext;
  tab: Awaited<ReturnType<ProfileContext["ensureTabAvailable"]>>;
  cdpUrl: string;
  resolveTabUrl: (fallbackUrl?: string) => Promise<string | undefined>;
};

type RouteTabPwContext = RouteTabContext & {
  pw: PwAiModule;
};

type RouteWithTabParams<T> = {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  targetId?: string;
  /**
   * Set for routes that read from or return data scoped to the selected tab.
   * Leave false only for routes that navigate, activate, close, or otherwise manage the tab.
   */
  enforceCurrentUrlAllowed?: boolean;
  run: (ctx: RouteTabContext) => Promise<T>;
};

/** Resolve profile and tab context, optionally enforcing current URL policy. */
export async function withRouteTabContext<T>(
  params: RouteWithTabParams<T>,
): Promise<T | undefined> {
  const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
  if (!profileCtx) {
    return undefined;
  }
  try {
    // Agent routes can address local-managed tabs through Playwright when per-tab WS discovery lags.
    const tab = await profileCtx.ensureTabAvailable(params.targetId, {
      allowPlaywrightFallback: true,
      signal: params.req.signal,
      timeoutMs: params.ctx.state().resolved.actionTimeoutMs,
    });
    if (params.enforceCurrentUrlAllowed) {
      await assertBrowserNavigationResultAllowed({
        url: tab.url,
        ...browserNavigationPolicyForProfile(params.ctx, profileCtx),
      });
    }
    return await params.run({
      profileCtx,
      tab,
      cdpUrl: profileCtx.profile.cdpUrl,
      resolveTabUrl: (fallbackUrl?: string) =>
        resolveSafeRouteTabUrl({
          ctx: params.ctx,
          profileCtx,
          targetId: tab.targetId,
          fallbackUrl,
          signal: params.req.signal,
          timeoutMs: params.ctx.state().resolved.actionTimeoutMs,
        }),
    });
  } catch (err) {
    handleRouteError(params.ctx, params.res, err);
    return undefined;
  }
}

/**
 * Response-only URL redaction. This swallows policy failures and must not be used as
 * an execution gate; use enforceCurrentUrlAllowed on the route helper instead.
 */
export async function resolveSafeRouteTabUrl(params: {
  ctx: BrowserRouteContext;
  profileCtx: ProfileContext;
  targetId: string;
  fallbackUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string | undefined> {
  let tabs: Array<{ targetId: string; url: string }>;
  try {
    tabs = await params.profileCtx.listTabs({ signal: params.signal, timeoutMs: params.timeoutMs });
  } catch {
    params.signal?.throwIfAborted();
    tabs = [];
  }
  const candidateUrl =
    tabs.find((tab) => tab.targetId === params.targetId)?.url ?? params.fallbackUrl;
  if (!candidateUrl) {
    return undefined;
  }
  try {
    await assertBrowserNavigationResultAllowed({
      url: candidateUrl,
      ...browserNavigationPolicyForProfile(params.ctx, params.profileCtx),
    });
    return candidateUrl;
  } catch {
    return undefined;
  }
}

type RouteWithPwParams<T> = {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  targetId?: string;
  feature: string;
  /**
   * Set for routes that read from or return data scoped to the selected tab.
   * Leave false only for routes that navigate, activate, close, or otherwise manage the tab.
   */
  enforceCurrentUrlAllowed?: boolean;
  run: (ctx: RouteTabPwContext) => Promise<T>;
};

/** Resolve profile, tab, and Playwright context for Playwright-only routes. */
export async function withPlaywrightRouteContext<T>(
  params: RouteWithPwParams<T>,
): Promise<T | undefined> {
  return await withRouteTabContext({
    req: params.req,
    res: params.res,
    ctx: params.ctx,
    targetId: params.targetId,
    enforceCurrentUrlAllowed: params.enforceCurrentUrlAllowed,
    run: async ({ profileCtx, tab, cdpUrl, resolveTabUrl }) => {
      const pw = await requirePwAi(params.res, params.feature);
      if (!pw) {
        return undefined as T | undefined;
      }
      return await params.run({ profileCtx, tab, cdpUrl, resolveTabUrl, pw });
    },
  });
}
