import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { formatErrorMessage, toErrorObject } from "../infra/errors.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { withManagedProxyForCdpUrl, withNoProxyForCdpUrl } from "./cdp-proxy-bypass.js";
import { PLAYWRIGHT_TARGET_INFO_TIMEOUT_MS } from "./cdp-timeouts.js";
import {
  assertCdpEndpointAllowed,
  getHeadersWithAuth,
  isWebSocketUrl,
  redactCdpErrorText,
  stripCdpUrlCredentials,
} from "./cdp.helpers.js";
import { getChromeWebSocketUrl } from "./chrome.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { playwrightCore } from "./playwright-core.runtime.js";
import {
  blockedPageRefsByCdpUrl,
  blockedTargetsByCdpUrl,
  cachedByCdpUrl,
  closeConnectionPromises,
  closedConnections,
  connectingByCdpUrl,
  contextStates,
  observedContexts,
  PLAYWRIGHT_CONNECTION_CLOSE_TIMEOUT_MS,
  retainedClosingByCdpUrl,
  type ConnectedBrowser,
  type ContextState,
  type PendingBrowserConnection,
  type PlaywrightConnectionRetirement,
} from "./pw-session-contracts.js";
import {
  bindRoleRefsTarget,
  ensurePageState,
  normalizeCdpUrl,
  targetKey,
} from "./pw-session-state.js";
import { withPlaywrightPageCdpSession } from "./pw-session.page-cdp.js";

const { chromium } = playwrightCore;

function resolveCdpConnectRetryDelayMs(attempt: number): number {
  return 250 + attempt * 250;
}

function hasCachedPlaywrightBrowserConnection(cdpUrl: string): boolean {
  return cachedByCdpUrl.has(normalizeCdpUrl(cdpUrl));
}

export function isRecoverablePlaywrightDisconnectError(err: unknown): boolean {
  const message = formatErrorMessage(err).toLowerCase();
  return (
    message.includes("target page, context or browser has been closed") ||
    message.includes("browser has been closed") ||
    message.includes("browser disconnected") ||
    message.includes("target closed") ||
    message.includes("connection closed") ||
    message.includes("websocket closed") ||
    message.includes("cdp socket closed")
  );
}

function isRecoverableStalePageSelectionError(err: unknown, reusedCachedBrowser: boolean): boolean {
  if (!reusedCachedBrowser) {
    return false;
  }
  if (
    err instanceof Error &&
    err.message.includes("No pages available in the connected browser.")
  ) {
    return true;
  }
  if (err instanceof BrowserTabNotFoundError) {
    return true;
  }
  const message = err instanceof Error ? err.message : formatErrorMessage(err);
  return message.toLowerCase().includes("tab not found");
}

export function isBlockedTarget(cdpUrl: string, targetId?: string): boolean {
  const normalizedTargetId = normalizeOptionalString(targetId) ?? "";
  if (!normalizedTargetId) {
    return false;
  }
  return blockedTargetsByCdpUrl.has(targetKey(cdpUrl, normalizedTargetId));
}

export function markTargetBlocked(cdpUrl: string, targetId?: string): void {
  const normalizedTargetId = normalizeOptionalString(targetId) ?? "";
  if (!normalizedTargetId) {
    return;
  }
  blockedTargetsByCdpUrl.add(targetKey(cdpUrl, normalizedTargetId));
}

export function clearBlockedTarget(cdpUrl: string, targetId?: string): void {
  const normalizedTargetId = normalizeOptionalString(targetId) ?? "";
  if (!normalizedTargetId) {
    return;
  }
  blockedTargetsByCdpUrl.delete(targetKey(cdpUrl, normalizedTargetId));
}

export function clearBlockedTargetsForCdpUrl(cdpUrl?: string): void {
  if (!cdpUrl) {
    blockedTargetsByCdpUrl.clear();
    return;
  }
  const prefix = `${normalizeCdpUrl(cdpUrl)}::`;
  for (const key of blockedTargetsByCdpUrl) {
    if (key.startsWith(prefix)) {
      blockedTargetsByCdpUrl.delete(key);
    }
  }
}

function blockedPageRefsForCdpUrl(cdpUrl: string): WeakSet<Page> {
  const normalized = normalizeCdpUrl(cdpUrl);
  const existing = blockedPageRefsByCdpUrl.get(normalized);
  if (existing) {
    return existing;
  }
  const created = new WeakSet<Page>();
  blockedPageRefsByCdpUrl.set(normalized, created);
  return created;
}

export function isBlockedPageRef(cdpUrl: string, page: Page): boolean {
  return blockedPageRefsByCdpUrl.get(normalizeCdpUrl(cdpUrl))?.has(page) ?? false;
}

export function markPageRefBlocked(cdpUrl: string, page: Page): void {
  blockedPageRefsForCdpUrl(cdpUrl).add(page);
}

export function clearBlockedPageRefsForCdpUrl(cdpUrl?: string): void {
  if (!cdpUrl) {
    blockedPageRefsByCdpUrl.clear();
    return;
  }
  blockedPageRefsByCdpUrl.delete(normalizeCdpUrl(cdpUrl));
}

export function clearBlockedPageRef(cdpUrl: string, page: Page): void {
  blockedPageRefsByCdpUrl.get(normalizeCdpUrl(cdpUrl))?.delete(page);
}

export function takeCachedPlaywrightBrowserConnection(cdpUrl: string): ConnectedBrowser | null {
  const normalized = normalizeCdpUrl(cdpUrl);
  const cur = cachedByCdpUrl.get(normalized);
  cachedByCdpUrl.delete(normalized);
  const pending = connectingByCdpUrl.get(normalized);
  if (pending) {
    // Invalidation must also retire an in-flight connect. Otherwise it can
    // resolve after cleanup and repopulate the cache with the stale pipe.
    abortPendingBrowserConnection(pending);
  }
  connectingByCdpUrl.delete(normalized);
  if (!cur) {
    return null;
  }
  if (cur.onDisconnected && typeof cur.browser.off === "function") {
    cur.browser.off("disconnected", cur.onDisconnected);
  }
  return cur;
}

function abortPendingBrowserConnection(
  pending: PendingBrowserConnection,
  reason: unknown = new Error("Playwright connection attempt retired."),
): void {
  if (!pending.attempt.abortController.signal.aborted) {
    pending.attempt.abortController.abort(reason);
  }
}

/** Raised when a page target has been quarantined after policy denial. */
export class BlockedBrowserTargetError extends Error {
  constructor() {
    super("Browser target is unavailable after SSRF policy blocked its navigation.");
    this.name = "BlockedBrowserTargetError";
  }
}

function retainClosingPlaywrightConnection(connection: ConnectedBrowser): void {
  const retained = retainedClosingByCdpUrl.get(connection.cdpUrl) ?? new Set<ConnectedBrowser>();
  retained.add(connection);
  retainedClosingByCdpUrl.set(connection.cdpUrl, retained);
}

function releaseClosingPlaywrightConnection(connection: ConnectedBrowser): void {
  const retained = retainedClosingByCdpUrl.get(connection.cdpUrl);
  retained?.delete(connection);
  if (retained?.size === 0) {
    retainedClosingByCdpUrl.delete(connection.cdpUrl);
  }
}

export async function closeTrackedPlaywrightConnection(
  connection: ConnectedBrowser,
): Promise<void> {
  if (closedConnections.has(connection)) {
    return;
  }
  const existing = closeConnectionPromises.get(connection);
  if (existing) {
    return await existing;
  }
  retainClosingPlaywrightConnection(connection);
  const closing = (async () => {
    try {
      await connection.browser.close();
      closedConnections.add(connection);
      releaseClosingPlaywrightConnection(connection);
    } finally {
      closeConnectionPromises.delete(connection);
    }
  })();
  closeConnectionPromises.set(connection, closing);
  return await closing;
}

async function withPlaywrightCloseTimeout(task: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Playwright adapter disconnect timed out.")),
          PLAYWRIGHT_CONNECTION_CLOSE_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Capture and retire only the adapter handles currently owned by one lifecycle transition. */
export function retirePlaywrightBrowserConnectionExact(opts: {
  cdpUrl: string;
}): PlaywrightConnectionRetirement {
  const normalized = normalizeCdpUrl(opts.cdpUrl);
  clearBlockedTargetsForCdpUrl(normalized);
  clearBlockedPageRefsForCdpUrl(normalized);
  const connections = new Set<ConnectedBrowser>();
  const closeAttempts = new Map<ConnectedBrowser, Promise<void>>();
  const pendingCollections = new Set<Promise<void>>();
  let retired = false;
  const startClosing = () => {
    for (const connection of connections) {
      if (closeAttempts.has(connection)) {
        continue;
      }
      const closing = closeTrackedPlaywrightConnection(connection);
      closeAttempts.set(connection, closing);
      void closing.catch(() => {});
    }
  };
  const awaitClosing = async () => {
    const attempts = [...closeAttempts];
    const results = await Promise.allSettled(attempts.map(([, closing]) => closing));
    let firstError: Error | undefined;
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        const [connection, closing] = attempts[index] ?? [];
        if (connection && closeAttempts.get(connection) === closing) {
          closeAttempts.delete(connection);
        }
        firstError ??= toErrorObject(result.reason, "Playwright adapter disconnect failed.");
      }
    }
    if (firstError) {
      throw firstError;
    }
  };
  const capture = () => {
    const pending = connectingByCdpUrl.get(normalized);
    const cached = takeCachedPlaywrightBrowserConnection(normalized);
    for (const connection of retainedClosingByCdpUrl.get(normalized) ?? []) {
      connections.add(connection);
    }
    if (cached) {
      connections.add(cached);
      retainClosingPlaywrightConnection(cached);
    }
    if (pending) {
      const collection = pending.promise.then(
        (connection) => {
          connections.add(connection);
        },
        () => {
          if (pending.attempt.retired) {
            connections.add(pending.attempt.retired);
          }
        },
      );
      pendingCollections.add(collection);
      void collection.then(() => {
        pendingCollections.delete(collection);
        startClosing();
      });
    }
    startClosing();
    const captured = Boolean(pending || connections.size > 0);
    retired ||= captured;
    return captured;
  };
  capture();
  return {
    get retired() {
      return retired;
    },
    refresh: capture,
    close: async () => {
      await withPlaywrightCloseTimeout(
        (async () => {
          startClosing();
          await Promise.all(pendingCollections);
          startClosing();
          await awaitClosing();
        })(),
      );
    },
  };
}

/** Retire a scoped adapter immediately; its CDP disconnect may settle later. */
export function retirePlaywrightBrowserConnection(opts: { cdpUrl: string }): boolean {
  return retirePlaywrightBrowserConnectionExact(opts).retired;
}

export function evictStalePlaywrightBrowserConnection(
  cdpUrl: string,
  expectedBrowser?: Browser,
): void {
  const current = cachedByCdpUrl.get(normalizeCdpUrl(cdpUrl));
  if (expectedBrowser && current?.browser !== expectedBrowser) {
    return;
  }
  const cur = takeCachedPlaywrightBrowserConnection(cdpUrl);
  if (cur) {
    void closeTrackedPlaywrightConnection(cur).catch(() => {});
  }
}

function hasBlockedTargetsForCdpUrl(cdpUrl: string): boolean {
  const prefix = `${normalizeCdpUrl(cdpUrl)}::`;
  for (const key of blockedTargetsByCdpUrl) {
    if (key.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/** Raised when a page target has been quarantined after policy denial. */

function observeContext(context: BrowserContext) {
  if (observedContexts.has(context)) {
    return;
  }
  observedContexts.add(context);
  ensureContextState(context);

  for (const page of context.pages()) {
    ensurePageState(page);
  }
  context.on("page", (page) => ensurePageState(page));
}

/** Ensure shared Playwright browser-context state. */
export function ensureContextState(context: BrowserContext): ContextState {
  const existing = contextStates.get(context);
  if (existing) {
    return existing;
  }
  const state: ContextState = { traceActive: false };
  contextStates.set(context, state);
  return state;
}

function observeBrowser(browser: Browser) {
  for (const context of browser.contexts()) {
    observeContext(context);
  }
}

export async function connectBrowser(
  cdpUrl: string,
  ssrfPolicy?: SsrFPolicy,
  signal?: AbortSignal,
): Promise<ConnectedBrowser> {
  signal?.throwIfAborted();
  const normalized = normalizeCdpUrl(cdpUrl);
  const cached = cachedByCdpUrl.get(normalized);
  if (cached) {
    return cached;
  }
  // Run SSRF policy check only on cache miss so transient DNS failures
  // do not break active sessions that already hold a live CDP connection.
  await assertCdpEndpointAllowed(normalized, ssrfPolicy);
  signal?.throwIfAborted();
  const connecting = connectingByCdpUrl.get(normalized);
  if (connecting) {
    return await waitForPendingBrowserConnection(normalized, connecting, signal);
  }

  const connectionAttempt: PendingBrowserConnection["attempt"] = {
    abortController: new AbortController(),
  };
  const connectWithRetry = async (): Promise<ConnectedBrowser> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (connectionAttempt.abortController.signal.aborted) {
        break;
      }
      try {
        const timeout = 5000 + attempt * 2000;
        const wsUrl = await getChromeWebSocketUrl(normalized, timeout, ssrfPolicy).catch(
          () => null,
        );
        if (connectionAttempt.abortController.signal.aborted) {
          throw new Error("Playwright connection attempt was superseded.");
        }
        const hasUrlCredentials = stripCdpUrlCredentials(normalized) !== normalized;
        if (!wsUrl && hasUrlCredentials && !isWebSocketUrl(normalized)) {
          // Playwright preserves explicit headers across HTTP discovery redirects.
          // Keep credentialed discovery in OpenClaw's guarded fetch path instead.
          throw new Error("Authenticated CDP HTTP endpoint did not expose a usable WebSocket URL.");
        }
        const endpoint = wsUrl ?? normalized;
        const connectEndpoint = async (target: string) => {
          const headers = getHeadersWithAuth(target);
          const connectionUrl = stripCdpUrlCredentials(target);
          // Keep both loopback bypasses active until the Playwright handshake settles.
          return await withManagedProxyForCdpUrl(connectionUrl, () =>
            withNoProxyForCdpUrl(connectionUrl, () =>
              chromium.connectOverCDP(connectionUrl, { timeout, headers }),
            ),
          );
        };
        let browser: Browser;
        try {
          browser = await connectEndpoint(endpoint);
        } catch (err) {
          if (connectionAttempt.abortController.signal.aborted) {
            throw err;
          }
          if (!isWebSocketUrl(normalized) || endpoint === normalized) {
            throw err;
          }
          browser = await connectEndpoint(normalized);
        }
        if (connectionAttempt.abortController.signal.aborted) {
          connectionAttempt.retired = { browser, cdpUrl: normalized };
          void closeTrackedPlaywrightConnection(connectionAttempt.retired).catch(() => {});
          throw new Error("Playwright connection attempt was superseded.");
        }
        const onDisconnected = () => {
          const current = cachedByCdpUrl.get(normalized);
          if (current?.browser === browser) {
            cachedByCdpUrl.delete(normalized);
          }
        };
        const connected: ConnectedBrowser = { browser, cdpUrl: normalized, onDisconnected };
        cachedByCdpUrl.set(normalized, connected);
        browser.on("disconnected", onDisconnected);
        observeBrowser(browser);
        return connected;
      } catch (err) {
        lastErr = err;
        if (connectionAttempt.abortController.signal.aborted) {
          break;
        }
        // Don't retry rate-limit errors; retrying worsens the 429.
        const errMsg = formatErrorMessage(err);
        if (errMsg.includes("rate limit")) {
          break;
        }
        const delay = resolveCdpConnectRetryDelayMs(attempt);
        await sleepWithAbort(delay, connectionAttempt.abortController.signal, {
          ref: false,
        }).catch(() => {});
      }
    }
    const message = lastErr ? formatErrorMessage(lastErr) : "CDP connect failed";
    // Never retain the raw dependency error as a cause: Playwright includes
    // connection URLs in some HTTP and WebSocket failures.
    throw new Error(redactCdpErrorText(message));
  };

  const pending = connectWithRetry().finally(() => {
    if (connectingByCdpUrl.get(normalized)?.attempt === connectionAttempt) {
      connectingByCdpUrl.delete(normalized);
    }
  });
  const pendingConnection: PendingBrowserConnection = {
    attempt: connectionAttempt,
    promise: pending,
    waiters: 0,
  };
  connectingByCdpUrl.set(normalized, pendingConnection);

  return await waitForPendingBrowserConnection(normalized, pendingConnection, signal);
}

function waitForPendingBrowserConnection(
  normalizedCdpUrl: string,
  pending: PendingBrowserConnection,
  signal?: AbortSignal,
): Promise<ConnectedBrowser> {
  pending.waiters += 1;
  let released = false;
  const release = (abortWhenLast: boolean) => {
    if (released) {
      return;
    }
    released = true;
    pending.waiters = Math.max(0, pending.waiters - 1);
    if (
      abortWhenLast &&
      pending.waiters === 0 &&
      connectingByCdpUrl.get(normalizedCdpUrl) === pending
    ) {
      connectingByCdpUrl.delete(normalizedCdpUrl);
      abortPendingBrowserConnection(pending, signal?.reason);
    }
  };
  if (!signal) {
    // Unsignalled callers own the producer until it settles. The exact-map
    // finally cleanup then drops the whole pending record and its waiter count.
    return pending.promise;
  }

  void pending.promise.catch(() => {});
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      // Publish ownership release inside the abort event so concurrent callers
      // cannot adopt an attempt after its final waiter has cancelled it.
      release(true);
      reject(signal.reason ?? new Error("Playwright connection aborted."));
    };
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) {
      abortListener();
    }
  });
  void aborted.catch(() => {});
  return Promise.race([pending.promise, aborted]).finally(() => {
    release(false);
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  });
}

export async function getAllPages(browser: Browser): Promise<Page[]> {
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());
  return pages;
}

async function partitionAccessiblePages(opts: {
  cdpUrl: string;
  pages: Page[];
  signal?: AbortSignal;
}): Promise<{
  accessible: Array<{ page: Page; targetId: string | null }>;
  blockedCount: number;
  targetInfoTimeout?: Error;
}> {
  const accessible: Array<{ page: Page; targetId: string | null }> = [];
  let blockedCount = 0;
  let targetInfoTimeout: Error | undefined;
  for (const page of opts.pages) {
    opts.signal?.throwIfAborted();
    if (isBlockedPageRef(opts.cdpUrl, page)) {
      blockedCount += 1;
      continue;
    }
    ensurePageState(page);
    let targetInfo: PageTargetInfo | null = null;
    try {
      targetInfo = await pageTargetInfo(page, opts.signal);
    } catch (err) {
      opts.signal?.throwIfAborted();
      if (err instanceof PageTargetInfoTimeoutError) {
        targetInfoTimeout ??= err;
      }
    }
    const targetId = targetInfo?.targetId ?? null;
    // Fail closed when we cannot resolve a target id while this session has
    // quarantined targets; otherwise a blocked tab can become selectable.
    if (!targetId) {
      if (hasBlockedTargetsForCdpUrl(opts.cdpUrl)) {
        blockedCount += 1;
        continue;
      }
      accessible.push({ page, targetId: null });
      continue;
    }
    if (isBlockedTarget(opts.cdpUrl, targetId)) {
      blockedCount += 1;
      continue;
    }
    bindRoleRefsTarget(page, opts.cdpUrl, targetId);
    accessible.push({ page, targetId });
  }
  return { accessible, blockedCount, targetInfoTimeout };
}

type PageTargetInfo = { targetId: string; title: string };

// A Page owns one bounded target-info read at a time so concurrent enumerations share its
// temporary CDP session. Settled reads evict themselves so later calls observe fresh metadata.
class PageTargetInfoTimeoutError extends Error {
  constructor(detail: string) {
    super(`Page target lookup timed out after ${PLAYWRIGHT_TARGET_INFO_TIMEOUT_MS}ms (${detail}).`);
    this.name = "PageTargetInfoTimeoutError";
  }
}

const targetInfoReads = new WeakMap<Page, Promise<PageTargetInfo | null>>();

function createPageTargetInfoRead(
  page: Page,
  signal?: AbortSignal,
): Promise<PageTargetInfo | null> {
  signal?.throwIfAborted();
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(
      new Error(`Page target lookup timed out after ${PLAYWRIGHT_TARGET_INFO_TIMEOUT_MS}ms.`),
    );
  }, PLAYWRIGHT_TARGET_INFO_TIMEOUT_MS);
  timer.unref?.();
  const operationSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  return withPlaywrightPageCdpSession(
    page,
    async (session) => {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      const targetId = normalizeOptionalString(targetInfo.targetId) ?? "";
      if (!targetId) {
        return null;
      }
      return { targetId, title: targetInfo.title };
    },
    operationSignal,
  )
    .catch((err: unknown) => {
      if (
        !timeoutController.signal.aborted ||
        operationSignal.reason !== timeoutController.signal.reason
      ) {
        throw err;
      }
      throw new PageTargetInfoTimeoutError(formatErrorMessage(err));
    })
    .finally(() => {
      clearTimeout(timer);
    });
}

export function pageTargetInfo(page: Page, signal?: AbortSignal): Promise<PageTargetInfo | null> {
  signal?.throwIfAborted();
  // A cancellable caller owns its exact temporary session. Unsignalled
  // background enumerations still share one bounded metadata read per Page.
  if (signal) {
    return createPageTargetInfoRead(page, signal);
  }
  let read = targetInfoReads.get(page);
  if (!read) {
    read = createPageTargetInfoRead(page);
    targetInfoReads.set(page, read);
    const evict = () => {
      if (targetInfoReads.get(page) === read) {
        targetInfoReads.delete(page);
      }
    };
    void read.then(evict, evict);
  }
  return read;
}

async function getPageForTargetIdOnce(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
}): Promise<Page> {
  opts.signal?.throwIfAborted();
  if (opts.targetId && isBlockedTarget(opts.cdpUrl, opts.targetId)) {
    throw new BlockedBrowserTargetError();
  }
  const { browser } = await connectBrowser(opts.cdpUrl, opts.ssrfPolicy, opts.signal);
  opts.signal?.throwIfAborted();
  const pages = await getAllPages(browser);
  if (!pages.length) {
    throw new Error("No pages available in the connected browser.");
  }

  const { accessible, blockedCount, targetInfoTimeout } = await partitionAccessiblePages({
    cdpUrl: opts.cdpUrl,
    pages,
    signal: opts.signal,
  });
  if (!accessible.length) {
    if (blockedCount > 0) {
      throw new BlockedBrowserTargetError();
    }
    throw new Error("No pages available in the connected browser.");
  }
  const first = expectDefined(accessible.at(0), "non-empty accessible browser pages");
  if (!opts.targetId) {
    bindRoleRefsTarget(first.page, opts.cdpUrl, first.targetId);
    return first.page;
  }
  const found = accessible.find((entry) => entry.targetId === opts.targetId);
  if (found) {
    bindRoleRefsTarget(found.page, opts.cdpUrl, found.targetId);
    return found.page;
  }
  if (targetInfoTimeout) {
    throw targetInfoTimeout;
  }
  throw new BrowserTabNotFoundError();
}

/** Resolve a Playwright page by target id, reconnecting once on stale state. */
export async function getPageForTargetId(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
}): Promise<Page> {
  const reusedCachedBrowser = hasCachedPlaywrightBrowserConnection(opts.cdpUrl);
  try {
    return await getPageForTargetIdOnce(opts);
  } catch (err) {
    opts.signal?.throwIfAborted();
    if (!isRecoverableStalePageSelectionError(err, reusedCachedBrowser)) {
      throw err;
    }
    retirePlaywrightBrowserConnection({ cdpUrl: opts.cdpUrl });
    return await getPageForTargetIdOnce(opts);
  }
}
