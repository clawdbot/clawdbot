import crypto from "node:crypto";
import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
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
  withCdpSocket,
} from "./cdp.helpers.js";
import { AX_REF_PATTERN, normalizeCdpWsUrl } from "./cdp.js";
import { getChromeWebSocketUrl } from "./chrome.js";
import { BrowserTabNotFoundError } from "./errors.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  InvalidBrowserNavigationUrlError,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { writeViaSiblingTempPath } from "./output-atomic.js";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";
import { playwrightCore } from "./playwright-core.runtime.js";
import { BROWSER_REF_MARKER_ATTRIBUTE, withPageScopedCdpClient } from "./pw-session.page-cdp.js";
import { sanitizeUntrustedFileName } from "./safe-filename.js";

const { chromium } = playwrightCore;

export type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
};

export type BrowserPageError = {
  message: string;
  name?: string;
  stack?: string;
  timestamp: string;
};

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

type PageState = {
  console: BrowserConsoleMessage[];
  errors: BrowserPageError[];
  requests: BrowserNetworkRequest[];
  requestIds: WeakMap<Request, string>;
  nextRequestId: number;
  armIdUpload: number;
  armIdDialog: number;
  armIdDownload: number;
  downloadWaiterDepth: number;
  /**
   * Role-based refs from the last role snapshot (e.g. e1/e2).
   * Mode "role" refs are generated from ariaSnapshot and resolved via getByRole.
   * Mode "aria" refs are Playwright aria-ref ids and resolved via `aria-ref=...`.
   */
  roleRefs?: Record<string, { role: string; name?: string; nth?: number; domMarker?: boolean }>;
  roleRefsMode?: "role" | "aria";
  roleRefsFrameSelector?: string;
};

type RoleRefs = NonNullable<PageState["roleRefs"]>;
type RoleRefsCacheEntry = {
  refs: RoleRefs;
  frameSelector?: string;
  mode?: NonNullable<PageState["roleRefsMode"]>;
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

const MAX_CONSOLE_MESSAGES = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;

const cachedByCdpUrl = new Map<string, ConnectedBrowser>();
const connectingByCdpUrl = new Map<string, Promise<ConnectedBrowser>>();
const blockedTargetsByCdpUrl = new Set<string>();
const blockedPageRefsByCdpUrl = new Map<string, WeakSet<Page>>();

function normalizeCdpUrl(raw: string) {
  return raw.replace(/\/$/, "");
}

function buildManagedDownloadPath(fileName: string): string {
  const id = crypto.randomUUID();
  const safeName = sanitizeUntrustedFileName(fileName, "download.bin");
  return path.join(DEFAULT_DOWNLOAD_DIR, `${id}-${safeName}`);
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

function targetKey(cdpUrl: string, targetId: string) {
  return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}

function roleRefsKey(cdpUrl: string, targetId: string) {
  return targetKey(cdpUrl, targetId);
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
  connectingByCdpUrl.delete(normalized);
  if (!cur) {
    return null;
  }
  if (cur.onDisconnected && typeof cur.browser.off === "function") {
    cur.browser.off("disconnected", cur.onDisconnected);
  }
  return cur;
}

function evictStalePlaywrightBrowserConnection(cdpUrl: string): void {
  const cur = takeCachedPlaywrightBrowserConnection(cdpUrl);
  cur?.browser.close().catch(() => {});
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

export class BlockedBrowserTargetError extends Error {
  constructor() {
    super("Browser target is unavailable after SSRF policy blocked its navigation.");
    this.name = "BlockedBrowserTargetError";
  }
}

export function rememberRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode?: NonNullable<PageState["roleRefsMode"]>;
}): void {
  const targetId = normalizeOptionalString(opts.targetId) ?? "";
  if (!targetId) {
    return;
  }
  roleRefsByTarget.set(roleRefsKey(opts.cdpUrl, targetId), {
    refs: opts.refs,
    ...(opts.frameSelector ? { frameSelector: opts.frameSelector } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
    const first = roleRefsByTarget.keys().next();
    if (first.done) {
      break;
    }
    roleRefsByTarget.delete(first.value);
  }
}

export function storeRoleRefsForTarget(opts: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode: NonNullable<PageState["roleRefsMode"]>;
}): void {
  const state = ensurePageState(opts.page);
  state.roleRefs = opts.refs;
  state.roleRefsFrameSelector = opts.frameSelector;
  state.roleRefsMode = opts.mode;
  const targetId = normalizeOptionalString(opts.targetId);
  if (!targetId) {
    return;
  }
  rememberRoleRefsForTarget({
    cdpUrl: opts.cdpUrl,
    targetId,
    refs: opts.refs,
    frameSelector: opts.frameSelector,
    mode: opts.mode,
  });
}

export function restoreRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  page: Page;
}): void {
  const targetId = normalizeOptionalString(opts.targetId) ?? "";
  if (!targetId) {
    return;
  }
  const cached = roleRefsByTarget.get(roleRefsKey(opts.cdpUrl, targetId));
  if (!cached) {
    return;
  }
  const state = ensurePageState(opts.page);
  if (state.roleRefs) {
    return;
  }
  state.roleRefs = cached.refs;
  state.roleRefsFrameSelector = cached.frameSelector;
  state.roleRefsMode = cached.mode;
}

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
    armIdDialog: 0,
    armIdDownload: 0,
    downloadWaiterDepth: 0,
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
    page.on(
      "download",
      (download: {
        suggestedFilename?: () => string;
        saveAs?: (outPath: string) => Promise<void>;
        path?: () => Promise<string>;
      }) => {
        if (state.downloadWaiterDepth > 0) {
          return;
        }
        const suggested = sanitizeUntrustedFileName(
          download.suggestedFilename?.() || "download.bin",
          "download.bin",
        );
        const managedPath = buildManagedDownloadPath(suggested);
        const managedSave = (async () => {
          await writeViaSiblingTempPath({
            rootDir: DEFAULT_DOWNLOAD_DIR,
            targetPath: managedPath,
            writeTemp: async (tempPath) => {
              await download.saveAs?.(tempPath);
            },
          });
          return managedPath;
        })();
        managedSave.catch(() => {});
        download.path = async () => await managedSave;
      },
    );
    page.on("close", () => {
      pageStates.delete(page);
      observedPages.delete(page);
    });
  }

  return state;
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
    return await connecting;
  }

  const connectWithRetry = async (): Promise<ConnectedBrowser> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const timeout = 5000 + attempt * 2000;
        const wsUrl = await getChromeWebSocketUrl(normalized, timeout, ssrfPolicy).catch(
          () => null,
        );
        const endpoint = wsUrl ?? normalized;
        const connectEndpoint = async (target: string) => {
          const headers = getHeadersWithAuth(target);
          // Bypass proxy for loopback CDP connections (#31219)
          return await withNoProxyForCdpUrl(target, () =>
            chromium.connectOverCDP(target, { timeout, headers }),
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
        // Don't retry rate-limit errors; retrying worsens the 429.
        const errMsg = formatErrorMessage(err);
        if (errMsg.includes("rate limit")) {
          break;
        }
        const delay = 250 + attempt * 250;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (lastErr instanceof Error) {
      throw lastErr;
    }
    const message = lastErr ? formatErrorMessage(lastErr) : "CDP connect failed";
    throw new Error(message);
  };

  const pending = connectWithRetry().finally(() => {
    connectingByCdpUrl.delete(normalized);
  });
  connectingByCdpUrl.set(normalized, pending);

  return await pending;
}

async function getAllPages(browser: Browser): Promise<Page[]> {
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());
  return pages;
}

async function partitionAccessiblePages(opts: {
  cdpUrl: string;
  pages: Page[];
}): Promise<{ accessible: Page[]; blockedCount: number }> {
  const accessible: Page[] = [];
  let blockedCount = 0;
  for (const page of opts.pages) {
    if (isBlockedPageRef(opts.cdpUrl, page)) {
      blockedCount += 1;
      continue;
    }
    const targetId = await pageTargetId(page).catch(() => null);
    // Fail closed when we cannot resolve a target id while this session has
    // quarantined targets; otherwise a blocked tab can become selectable.
    if (!targetId) {
      if (hasBlockedTargetsForCdpUrl(opts.cdpUrl)) {
        blockedCount += 1;
        continue;
      }
      accessible.push(page);
      continue;
    }
    if (isBlockedTarget(opts.cdpUrl, targetId)) {
      blockedCount += 1;
      continue;
    }
    accessible.push(page);
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

function matchPageByTargetList(
  pages: Page[],
  targets: Array<{ id: string; url: string; title?: string }>,
  targetId: string,
): Page | null {
  const target = targets.find((entry) => entry.id === targetId);
  if (!target) {
    return null;
  }

  const urlMatch = pages.filter((page) => page.url() === target.url);
  if (urlMatch.length === 1) {
    return urlMatch[0] ?? null;
  }
  if (urlMatch.length > 1) {
    const sameUrlTargets = targets.filter((entry) => entry.url === target.url);
    if (sameUrlTargets.length === urlMatch.length) {
      const idx = sameUrlTargets.findIndex((entry) => entry.id === targetId);
      if (idx >= 0 && idx < urlMatch.length) {
        return urlMatch[idx] ?? null;
      }
    }
  }
  return null;
}

async function findPageByTargetIdViaTargetList(
  pages: Page[],
  targetId: string,
  cdpUrl: string,
  ssrfPolicy?: SsrFPolicy,
): Promise<Page | null> {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(cdpUrl);
  await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
  const targets = await fetchJson<
    Array<{
      id: string;
      url: string;
      title?: string;
    }>
  >(appendCdpPath(cdpHttpBase, "/json/list"), 2000);
  return matchPageByTargetList(pages, targets, targetId);
}

async function findPageByTargetId(
  browser: Browser,
  targetId: string,
  cdpUrl?: string,
  ssrfPolicy?: SsrFPolicy,
): Promise<Page | null> {
  const pages = await getAllPages(browser);
  let resolvedViaCdp = false;
  for (const page of pages) {
    let tid: string | null = null;
    try {
      tid = await pageTargetId(page);
      resolvedViaCdp = true;
    } catch {
      tid = null;
    }
    if (tid && tid === targetId) {
      return page;
    }
  }
  if (cdpUrl) {
    try {
      return await findPageByTargetIdViaTargetList(pages, targetId, cdpUrl, ssrfPolicy);
    } catch {
      // Ignore fetch errors and fall through to return null.
    }
  }
  if (!resolvedViaCdp && pages.length === 1) {
    return pages[0] ?? null;
  }
  return null;
}

async function resolvePageByTargetIdOrThrow(opts: {
  cdpUrl: string;
  targetId: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<Page> {
  if (isBlockedTarget(opts.cdpUrl, opts.targetId)) {
    throw new BlockedBrowserTargetError();
  }
  const { browser } = await connectBrowser(opts.cdpUrl, opts.ssrfPolicy);
  const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl, opts.ssrfPolicy);
  if (!page) {
    throw new BrowserTabNotFoundError();
  }
  return page;
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
  const first = accessible[0];
  if (!opts.targetId) {
    return first;
  }
  const found = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl, opts.ssrfPolicy);
  if (found) {
    if (isBlockedPageRef(opts.cdpUrl, found)) {
      throw new BlockedBrowserTargetError();
    }
    const foundTargetId = await pageTargetId(found).catch(() => null);
    if (foundTargetId && isBlockedTarget(opts.cdpUrl, foundTargetId)) {
      throw new BlockedBrowserTargetError();
    }
    return found;
  }
  // If Playwright only exposes a single Page total, use it as a best-effort fallback.
  if (pages.length === 1) {
    return first;
  }
  throw new BrowserTabNotFoundError();
}

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
    await closePlaywrightBrowserConnection({ cdpUrl: opts.cdpUrl });
    return await getPageForTargetIdOnce(opts);
  }
}

function isTopLevelNavigationRequest(page: Page, request: Request): boolean {
  let sameMainFrame = false;
  try {
    sameMainFrame = request.frame() === page.mainFrame();
  } catch {
    // Frame resolution can fail during redirect/renderer churn; fail closed.
    sameMainFrame = true;
  }
  if (!sameMainFrame) {
    return false;
  }

  try {
    if (request.isNavigationRequest()) {
      return true;
    }
  } catch {
    // Ignore and fall back to resource-type check below.
  }

  try {
    return request.resourceType() === "document";
  } catch {
    return false;
  }
}

function isSubframeDocumentNavigationRequest(page: Page, request: Request): boolean {
  let sameMainFrame = false;
  try {
    sameMainFrame = request.frame() === page.mainFrame();
  } catch {
    // Fail closed: if frame resolution throws after the top-level check already
    // determined this is NOT the main frame, treat it as a subframe document
    // navigation so the SSRF guard still fires. Returning false here would let
    // transient renderer churn skip the policy check entirely.
    return true;
  }
  if (sameMainFrame) {
    return false;
  }

  try {
    if (request.isNavigationRequest()) {
      return true;
    }
  } catch {
    // Fall through to the resource-type check.
  }

  try {
    return request.resourceType() === "document";
  } catch {
    return false;
  }
}

export function isPolicyDenyNavigationError(err: unknown): boolean {
  return err instanceof SsrFBlockedError || err instanceof InvalidBrowserNavigationUrlError;
}

// Mark a page (and its CDP target id when resolvable) as blocked so subsequent
// OpenClaw operations short-circuit instead of re-running the SSRF check on a
// page we have already proven is non-compliant. This is a pure bookkeeping
// step; it does NOT close the tab. Read-only paths can call this safely on a
// user-owned tab without losing the user's content.
async function quarantineBlockedTarget(opts: {
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
export async function closeBlockedNavigationTarget(opts: {
  cdpUrl: string;
  page: Page;
  targetId?: string;
}): Promise<void> {
  await quarantineBlockedTarget(opts);
  await opts.page.close().catch(() => {});
}

// On policy denial: quarantines and rethrows (never closes).
// Navigate-style callers catch the rethrow and close via closeBlockedNavigationTarget.
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
      await quarantineBlockedTarget({
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
    const isTopLevel = isTopLevelNavigationRequest(opts.page, request);
    const isSubframeDocument =
      !isTopLevel && isSubframeDocumentNavigationRequest(opts.page, request);
    if (!isTopLevel && !isSubframeDocument) {
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
        if (isTopLevel) {
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
      throw blockedError;
    }
    return response;
  } catch (err) {
    if (blockedError) {
      throw blockedError;
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

export function refLocator(page: Page, ref: string) {
  const normalized = ref.startsWith("@")
    ? ref.slice(1)
    : ref.startsWith("ref=")
      ? ref.slice(4)
      : ref;

  if (/^e\d+$/.test(normalized)) {
    const state = pageStates.get(page);
    if (state?.roleRefsMode === "aria") {
      const scope = state.roleRefsFrameSelector
        ? page.frameLocator(state.roleRefsFrameSelector)
        : page;
      return scope.locator(`aria-ref=${normalized}`);
    }
    const info = state?.roleRefs?.[normalized];
    if (!info) {
      throw new Error(
        `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
      );
    }
    const scope = state?.roleRefsFrameSelector
      ? page.frameLocator(state.roleRefsFrameSelector)
      : page;
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
    const scope = state.roleRefsFrameSelector
      ? page.frameLocator(state.roleRefsFrameSelector)
      : page;
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

export async function closePlaywrightBrowserConnection(opts?: { cdpUrl?: string }): Promise<void> {
  const normalized = opts?.cdpUrl ? normalizeCdpUrl(opts.cdpUrl) : null;

  if (normalized) {
    clearBlockedTargetsForCdpUrl(normalized);
    clearBlockedPageRefsForCdpUrl(normalized);
    const cur = takeCachedPlaywrightBrowserConnection(normalized);
    if (!cur) {
      return;
    }
    await cur.browser.close().catch(() => {});
    return;
  }

  const connections = Array.from(cachedByCdpUrl.values());
  clearBlockedTargetsForCdpUrl();
  clearBlockedPageRefsForCdpUrl();
  cachedByCdpUrl.clear();
  connectingByCdpUrl.clear();
  for (const cur of connections) {
    if (cur.onDisconnected && typeof cur.browser.off === "function") {
      cur.browser.off("disconnected", cur.onDisconnected);
    }
    await cur.browser.close().catch(() => {});
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
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(opts.cdpUrl);
  const listUrl = appendCdpPath(cdpHttpBase, "/json/list");

  const pages = await fetchJson<
    Array<{
      id?: string;
      webSocketDebuggerUrl?: string;
    }>
  >(listUrl, 2000).catch(() => null);
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
 * 1. Null out `cached` so the next call triggers a fresh connectOverCDP
 * 2. Fire-and-forget browser.close() — it may hang but won't block us
 * 3. The next connectBrowser() creates a completely new CDP WebSocket connection
 *
 * The old browser.close() eventually resolves when the in-browser evaluate timeout fires,
 * or the old connection gets GC'd. Either way, it doesn't affect the fresh connection.
 */
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
  cur.browser.close().catch(() => {});
}

async function withPlaywrightSafeReadReconnect<T>(
  cdpUrl: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isRecoverablePlaywrightDisconnectError(err)) {
      throw err;
    }
    evictStalePlaywrightBrowserConnection(cdpUrl);
    return await run();
  }
}

/**
 * List all pages/tabs from the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/list is ephemeral.
 */
export async function listPagesViaPlaywright(opts: {
  cdpUrl: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<
  Array<{
    targetId: string;
    title: string;
    url: string;
    type: string;
  }>
> {
  return await withPlaywrightSafeReadReconnect(opts.cdpUrl, async () => {
    const { browser } = await connectBrowser(opts.cdpUrl, opts.ssrfPolicy);
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
  });
}

/**
 * Create a new page/tab using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/new is ephemeral.
 * Returns the new page's targetId and metadata.
 */
export async function createPageViaPlaywright(
  opts: {
    cdpUrl: string;
    url: string;
  } & BrowserNavigationPolicyOptions,
): Promise<{
  targetId: string;
  title: string;
  url: string;
  type: string;
}> {
  const { browser } = await connectBrowser(opts.cdpUrl, opts.ssrfPolicy);
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
  const page = await resolvePageByTargetIdOrThrow(opts);
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
  const page = await resolvePageByTargetIdOrThrow(opts);
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
      return;
    } catch {
      throw err;
    }
  }
}
