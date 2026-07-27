/** Browser page-content capture route for the extract action. */
import {
  BROWSER_EXTRACT_MAX_HTML_CHARS,
  DEFAULT_BROWSER_EXTRACT_TIMEOUT_MS,
  MAX_BROWSER_EXTRACT_TIMEOUT_MS,
  MIN_BROWSER_EXTRACT_TIMEOUT_MS,
} from "../constants.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserRouteContext } from "../server-context.js";
import { readBody, resolveProfileContext, withPlaywrightRouteContext } from "./agent.shared.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { readRoutePositiveInteger } from "./route-numeric.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toStringOrEmpty } from "./utils.js";

function resolveExtractTimeoutMs(value: unknown): number {
  const requested = readRoutePositiveInteger(value, "timeoutMs");
  return Math.max(
    MIN_BROWSER_EXTRACT_TIMEOUT_MS,
    Math.min(MAX_BROWSER_EXTRACT_TIMEOUT_MS, requested ?? DEFAULT_BROWSER_EXTRACT_TIMEOUT_MS),
  );
}

function formatExtractCaptureError(params: {
  error: "invalid_selector" | "selector_not_found";
  selector?: string;
}): string {
  if (params.error === "invalid_selector") {
    return "One or more CSS selectors are invalid; check selector and ignoreSelectors and try again.";
  }
  return params.selector
    ? `CSS selector ${JSON.stringify(params.selector)} matched no usable elements; check selector and ignoreSelectors, or omit selector to extract the whole page.`
    : "ignoreSelectors removed all captured page content; adjust ignoreSelectors and try again.";
}

/** Register the Playwright-only page-content capture endpoint. */
export function registerBrowserExtractRoute(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  app.post("/extract", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const selector = toStringOrEmpty(body.selector) || undefined;
    const ignoreSelectors = Array.isArray(body.ignoreSelectors)
      ? body.ignoreSelectors.filter((value): value is string => typeof value === "string")
      : [];
    let timeoutMs: number;
    try {
      timeoutMs = resolveExtractTimeoutMs(body.timeoutMs);
    } catch (err) {
      return jsonError(res, 400, String(err instanceof Error ? err.message : err));
    }
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
      return jsonError(res, 501, EXISTING_SESSION_LIMITS.extract);
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const routeSignal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;
    await withPlaywrightRouteContext({
      req: { ...req, signal: routeSignal },
      res,
      ctx,
      profileCtx,
      targetId,
      feature: "extract",
      enforceCurrentUrlAllowed: true,
      run: async ({ cdpUrl, tab, signal, resolveTabUrl, pw }) => {
        const captured = await pw.pageContentViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          ssrfPolicy: ctx.state().resolved.ssrfPolicy,
          signal,
          selector,
          ignoreSelectors,
        });
        const url = (await resolveTabUrl(tab.url)) ?? tab.url;
        if (!captured.ok) {
          return res.json({
            ...captured,
            message: formatExtractCaptureError({ error: captured.error, selector }),
            targetId: tab.targetId,
            url,
          });
        }
        const { html } = captured;
        if (html.length > BROWSER_EXTRACT_MAX_HTML_CHARS) {
          return jsonError(
            res,
            413,
            `page HTML exceeds the ${BROWSER_EXTRACT_MAX_HTML_CHARS} character extraction limit; use snapshot instead.`,
          );
        }
        res.json({ ok: true, targetId: tab.targetId, url, html });
      },
    });
  });
}
