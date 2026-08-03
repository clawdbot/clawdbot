/** Playwright-backed HTML capture for scoped Browser extraction. */
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { getPageForTargetId } from "./pw-session.js";

type BrowserPageContentCapture =
  | { ok: true; html: string }
  | {
      ok: false;
      error: "invalid_selector" | "selector_not_found";
    };

/** Runs in the page so scoped extraction never serializes unrelated DOM. */
function capturePageHtmlForExtract(params: {
  selector?: string;
  ignoreSelectors: string[];
}): BrowserPageContentCapture {
  let nodes: Element[];
  if (params.selector) {
    try {
      nodes = Array.from(document.querySelectorAll(params.selector));
    } catch {
      return {
        ok: false,
        error: "invalid_selector",
      };
    }
    if (nodes.length === 0) {
      return {
        ok: false,
        error: "selector_not_found",
      };
    }
    const selected = new Set(nodes);
    nodes = nodes.filter((node) => {
      let ancestor = node.parentElement;
      while (ancestor) {
        if (selected.has(ancestor)) {
          return false;
        }
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  } else {
    nodes = [document.documentElement];
  }

  const ignoredNodes = new Set<Element>();
  for (const ignoreSelector of params.ignoreSelectors) {
    try {
      document.querySelectorAll(ignoreSelector).forEach((node) => ignoredNodes.add(node));
    } catch {
      return {
        ok: false,
        error: "invalid_selector",
      };
    }
  }

  const html = nodes
    .map((node) => {
      const cloneWithoutIgnoredNodes = (source: Node): Node | null => {
        if (source instanceof Element && ignoredNodes.has(source)) {
          return null;
        }
        const clone = source.cloneNode(false);
        for (const child of Array.from(source.childNodes)) {
          const childClone = cloneWithoutIgnoredNodes(child);
          if (childClone) {
            clone.appendChild(childClone);
          }
        }
        return clone;
      };
      return (cloneWithoutIgnoredNodes(node) as Element | null)?.outerHTML ?? "";
    })
    .filter(Boolean)
    .join("\n");
  if (!html) {
    return {
      ok: false,
      error: "selector_not_found",
    };
  }
  return { ok: true, html };
}

/** Capture serialized HTML from the resolved Playwright page. */
export async function pageContentViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
  selector?: string;
  ignoreSelectors?: string[];
}): Promise<BrowserPageContentCapture> {
  const page = await getPageForTargetId(opts);
  opts.signal?.throwIfAborted();
  const capture =
    opts.selector || opts.ignoreSelectors?.length
      ? page.evaluate(capturePageHtmlForExtract, {
          selector: opts.selector,
          ignoreSelectors: opts.ignoreSelectors ?? [],
        })
      : page.content().then((html) => ({ ok: true as const, html }));
  if (!opts.signal) {
    return await capture;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      const reason = opts.signal?.reason;
      reject(reason instanceof Error ? reason : new Error("browser page capture aborted"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([capture, aborted]);
  } finally {
    if (onAbort) {
      opts.signal.removeEventListener("abort", onAbort);
    }
  }
}
