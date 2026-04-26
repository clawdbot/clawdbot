import type { CDPSession, Page } from "playwright-core";

type PageCdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type MarkBackendDomRef = { ref: string; backendDOMNodeId: number };

export const BROWSER_REF_MARKER_ATTRIBUTE = "data-openclaw-browser-ref";

async function withPlaywrightPageCdpSession<T>(
  page: Page,
  fn: (session: CDPSession) => Promise<T>,
): Promise<T> {
  const session = await page.context().newCDPSession(page);
  try {
    return await fn(session);
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function withPageScopedCdpClient<T>(opts: {
  cdpUrl: string;
  page: Page;
  targetId?: string;
  fn: (send: PageCdpSend) => Promise<T>;
}): Promise<T> {
  return await withPlaywrightPageCdpSession(opts.page, async (session) => {
    return await opts.fn((method, params) =>
      (
        session.send as unknown as (
          method: string,
          params?: Record<string, unknown>,
        ) => Promise<unknown>
      )(method, params),
    );
  });
}

export async function markBackendDomRefsOnPage(opts: {
  page: Page;
  refs: MarkBackendDomRef[];
}): Promise<Set<string>> {
  await opts.page
    .locator(`[${BROWSER_REF_MARKER_ATTRIBUTE}]`)
    .evaluateAll((elements, attr) => {
      for (const element of elements) {
        if (element instanceof Element) {
          element.removeAttribute(attr);
        }
      }
    }, BROWSER_REF_MARKER_ATTRIBUTE)
    .catch(() => {});

  const refs = opts.refs.filter(
    (entry) =>
      /^ax\d+$/.test(entry.ref) &&
      Number.isFinite(entry.backendDOMNodeId) &&
      Math.floor(entry.backendDOMNodeId) > 0,
  );
  const marked = new Set<string>();
  if (!refs.length) {
    return marked;
  }

  return await withPlaywrightPageCdpSession(opts.page, async (session) => {
    const send = async (method: string, params?: Record<string, unknown>) =>
      await (
        session.send as unknown as (
          method: string,
          params?: Record<string, unknown>,
        ) => Promise<unknown>
      )(method, params);

    await send("DOM.enable").catch(() => {});

    const backendNodeIds = [...new Set(refs.map((entry) => Math.floor(entry.backendDOMNodeId)))];
    const pushed = (await send("DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds,
    }).catch(() => ({}))) as { nodeIds?: number[] };
    const nodeIds = Array.isArray(pushed.nodeIds) ? pushed.nodeIds : [];
    const nodeIdByBackendId = new Map<number, number>();
    for (let index = 0; index < backendNodeIds.length; index += 1) {
      const backendNodeId = backendNodeIds[index];
      const nodeId = nodeIds[index];
      if (backendNodeId && typeof nodeId === "number" && nodeId > 0) {
        nodeIdByBackendId.set(backendNodeId, nodeId);
      }
    }

    for (const entry of refs) {
      const nodeId = nodeIdByBackendId.get(Math.floor(entry.backendDOMNodeId));
      if (!nodeId) {
        continue;
      }
      try {
        await send("DOM.setAttributeValue", {
          nodeId,
          name: BROWSER_REF_MARKER_ATTRIBUTE,
          value: entry.ref,
        });
        marked.add(entry.ref);
      } catch {
        // Best-effort marker write. Unmarked refs fall back to role metadata.
      }
    }

    return marked;
  });
}
