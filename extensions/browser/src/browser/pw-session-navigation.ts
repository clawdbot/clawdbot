import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Page, Request, Response, Route } from "playwright-core";
import { toErrorObject } from "../infra/errors.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  InvalidBrowserNavigationUrlError,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { markPageRefBlocked, markTargetBlocked, pageTargetId } from "./pw-session-connection.js";

type BrowserDocumentNavigationRequestKind = "top-level" | "subframe";

/** Classify requests that can navigate the selected page or one of its frames. */
function classifyBrowserDocumentNavigationRequest(
  page: Page,
  request: Request,
): BrowserDocumentNavigationRequestKind | null {
  let kind: BrowserDocumentNavigationRequestKind;
  let frameResolutionFailed = false;
  try {
    kind = request.frame() === page.mainFrame() ? "top-level" : "subframe";
  } catch {
    // Preserve the navigate-owner fail-closed contract during renderer churn:
    // an unresolved document request may be the selected main frame.
    kind = "top-level";
    frameResolutionFailed = true;
  }

  try {
    if (request.isNavigationRequest()) {
      return kind;
    }
  } catch {
    // Fall through to the resource-type check.
  }

  try {
    if (request.resourceType() === "document") {
      return kind;
    }
  } catch {
    // Fall through to the unresolved-frame result below.
  }
  // Match the previous two-step classifier: known non-doc requests fall
  // through, while an unresolved frame remains guarded as a subframe.
  return frameResolutionFailed ? "subframe" : null;
}

/** Return true when an error is a browser navigation policy denial. */
export function isPolicyDenyNavigationError(err: unknown): boolean {
  return err instanceof SsrFBlockedError || err instanceof InvalidBrowserNavigationUrlError;
}

// Mark a page (and its CDP target id when resolvable) as blocked so subsequent
// OpenClaw operations short-circuit instead of re-running the SSRF check on a
// page we have already proven is non-compliant. This is a pure bookkeeping
// step; it does NOT close the tab. Read-only paths can call this safely on a
// user-owned tab without losing the user's content.
export async function quarantineBlockedNavigationTarget(opts: {
  cdpUrl: string;
  page: Page;
  targetId?: string;
}): Promise<void> {
  markPageRefBlocked(opts.cdpUrl, opts.page);
  const resolvedTargetId = await pageTargetId(opts.page).catch(() => null);
  const fallbackTargetId = normalizeOptionalString(opts.targetId) ?? "";
  const targetIdToBlock = resolvedTargetId || fallbackTargetId;
  if (targetIdToBlock) {
    markTargetBlocked(opts.cdpUrl, targetIdToBlock);
  }
}

// Quarantine and close a tab that OpenClaw itself navigated to a blocked URL.
// Only callers that own the navigation lifecycle (gotoPageWithNavigationGuard
// and the navigate-style entry points that wrap it) may invoke this — closing
// a tab is a destructive action that must not happen on user-owned tabs from
// read-only operations like snapshot/screenshot/interactions.
/** Quarantine and close a tab that OpenClaw navigated to a blocked URL. */
export async function closeBlockedNavigationTarget(opts: {
  cdpUrl: string;
  page: Page;
  targetId?: string;
}): Promise<void> {
  await quarantineBlockedNavigationTarget(opts);
  await opts.page.close().catch(() => {});
}

// On policy denial: quarantines and rethrows (never closes).
// Navigate-style callers catch the rethrow and close via closeBlockedNavigationTarget.
/** Validate a completed page navigation and quarantine policy-denied targets. */
export async function assertPageNavigationCompletedSafely(
  opts: {
    cdpUrl: string;
    page: Page;
    response: Response | null;
    targetId?: string;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: opts.browserProxyMode,
  });
  try {
    await assertBrowserNavigationRedirectChainAllowed({
      request: opts.response?.request(),
      ...navigationPolicy,
    });
    await assertBrowserNavigationResultAllowed({
      url: opts.page.url(),
      ...navigationPolicy,
    });
  } catch (err) {
    if (isPolicyDenyNavigationError(err)) {
      await quarantineBlockedNavigationTarget({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        targetId: opts.targetId,
      });
    }
    throw err;
  }
}

async function continueRouteSafely(route: Route): Promise<void> {
  try {
    await route.continue();
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("Route is already handled")) {
      return;
    }
    throw err;
  }
}

async function fallbackRouteSafely(route: Route): Promise<void> {
  try {
    await route.fallback();
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("Route is already handled")) {
      return;
    }
    throw err;
  }
}

const sourcePreservedPolicyDenials = new WeakSet<object>();

async function removePageNavigationRequestGuard(
  page: Page,
  handler: (route: Route, request: Request) => Promise<void>,
): Promise<unknown> {
  try {
    await page.unroute("**", handler);
  } catch (err) {
    // A closed page owns no remaining route. Preserve close-triggering actions,
    // but surface cleanup failures while the page is still usable.
    try {
      if (page.isClosed()) {
        return undefined;
      }
    } catch {
      // Keep the original cleanup failure when page state is unavailable.
    }
    return err;
  }
  return undefined;
}

/** Return true when policy denial left the selected page on its source document. */
export function wasBrowserNavigationSourcePreservedAfterPolicyDenial(err: unknown): boolean {
  return typeof err === "object" && err !== null && sourcePreservedPolicyDenials.has(err);
}

/** Run one selected-page action while guarding document requests. */
export async function withPageNavigationRequestGuard<T>(
  opts: {
    action: (baselineUrl: string) => Promise<T>;
    onPolicyCheckStarted?: (check: Promise<void>) => void;
    onPolicyDenied?: (
      event:
        | { state: "detected"; error: unknown }
        | { state: "handled"; error: unknown; sourcePreserved: boolean },
    ) => void;
    page: Page;
  } & BrowserNavigationPolicyOptions,
): Promise<T> {
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: opts.browserProxyMode,
  });
  if (!navigationPolicy.ssrfPolicy && !navigationPolicy.browserProxyMode) {
    return await opts.action(opts.page.url());
  }

  const inFlight = new Set<Promise<void>>();
  let hasGuardError = false;
  let firstGuardError: unknown;
  let deniedDocumentCount = 0;
  let fulfilledDeniedDocumentCount = 0;
  let pendingDeniedDocumentCount = 0;
  let unpreservedDocumentCount = 0;
  let policyDeniedDetected = false;
  let lastNotifiedSourcePreserved: boolean | undefined;

  const recordGuardError = (err: unknown) => {
    if (hasGuardError) {
      if (!isPolicyDenyNavigationError(firstGuardError) && isPolicyDenyNavigationError(err)) {
        firstGuardError = err;
      }
      return;
    }
    hasGuardError = true;
    firstGuardError = err;
  };
  const emitPolicyDenied = (
    event:
      | { state: "detected"; error: unknown }
      | { state: "handled"; error: unknown; sourcePreserved: boolean },
  ) => {
    try {
      opts.onPolicyDenied?.(event);
    } catch {
      // Notification only exposes state already owned by this guard.
    }
  };
  const updateImmediateSourcePreservation = () => {
    if (typeof firstGuardError !== "object" || firstGuardError === null) {
      return;
    }
    let sourcePreserved: boolean | undefined;
    if (unpreservedDocumentCount > 0) {
      sourcePreserved = false;
    } else if (
      isPolicyDenyNavigationError(firstGuardError) &&
      deniedDocumentCount > 0 &&
      pendingDeniedDocumentCount === 0 &&
      fulfilledDeniedDocumentCount === deniedDocumentCount
    ) {
      sourcePreserved = true;
    }
    if (sourcePreserved === undefined) {
      sourcePreservedPolicyDenials.delete(firstGuardError);
      return;
    }
    if (sourcePreserved) {
      sourcePreservedPolicyDenials.add(firstGuardError);
    } else {
      sourcePreservedPolicyDenials.delete(firstGuardError);
    }
    if (policyDeniedDetected && sourcePreserved !== lastNotifiedSourcePreserved) {
      lastNotifiedSourcePreserved = sourcePreserved;
      emitPolicyDenied({ state: "handled", error: firstGuardError, sourcePreserved });
    }
  };
  const notifyPolicyDeniedDetected = () => {
    if (policyDeniedDetected || !isPolicyDenyNavigationError(firstGuardError)) {
      return;
    }
    policyDeniedDetected = true;
    emitPolicyDenied({ state: "detected", error: firstGuardError });
  };
  const stopGuardedRoute = async (
    route: Route,
    preserveDocument: boolean,
    requestError: unknown,
  ) => {
    if (preserveDocument && isPolicyDenyNavigationError(requestError)) {
      deniedDocumentCount += 1;
      pendingDeniedDocumentCount += 1;
      try {
        // A synthetic 204 stops the document load while Chromium keeps the
        // selected page's current document. route.abort() commits an error page.
        await route.fulfill({ status: 204, body: "" });
        fulfilledDeniedDocumentCount += 1;
        pendingDeniedDocumentCount -= 1;
        updateImmediateSourcePreservation();
        return;
      } catch {
        pendingDeniedDocumentCount -= 1;
        // Abort still stops the document load, but the source may no longer be usable.
      }
    }
    if (preserveDocument) {
      unpreservedDocumentCount += 1;
      updateImmediateSourcePreservation();
    }
    await route.abort().catch(() => {});
  };
  const handleRoute = async (route: Route, request: Request) => {
    if (!classifyBrowserDocumentNavigationRequest(opts.page, request)) {
      try {
        await fallbackRouteSafely(route);
      } catch (err) {
        recordGuardError(err);
        await stopGuardedRoute(route, false, err);
      }
      return;
    }
    const policyCheck = assertBrowserNavigationAllowed({
      url: request.url(),
      ...navigationPolicy,
    });
    try {
      opts.onPolicyCheckStarted?.(policyCheck);
    } catch {
      // Observation cannot change the policy decision owned by this guard.
    }
    try {
      await policyCheck;
    } catch (err) {
      recordGuardError(err);
      notifyPolicyDeniedDetected();
      await stopGuardedRoute(route, true, err);
      return;
    }
    try {
      await fallbackRouteSafely(route);
    } catch (err) {
      recordGuardError(err);
      await stopGuardedRoute(route, true, err);
    }
  };
  const handler = (route: Route, request: Request) => {
    const operation = handleRoute(route, request).catch(async (err: unknown) => {
      recordGuardError(err);
      await stopGuardedRoute(route, true, err);
    });
    inFlight.add(operation);
    void operation.finally(() => inFlight.delete(operation));
    return operation;
  };

  try {
    await opts.page.route("**", handler);
  } catch (err) {
    // Playwright can register the client handler before browser-side setup
    // rejects, so roll back that exact handler even on setup failure.
    await removePageNavigationRequestGuard(opts.page, handler);
    throw err;
  }

  let result: T | undefined;
  let actionFailed = false;
  let actionError: unknown;
  try {
    let baselineUrl = opts.page.url();
    await assertBrowserNavigationResultAllowed({ url: baselineUrl, ...navigationPolicy });
    const latestUrl = opts.page.url();
    if (latestUrl !== baselineUrl) {
      // The route is already installed, so any later document request remains
      // intercepted. Revalidate the one URL that could commit during preflight.
      await assertBrowserNavigationResultAllowed({ url: latestUrl, ...navigationPolicy });
      baselineUrl = latestUrl;
    }
    result = await opts.action(baselineUrl);
  } catch (err) {
    actionFailed = true;
    actionError = err;
    if (isPolicyDenyNavigationError(err)) {
      // Preflight/postflight policy errors describe committed or otherwise
      // unpreserved state. Notify before cleanup can stall on active routes.
      recordGuardError(err);
      notifyPolicyDeniedDetected();
      unpreservedDocumentCount += 1;
      updateImmediateSourcePreservation();
    }
  }

  // Remove admission first so a busy page cannot add work indefinitely. Active
  // RouteHandler callbacks retain their exact invocation and are drained below.
  const cleanupError = await removePageNavigationRequestGuard(opts.page, handler);
  while (inFlight.size > 0) {
    await Promise.allSettled(inFlight);
  }

  // Request-policy denial wins over locator/action/cleanup errors. Only 204
  // responses prove that every denied document was intercepted and source-preserved.
  if (hasGuardError) {
    const sourcePreserved =
      isPolicyDenyNavigationError(firstGuardError) &&
      deniedDocumentCount > 0 &&
      fulfilledDeniedDocumentCount === deniedDocumentCount &&
      unpreservedDocumentCount === 0 &&
      !(actionFailed && isPolicyDenyNavigationError(actionError)) &&
      typeof firstGuardError === "object" &&
      firstGuardError !== null;
    if (typeof firstGuardError === "object" && firstGuardError !== null) {
      if (sourcePreserved) {
        sourcePreservedPolicyDenials.add(firstGuardError);
      } else {
        sourcePreservedPolicyDenials.delete(firstGuardError);
      }
    }
    throw toErrorObject(firstGuardError, "Non-Error thrown");
  }
  if (actionFailed) {
    throw toErrorObject(actionError, "Non-Error thrown");
  }
  if (cleanupError !== undefined) {
    throw toErrorObject(cleanupError, "Non-Error thrown");
  }
  return result as T;
}

/** Navigate a page while guarding requested URL and redirect chain. */
export async function gotoPageWithNavigationGuard(
  opts: {
    cdpUrl: string;
    page: Page;
    url: string;
    timeoutMs: number;
    targetId?: string;
  } & BrowserNavigationPolicyOptions,
): Promise<Response | null> {
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: opts.browserProxyMode,
  });
  let blockedError: unknown = null;

  const handler = async (route: Route, request: Request) => {
    if (blockedError) {
      await route.abort().catch(() => {});
      return;
    }
    const requestKind = classifyBrowserDocumentNavigationRequest(opts.page, request);
    if (!requestKind) {
      await continueRouteSafely(route);
      return;
    }
    try {
      await assertBrowserNavigationAllowed({
        url: request.url(),
        ...navigationPolicy,
      });
    } catch (err) {
      if (isPolicyDenyNavigationError(err)) {
        if (requestKind === "top-level") {
          blockedError = err;
        }
        await route.abort().catch(() => {});
        return;
      }
      throw err;
    }
    await continueRouteSafely(route);
  };

  try {
    await opts.page.route("**", handler);
  } catch (err) {
    // Playwright registers the client route before browser-side setup can fail.
    // Remove this exact handler without replacing the original setup error.
    await removePageNavigationRequestGuard(opts.page, handler);
    throw err;
  }
  let response: Response | null = null;
  let navigationFailed = false;
  let navigationError: unknown;
  try {
    response = await opts.page.goto(opts.url, { timeout: opts.timeoutMs });
  } catch (err) {
    navigationFailed = true;
    navigationError = err;
  }

  const cleanupError = await removePageNavigationRequestGuard(opts.page, handler);
  if (blockedError) {
    await closeBlockedNavigationTarget({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      targetId: opts.targetId,
    });
    throw toErrorObject(blockedError, "Non-Error thrown");
  }
  // A live-page cleanup failure is observable, but the original navigation
  // error owns the result and must not lose its precedence.
  if (navigationFailed) {
    throw navigationError;
  }
  if (cleanupError !== undefined) {
    throw toErrorObject(cleanupError, "Non-Error thrown");
  }
  return response;
}

/** Resolve a browser snapshot ref into a Playwright locator. */
