/**
 * Playwright page-scoped CDP helpers.
 *
 * Opens a CDP session through Playwright pages and marks backend DOM nodes with
 * temporary browser refs for role-snapshot interactions.
 */
import { uniqueValues } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CDPSession, Page } from "playwright-core";
import { readCdpMainFrameDocumentIdentity } from "./cdp-page-session.js";

type PageCdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type MarkBackendDomRef = { ref: string; backendDOMNodeId: number };

/** Attribute used to mark DOM nodes that correspond to generated browser refs. */
export const BROWSER_REF_MARKER_ATTRIBUTE = "data-openclaw-browser-ref";

function pageCdpAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Browser page CDP operation aborted.", { cause: signal.reason });
}

async function racePageCdpTaskWithAbort<T>(params: {
  task: Promise<T>;
  signal: AbortSignal;
  onAbort?: () => void;
}): Promise<T> {
  void params.task.catch(() => {});
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      params.onAbort?.();
      // A detached relay session can reject the pending command with a more
      // precise error. Give that already-triggered rejection one turn to win.
      setImmediate(() => reject(pageCdpAbortError(params.signal)));
    };
    if (params.signal.aborted) {
      onAbort();
    } else {
      params.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([params.task, aborted]);
  } finally {
    if (onAbort) {
      params.signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Run one operation in an exact Playwright page session and detach it on cancellation. */
export async function withPlaywrightPageCdpSession<T>(
  page: Page,
  fn: (session: CDPSession) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  let session: CDPSession | undefined;
  let detachPromise: Promise<void> | undefined;
  const detach = (target = session) => {
    if (!target) {
      return undefined;
    }
    detachPromise ??= target.detach().catch(() => {});
    return detachPromise;
  };

  const sessionTask = page
    .context()
    .newCDPSession(page)
    .then((created) => {
      session = created;
      if (signal?.aborted) {
        void detach(created);
      }
      return created;
    });
  void sessionTask.catch(() => {});
  session = signal
    ? await racePageCdpTaskWithAbort({
        task: sessionTask,
        signal,
        onAbort: () => {
          void sessionTask.then(
            (created) => detach(created),
            () => {},
          );
        },
      })
    : await sessionTask;

  try {
    signal?.throwIfAborted();
    const operation = fn(session);
    void operation.catch(() => {});
    if (!signal) {
      return await operation;
    }
    return await racePageCdpTaskWithAbort({
      task: operation,
      signal,
      onAbort: () => {
        void detach();
      },
    });
  } finally {
    const cleanup = detach();
    if (cleanup && !signal?.aborted) {
      if (!signal) {
        await cleanup;
      } else {
        await racePageCdpTaskWithAbort({
          task: cleanup,
          signal,
          onAbort: () => {
            void detach();
          },
        });
      }
    }
  }
}

/** Run a function with a CDP send helper scoped to one Playwright page. */
export async function withPageScopedCdpClient<T>(opts: {
  cdpUrl: string;
  page: Page;
  targetId?: string;
  signal?: AbortSignal;
  fn: (send: PageCdpSend) => Promise<T>;
}): Promise<T> {
  return await withPlaywrightPageCdpSession(
    opts.page,
    async (session) =>
      await opts.fn((method, params) =>
        (
          session.send as unknown as (
            method: string,
            params?: Record<string, unknown>,
          ) => Promise<unknown>
        )(method, params),
      ),
    opts.signal,
  );
}

/** Read the browser-owned loader identity for a Playwright page's main frame. */
export async function readMainFrameDocumentIdentityForPage(
  page: Page,
): Promise<string | undefined> {
  return await withPlaywrightPageCdpSession(
    page,
    async (session) =>
      await readCdpMainFrameDocumentIdentity((method, params) =>
        (
          session.send as unknown as (
            method: string,
            params?: Record<string, unknown>,
          ) => Promise<unknown>
        )(method, params),
      ),
  );
}

/** Mark backend DOM node ids on the page with browser ref attributes. */
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

    const backendNodeIds = uniqueValues(refs.map((entry) => Math.floor(entry.backendDOMNodeId)));
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
