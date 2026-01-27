import type { BrowserActionOk, BrowserActionTargetOk } from "./client-actions-types.js";
import { fetchBrowserJson } from "./client-fetch.js";

function buildProfileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}

function withBaseUrl(baseUrl: string | undefined, path: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return path;
  return `${trimmed.replace(/\/$/, "")}${path}`;
}

export async function browserCookies(
  baseUrl: string | undefined,
  opts: { targetId?: string; profile?: string } = {},
): Promise<{ ok: true; targetId: string; cookies: unknown[] }> {
  const q = new URLSearchParams();
  if (opts.targetId) q.set("targetId", opts.targetId);
  if (opts.profile) q.set("profile", opts.profile);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return await fetchBrowserJson<{
    ok: true;
    targetId: string;
    cookies: unknown[];
  }>(withBaseUrl(baseUrl, `/cookies${suffix}`), { timeoutMs: 20000 });
}

export async function browserCookiesSet(
  baseUrl: string | undefined,
  opts: {
    cookie: Record<string, unknown>;
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(withBaseUrl(baseUrl, `/cookies/set${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId, cookie: opts.cookie }),
    timeoutMs: 20000,
  });
}

export async function browserCookiesClear(
  baseUrl: string | undefined,
  opts: { targetId?: string; profile?: string } = {},
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(withBaseUrl(baseUrl, `/cookies/clear${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

export async function browserStorageGet(
  baseUrl: string | undefined,
  opts: {
    kind: "local" | "session";
    key?: string;
    targetId?: string;
    profile?: string;
  },
): Promise<{ ok: true; targetId: string; values: Record<string, string> }> {
  const q = new URLSearchParams();
  if (opts.targetId) q.set("targetId", opts.targetId);
  if (opts.key) q.set("key", opts.key);
  if (opts.profile) q.set("profile", opts.profile);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return await fetchBrowserJson<{
    ok: true;
    targetId: string;
    values: Record<string, string>;
  }>(withBaseUrl(baseUrl, `/storage/${opts.kind}${suffix}`), { timeoutMs: 20000 });
}

export async function browserStorageSet(
  baseUrl: string | undefined,
  opts: {
    kind: "local" | "session";
    key: string;
    value: string;
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(
    withBaseUrl(baseUrl, `/storage/${opts.kind}/set${q}`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetId: opts.targetId,
        key: opts.key,
        value: opts.value,
      }),
      timeoutMs: 20000,
    },
  );
}

export async function browserStorageClear(
  baseUrl: string | undefined,
  opts: { kind: "local" | "session"; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(
    withBaseUrl(baseUrl, `/storage/${opts.kind}/clear${q}`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: opts.targetId }),
      timeoutMs: 20000,
    },
  );
}

export async function browserSetOffline(
  baseUrl: string | undefined,
  opts: { offline: boolean; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(withBaseUrl(baseUrl, `/set/offline${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId, offline: opts.offline }),
    timeoutMs: 20000,
  });
}

export async function browserSetHeaders(
  baseUrl: string | undefined,
  opts: {
    headers: Record<string, string>;
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(withBaseUrl(baseUrl, `/set/headers${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId, headers: opts.headers }),
    timeoutMs: 20000,
  });
}

export async function browserSetHttpCredentials(
  baseUrl: string | undefined,
  opts: {
    username?: string;
    password?: string;
    clear?: boolean;
    targetId?: string;
    profile?: string;
  } = {},
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(
    withBaseUrl(baseUrl, `/set/credentials${q}`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetId: opts.targetId,
        username: opts.username,
        password: opts.password,
        clear: opts.clear,
      }),
      timeoutMs: 20000,
    },
  );
}

export async function browserSetGeolocation(
  baseUrl: string | undefined,
  opts: {
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    origin?: string;
    clear?: boolean;
    targetId?: string;
    profile?: string;
  } = {},
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(
    withBaseUrl(baseUrl, `/set/geolocation${q}`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetId: opts.targetId,
        latitude: opts.latitude,
        longitude: opts.longitude,
        accuracy: opts.accuracy,
        origin: opts.origin,
        clear: opts.clear,
      }),
      timeoutMs: 20000,
    },
  );
}

export async function browserSetMedia(
  baseUrl: string | undefined,
  opts: {
    colorScheme: "dark" | "light" | "no-preference" | "none";
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(withBaseUrl(baseUrl, `/set/media${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      colorScheme: opts.colorScheme,
    }),
    timeoutMs: 20000,
  });
}

export async function browserSetTimezone(
  baseUrl: string | undefined,
  opts: { timezoneId: string; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(withBaseUrl(baseUrl, `/set/timezone${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      timezoneId: opts.timezoneId,
    }),
    timeoutMs: 20000,
  });
}

export async function browserSetLocale(
  baseUrl: string | undefined,
  opts: { locale: string; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(withBaseUrl(baseUrl, `/set/locale${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId, locale: opts.locale }),
    timeoutMs: 20000,
  });
}

export async function browserSetDevice(
  baseUrl: string | undefined,
  opts: { name: string; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(withBaseUrl(baseUrl, `/set/device${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId, name: opts.name }),
    timeoutMs: 20000,
  });
}

export async function browserClearPermissions(
  baseUrl: string | undefined,
  opts: { targetId?: string; profile?: string } = {},
): Promise<BrowserActionOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionOk>(withBaseUrl(baseUrl, `/set/geolocation${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId, clear: true }),
    timeoutMs: 20000,
  });
}
