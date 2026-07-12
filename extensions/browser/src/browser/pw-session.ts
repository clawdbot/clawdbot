/**
 * Playwright browser session manager.
 *
 * Manages CDP-backed Playwright connections, page lookup, observed dialogs,
 * console/network/page state, role refs, and safe navigation handling.
 */
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  isFutureDateTimestampMs,
  parseFiniteNumber,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Dialog,
  Frame,
  Page,
  Request,
  Response,
  Route,
} from "playwright-core";
import { formatErrorMessage } from "../infra/errors.js";
import { SsrFBlockedError, type SsrFPolicy } from "../infra/net/ssrf.js";
import { withNoProxyForCdpUrl } from "./cdp-proxy-bypass.js";
import {
  appendCdpPath,
  assertCdpEndpointAllowed,
  fetchJson,
  getHeadersWithAuth,
  isWebSocketUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  redactCdpErrorText,
  scopeCdpPolicyToConfiguredEndpoint,
  stripCdpUrlCredentials,
  withCdpSocket,
} from "./cdp.helpers.js";
import { AX_REF_PATTERN, normalizeCdpWsUrl } from "./cdp.js";
import { getChromeWebSocketUrl } from "./chrome.js";
import type { BrowserDownloadCandidate, BrowserDownloadResult } from "./download-types.js";
import { BrowserTabNotFoundError } from "./errors.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  InvalidBrowserNavigationUrlError,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { playwrightCore } from "./playwright-core.runtime.js";
import {
  saveBrowserDownload,
  type BrowserDownloadCaptureOptions,
  type PlaywrightDownload,
} from "./pw-download-capture.js";
import { BROWSER_REF_MARKER_ATTRIBUTE, withPageScopedCdpClient } from "./pw-session.page-cdp.js";

const { chromium } = playwrightCore;

/** Console message captured from a Playwright page. */
export type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
};

/** Page error captured from a Playwright page. */
export type BrowserPageError = {
  message: string;
  name?: string;
  stack?: string;
  timestamp: string;
};

/** Network request record captured from a Playwright page. */
export type BrowserNetworkRequest = {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
};

/** Observed browser dialog record tracked for agent-visible state. */
type BrowserObservedDialogRecord = {
  id: string;
  type: string;
  message: string;
  defaultValue?: string;
  openedAt: string;
  closedAt?: string;
  closedBy?: "agent" | "armed" | "auto" | "timeout" | "remote";
};

/** Pending and recent dialog state for a page. */
type BrowserObservedDialogState = {
  pending: BrowserObservedDialogRecord[];
  recent: BrowserObservedDialogRecord[];
};

/** Browser state currently observable by agent responses. */
type BrowserObservedState = {
  dialogs: BrowserObservedDialogState;
};

/** Raised when an action is blocked by an observed modal dialog. */
export class BrowserObservedDialogBlockedError extends Error {
  readonly browserState: BrowserObservedState;

  constructor(browserState: BrowserObservedState) {
    super("Browser action blocked by a modal dialog.");
    this.name = "BrowserObservedDialogBlockedError";
    this.browserState = browserState;
  }
}

/** Type guard for observed-dialog blocked errors. */
export function isBrowserObservedDialogBlockedError(
  err: unknown,
): err is BrowserObservedDialogBlockedError {
  return err instanceof BrowserObservedDialogBlockedError;
}

type PendingObservedDialog = BrowserObservedDialogRecord & {
  dialog: Dialog;
};

type ArmedDialogResponse = {
  accept: boolean;
  promptText?: string;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

type TargetInfoResponse = {
  targetInfo?: {
    targetId?: string;
  };
};

type ConnectedBrowser = {
  browser: Browser;
  cdpUrl: string;
  onDisconnected?: () => void;
};

type DownloadPayload = PlaywrightDownload & {
  path?: () => Promise<string>;
};

type ActionDownloadCapture = {
  beforeSave?: (download: BrowserDownloadCandidate) => Promise<void> | void;
  lastEventAtMs?: number;
  pending: Array<Promise<BrowserDownloadResult>>;
  validations: Array<Promise<void>>;
  waiters: Array<() => void>;
};

type PageState = {
  console: BrowserConsoleMessage[];
  errors: BrowserPageError[];
  requests: BrowserNetworkRequest[];
  requestIds: WeakMap<Request, string>;
  nextRequestId: number;
  armIdUpload: number;
  armIdDownload: number;
  downloadWaiterDepth: number;
  actionDownloadCapture?: ActionDownloadCapture;
  nextObservedDialogId: number;
  pendingDialogs: PendingObservedDialog[];
  recentDialogs: BrowserObservedDialogRecord[];
  armedDialogResponse?: ArmedDialogResponse;
  dialogAbortControllers: Set<AbortController>;
  /**
   * Role-based refs from the last role snapshot (e.g. e1/e2).
   * Mode "role" refs are generated from ariaSnapshot and resolved via getByRole.
   * Mode "aria" refs are Playwright aria-ref ids and resolved via `aria-ref=...`.
   */
  roleRefs?: Record<string, { role: string; name?: string; nth?: number; domMarker?: boolean }>;
  roleRefsMode?: "role" | "aria";
  roleRefsFrameSelector?: string;
  roleRefsFrame?: Frame;
  /** Target-cache entry owned by the current role refs. */
  roleRefsTargetKey?: string;
  /** Cache generation restored or stored by this Page. */
  roleRefsTargetGeneration?: number;
  /** Main-frame navigation observed before this Page could be bound to its target. */
  roleRefsInvalidBeforeGeneration?: number;
  /** Any frame changed before target binding; invalidates only page-wide aria refs. */
  roleRefsAriaInvalidBeforeGeneration?: number;
};

type RoleRefs = NonNullable<PageState["roleRefs"]>;
type RoleRefsCacheEntry = {
  refs: RoleRefs;
  mode?: NonNullable<PageState["roleRefsMode"]>;
  generation: number;
};

type ContextState = {
  traceActive: boolean;
};

const pageStates = new WeakMap<Page, PageState>();
const contextStates = new WeakMap<BrowserContext, ContextState>();
const observedContexts = new WeakSet<BrowserContext>();
const observedPages = new WeakSet<Page>();

// Best-effort cache to make role refs stable even if Playwright returns a different Page object
// for the same CDP target across requests.
const roleRefsByTarget = new Map<string, RoleRefsCacheEntry>();
const MAX_ROLE_REFS_CACHE = 50;
let roleRefsCacheGeneration = 0;

const MAX_CONSOLE_MESSAGES = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;
const MAX_RECENT_DIALOGS = 20;
const OBSERVED_DIALOG_TIMEOUT_MS = 120_000;

type PendingBrowserConnection = {
  attempt: { cancelled: boolean; retired?: ConnectedBrowser };
  promise: Promise<ConnectedBrowser>;
};

export type PlaywrightConnectionRetirement = {
  readonly retired: boolean;
  /** Capture handles created by already-admitted work before cleanup begins. */
  refresh?: () => boolean;
  close: () => Promise<void>;
};

const cachedByCdpUrl = new Map<string, ConnectedBrowser>();
const connectingByCdpUrl = new Map<string, PendingBrowserConnection>();
const retainedClosingByCdpUrl = new Map<string, Set<ConnectedBrowser>>();
const closeConnectionPromises = new WeakMap<ConnectedBrowser, Promise<void>>();
const closedConnections = new WeakSet<ConnectedBrowser>();
const PLAYWRIGHT_CONNECTION_CLOSE_TIMEOUT_MS = 2_000;
const blockedTargetsByCdpUrl = new Set<string>();
const blockedPageRefsByCdpUrl = new Map<string, WeakSet<Page>>();
let cdpConnectRetryDelayMsForTests: number | undefined;

/** Override CDP reconnect retry delay in tests. */
export function setCdpConnectRetryDelayMsForTests(delayMs?: number): void {
  cdpConnectRetryDelayMsForTests = delayMs;
}

function resolveObservedDialogTimeoutMs(timeoutMs: number | undefined): number {
  const parsed = parseFiniteNumber(timeoutMs);
  return Math.max(1, Math.floor(parsed ?? OBSERVED_DIALOG_TIMEOUT_MS));
}

function normalizeCdpUrl(raw: string) {
  return raw.replace(/\/$/, "");
}

function resolveCdpConnectRetryDelayMs(attempt: number): number {
  return cdpConnectRetryDelayMsForTests ?? 250 + attempt * 250;
}

export function isDownloadStartingNavigationError(err: unknown, expectedUrl?: string): boolean {
  const message = formatErrorMessage(err).toLowerCase();
  if (message.includes("download is starting")) {
    return true;
  }
  const normalizedUrl = normalizeOptionalString(expectedUrl)?.toLowerCase();
  return Boolean(
    normalizedUrl && message.includes("net::err_aborted") && message.includes(normalizedUrl),
  );
}

/** Capture downloads started synchronously by one Browser action. */
export function beginActionDownloadCaptureOnPage(
  page: Page,
  opts: {
    beforeSave?: (download: BrowserDownloadCandidate) => Promise<void> | void;
  } = {},
): {
  drain: (opts?: {
    firstEventGraceMs?: number;
    maxWaitMs?: number;
    quietMs?: number;
  }) => Promise<BrowserDownloadResult[] | undefined>;
  dispose: () => void;
} {
  const state = ensurePageState(page);
  const capture: ActionDownloadCapture = {
    pending: [],
    validations: [],
    waiters: [],
    ...(opts.beforeSave ? { beforeSave: opts.beforeSave } : {}),
  };
  // One page event belongs to one action. A newer overlapping action owns
  // future events; older captures may still drain saves they already started.
  state.actionDownloadCapture = capture;
  const detach = () => {
    if (state.actionDownloadCapture === capture) {
      state.actionDownloadCapture = undefined;
    }
    for (const finish of capture.waiters.splice(0)) {
      finish();
    }
  };

  return {
    drain: async (drainOpts = {}) => {
      const waitForEvent = async (timeoutMs: number) => {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            capture.waiters = capture.waiters.filter((waiter) => waiter !== finish);
            resolve();
          };
          const timer = setTimeout(finish, timeoutMs);
          capture.waiters.push(finish);
        });
      };
      const firstEventGraceMs = Math.max(0, drainOpts.firstEventGraceMs ?? 0);
      const maxWaitMs = Math.max(0, drainOpts.maxWaitMs ?? Number.POSITIVE_INFINITY);
      const deadlineAtMs = Date.now() + maxWaitMs;
      const remainingBudgetMs = () => Math.max(0, deadlineAtMs - Date.now());
      if (capture.pending.length === 0 && firstEventGraceMs > 0) {
        await waitForEvent(Math.min(firstEventGraceMs, remainingBudgetMs()));
      }
      const quietMs = Math.max(0, drainOpts.quietMs ?? 0);
      if (quietMs > 0) {
        while (capture.lastEventAtMs !== undefined) {
          const remainingQuietMs = Math.min(
            quietMs - (Date.now() - capture.lastEventAtMs),
            remainingBudgetMs(),
          );
          if (remainingQuietMs <= 0) {
            break;
          }
          await waitForEvent(remainingQuietMs);
        }
      }
      // Establish event ownership before awaiting file I/O. Slow saves must not
      // hold the action window open and absorb unrelated later downloads.
      detach();
      const pending = capture.pending.slice();
      await Promise.all(capture.validations.slice());
      const downloads = await Promise.all(pending);
      return downloads.length > 0 ? downloads : undefined;
    },
    dispose: detach,
  };
}

function hasCachedPlaywrightBrowserConnection(cdpUrl: string): boolean {
  return cachedByCdpUrl.has(normalizeCdpUrl(cdpUrl));
}

function isRecoverablePlaywrightDisconnectError(err: unknown): boolean {
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

function findNetworkRequestById(state: PageState, id: string): BrowserNetworkRequest | undefined {
  for (let i = state.requests.length - 1; i >= 0; i -= 1) {
    const candidate = state.requests[i];
    if (candidate && candidate.id === id) {
      return candidate;
    }
  }
  return undefined;
}

function appendRecentDialog(state: PageState, record: BrowserObservedDialogRecord): void {
  state.recentDialogs.push(record);
  while (state.recentDialogs.length > MAX_RECENT_DIALOGS) {
    state.recentDialogs.shift();
  }
}

function serializeDialogRecord(dialog: BrowserObservedDialogRecord): BrowserObservedDialogRecord {
  return {
    id: dialog.id,
    type: dialog.type,
    message: dialog.message,
    ...(dialog.defaultValue !== undefined ? { defaultValue: dialog.defaultValue } : {}),
    openedAt: dialog.openedAt,
    ...(dialog.closedAt !== undefined ? { closedAt: dialog.closedAt } : {}),
    ...(dialog.closedBy !== undefined ? { closedBy: dialog.closedBy } : {}),
  };
}

function serializePendingDialog(dialog: PendingObservedDialog): BrowserObservedDialogRecord {
  return serializeDialogRecord(dialog);
}

function serializeObservedBrowserState(state: PageState): BrowserObservedState {
  return {
    dialogs: {
      pending: state.pendingDialogs.map(serializePendingDialog),
      recent: state.recentDialogs.map(serializeDialogRecord),
    },
  };
}

function clearArmedDialogResponse(state: PageState): void {
  if (state.armedDialogResponse?.timer) {
    clearTimeout(state.armedDialogResponse.timer);
  }
  state.armedDialogResponse = undefined;
}

function abortActionsBlockedByDialog(state: PageState): void {
  if (state.dialogAbortControllers.size === 0) {
    return;
  }
  const err = new BrowserObservedDialogBlockedError(serializeObservedBrowserState(state));
  for (const controller of state.dialogAbortControllers) {
    if (!controller.signal.aborted) {
      controller.abort(err);
    }
  }
  state.dialogAbortControllers.clear();
}

function isNoDialogShowingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes("no dialog is showing");
}

async function settleObservedDialog(params: {
  state: PageState;
  pending: PendingObservedDialog;
  accept: boolean;
  promptText?: string;
  closedBy: NonNullable<BrowserObservedDialogRecord["closedBy"]>;
}): Promise<BrowserObservedDialogRecord> {
  const { state, pending } = params;
  state.pendingDialogs = state.pendingDialogs.filter((dialog) => dialog.id !== pending.id);

  let closedBy = params.closedBy;
  try {
    if (params.accept) {
      await pending.dialog.accept(params.promptText);
    } else {
      await pending.dialog.dismiss();
    }
  } catch (err) {
    if (!isNoDialogShowingError(err)) {
      if (params.closedBy === "agent") {
        state.pendingDialogs.push(pending);
      }
      throw err;
    }
    closedBy = "remote";
  }

  const record: BrowserObservedDialogRecord = {
    id: pending.id,
    type: pending.type,
    message: pending.message,
    ...(pending.defaultValue !== undefined ? { defaultValue: pending.defaultValue } : {}),
    openedAt: pending.openedAt,
    closedAt: new Date().toISOString(),
    closedBy,
  };
  appendRecentDialog(state, record);
  return record;
}

function observeDialog(pageState: PageState, dialog: Dialog): void {
  pageState.nextObservedDialogId += 1;
  const type = dialog.type();
  const defaultValue = dialog.defaultValue();
  const pending: PendingObservedDialog = {
    id: `d${pageState.nextObservedDialogId}`,
    type,
    message: dialog.message(),
    openedAt: new Date().toISOString(),
    dialog,
    ...(type === "prompt" ? { defaultValue } : {}),
  };
  pageState.pendingDialogs.push(pending);

  const armed = pageState.armedDialogResponse;
  if (armed && isFutureDateTimestampMs(armed.expiresAt)) {
    clearArmedDialogResponse(pageState);
    void settleObservedDialog({
      state: pageState,
      pending,
      accept: armed.accept,
      ...(armed.promptText !== undefined ? { promptText: armed.promptText } : {}),
      closedBy: "armed",
    }).catch(() => {});
    return;
  }
  if (armed) {
    clearArmedDialogResponse(pageState);
  }
  abortActionsBlockedByDialog(pageState);
}

function targetKey(cdpUrl: string, targetId: string) {
  return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}

function roleRefsKey(cdpUrl: string, targetId: string) {
  return targetKey(cdpUrl, targetId);
}

function bindRoleRefsTarget(page: Page, cdpUrl: string, targetId?: string | null): void {
  const normalizedTargetId = normalizeOptionalString(targetId ?? undefined);
  if (!normalizedTargetId) {
    return;
  }
  const state = ensurePageState(page);
  const key = roleRefsKey(cdpUrl, normalizedTargetId);
  const invalidBeforeGeneration = state.roleRefsInvalidBeforeGeneration;
  const ariaInvalidBeforeGeneration = state.roleRefsAriaInvalidBeforeGeneration;
  const cached = roleRefsByTarget.get(key);
  if (
    cached &&
    ((invalidBeforeGeneration !== undefined && cached.generation <= invalidBeforeGeneration) ||
      (ariaInvalidBeforeGeneration !== undefined &&
        cached.mode === "aria" &&
        cached.generation <= ariaInvalidBeforeGeneration))
  ) {
    roleRefsByTarget.delete(key);
  }
  state.roleRefsInvalidBeforeGeneration = undefined;
  state.roleRefsAriaInvalidBeforeGeneration = undefined;
  state.roleRefsTargetKey = key;
  if (!state.roleRefs) {
    state.roleRefsTargetGeneration = roleRefsByTarget.get(key)?.generation;
  }
}

function isBlockedTarget(cdpUrl: string, targetId?: string): boolean {
  const normalizedTargetId = normalizeOptionalString(targetId) ?? "";
  if (!normalizedTargetId) {
    return false;
  }
  return blockedTargetsByCdpUrl.has(targetKey(cdpUrl, normalizedTargetId));
}

function markTargetBlocked(cdpUrl: string, targetId?: string): void {
  const normalizedTargetId = normalizeOptionalString(targetId) ?? "";
  if (!normalizedTargetId) {
    return;
  }
  blockedTargetsByCdpUrl.add(targetKey(cdpUrl, normalizedTargetId));
}

function clearBlockedTarget(cdpUrl: string, targetId?: string): void {
  const normalizedTargetId = normalizeOptionalString(targetId) ?? "";
  if (!normalizedTargetId) {
    return;
  }
  blockedTargetsByCdpUrl.delete(targetKey(cdpUrl, normalizedTargetId));
}

function clearBlockedTargetsForCdpUrl(cdpUrl?: string): void {
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

function isBlockedPageRef(cdpUrl: string, page: Page): boolean {
  return blockedPageRefsByCdpUrl.get(normalizeCdpUrl(cdpUrl))?.has(page) ?? false;
}

function markPageRefBlocked(cdpUrl: string, page: Page): void {
  blockedPageRefsForCdpUrl(cdpUrl).add(page);
}

function clearBlockedPageRefsForCdpUrl(cdpUrl?: string): void {
  if (!cdpUrl) {
    blockedPageRefsByCdpUrl.clear();
    return;
  }
  blockedPageRefsByCdpUrl.delete(normalizeCdpUrl(cdpUrl));
}

function clearBlockedPageRef(cdpUrl: string, page: Page): void {
  blockedPageRefsByCdpUrl.get(normalizeCdpUrl(cdpUrl))?.delete(page);
}

function takeCachedPlaywrightBrowserConnection(cdpUrl: string): ConnectedBrowser | null {
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

async function closeTrackedPlaywrightConnection(connection: ConnectedBrowser): Promise<void> {
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
        firstError ??= toLintErrorObject(result.reason, "Playwright adapter disconnect failed.");
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

function evictStalePlaywrightBrowserConnection(cdpUrl: string, expectedBrowser?: Browser): void {
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
export class BlockedBrowserTargetError extends Error {
  constructor() {
    super("Browser target is unavailable after SSRF policy blocked its navigation.");
    this.name = "BlockedBrowserTargetError";
  }
}

/** Cache role refs for a target id after a snapshot. */
export function rememberRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode?: NonNullable<PageState["roleRefsMode"]>;
}): number | undefined {
  const targetId = normalizeOptionalString(opts.targetId) ?? "";
  if (!targetId) {
    return undefined;
  }
  const key = roleRefsKey(opts.cdpUrl, targetId);
  // A selector cannot preserve frame identity across replacement Page objects.
  // Frame-scoped refs remain local and require a fresh snapshot after reconnect.
  if (opts.frameSelector) {
    roleRefsByTarget.delete(key);
    return undefined;
  }
  const generation = ++roleRefsCacheGeneration;
  roleRefsByTarget.set(key, {
    refs: opts.refs,
    ...(opts.mode ? { mode: opts.mode } : {}),
    generation,
  });
  while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
    const first = roleRefsByTarget.keys().next();
    if (first.done) {
      break;
    }
    roleRefsByTarget.delete(first.value);
  }
  return generation;
}

/** Store role refs on the page and target cache. */
export function storeRoleRefsForTarget(opts: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  refs: RoleRefs;
  frameSelector?: string;
  frame?: Frame;
  mode: NonNullable<PageState["roleRefsMode"]>;
}): void {
  if (opts.frameSelector && !opts.frame) {
    throw new Error("Frame-scoped role refs require their resolved frame.");
  }
  const state = ensurePageState(opts.page);
  state.roleRefs = opts.refs;
  state.roleRefsFrameSelector = opts.frameSelector;
  state.roleRefsFrame = opts.frame;
  state.roleRefsMode = opts.mode;
  const targetId = normalizeOptionalString(opts.targetId);
  if (!targetId) {
    state.roleRefsTargetKey = undefined;
    state.roleRefsTargetGeneration = undefined;
    return;
  }
  bindRoleRefsTarget(opts.page, opts.cdpUrl, targetId);
  state.roleRefsTargetGeneration = rememberRoleRefsForTarget({
    cdpUrl: opts.cdpUrl,
    targetId,
    refs: opts.refs,
    frameSelector: opts.frameSelector,
    mode: opts.mode,
  });
}

function clearRoleRefs(state: PageState): void {
  if (state.roleRefsTargetKey) {
    const cached = roleRefsByTarget.get(state.roleRefsTargetKey);
    // A delayed event from an obsolete Page must not erase refs that a newer
    // wrapper stored for the same target after this Page's generation.
    if (cached?.generation === state.roleRefsTargetGeneration) {
      roleRefsByTarget.delete(state.roleRefsTargetKey);
    }
  }
  state.roleRefs = undefined;
  state.roleRefsMode = undefined;
  state.roleRefsFrameSelector = undefined;
  state.roleRefsFrame = undefined;
  state.roleRefsTargetKey = undefined;
  state.roleRefsTargetGeneration = undefined;
}

function currentTargetRoleRefsMode(
  state: PageState,
): NonNullable<PageState["roleRefsMode"]> | undefined {
  if (!state.roleRefsTargetKey) {
    return undefined;
  }
  const cached = roleRefsByTarget.get(state.roleRefsTargetKey);
  return cached && cached.generation === state.roleRefsTargetGeneration ? cached.mode : undefined;
}

/** Restore cached role refs onto a newly resolved page. */
export function restoreRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  page: Page;
}): void {
  const targetId = normalizeOptionalString(opts.targetId) ?? "";
  if (!targetId) {
    return;
  }
  const cacheKey = roleRefsKey(opts.cdpUrl, targetId);
  bindRoleRefsTarget(opts.page, opts.cdpUrl, targetId);
  const cached = roleRefsByTarget.get(cacheKey);
  if (!cached) {
    return;
  }
  const state = ensurePageState(opts.page);
  if (state.roleRefs) {
    return;
  }
  state.roleRefsTargetKey = cacheKey;
  state.roleRefsTargetGeneration = cached.generation;
  state.roleRefs = cached.refs;
  state.roleRefsMode = cached.mode;
}

/** Ensure and attach state listeners for a Playwright page. */
export function ensurePageState(page: Page): PageState {
  const existing = pageStates.get(page);
  if (existing) {
    return existing;
  }

  const state: PageState = {
    console: [],
    errors: [],
    requests: [],
    requestIds: new WeakMap(),
    nextRequestId: 0,
    armIdUpload: 0,
    armIdDownload: 0,
    downloadWaiterDepth: 0,
    nextObservedDialogId: 0,
    pendingDialogs: [],
    recentDialogs: [],
    dialogAbortControllers: new Set(),
  };
  pageStates.set(page, state);

  if (!observedPages.has(page)) {
    observedPages.add(page);
    page.on("console", (msg: ConsoleMessage) => {
      const entry: BrowserConsoleMessage = {
        type: msg.type(),
        text: msg.text(),
        timestamp: new Date().toISOString(),
        location: msg.location(),
      };
      state.console.push(entry);
      if (state.console.length > MAX_CONSOLE_MESSAGES) {
        state.console.shift();
      }
    });
    page.on("pageerror", (err: Error) => {
      state.errors.push({
        message: err.message || String(err),
        name: err.name || undefined,
        stack: err.stack || undefined,
        timestamp: new Date().toISOString(),
      });
      if (state.errors.length > MAX_PAGE_ERRORS) {
        state.errors.shift();
      }
    });
    page.on("request", (req: Request) => {
      state.nextRequestId += 1;
      const id = `r${state.nextRequestId}`;
      state.requestIds.set(req, id);
      state.requests.push({
        id,
        timestamp: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
      });
      if (state.requests.length > MAX_NETWORK_REQUESTS) {
        state.requests.shift();
      }
    });
    page.on("response", (resp: Response) => {
      const req = resp.request();
      const id = state.requestIds.get(req);
      if (!id) {
        return;
      }
      const rec = findNetworkRequestById(state, id);
      if (!rec) {
        return;
      }
      rec.status = resp.status();
      rec.ok = resp.ok();
    });
    page.on("requestfailed", (req: Request) => {
      const id = state.requestIds.get(req);
      if (!id) {
        return;
      }
      const rec = findNetworkRequestById(state, id);
      if (!rec) {
        return;
      }
      rec.failureText = req.failure()?.errorText;
      rec.ok = false;
    });
    page.on("dialog", (dialog: Dialog) => {
      observeDialog(state, dialog);
    });
    page.on("download", (download: DownloadPayload) => {
      if (state.downloadWaiterDepth > 0) {
        return;
      }
      const actionCapture = state.actionDownloadCapture;
      const beforeSave = actionCapture?.beforeSave;
      const captureOptions: BrowserDownloadCaptureOptions | undefined =
        actionCapture && beforeSave
          ? {
              beforeSave: (candidate) => {
                const validation = Promise.resolve().then(() => beforeSave(candidate));
                actionCapture.validations.push(validation);
                return validation;
              },
            }
          : undefined;
      const managedSave = saveBrowserDownload(download, captureOptions);
      managedSave.catch(() => {});
      download.path = async () => (await managedSave).path;
      if (actionCapture) {
        actionCapture.lastEventAtMs = Date.now();
      }
      actionCapture?.pending.push(managedSave);
      for (const finish of actionCapture?.waiters.splice(0) ?? []) {
        finish();
      }
    });
    page.on("framenavigated", (frame) => {
      // Clear role refs on main-frame navigation so stale refs from the
      // previous page are never used to locate elements on the new page.
      // Unscoped refs survive subframe navigation. Frame-scoped refs are
      // invalid only when their exact Frame replaces its document.
      const isMainFrame = frame === page.mainFrame();
      const targetWasBound = state.roleRefsTargetKey !== undefined;
      if (!targetWasBound) {
        // Target discovery is asynchronous. Remember an early navigation so
        // binding removes only cache generations that already existed. Refs a
        // newer Page stores after this event must survive the delayed lookup.
        if (isMainFrame) {
          state.roleRefsInvalidBeforeGeneration = roleRefsCacheGeneration;
        } else {
          state.roleRefsAriaInvalidBeforeGeneration = roleRefsCacheGeneration;
        }
      }
      const pageWideAriaRefs =
        state.roleRefsMode === "aria" || currentTargetRoleRefsMode(state) === "aria";
      if (isMainFrame || pageWideAriaRefs || frame === state.roleRefsFrame) {
        // Replacement Page objects restore from this target cache, so local
        // clearing alone could resurrect refs from the previous document.
        clearRoleRefs(state);
      }
    });
    page.on("framedetached", (frame) => {
      if (!state.roleRefsTargetKey) {
        if (frame === page.mainFrame()) {
          state.roleRefsInvalidBeforeGeneration = roleRefsCacheGeneration;
        } else {
          state.roleRefsAriaInvalidBeforeGeneration = roleRefsCacheGeneration;
        }
      }
      const pageWideAriaRefs =
        state.roleRefsMode === "aria" || currentTargetRoleRefsMode(state) === "aria";
      if (pageWideAriaRefs || frame === state.roleRefsFrame) {
        clearRoleRefs(state);
      }
    });
    page.on("close", () => {
      clearArmedDialogResponse(state);
      for (const controller of state.dialogAbortControllers) {
        if (!controller.signal.aborted) {
          controller.abort(new Error("Page closed before browser action completed."));
        }
      }
      state.dialogAbortControllers.clear();
      state.pendingDialogs = [];
      pageStates.delete(page);
      observedPages.delete(page);
    });
  }

  return state;
}

/** Read observed dialog state from a Playwright page. */
export function getObservedBrowserStateForPage(page: Page): BrowserObservedState {
  const state = ensurePageState(page);
  return serializeObservedBrowserState(state);
}

/** Resolve a page and read its observed browser state. */
export async function getObservedBrowserStateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<BrowserObservedState> {
  const page = await getPageForTargetId(opts);
  return getObservedBrowserStateForPage(page);
}

function resolvePendingDialogForResponse(params: {
  state: PageState;
  dialogId?: string;
}): PendingObservedDialog {
  const dialogId = normalizeOptionalString(params.dialogId);
  if (dialogId) {
    const found = params.state.pendingDialogs.find((dialog) => dialog.id === dialogId);
    if (found) {
      return found;
    }
    throw new Error(`Dialog "${dialogId}" is not pending.`);
  }
  if (params.state.pendingDialogs.length === 1) {
    return expectDefined(params.state.pendingDialogs.at(0), "single pending browser dialog");
  }
  if (params.state.pendingDialogs.length > 1) {
    throw new Error("Multiple dialogs are pending; pass dialogId.");
  }
  throw new Error("No dialog is pending.");
}

/** Respond to a pending observed dialog on a page. */
export async function respondToObservedDialogOnPage(opts: {
  page: Page;
  dialogId?: string;
  accept: boolean;
  promptText?: string;
  closedBy?: "agent" | "armed";
}): Promise<BrowserObservedDialogRecord> {
  const state = ensurePageState(opts.page);
  const pending = resolvePendingDialogForResponse({
    state,
    ...(opts.dialogId !== undefined ? { dialogId: opts.dialogId } : {}),
  });
  return await settleObservedDialog({
    state,
    pending,
    accept: opts.accept,
    ...(opts.promptText !== undefined ? { promptText: opts.promptText } : {}),
    closedBy: opts.closedBy ?? "agent",
  });
}

/** Resolve a page and respond to one of its observed dialogs. */
export async function respondToObservedDialogViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  dialogId?: string;
  accept: boolean;
  promptText?: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<BrowserObservedDialogRecord> {
  const page = await getPageForTargetId(opts);
  return await respondToObservedDialogOnPage({
    page,
    accept: opts.accept,
    ...(opts.dialogId !== undefined ? { dialogId: opts.dialogId } : {}),
    ...(opts.promptText !== undefined ? { promptText: opts.promptText } : {}),
  });
}

/** Mark pending observed dialogs as handled by a remote/browser-side hook. */
export function markObservedDialogsHandledRemotelyForPage(page: Page): BrowserObservedState {
  const state = ensurePageState(page);
  const pending = state.pendingDialogs.splice(0);
  const closedAt = new Date().toISOString();
  for (const dialog of pending) {
    appendRecentDialog(state, {
      id: dialog.id,
      type: dialog.type,
      message: dialog.message,
      ...(dialog.defaultValue !== undefined ? { defaultValue: dialog.defaultValue } : {}),
      openedAt: dialog.openedAt,
      closedAt,
      closedBy: "remote",
    });
  }
  return serializeObservedBrowserState(state);
}

/** Arm a one-shot automatic dialog response for a page. */
export function armObservedDialogResponseOnPage(opts: {
  page: Page;
  accept: boolean;
  promptText?: string;
  timeoutMs?: number;
}): void {
  const state = ensurePageState(opts.page);
  clearArmedDialogResponse(state);
  const timeoutMs = resolveObservedDialogTimeoutMs(opts.timeoutMs);
  const expiresAt = resolveExpiresAtMsFromDurationMs(timeoutMs);
  if (expiresAt === undefined) {
    return;
  }
  const response: ArmedDialogResponse = {
    accept: opts.accept,
    expiresAt,
    ...(opts.promptText !== undefined ? { promptText: opts.promptText } : {}),
  };
  response.timer = setTimeout(() => {
    if (state.armedDialogResponse === response) {
      state.armedDialogResponse = undefined;
    }
  }, timeoutMs);
  state.armedDialogResponse = response;
}

/** Create an abort signal that fires while a dialog blocks the page. */
export function createObservedDialogAbortSignalForPage(opts: {
  page: Page;
  parentSignal?: AbortSignal;
}): { signal: AbortSignal; cleanup: () => void } {
  const state = ensurePageState(opts.page);
  const controller = new AbortController();
  const abortForCurrentDialog = () => {
    if (!controller.signal.aborted) {
      controller.abort(new BrowserObservedDialogBlockedError(serializeObservedBrowserState(state)));
    }
  };
  const abortForParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(opts.parentSignal?.reason ?? new Error("aborted"));
    }
  };

  if (state.pendingDialogs.length > 0) {
    abortForCurrentDialog();
  } else {
    state.dialogAbortControllers.add(controller);
  }
  if (opts.parentSignal) {
    if (opts.parentSignal.aborted) {
      abortForParent();
    } else {
      opts.parentSignal.addEventListener("abort", abortForParent, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      state.dialogAbortControllers.delete(controller);
      opts.parentSignal?.removeEventListener("abort", abortForParent);
    },
  };
}

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

async function connectBrowser(cdpUrl: string, ssrfPolicy?: SsrFPolicy): Promise<ConnectedBrowser> {
  const normalized = normalizeCdpUrl(cdpUrl);
  const cached = cachedByCdpUrl.get(normalized);
  if (cached) {
    return cached;
  }
  // Run SSRF policy check only on cache miss so transient DNS failures
  // do not break active sessions that already hold a live CDP connection.
  await assertCdpEndpointAllowed(normalized, ssrfPolicy);
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
        const wsUrl = await getChromeWebSocketUrl(normalized, timeout, ssrfPolicy).catch(
          () => null,
        );
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
          // Bypass proxy for loopback CDP connections (#31219)
          return await withNoProxyForCdpUrl(connectionUrl, () =>
            chromium.connectOverCDP(connectionUrl, { timeout, headers }),
          );
        };
        let browser: Browser;
        try {
          browser = await connectEndpoint(endpoint);
        } catch (err) {
          if (!isWebSocketUrl(normalized) || endpoint === normalized) {
            throw err;
          }
          browser = await connectEndpoint(normalized);
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
        if (connectionAttempt.cancelled) {
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

async function getAllPages(browser: Browser): Promise<Page[]> {
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
    const targetId = await pageTargetId(page).catch(() => null);
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

async function pageTargetId(page: Page): Promise<string | null> {
  const session = await page.context().newCDPSession(page);
  try {
    const info = (await session.send("Target.getTargetInfo")) as TargetInfoResponse;
    const targetId = normalizeOptionalString(info?.targetInfo?.targetId) ?? "";
    return targetId || null;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function getPageForTargetIdOnce(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<Page> {
  if (opts.targetId && isBlockedTarget(opts.cdpUrl, opts.targetId)) {
    throw new BlockedBrowserTargetError();
  }
  const { browser } = await connectBrowser(opts.cdpUrl, opts.ssrfPolicy);
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
}): Promise<Page> {
  const reusedCachedBrowser = hasCachedPlaywrightBrowserConnection(opts.cdpUrl);
  try {
    return await getPageForTargetIdOnce(opts);
  } catch (err) {
    if (!isRecoverableStalePageSelectionError(err, reusedCachedBrowser)) {
      throw err;
    }
    retirePlaywrightBrowserConnection({ cdpUrl: opts.cdpUrl });
    return await getPageForTargetIdOnce(opts);
  }
}

export type BrowserDocumentNavigationRequestKind = "top-level" | "subframe";

/** Classify requests that can navigate the selected page or one of its frames. */
export function classifyBrowserDocumentNavigationRequest(
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
    throw toLintErrorObject(firstGuardError, "Non-Error thrown");
  }
  if (actionFailed) {
    throw toLintErrorObject(actionError, "Non-Error thrown");
  }
  if (cleanupError !== undefined) {
    throw toLintErrorObject(cleanupError, "Non-Error thrown");
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

  await opts.page.route("**", handler);
  try {
    const response = await opts.page.goto(opts.url, { timeout: opts.timeoutMs });
    if (blockedError) {
      throw toLintErrorObject(blockedError, "Non-Error thrown");
    }
    return response;
  } catch (err) {
    if (blockedError) {
      throw toLintErrorObject(blockedError, "Non-Error thrown");
    }
    throw err;
  } finally {
    await opts.page.unroute("**", handler).catch(() => {});
    if (blockedError) {
      await closeBlockedNavigationTarget({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        targetId: opts.targetId,
      });
    }
  }
}

/** Resolve a browser snapshot ref into a Playwright locator. */
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
  await assertCdpEndpointAllowed(wsUrl, cdpControlPolicy, {
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
    { handshakeTimeoutMs: 2000 },
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
      const results: Array<{
        targetId: string;
        title: string;
        url: string;
        type: string;
      }> = [];

      for (const page of pages) {
        if (isBlockedPageRef(opts.cdpUrl, page)) {
          continue;
        }
        let tid: string | null;
        try {
          tid = await pageTargetId(page);
        } catch (err) {
          if (isRecoverablePlaywrightDisconnectError(err)) {
            throw err;
          }
          tid = null;
        }
        if (tid && !isBlockedTarget(opts.cdpUrl, tid)) {
          let title = "";
          try {
            title = await page.title();
          } catch (err) {
            if (isRecoverablePlaywrightDisconnectError(err)) {
              throw err;
            }
          }
          let url = "";
          try {
            url = page.url();
          } catch (err) {
            if (isRecoverablePlaywrightDisconnectError(err)) {
              throw err;
            }
          }
          results.push({
            targetId: tid,
            title,
            url,
            type: "page",
          });
        }
      }
      return results;
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
  const createdTargetId = await pageTargetId(page).catch(() => null);
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
  const tid = createdTargetId || (await pageTargetId(page).catch(() => null));
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
  try {
    await page.bringToFront();
  } catch (err) {
    try {
      await withPageScopedCdpClient({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: opts.targetId,
        fn: async (send) => {
          await send("Page.bringToFront");
        },
      });
    } catch {
      throw err;
    }
  }
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
