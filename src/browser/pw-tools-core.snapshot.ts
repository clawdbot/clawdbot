import type { Page } from "playwright-core";

import { type AriaSnapshotNode, formatAriaSnapshot, type RawAXNode } from "./cdp.js";
import {
  buildRoleSnapshotFromAiSnapshot,
  buildRoleSnapshotFromAriaSnapshot,
  getRoleSnapshotStats,
  type RoleSnapshotOptions,
} from "./pw-role-snapshot.js";
import {
  ensurePageState,
  getPageForTargetId,
  rememberRoleRefsForTarget,
  type WithSnapshotForAI,
} from "./pw-session.js";

export async function snapshotAriaViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  limit?: number;
}): Promise<{ nodes: AriaSnapshotNode[] }> {
  const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 500)));
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Accessibility.enable").catch(() => {});
    const res = (await session.send("Accessibility.getFullAXTree")) as {
      nodes?: RawAXNode[];
    };
    const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
    return { nodes: formatAriaSnapshot(nodes, limit) };
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function snapshotAiViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timeoutMs?: number;
  maxChars?: number;
}): Promise<{ snapshot: string; truncated?: boolean }> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);

  const maybe = page as unknown as WithSnapshotForAI;
  if (!maybe._snapshotForAI) {
    throw new Error("Playwright _snapshotForAI is not available. Upgrade playwright-core.");
  }

  const result = await maybe._snapshotForAI({
    timeout: Math.max(500, Math.min(60_000, Math.floor(opts.timeoutMs ?? 5000))),
    track: "response",
  });
  let snapshot = String(result?.full ?? "");
  const maxChars = opts.maxChars;
  const limit =
    typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
      ? Math.floor(maxChars)
      : undefined;
  if (limit && snapshot.length > limit) {
    snapshot = `${snapshot.slice(0, limit)}\n\n[...TRUNCATED - page too large]`;
    return { snapshot, truncated: true };
  }
  return { snapshot };
}

export async function snapshotRoleViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  selector?: string;
  frameSelector?: string;
  refsMode?: "role" | "aria";
  options?: RoleSnapshotOptions;
}): Promise<{
  snapshot: string;
  refs: Record<string, { role: string; name?: string; nth?: number }>;
  stats: { lines: number; chars: number; refs: number; interactive: number };
}> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  const state = ensurePageState(page);

  if (opts.refsMode === "aria") {
    if (opts.selector?.trim() || opts.frameSelector?.trim()) {
      throw new Error("refs=aria does not support selector/frame snapshots yet.");
    }
    const maybe = page as unknown as WithSnapshotForAI;
    if (!maybe._snapshotForAI) {
      throw new Error("refs=aria requires Playwright _snapshotForAI support.");
    }
    const result = await maybe._snapshotForAI({
      timeout: 5000,
      track: "response",
    });
    const built = buildRoleSnapshotFromAiSnapshot(String(result?.full ?? ""), opts.options);
    state.roleRefs = built.refs;
    state.roleRefsFrameSelector = undefined;
    state.roleRefsMode = "aria";
    if (opts.targetId) {
      rememberRoleRefsForTarget({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        refs: built.refs,
        mode: "aria",
      });
    }
    return {
      snapshot: built.snapshot,
      refs: built.refs,
      stats: getRoleSnapshotStats(built.snapshot, built.refs),
    };
  }

  const frameSelector = opts.frameSelector?.trim() || "";
  const selector = opts.selector?.trim() || "";
  const locator = frameSelector
    ? selector
      ? page.frameLocator(frameSelector).locator(selector)
      : page.frameLocator(frameSelector).locator(":root")
    : selector
      ? page.locator(selector)
      : page.locator(":root");

  const ariaSnapshot = await locator.ariaSnapshot();
  const built = buildRoleSnapshotFromAriaSnapshot(String(ariaSnapshot ?? ""), opts.options);
  state.roleRefs = built.refs;
  state.roleRefsFrameSelector = frameSelector || undefined;
  state.roleRefsMode = "role";
  if (opts.targetId) {
    rememberRoleRefsForTarget({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      refs: built.refs,
      frameSelector: frameSelector || undefined,
      mode: "role",
    });
  }
  return {
    snapshot: built.snapshot,
    refs: built.refs,
    stats: getRoleSnapshotStats(built.snapshot, built.refs),
  };
}

export async function navigateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
}): Promise<{ url: string }> {
  const url = String(opts.url ?? "").trim();
  if (!url) throw new Error("url is required");
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.goto(url, {
    timeout: Math.max(1000, Math.min(120_000, opts.timeoutMs ?? 20_000)),
  });
  return { url: page.url() };
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
    width: Math.max(1, Math.floor(opts.width)),
    height: Math.max(1, Math.floor(opts.height)),
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
  const buffer = await (page as Page).pdf({ printBackground: true });
  return { buffer };
}
