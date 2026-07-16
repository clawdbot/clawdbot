import { readStringValue } from "openclaw/plugin-sdk/text-runtime";
import { ensurePageState, getPageForTargetId } from "./pw-session.js";

export async function cookiesGetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<{ cookies: unknown[] }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const cookies = await page.context().cookies();
  return { cookies };
}

export async function cookiesSetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  cookie: {
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

export async function cookiesClearViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.context().clearCookies();
}

type StorageKind = "local" | "session";

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
