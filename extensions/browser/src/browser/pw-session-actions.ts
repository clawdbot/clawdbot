import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Browser, Page, Response } from "playwright-core";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import {
  appendCdpPath,
  assertCdpEndpointAllowed,
  fetchJson,
  normalizeCdpHttpBaseForJsonEndpoints,
  scopeCdpPolicyToConfiguredEndpoint,
  withCdpSocket,
} from "./cdp.helpers.js";
import { AX_REF_PATTERN, normalizeCdpWsUrl } from "./cdp.js";
import {
  withBrowserNavigationPolicy,
  assertBrowserNavigationAllowed,
  type BrowserNavigationPolicyOptions,
} from "./navigation-guard.js";
import {
  BlockedBrowserTargetError,
  clearBlockedPageRef,
  clearBlockedPageRefsForCdpUrl,
  clearBlockedTarget,
  clearBlockedTargetsForCdpUrl,
  closeTrackedPlaywrightConnection,
  connectBrowser,
  evictStalePlaywrightBrowserConnection,
  getAllPages,
  getPageForTargetId,
  isBlockedPageRef,
  isBlockedTarget,
  isRecoverablePlaywrightDisconnectError,
  pageTargetInfo,
  retirePlaywrightBrowserConnectionExact,
  takeCachedPlaywrightBrowserConnection,
  ensureContextState,
} from "./pw-session-connection.js";
import {
  cachedByCdpUrl,
  connectingByCdpUrl,
  pageStates,
  retainedClosingByCdpUrl,
  type BrowserObservedState,
} from "./pw-session-contracts.js";
import {
  assertPageNavigationCompletedSafely,
  closeBlockedNavigationTarget,
  gotoPageWithNavigationGuard,
  isPolicyDenyNavigationError,
} from "./pw-session-navigation.js";
import {
  ensurePageState,
  getObservedBrowserStateForPage,
  normalizeCdpUrl,
} from "./pw-session-state.js";
import {
  BROWSER_REF_MARKER_ATTRIBUTE,
  readMainFrameDocumentIdentityForPage,
} from "./pw-session.page-cdp.js";

export async function getObservedBrowserStateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<BrowserObservedState> {
  const page = await getPageForTargetId(opts);
  return getObservedBrowserStateForPage(page);
}

/** Resolve a page and read its current main-frame document identity. */
export async function getMainFrameDocumentIdentityViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<string | undefined> {
  const page = await getPageForTargetId(opts);
  return await readMainFrameDocumentIdentityForPage(page);
}

export function refLocator(page: Page, ref: string) {
  const normalized = ref.startsWith("@")
    ? ref.slice(1)
    : ref.startsWith("ref=")
      ? ref.slice(4)
      : ref;

  if (/^e\d+$/.test(normalized)) {
    const state = pageStates.get(page);
    if (state?.roleRefsMode === "aria") {
      const scope = state.roleRefsFrame ?? page;
      return scope.locator(`aria-ref=${normalized}`);
    }
    const info = state?.roleRefs?.[normalized];
    if (!info) {
      throw new Error(
        `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
      );
    }
    const scope = state?.roleRefsFrame ?? page;
    const locAny = scope as unknown as {
      getByRole: (
        role: never,
        opts?: { name?: string; exact?: boolean },
      ) => ReturnType<Page["getByRole"]>;
    };
    const locator = info.name
      ? locAny.getByRole(info.role as never, { name: info.name, exact: true })
      : locAny.getByRole(info.role as never);
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }

  if (AX_REF_PATTERN.test(normalized)) {
    const state = pageStates.get(page);
    const info = state?.roleRefs?.[normalized];
    if (!info) {
      throw new Error(
        `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
      );
    }
    const scope = state.roleRefsFrame ?? page;
    if (info.domMarker) {
      return scope.locator(`[${BROWSER_REF_MARKER_ATTRIBUTE}="${normalized}"]`);
    }
    const locAny = scope as unknown as {
      getByRole: (
        role: never,
        opts?: { name?: string; exact?: boolean },
      ) => ReturnType<Page["getByRole"]>;
    };
    const locator = info.name
      ? locAny.getByRole(info.role as never, { name: info.name, exact: true })
      : locAny.getByRole(info.role as never);
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }

  return page.locator(`aria-ref=${normalized}`);
}

/** Close one or all cached Playwright browser connections. */
export async function closePlaywrightBrowserConnection(opts?: { cdpUrl?: string }): Promise<void> {
  const normalized = opts?.cdpUrl ? normalizeCdpUrl(opts.cdpUrl) : null;

  if (normalized) {
    await retirePlaywrightBrowserConnectionExact({ cdpUrl: normalized }).close();
    return;
  }

  const cdpUrls = new Set([
    ...cachedByCdpUrl.keys(),
    ...connectingByCdpUrl.keys(),
    ...retainedClosingByCdpUrl.keys(),
  ]);
  clearBlockedTargetsForCdpUrl();
  clearBlockedPageRefsForCdpUrl();
  const results = await Promise.allSettled(
    [...cdpUrls].map(
      async (cdpUrl) => await retirePlaywrightBrowserConnectionExact({ cdpUrl }).close(),
    ),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) {
    throw failed.reason;
  }
}

function cdpSocketNeedsAttach(wsUrl: string): boolean {
  try {
    const pathname = new URL(wsUrl).pathname;
    return (
      pathname === "/cdp" || pathname.endsWith("/cdp") || pathname.includes("/devtools/browser/")
    );
  } catch {
    return false;
  }
}

async function tryTerminateExecutionViaCdp(opts: {
  cdpUrl: string;
  targetId: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<void> {
  await assertCdpEndpointAllowed(opts.cdpUrl, opts.ssrfPolicy);
  const cdpControlPolicy = scopeCdpPolicyToConfiguredEndpoint(opts.cdpUrl, opts.ssrfPolicy);
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(opts.cdpUrl);
  const listUrl = appendCdpPath(cdpHttpBase, "/json/list");

  const pages = await fetchJson<
    Array<{
      id?: string;
      webSocketDebuggerUrl?: string;
    }>
  >(listUrl, 2000, undefined, cdpControlPolicy).catch(() => null);
  if (!pages || pages.length === 0) {
    return;
  }

  const targetId = normalizeOptionalString(opts.targetId) ?? "";
  const target = pages.find((p) => normalizeOptionalString(p.id) === targetId);
  const wsUrlRaw = normalizeOptionalString(target?.webSocketDebuggerUrl) ?? "";
  if (!wsUrlRaw) {
    return;
  }
  const wsUrl = normalizeCdpWsUrl(wsUrlRaw, cdpHttpBase);
  const wsPin = await assertCdpEndpointAllowed(wsUrl, cdpControlPolicy, {
    source: "discovered",
    configuredUrl: opts.cdpUrl,
  });
  const needsAttach = cdpSocketNeedsAttach(wsUrl);

  const runWithTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("CDP command timed out")), ms);
    });
    try {
      return await Promise.race([work, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  await withCdpSocket(
    wsUrl,
    async (send) => {
      let sessionId: string | undefined;
      try {
        if (needsAttach) {
          const attached = (await runWithTimeout(
            send("Target.attachToTarget", { targetId: opts.targetId, flatten: true }),
            1500,
          )) as { sessionId?: unknown };
          const attachedSessionId = normalizeOptionalString(attached?.sessionId);
          if (attachedSessionId) {
            sessionId = attachedSessionId;
          }
        }
        await runWithTimeout(send("Runtime.terminateExecution", undefined, sessionId), 1500);
        if (sessionId) {
          // Best-effort cleanup; not required for termination to take effect.
          void send("Target.detachFromTarget", { sessionId }).catch(() => {});
        }
      } catch {
        // Best-effort; ignore
      }
    },
    { handshakeTimeoutMs: 2000, ...(wsPin?.lookup ? { lookup: wsPin.lookup } : {}) },
  ).catch(() => {});
}

/**
 * Best-effort cancellation for stuck page operations.
 *
 * Playwright serializes CDP commands per page; a long-running or stuck operation (notably evaluate)
 * can block all subsequent commands. We cannot safely "cancel" an individual command, and we do
 * not want to close the actual Chromium tab. Instead, we disconnect Playwright's CDP connection
 * so in-flight commands fail fast and the next request reconnects transparently.
 *
 * IMPORTANT: We CANNOT call Connection.close() because Playwright shares a single Connection
 * across all objects (BrowserType, Browser, etc.). Closing it corrupts the entire Playwright
 * instance, preventing reconnection.
 *
 * Instead we:
 * 1. Retire the scoped cached or in-flight connection so the next call reconnects
 * 2. Fire-and-forget browser.close() — it may hang but won't block us
 * 3. The next connectBrowser() creates a completely new CDP WebSocket connection
 *
 * The old browser.close() eventually resolves when the in-browser evaluate timeout fires,
 * or the old connection gets GC'd. Either way, it doesn't affect the fresh connection.
 */
/** Force-disconnect a Playwright connection to unblock a stuck target operation. */
export async function forceDisconnectPlaywrightForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  reason?: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<void> {
  const normalized = normalizeCdpUrl(opts.cdpUrl);
  const cur = takeCachedPlaywrightBrowserConnection(normalized);
  if (!cur) {
    return;
  }

  // Best-effort: kill any stuck JS to unblock the target's execution context before we
  // disconnect Playwright's CDP connection.
  const targetId = normalizeOptionalString(opts.targetId) ?? "";
  if (targetId) {
    await tryTerminateExecutionViaCdp({
      cdpUrl: normalized,
      targetId,
      ssrfPolicy: opts.ssrfPolicy,
    }).catch(() => {});
  }

  // Fire-and-forget: don't await because browser.close() may hang on the stuck CDP pipe.
  void closeTrackedPlaywrightConnection(cur).catch(() => {});
}

async function withPlaywrightSafeReadReconnect<T>(
  opts: {
    cdpUrl: string;
    ssrfPolicy?: SsrFPolicy;
    attempt?: { cancelled: boolean };
  },
  run: (browser: Browser) => Promise<T>,
): Promise<T> {
  const connected = await connectBrowser(opts.cdpUrl, opts.ssrfPolicy);
  try {
    return await run(connected.browser);
  } catch (err) {
    if (!isRecoverablePlaywrightDisconnectError(err) || opts.attempt?.cancelled) {
      throw err;
    }
    evictStalePlaywrightBrowserConnection(opts.cdpUrl, connected.browser);
    if (opts.attempt?.cancelled) {
      throw err;
    }
    const retry = await connectBrowser(opts.cdpUrl, opts.ssrfPolicy);
    return await run(retry.browser);
  }
}

async function readPagesViaPlaywright(
  opts: { cdpUrl: string; ssrfPolicy?: SsrFPolicy },
  attempt?: { cancelled: boolean },
): Promise<
  Array<{
    targetId: string;
    title: string;
    url: string;
    type: string;
  }>
> {
  return await withPlaywrightSafeReadReconnect(
    { cdpUrl: opts.cdpUrl, ssrfPolicy: opts.ssrfPolicy, attempt },
    async (browser) => {
      const pages = await getAllPages(browser);
      const candidatePages = pages.filter((page) => !isBlockedPageRef(opts.cdpUrl, page));
      const pageResults = await Promise.all(
        candidatePages.map(async (page) => {
          let targetInfo: Awaited<ReturnType<typeof pageTargetInfo>>;
          try {
            targetInfo = await pageTargetInfo(page);
          } catch (err) {
            if (isRecoverablePlaywrightDisconnectError(err)) {
              throw err;
            }
            targetInfo = null;
          }
          if (!targetInfo || isBlockedTarget(opts.cdpUrl, targetInfo.targetId)) {
            return null;
          }
          let url = "";
          try {
            url = page.url();
          } catch (err) {
            if (isRecoverablePlaywrightDisconnectError(err)) {
              throw err;
            }
          }
          return {
            targetId: targetInfo.targetId,
            title: targetInfo.title,
            url,
            type: "page",
          };
        }),
      );
      // Promise.all preserves candidate order and still propagates recoverable disconnects
      // to the outer reconnect path when any per-page task rejects.
      return pageResults.filter((result) => result !== null);
    },
  );
}

/**
 * List all pages/tabs from the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/list is ephemeral.
 */
/** List pages through the persistent Playwright connection. */
export async function listPagesViaPlaywright(opts: {
  cdpUrl: string;
  ssrfPolicy?: SsrFPolicy;
  timeoutMs?: number;
}) {
  const timeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(1, Math.floor(opts.timeoutMs))
      : undefined;
  if (timeoutMs === undefined) {
    return await readPagesViaPlaywright(opts);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: Error | undefined;
  const attempt = { cancelled: false };
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      attempt.cancelled = true;
      timeoutError = new Error(`Playwright page enumeration timed out after ${timeoutMs}ms`);
      reject(timeoutError);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([readPagesViaPlaywright(opts, attempt), timeout]);
  } catch (err) {
    if (err === timeoutError) {
      await forceDisconnectPlaywrightForTarget({
        cdpUrl: opts.cdpUrl,
        ssrfPolicy: opts.ssrfPolicy,
        reason: "Playwright page enumeration",
      }).catch(() => {});
    }
    throw err;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Create a new page/tab using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/new is ephemeral.
 * Returns the new page's targetId and metadata.
 */
/** Create and optionally navigate a page through Playwright. */
export async function createPageViaPlaywright(
  opts: {
    cdpUrl: string;
    url: string;
    cdpPolicy?: SsrFPolicy;
  } & BrowserNavigationPolicyOptions,
): Promise<{
  targetId: string;
  title: string;
  url: string;
  type: string;
}> {
  const { browser } = await connectBrowser(opts.cdpUrl, opts.cdpPolicy ?? opts.ssrfPolicy);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  ensureContextState(context);

  const page = await context.newPage();
  ensurePageState(page);
  clearBlockedPageRef(opts.cdpUrl, page);
  const createdTargetId = (await pageTargetInfo(page).catch(() => null))?.targetId ?? null;
  clearBlockedTarget(opts.cdpUrl, createdTargetId ?? undefined);

  // Navigate to the URL
  const targetUrl = opts.url.trim() || "about:blank";
  if (targetUrl !== "about:blank") {
    const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, {
      browserProxyMode: opts.browserProxyMode,
    });
    await assertBrowserNavigationAllowed({
      url: targetUrl,
      ...navigationPolicy,
    });
    let response: Response | null = null;
    try {
      response = await gotoPageWithNavigationGuard({
        cdpUrl: opts.cdpUrl,
        page,
        url: targetUrl,
        timeoutMs: 30_000,
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
        targetId: createdTargetId ?? undefined,
      });
    } catch (err) {
      if (isPolicyDenyNavigationError(err) || err instanceof BlockedBrowserTargetError) {
        throw err;
      }
    }
    // OpenClaw owns this newly-created tab: if the post-navigation safety
    // check trips, close the tab we just spawned.
    try {
      await assertPageNavigationCompletedSafely({
        cdpUrl: opts.cdpUrl,
        page,
        response,
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
        targetId: createdTargetId ?? undefined,
      });
    } catch (err) {
      if (isPolicyDenyNavigationError(err)) {
        await closeBlockedNavigationTarget({
          cdpUrl: opts.cdpUrl,
          page,
          targetId: createdTargetId ?? undefined,
        });
      }
      throw err;
    }
  }

  // Get the targetId for this page
  const tid = createdTargetId ?? (await pageTargetInfo(page).catch(() => null))?.targetId ?? null;
  if (!tid) {
    throw new Error("Failed to get targetId for new page");
  }

  return {
    targetId: tid,
    title: await page.title().catch(() => ""),
    url: page.url(),
    type: "page",
  };
}

/**
 * Close a page/tab by targetId using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/close is ephemeral.
 */
export async function closePageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  await page.close();
}

/**
 * Focus a page/tab by targetId using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/activate can be ephemeral.
 */
export async function focusPageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  await page.bringToFront();
}
