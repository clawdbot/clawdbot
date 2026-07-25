/**
 * Cookie and Web Storage helpers for Playwright-backed browser tools.
 */
import { readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ensurePageState, getPageForTargetId } from "./pw-session.js";

type PlaywrightCookieInput = {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "None" | "Strict";
};

/** Returns cookies visible to the target browser context. */
export async function cookiesGetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<{ cookies: unknown[] }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const cookies = await page.context().cookies();
  return { cookies };
}

/** Adds or replaces a cookie in the target browser context. */
export async function cookiesSetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  cookie: PlaywrightCookieInput;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const cookie = opts.cookie;
  if (!cookie.name || cookie.value === undefined) {
    throw new Error("cookie name and value are required");
  }
  const hasUrl = typeof cookie.url === "string" && cookie.url.trim();
  const hasDomainPath =
    typeof cookie.domain === "string" &&
    cookie.domain.trim() &&
    typeof cookie.path === "string" &&
    cookie.path.trim();
  if (!hasUrl && !hasDomainPath) {
    throw new Error("cookie requires url, or domain+path");
  }
  await page.context().addCookies([cookie]);
}

/**
 * Add cookies in bounded batches on one browser context. On a batch error, retry
 * that batch cookie-by-cookie so one cookie Playwright rejects neither drops the
 * whole batch nor aborts the import. Returns the count actually added so callers
 * can report rejects instead of leaving an ambiguous partial write.
 */
export async function cookiesSetManyViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  cookies: PlaywrightCookieInput[];
  signal?: AbortSignal;
}): Promise<{ added: number }> {
  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const context = page.context();
  let added = 0;
  for (let index = 0; index < opts.cookies.length; index += 500) {
    opts.signal?.throwIfAborted();
    const batch = opts.cookies.slice(index, index + 500);
    try {
      await context.addCookies(batch);
      added += batch.length;
    } catch {
      for (const cookie of batch) {
        opts.signal?.throwIfAborted();
        try {
          await context.addCookies([cookie]);
          added += 1;
        } catch {
          // Individual cookie rejected by Playwright/Chrome; counted as not added.
        }
      }
    }
  }
  opts.signal?.throwIfAborted();
  return { added };
}

/** Clears cookies in the target browser context. */
export async function cookiesClearViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.context().clearCookies();
}

type StorageKind = "local" | "session";

/** Reads localStorage or sessionStorage values from the target page. */
export async function storageGetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  kind: StorageKind;
  key?: string;
}): Promise<{ values: Record<string, string> }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const kind = opts.kind;
  const key = readStringValue(opts.key);
  const values = await page.evaluate(
    ({ kind: kind2, key: key2 }) => {
      const store = kind2 === "session" ? window.sessionStorage : window.localStorage;
      if (key2) {
        const value = store.getItem(key2);
        return value === null ? {} : { [key2]: value };
      }
      const out: Record<string, string> = {};
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        if (!k) {
          continue;
        }
        const v = store.getItem(k);
        if (v !== null) {
          out[k] = v;
        }
      }
      return out;
    },
    { kind, key },
  );
  return { values: values ?? {} };
}

/** Writes one localStorage or sessionStorage value on the target page. */
export async function storageSetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  kind: StorageKind;
  key: string;
  value: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const key = opts.key;
  if (!key) {
    throw new Error("key is required");
  }
  await page.evaluate(
    ({ kind, key: k, value }) => {
      const store = kind === "session" ? window.sessionStorage : window.localStorage;
      store.setItem(k, value);
    },
    { kind: opts.kind, key, value: opts.value },
  );
}

/** Clears localStorage or sessionStorage on the target page. */
export async function storageClearViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  kind: StorageKind;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.evaluate(
    ({ kind }) => {
      const store = kind === "session" ? window.sessionStorage : window.localStorage;
      store.clear();
    },
    { kind: opts.kind },
  );
}
