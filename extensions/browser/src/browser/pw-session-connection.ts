import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { formatErrorMessage, toErrorObject } from "../infra/errors.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { withManagedProxyForCdpUrl, withNoProxyForCdpUrl } from "./cdp-proxy-bypass.js";
import {
  assertCdpEndpointAllowed,
  getHeadersWithAuth,
  isLoopbackHost,
  isWebSocketUrl,
  redactCdpErrorText,
  stripCdpUrlCredentials,
} from "./cdp.helpers.js";
import { getChromeWebSocketEndpoint } from "./chrome.js";
import { BrowserTabNotFoundError } from "./errors.js";
import type { RelayOperationReference } from "./extension-relay/owner-client.js";
import {
  connectRelayBrowser,
  closeRelayOperationConnection,
} from "./extension-relay/owner-playwright.js";
import { getBorrowedRelayCdpAccess } from "./extension-relay/relay-access.js";
import { connectOverCdpTransport } from "./pw-session-cdp-transport.js";
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
import { pageTargetInfo } from "./pw-session-page-target.js";
import {
  bindRoleRefsTarget,
  ensurePageState,
  normalizeCdpUrl,
  targetKey,
} from "./pw-session-state.js";

export { pageTargetInfo } from "./pw-session-page-target.js";

type CdpEndpointPin = NonNullable<Awaited<ReturnType<typeof assertCdpEndpointAllowed>>>;

function resolveCdpConnectRetryDelayMs(attempt: number): number {
  return 250 + attempt * 250;
}

export function hasCachedPlaywrightBrowserConnection(cdpUrl: string): boolean {
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
    pending.attempt.cancelled = true;
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
  relayReference?: RelayOperationReference,
): Promise<ConnectedBrowser> {
  const normalized = normalizeCdpUrl(cdpUrl);
  const relay = getBorrowedRelayCdpAccess(normalized);
  if (relayReference) {
    if (!relay) {
      throw new Error("Captured relay connection is unavailable");
    }
    const browser = await connectRelayBrowser(relay, normalized, relayReference);
    observeBrowser(browser);
    return { browser, cdpUrl: normalized };
  }
  const cached = cachedByCdpUrl.get(normalized);
  if (cached) {
    return cached;
  }
  // Run SSRF policy check only on cache miss so transient DNS failures
  // do not break active sessions that already hold a live CDP connection.
  const configuredPin = await assertCdpEndpointAllowed(normalized, ssrfPolicy);
  const connecting = connectingByCdpUrl.get(normalized);
  if (connecting) {
    return await connecting.promise;
  }

  const connectionAttempt: PendingBrowserConnection["attempt"] = { cancelled: false };
  const connectWithRetry = async (): Promise<ConnectedBrowser> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (connectionAttempt.cancelled) {
        break;
      }
      try {
        const timeout = 5000 + attempt * 2000;
        let endpointDiscoveryError: unknown;
        const resolvedEndpoint = relay
          ? null
          : await getChromeWebSocketEndpoint(normalized, timeout, ssrfPolicy).catch(
              (err: unknown) => {
                endpointDiscoveryError = err;
                return null;
              },
            );
        const hasUrlCredentials = stripCdpUrlCredentials(normalized) !== normalized;
        const configuredIsWebSocket = isWebSocketUrl(normalized);
        if (!relay && !resolvedEndpoint && !configuredIsWebSocket) {
          if (hasUrlCredentials) {
            // Playwright preserves explicit headers across HTTP discovery redirects.
            // Keep credentialed discovery in OpenClaw's guarded fetch path instead.
            throw new Error(
              "Authenticated CDP HTTP endpoint did not expose a usable WebSocket URL.",
            );
          }
          const detail = endpointDiscoveryError
            ? ` Reason: ${redactCdpErrorText(formatErrorMessage(endpointDiscoveryError))}`
            : "";
          if (ssrfPolicy) {
            throw new Error(`Guarded CDP endpoint did not expose a usable WebSocket URL.${detail}`);
          }
        }
        const normalizedCdpHostname = new URL(normalized).hostname;
        const needsPinnedDependencyConnect =
          Boolean(configuredPin?.lookup) && !isLoopbackHost(normalizedCdpHostname);
        const endpointUrl = resolvedEndpoint?.url ?? normalized;
        const endpointLookup =
          resolvedEndpoint?.lookup ??
          (needsPinnedDependencyConnect ? configuredPin?.lookup : undefined);
        const connectEndpoint = async (target: string, lookup?: CdpEndpointPin["lookup"]) => {
          const headers = getHeadersWithAuth(target);
          const connectionUrl = stripCdpUrlCredentials(target);
          const resolveWebSocketUrl = isWebSocketUrl(connectionUrl)
            ? undefined
            : async () => (await getChromeWebSocketEndpoint(connectionUrl, timeout))?.url;
          // Keep both loopback bypasses active until the Playwright handshake settles.
          return await withManagedProxyForCdpUrl(connectionUrl, () =>
            withNoProxyForCdpUrl(connectionUrl, async () => {
              return await connectOverCdpTransport(connectionUrl, {
                timeout,
                headers,
                lookup,
                resolveWebSocketUrl,
              });
            }),
          );
        };
        let browser: Browser;
        try {
          browser = relay
            ? await connectRelayBrowser(relay, normalized)
            : await connectEndpoint(endpointUrl, endpointLookup);
          if (relay && getBorrowedRelayCdpAccess(normalized) !== relay) {
            await browser.close();
            throw new Error("Relay connection was superseded");
          }
        } catch (err) {
          if (!configuredIsWebSocket || endpointUrl === normalized) {
            throw err;
          }
          browser = await connectEndpoint(normalized, configuredPin?.lookup);
        }
        if (connectionAttempt.cancelled) {
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
        if (connectionAttempt.cancelled || relay) {
          break;
        }
        // Don't retry rate-limit errors; retrying worsens the 429.
        const errMsg = formatErrorMessage(err);
        if (errMsg.includes("rate limit")) {
          break;
        }
        const delay = resolveCdpConnectRetryDelayMs(attempt);
        await new Promise((r) => {
          setTimeout(r, delay);
        });
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
  connectingByCdpUrl.set(normalized, { attempt: connectionAttempt, promise: pending });

  return await pending;
}

export async function getAllPages(browser: Browser): Promise<Page[]> {
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());
  return pages;
}

async function partitionAccessiblePages(opts: { cdpUrl: string; pages: Page[] }): Promise<{
  accessible: Array<{ page: Page; targetId: string | null }>;
  blockedCount: number;
}> {
  const accessible: Array<{ page: Page; targetId: string | null }> = [];
  let blockedCount = 0;
  for (const page of opts.pages) {
    if (isBlockedPageRef(opts.cdpUrl, page)) {
      blockedCount += 1;
      continue;
    }
    ensurePageState(page);
    const targetId = (await pageTargetInfo(page).catch(() => null))?.targetId ?? null;
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
  return { accessible, blockedCount };
}

async function getPageForTargetIdOnce(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
  relayReference?: RelayOperationReference;
}): Promise<Page> {
  if (opts.targetId && isBlockedTarget(opts.cdpUrl, opts.targetId)) {
    throw new BlockedBrowserTargetError();
  }
  const { browser } = await connectBrowser(opts.cdpUrl, opts.ssrfPolicy, opts.relayReference);
  const pages = await getAllPages(browser);
  if (!pages.length) {
    throw new Error("No pages available in the connected browser.");
  }

  const { accessible, blockedCount } = await partitionAccessiblePages({
    cdpUrl: opts.cdpUrl,
    pages,
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
  throw new BrowserTabNotFoundError();
}

/** Resolve a Playwright page by target id, reconnecting once on stale state. */
export async function getPageForTargetId(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
  relayReference?: RelayOperationReference;
}): Promise<Page> {
  const reusedCachedBrowser = hasCachedPlaywrightBrowserConnection(opts.cdpUrl);
  try {
    return await getPageForTargetIdOnce(opts);
  } catch (err) {
    if (!isRecoverableStalePageSelectionError(err, reusedCachedBrowser)) {
      throw err;
    }
    if (opts.relayReference) {
      await closeRelayOperationConnection(opts.relayReference);
    } else {
      retirePlaywrightBrowserConnection({ cdpUrl: opts.cdpUrl });
    }
    return await getPageForTargetIdOnce(opts);
  }
}
