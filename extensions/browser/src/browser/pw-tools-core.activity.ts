/**
 * Page inspection helpers for visible text, observed errors, network requests,
 * and console messages from Playwright page state.
 */
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS, DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS } from "./constants.js";
import type {
  BrowserConsoleMessage,
  BrowserNetworkRequest,
  BrowserPageError,
} from "./pw-session.js";
import { ensurePageState, getPageForTargetId } from "./pw-session.js";

/** Returns visible page text without evaluating caller-provided JavaScript. */
export async function getPageTextViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  selector?: string;
  maxChars?: number;
  signal?: AbortSignal;
}): Promise<{ text: string; truncated: boolean }> {
  const maxChars = Math.min(
    opts.maxChars ?? DEFAULT_AI_SNAPSHOT_MAX_CHARS,
    DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  );
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new Error("maxChars must be a positive integer.");
  }
  const page = await getPageForTargetId(opts);
  let locator = page.locator(opts.selector ?? "body").first();
  if (!opts.selector) {
    for (const selector of ["article", "main"]) {
      const candidate = page.locator(selector).first();
      if (await candidate.count()) {
        locator = candidate;
        break;
      }
    }
  }
  // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- This action reads rendered text, not hidden DOM text.
  const text = await locator.innerText({
    timeout: DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS,
    signal: opts.signal,
  });
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

/** Returns captured page errors, optionally clearing the per-page buffer. */
export async function getPageErrorsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  clear?: boolean;
}): Promise<{ errors: BrowserPageError[] }> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const errors = [...state.errors];
  if (opts.clear) {
    state.errors = [];
  }
  return { errors };
}

/** Returns captured requests, optionally filtering URLs/resource types and clearing. */
export async function getNetworkRequestsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  filter?: string;
  clear?: boolean;
}): Promise<{ requests: BrowserNetworkRequest[] }> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const raw = [...state.requests.values()];
  const filter = typeof opts.filter === "string" ? opts.filter.trim() : "";
  const requests = filter
    ? raw.filter((r) => r.url.includes(filter) || r.resourceType?.includes(filter))
    : raw;
  if (opts.clear) {
    state.requests.clear();
    state.requestIds = new WeakMap();
  }
  return { requests };
}

function consolePriority(level: string) {
  switch (level) {
    case "error":
      return 3;
    case "warn":
    case "warning":
      return 2;
    case "info":
    case "log":
      return 1;
    case "debug":
      return 0;
    default:
      return 1;
  }
}

/** Returns captured console messages at or above the requested priority level. */
export async function getConsoleMessagesViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  level?: string;
}): Promise<BrowserConsoleMessage[]> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  if (!opts.level) {
    return [...state.console];
  }
  const min = consolePriority(opts.level);
  return state.console.filter((msg) => consolePriority(msg.type) >= min);
}
