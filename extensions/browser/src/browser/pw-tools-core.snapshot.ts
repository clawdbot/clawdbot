import { parseFiniteNumber, resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Page } from "playwright-core";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { ACT_MAX_VIEWPORT_DIMENSION } from "./act-policy.js";
import { type AriaSnapshotNode, formatAriaSnapshot, type RawAXNode } from "./cdp.js";
import {
  assertBrowserNavigationAllowed,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import {
  buildRoleSnapshotFromAiSnapshot,
  buildRoleSnapshotFromAriaSnapshot,
  getRoleSnapshotStats,
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
            .slice(0, 120) || href;
        seen.add(href);
        out.push({ text, url: href });
        if (out.length >= 100) {
          break;
        }
      }
      return out;
    })
    .catch(() => []);
  return Array.isArray(urls) ? urls : [];
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
    refsByKey.set(key, [...(refsByKey.get(key) ?? []), node.ref]);
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
  const maxChars = opts.maxChars;
  const limit =
    typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
      ? Math.floor(maxChars)
      : undefined;
  let truncated = false;
  if (limit && snapshot.length > limit) {
    snapshot = `${snapshot.slice(0, limit)}\n\n[...TRUNCATED - page too large]`;
    truncated = true;
  }

  const built = buildRoleSnapshotFromAiSnapshot(snapshot);
  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: built.refs,
    mode: "aria",
  });
  return truncated ? { snapshot, truncated, refs: built.refs } : { snapshot, refs: built.refs };
}

async function finalizeRoleSnapshotViaPlaywright(params: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  frameSelector?: string;
  mode: "aria" | "role";
  built: { snapshot: string; refs: RoleRefMap };
  urls?: boolean;
}): Promise<{
  snapshot: string;
  refs: RoleRefMap;
  stats: { lines: number; chars: number; refs: number; interactive: number };
}> {
  const snapshot = params.urls
    ? appendSnapshotUrls(params.built.snapshot, await collectSnapshotUrls(params.page))
    : params.built.snapshot;
  storeRoleRefsForTarget({
    page: params.page,
    cdpUrl: params.cdpUrl,
    targetId: params.targetId,
    refs: params.built.refs,
    ...(params.frameSelector ? { frameSelector: params.frameSelector } : {}),
    mode: params.mode,
  });
  return {
    snapshot,
    refs: params.built.refs,
    stats: getRoleSnapshotStats(snapshot, params.built.refs),
  };
}

export async function snapshotRoleViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  selector?: string;
  frameSelector?: string;
  refsMode?: "role" | "aria";
  options?: RoleSnapshotOptions;
  urls?: boolean;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{
  snapshot: string;
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
  });
}

export async function navigateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
}): Promise<{ url: string }> {
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
  await assertBrowserNavigationAllowed({
    url,
    ...withBrowserNavigationPolicy(opts.ssrfPolicy, {
      browserProxyMode: opts.browserProxyMode,
    }),
  });
  const timeout = resolveNavigationTimeoutMs(opts.timeoutMs);
  let page = await getPageForTargetId(opts);
  ensurePageState(page);
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
  let response;
  try {
    response = await navigate();
  } catch (err) {
    if (!isRetryableNavigateError(err)) {
      throw err;
    }
    // Extension relays can briefly drop CDP during renderer swaps/navigation.
    // Force a clean reconnect, then retry once on the refreshed page handle.
    await forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      reason: "retry navigate after detached frame",
    }).catch(() => {});
    page = await getPageForTargetId(opts);
    ensurePageState(page);
    response = await navigate();
  }
  try {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page,
      response,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
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
  const finalUrl = page.url();
  return { url: finalUrl };
}

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

export async function closePageViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.close();
}

export async function pdfViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const buffer = await page.pdf({ printBackground: true });
  return { buffer };
}
