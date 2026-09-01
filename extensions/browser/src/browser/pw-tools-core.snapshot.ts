/**
 * Snapshot, navigation, viewport, close, and PDF helpers for Playwright-backed
 * browser tools.
 */
import { parseFiniteNumber, resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe, withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import type { Frame, Page } from "playwright-core";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { ACT_MAX_VIEWPORT_DIMENSION, resolveBrowserNavigationTimeoutMs } from "./act-policy.js";
import { type AriaSnapshotNode, formatAriaSnapshot, type RawAXNode } from "./cdp.js";
import type { BrowserDownloadResult } from "./download-types.js";
import { BrowserTabNotFoundError } from "./errors.js";
import type { RelayOperationReference } from "./extension-relay/owner-client.js";
import { closeRelayOperationConnection } from "./extension-relay/owner-playwright.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { createDownloadCaptureForPage } from "./pw-download-capture.js";
import {
  buildRoleSnapshotFromAiSnapshot,
  buildRoleSnapshotFromAriaSnapshot,
  finalizeRoleSnapshot,
  type RoleSnapshotIdentityMode,
  type RoleSnapshotOptions,
  type RoleRefMap,
} from "./pw-role-snapshot.js";
import { connectBrowser, pageTargetInfo } from "./pw-session-connection.js";
import {
  assertPageNavigationCompletedSafely,
  closeBlockedNavigationTarget,
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  gotoPageWithNavigationGuard,
  isDownloadStartingNavigationError,
  isPolicyDenyNavigationError,
  storeRoleRefsForTarget,
} from "./pw-session.js";
import {
  markBackendDomRefsOnPage,
  readMainFrameDocumentIdentityForPage,
  withPageScopedCdpClient,
} from "./pw-session.page-cdp.js";
import { appendSnapshotUrls, type SnapshotUrlEntry } from "./snapshot-urls.js";

type StoredSnapshotRef = RoleRefMap[string] & { backendDOMNodeId?: number };

function resolveBoundedTimeoutMs(
  timeoutMs: number | undefined,
  fallbackMs: number,
  minMs: number,
  maxMs: number,
): number {
  const parsed = parseFiniteNumber(timeoutMs);
  return Math.max(minMs, Math.min(maxMs, Math.floor(parsed ?? fallbackMs)));
}

function resolveSnapshotTimeoutMs(timeoutMs: number | undefined): number {
  return resolveBoundedTimeoutMs(timeoutMs, 5_000, 500, 60_000);
}

function resolveViewportDimension(value: unknown, label: "width" | "height"): number {
  const dimension = resolveIntegerOption(value, 1, { min: 1 });
  if (dimension > ACT_MAX_VIEWPORT_DIMENSION) {
    throw new Error(`viewport ${label} exceeds maximum of ${ACT_MAX_VIEWPORT_DIMENSION}`);
  }
  return dimension;
}

async function collectSnapshotUrls(page: Page): Promise<SnapshotUrlEntry[]> {
  const urls = await page
    .evaluate(() => {
      const seen = new Set<string>();
      const out: SnapshotUrlEntry[] = [];
      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const href = anchor instanceof HTMLAnchorElement ? anchor.href : "";
        if (!href || seen.has(href)) {
          continue;
        }
        const text =
          (anchor.textContent || anchor.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 121) || href;
        seen.add(href);
        out.push({ text, url: href });
        if (out.length >= 100) {
          break;
        }
      }
      return out;
    })
    .catch(() => []);
  return Array.isArray(urls)
    ? urls.map((entry) => {
        entry.text = truncateUtf16Safe(entry.text, 120) || entry.url;
        return entry;
      })
    : [];
}

function buildStoredAriaRefs(nodes: AriaSnapshotNode[]): Record<string, StoredSnapshotRef> {
  const refs: Record<string, StoredSnapshotRef> = {};
  const groups = new Map<string, { count: number; firstRef: string }>();

  for (const node of nodes) {
    const role = normalizeLowercaseStringOrEmpty(node.role) || "unknown";
    const name = node.name.trim();
    const key = `${role}:${name}`;
    const group = groups.get(key);
    const nth = group?.count ?? 0;
    if (group) {
      group.count += 1;
    } else {
      groups.set(key, { count: 1, firstRef: node.ref });
    }
    refs[node.ref] = {
      role,
      name,
      // Keep index zero for duplicates; only singleton groups can omit nth.
      nth,
      ...(typeof node.backendDOMNodeId === "number"
        ? { backendDOMNodeId: node.backendDOMNodeId }
        : {}),
    };
  }

  // Resolve by ref after grouping: later input nodes can overwrite the same ref.
  for (const { count, firstRef } of groups.values()) {
    if (count === 1 && firstRef) {
      delete refs[firstRef]?.nth;
    }
  }

  return refs;
}

/** Publish raw or finalized snapshot refs into the Playwright action cache. */
export async function storeSnapshotRefsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  page?: Page;
  nodes?: AriaSnapshotNode[];
  refs?: Record<string, StoredSnapshotRef>;
  expectedDocumentIdentity?: string;
}): Promise<void> {
  const sourceRefs = opts.refs ?? buildStoredAriaRefs(opts.nodes ?? []);
  const page =
    opts.page ??
    (await getPageForTargetId({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
    }));
  ensurePageState(page);
  const markedRefs = await markBackendDomRefsOnPage({
    page,
    refs: Object.entries(sourceRefs).flatMap(([ref, info]) =>
      typeof info.backendDOMNodeId === "number"
        ? [{ ref, backendDOMNodeId: info.backendDOMNodeId }]
        : [],
    ),
  });
  if (
    opts.expectedDocumentIdentity &&
    (await readMainFrameDocumentIdentityForPage(page)) !== opts.expectedDocumentIdentity
  ) {
    throw new Error("Frame changed while its browser snapshot refs were being published; retry.");
  }
  const refs: RoleRefMap = Object.fromEntries(
    Object.entries(sourceRefs).map(([ref, info]) => {
      const storedInfo = { ...info };
      delete storedInfo.backendDOMNodeId;
      return [ref, { ...storedInfo, ...(markedRefs.has(ref) ? { domMarker: true } : {}) }];
    }),
  );
  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs,
    mode: "role",
  });
}

async function prepareSnapshotPageViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<Page> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);
  if (opts.ssrfPolicy) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }
  return page;
}

/** Captures a raw accessibility tree snapshot and stores matching role refs. */
export async function snapshotAriaViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  limit?: number;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ nodes: AriaSnapshotNode[] }> {
  const limit = resolveIntegerOption(opts.limit, 500, { min: 1, max: 2000 });
  const page = await prepareSnapshotPageViaPlaywright({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  const ariaTimeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? Math.max(500, Math.min(60_000, Math.floor(opts.timeoutMs)))
      : undefined;
  const collectAxTree = withPageScopedCdpClient({
    cdpUrl: opts.cdpUrl,
    page,
    targetId: opts.targetId,
    fn: async (send) => {
      await send("Accessibility.enable").catch(() => {});
      return (await send("Accessibility.getFullAXTree")) as {
        nodes?: RawAXNode[];
      };
    },
  });
  const res = await withTimeout(collectAxTree, ariaTimeoutMs ?? 0, {
    message: `Aria snapshot via Playwright timed out after ${ariaTimeoutMs}ms.`,
  });
  const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
  const formatted = formatAriaSnapshot(nodes, limit);
  await storeSnapshotRefsViaPlaywright({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    nodes: formatted,
    page,
  });
  return { nodes: formatted };
}

/** Captures Playwright's AI aria snapshot with optional URL appendix and truncation. */
export async function snapshotAiViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timeoutMs?: number;
  maxChars?: number;
  urls?: boolean;
  ssrfPolicy?: SsrFPolicy;
  delta?: { mode: RoleSnapshotIdentityMode; previousKeys?: ReadonlySet<string> };
}): Promise<{
  snapshot: string;
  truncated?: boolean;
  refs: RoleRefMap;
  newElements?: number;
}> {
  const page = await prepareSnapshotPageViaPlaywright({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });

  return await withSnapshotFrameGuard({
    page,
    run: async (isFrameCurrent) => {
      let snapshot = await page.ariaSnapshot({
        mode: "ai",
        timeout: resolveSnapshotTimeoutMs(opts.timeoutMs),
      });
      if (opts.urls) {
        snapshot = appendSnapshotUrls(snapshot, await collectSnapshotUrls(page));
      }
      const built = buildRoleSnapshotFromAiSnapshot(snapshot);
      const finalized = finalizeRoleSnapshot({
        snapshot,
        refs: built.refs,
        maxChars: opts.maxChars,
        delta: opts.delta,
      });
      assertSnapshotFrameCurrent(isFrameCurrent);
      storeRoleRefsForTarget({
        page,
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        refs: finalized.refs,
        mode: "aria",
      });
      return finalized;
    },
  });
}

function assertSnapshotFrameCurrent(isFrameCurrent: () => boolean): void {
  if (!isFrameCurrent()) {
    throw new Error("Frame changed while its browser snapshot was being captured; retry.");
  }
}

async function withSnapshotFrameGuard<T>(opts: {
  page: Page;
  /** Omit for page-wide AI snapshots, whose refs can include every frame. */
  frame?: Frame;
  run: (isFrameCurrent: () => boolean) => Promise<T>;
}): Promise<T> {
  let frameCurrent = true;
  const onFrameChanged = (frame: Frame) => {
    if (!opts.frame || frame === opts.frame) {
      frameCurrent = false;
    }
  };
  opts.page.on("framenavigated", onFrameChanged);
  opts.page.on("framedetached", onFrameChanged);
  try {
    return await opts.run(() => frameCurrent);
  } finally {
    opts.page.off("framenavigated", onFrameChanged);
    opts.page.off("framedetached", onFrameChanged);
  }
}

async function finalizeRoleSnapshotViaPlaywright(params: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  frameSelector?: string;
  frame?: Frame;
  isFrameCurrent?: () => boolean;
  mode: "aria" | "role";
  built: { snapshot: string; refs: RoleRefMap };
  urls?: boolean;
  maxChars?: number;
  delta?: { mode: RoleSnapshotIdentityMode; previousKeys?: ReadonlySet<string> };
}): Promise<{
  snapshot: string;
  truncated?: boolean;
  refs: RoleRefMap;
  stats: { lines: number; chars: number; refs: number; interactive: number };
  newElements?: number;
}> {
  const snapshot = params.urls
    ? appendSnapshotUrls(params.built.snapshot, await collectSnapshotUrls(params.page))
    : params.built.snapshot;
  if (params.isFrameCurrent) {
    assertSnapshotFrameCurrent(params.isFrameCurrent);
  }
  const finalized = finalizeRoleSnapshot({
    snapshot,
    refs: params.built.refs,
    maxChars: params.maxChars,
    delta: params.delta,
  });
  storeRoleRefsForTarget({
    page: params.page,
    cdpUrl: params.cdpUrl,
    targetId: params.targetId,
    refs: finalized.refs,
    ...(params.frameSelector ? { frameSelector: params.frameSelector } : {}),
    ...(params.frame ? { frame: params.frame } : {}),
    mode: params.mode,
  });
  return finalized;
}

/** Captures a role-ref snapshot used by model-facing browser interaction tools. */
export async function snapshotRoleViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  selector?: string;
  frameSelector?: string;
  refsMode?: "role" | "aria";
  options?: RoleSnapshotOptions;
  urls?: boolean;
  maxChars?: number;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  delta?: { mode: RoleSnapshotIdentityMode; previousKeys?: ReadonlySet<string> };
}): Promise<{
  snapshot: string;
  truncated?: boolean;
  refs: Record<string, { role: string; name?: string; nth?: number }>;
  stats: { lines: number; chars: number; refs: number; interactive: number };
  newElements?: number;
}> {
  const page = await prepareSnapshotPageViaPlaywright({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });

  const ariaSnapshotTimeout = resolveSnapshotTimeoutMs(opts.timeoutMs);

  if (opts.refsMode === "aria") {
    if (normalizeOptionalString(opts.selector) || normalizeOptionalString(opts.frameSelector)) {
      throw new Error("refs=aria does not support selector/frame snapshots yet.");
    }
    return await withSnapshotFrameGuard({
      page,
      run: async (isFrameCurrent) => {
        const snapshot = await page.ariaSnapshot({
          mode: "ai",
          timeout: ariaSnapshotTimeout,
        });
        const built = buildRoleSnapshotFromAiSnapshot(snapshot, opts.options);
        return await finalizeRoleSnapshotViaPlaywright({
          page,
          cdpUrl: opts.cdpUrl,
          targetId: opts.targetId,
          isFrameCurrent,
          built,
          mode: "aria",
          urls: opts.urls,
          maxChars: opts.maxChars,
          delta: opts.delta,
        });
      },
    });
  }

  const frameSelector = normalizeOptionalString(opts.frameSelector) ?? "";
  const selector = normalizeOptionalString(opts.selector) ?? "";
  const frameElement = frameSelector
    ? await page.locator(frameSelector).elementHandle({ timeout: ariaSnapshotTimeout })
    : undefined;
  let frame: Frame | undefined;
  if (frameElement) {
    try {
      frame = (await frameElement.contentFrame()) ?? undefined;
    } finally {
      await frameElement.dispose();
    }
  }
  if (frameSelector && !frame) {
    throw new Error("Frame was unavailable while its browser snapshot was being captured.");
  }
  return await withSnapshotFrameGuard({
    page,
    frame: frame ?? page.mainFrame(),
    run: async (isFrameCurrent) => {
      const snapshotScope = frame ?? page;
      const locator = snapshotScope.locator(selector || ":root");
      const captureDeadline = performance.now() + ariaSnapshotTimeout;
      // Count has no timeout; both capture stages share one budget before refs are published.
      const selectorMatched =
        !selector ||
        (await withTimeout(locator.count(), ariaSnapshotTimeout, "Role snapshot selector")) > 0;
      const ariaSnapshot = selectorMatched
        ? await locator.ariaSnapshot({
            // A zero Playwright timeout disables its deadline.
            timeout: selector
              ? Math.max(1, captureDeadline - performance.now())
              : ariaSnapshotTimeout,
          })
        : "";
      const built = buildRoleSnapshotFromAriaSnapshot(ariaSnapshot ?? "", opts.options);
      return await finalizeRoleSnapshotViaPlaywright({
        page,
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        frameSelector: frameSelector || undefined,
        frame: frame ?? undefined,
        isFrameCurrent,
        built,
        mode: "role",
        urls: opts.urls && selectorMatched,
        maxChars: opts.maxChars,
        delta: opts.delta,
      });
    },
  });
}

/** Navigates the target page while enforcing browser SSRF policy before and after load. */
export async function navigateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  resolveOperationTarget?: () => string | undefined | Promise<string | undefined>;
  relayReference?: RelayOperationReference;
  url: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
}): Promise<{ url: string; targetId?: string; download?: BrowserDownloadResult }> {
  const isRetryableNavigateError = (err: unknown): boolean => {
    const msg =
      typeof err === "string"
        ? err.toLowerCase()
        : err instanceof Error
          ? err.message.toLowerCase()
          : "";
    return (
      msg.includes("frame has been detached") ||
      msg.includes("target page, context or browser has been closed")
    );
  };

  const url = normalizeOptionalString(opts.url) ?? "";
  if (!url) {
    throw new Error("url is required");
  }
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: opts.browserProxyMode,
  });
  await assertBrowserNavigationAllowed({
    url,
    ...navigationPolicy,
  });
  const timeout = resolveBrowserNavigationTimeoutMs(opts.timeoutMs);
  let currentTargetId = opts.targetId;
  let page = await getPageForTargetId(opts);
  let pageState = ensurePageState(page);
  const navigate = async () =>
    await gotoPageWithNavigationGuard({
      cdpUrl: opts.cdpUrl,
      page,
      url,
      timeoutMs: timeout,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: currentTargetId,
      ...(opts.resolveOperationTarget
        ? {
            assertPageCurrent: async () => {
              if ((await opts.resolveOperationTarget?.()) !== currentTargetId) {
                throw new BrowserTabNotFoundError({ input: currentTargetId });
              }
            },
          }
        : {}),
    });
  const navigateWithDownloadCapture = async (): Promise<{
    response: Awaited<ReturnType<typeof navigate>> | null;
    download?: BrowserDownloadResult;
  }> => {
    const downloadCapture = createDownloadCaptureForPage(page, pageState, timeout, {
      mode: "passive",
      timeoutMessage: "Timeout waiting for navigation download",
      beforeSave: async (download) => {
        await assertBrowserNavigationResultAllowed({
          url: download.url || url,
          ...navigationPolicy,
        });
      },
    });
    void downloadCapture.promise.catch(() => {});
    try {
      const response = await navigate();
      downloadCapture.cancel();
      return { response };
    } catch (err) {
      if (!isDownloadStartingNavigationError(err, url) || !downloadCapture.armed) {
        downloadCapture.cancel();
        throw err;
      }
      try {
        return { response: null, download: await downloadCapture.promise };
      } catch (downloadErr) {
        if (
          downloadErr instanceof Error &&
          downloadErr.message === "Timeout waiting for navigation download"
        ) {
          throw err;
        }
        if (isPolicyDenyNavigationError(downloadErr)) {
          await closeBlockedNavigationTarget({
            cdpUrl: opts.cdpUrl,
            page,
            targetId: currentTargetId,
          });
        }
        throw downloadErr;
      }
    }
  };

  let navigationResult: Awaited<ReturnType<typeof navigateWithDownloadCapture>>;
  try {
    navigationResult = await navigateWithDownloadCapture();
  } catch (err) {
    if (!isRetryableNavigateError(err)) {
      throw err;
    }
    // Extension relays can briefly drop CDP during renderer swaps/navigation.
    // Force a clean reconnect, then retry once on the refreshed page handle.
    if (opts.relayReference) {
      await closeRelayOperationConnection(opts.relayReference);
    } else {
      await forceDisconnectPlaywrightForTarget({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        ssrfPolicy: opts.ssrfPolicy,
        reason: "retry navigate after detached frame",
      }).catch(() => {});
    }
    if (opts.resolveOperationTarget) {
      // Auto-attach completes during reconnect; only then can the same tab owner prove its new ID.
      await connectBrowser(opts.cdpUrl, opts.ssrfPolicy, opts.relayReference);
      const replacementTargetId = await opts.resolveOperationTarget();
      if (!replacementTargetId) {
        throw new BrowserTabNotFoundError({ input: currentTargetId });
      }
      page = await getPageForTargetId({ ...opts, targetId: replacementTargetId });
      if ((await opts.resolveOperationTarget()) !== replacementTargetId) {
        throw new BrowserTabNotFoundError({ input: currentTargetId });
      }
      currentTargetId = replacementTargetId;
    } else {
      page = await getPageForTargetId(opts);
    }
    pageState = ensurePageState(page);
    navigationResult = await navigateWithDownloadCapture();
  }
  try {
    if (!navigationResult.download) {
      await assertPageNavigationCompletedSafely({
        cdpUrl: opts.cdpUrl,
        page,
        response: navigationResult.response,
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
        targetId: currentTargetId,
      });
    }
  } catch (err) {
    if (isPolicyDenyNavigationError(err)) {
      await closeBlockedNavigationTarget({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: currentTargetId,
      });
    }
    throw err;
  }
  const finalUrl = navigationResult.download?.url || page.url();
  const targetId = (await pageTargetInfo(page).catch(() => null))?.targetId;
  return {
    url: finalUrl,
    ...(targetId ? { targetId } : {}),
    ...(navigationResult.download ? { download: navigationResult.download } : {}),
  };
}

/** Resizes the target page viewport within the browser action policy bounds. */
export async function resizeViewportViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  width: number;
  height: number;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.setViewportSize({
    width: resolveViewportDimension(opts.width, "width"),
    height: resolveViewportDimension(opts.height, "height"),
  });
}

/** Closes the target Playwright page. */
export async function closePageViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.close();
}

/** Renders the target page to a PDF buffer. */
export async function pdfViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const buffer = await page.pdf({ printBackground: true });
  return { buffer };
}
