/**
 * Snapshot, navigation, viewport, close, and PDF helpers for Playwright-backed
 * browser tools.
 */
import { parseFiniteNumber, resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { Page } from "playwright-core";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { ACT_MAX_VIEWPORT_DIMENSION } from "./act-policy.js";
import { type AriaSnapshotNode, formatAriaSnapshot, type RawAXNode } from "./cdp.js";
import type { BrowserDownloadResult } from "./download-types.js";
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
  type RoleSnapshotOptions,
  type RoleRefMap,
} from "./pw-role-snapshot.js";
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
import { markBackendDomRefsOnPage, withPageScopedCdpClient } from "./pw-session.page-cdp.js";
import { appendSnapshotUrls, type SnapshotUrlEntry } from "./snapshot-urls.js";

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

function resolveNavigationTimeoutMs(timeoutMs: number | undefined): number {
  return resolveBoundedTimeoutMs(timeoutMs, 20_000, 1000, 120_000);
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

function buildStoredAriaRefs(
  nodes: AriaSnapshotNode[],
  markedRefs: Set<string>,
): Record<string, { role: string; name?: string; nth?: number; domMarker?: boolean }> {
  const refs: Record<string, { role: string; name?: string; nth?: number; domMarker?: boolean }> =
    {};
  const counts = new Map<string, number>();
  const refsByKey = new Map<string, string[]>();

  for (const node of nodes) {
    const role = normalizeLowercaseStringOrEmpty(node.role) || "unknown";
    const name = node.name.trim() || undefined;
    const key = `${role}:${name ?? ""}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    const refsForKey = refsByKey.get(key);
    if (refsForKey) {
      refsForKey.push(node.ref);
    } else {
      refsByKey.set(key, [node.ref]);
    }
    refs[node.ref] = {
      role,
      ...(name ? { name } : {}),
      ...(nth > 0 ? { nth } : {}),
      ...(markedRefs.has(node.ref) ? { domMarker: true } : {}),
    };
  }

  for (const refsForKey of refsByKey.values()) {
    if (refsForKey.length > 1) {
      continue;
    }
    const ref = refsForKey[0];
    if (ref) {
      delete refs[ref]?.nth;
    }
  }

  return refs;
}

/** Stores aria snapshot refs so later tool calls can resolve stable element refs. */
export async function storeAriaSnapshotRefsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  nodes: AriaSnapshotNode[];
  page?: Page;
}): Promise<void> {
  const page =
    opts.page ??
    (await getPageForTargetId({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
    }));
  ensurePageState(page);
  const markedRefs = await markBackendDomRefsOnPage({
    page,
    refs: opts.nodes.flatMap((node) =>
      typeof node.backendDOMNodeId === "number"
        ? [{ ref: node.ref, backendDOMNodeId: node.backendDOMNodeId }]
        : [],
    ),
  });
  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: buildStoredAriaRefs(opts.nodes, markedRefs),
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
  const res = (await (ariaTimeoutMs === undefined
    ? collectAxTree
    : (() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Aria snapshot via Playwright timed out after ${ariaTimeoutMs}ms.`));
          }, ariaTimeoutMs);
          timer.unref?.();
        });
        return Promise.race([collectAxTree, timeout]).finally(() => {
          if (timer) {
            clearTimeout(timer);
          }
        });
      })())) as {
    nodes?: RawAXNode[];
  };
  const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
  const formatted = formatAriaSnapshot(nodes, limit);
  await storeAriaSnapshotRefsViaPlaywright({
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
}): Promise<{ snapshot: string; truncated?: boolean; refs: RoleRefMap }> {
  const page = await prepareSnapshotPageViaPlaywright({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });

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
  });
  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: finalized.refs,
    mode: "aria",
  });
  return finalized;
}

async function finalizeRoleSnapshotViaPlaywright(params: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  frameSelector?: string;
  mode: "aria" | "role";
  built: { snapshot: string; refs: RoleRefMap };
  urls?: boolean;
  maxChars?: number;
}): Promise<{
  snapshot: string;
  truncated?: boolean;
  refs: RoleRefMap;
  stats: { lines: number; chars: number; refs: number; interactive: number };
}> {
  const snapshot = params.urls
    ? appendSnapshotUrls(params.built.snapshot, await collectSnapshotUrls(params.page))
    : params.built.snapshot;
  const finalized = finalizeRoleSnapshot({
    snapshot,
    refs: params.built.refs,
    maxChars: params.maxChars,
  });
  storeRoleRefsForTarget({
    page: params.page,
    cdpUrl: params.cdpUrl,
    targetId: params.targetId,
    refs: finalized.refs,
    ...(params.frameSelector ? { frameSelector: params.frameSelector } : {}),
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
}): Promise<{
  snapshot: string;
  truncated?: boolean;
  refs: Record<string, { role: string; name?: string; nth?: number }>;
  stats: { lines: number; chars: number; refs: number; interactive: number };
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
    const snapshot = await page.ariaSnapshot({
      mode: "ai",
      timeout: ariaSnapshotTimeout,
    });
    const built = buildRoleSnapshotFromAiSnapshot(snapshot, opts.options);
    return await finalizeRoleSnapshotViaPlaywright({
      page,
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      built,
      mode: "aria",
      urls: opts.urls,
      maxChars: opts.maxChars,
    });
  }

  const frameSelector = normalizeOptionalString(opts.frameSelector) ?? "";
  const selector = normalizeOptionalString(opts.selector) ?? "";
  const locator = frameSelector
    ? selector
      ? page.frameLocator(frameSelector).locator(selector)
      : page.frameLocator(frameSelector).locator(":root")
    : selector
      ? page.locator(selector)
      : page.locator(":root");

  const ariaSnapshot = await locator.ariaSnapshot({ timeout: ariaSnapshotTimeout });
  const built = buildRoleSnapshotFromAriaSnapshot(ariaSnapshot ?? "", opts.options);
  return await finalizeRoleSnapshotViaPlaywright({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    frameSelector: frameSelector || undefined,
    built,
    mode: "role",
    urls: opts.urls,
    maxChars: opts.maxChars,
  });
}

/** Navigates the target page while enforcing browser SSRF policy before and after load. */
export async function navigateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
}): Promise<{ url: string; download?: BrowserDownloadResult }> {
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
  const timeout = resolveNavigationTimeoutMs(opts.timeoutMs);
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
      targetId: opts.targetId,
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
            targetId: opts.targetId,
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
    await forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      ssrfPolicy: opts.ssrfPolicy,
      reason: "retry navigate after detached frame",
    }).catch(() => {});
    page = await getPageForTargetId(opts);
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
        targetId: opts.targetId,
      });
    }
  } catch (err) {
    if (isPolicyDenyNavigationError(err)) {
      await closeBlockedNavigationTarget({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: opts.targetId,
      });
    }
    throw err;
  }
  const finalUrl = navigationResult.download?.url || page.url();
  return {
    url: finalUrl,
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
