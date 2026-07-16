import type { BrowserActionOk, BrowserActionTargetOk } from "./client-actions-types.js";
import { buildProfileQuery, withBaseUrl } from "./client-actions-url.js";
import { fetchBrowserJson } from "./client-fetch.js";

type TargetedProfileOptions = {
  targetId?: string;
  profile?: string;
};

type HttpCredentialsOptions = TargetedProfileOptions & {
  username?: string;
  password?: string;
  clear?: boolean;
};

type GeolocationOptions = TargetedProfileOptions & {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  origin?: string;
  clear?: boolean;
};

function buildStateQuery(params: { targetId?: string; key?: string; profile?: string }): string {
  const query = new URLSearchParams();
  if (params.targetId) {
    query.set("targetId", params.targetId);
  }
  if (params.key) {
    query.set("key", params.key);
  }
  if (params.profile) {
    query.set("profile", params.profile);
  }
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

async function postProfileJson<T>(
  baseUrl: string | undefined,
  params: { path: string; profile?: string; body: unknown },
): Promise<T> {
  const query = buildProfileQuery(params.profile);
  return await fetchBrowserJson<T>(withBaseUrl(baseUrl, `${params.path}${query}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params.body),
    timeoutMs: 20000,
  });
}

async function postTargetedProfileJson(
  baseUrl: string | undefined,
  params: {
    path: string;
    opts: { targetId?: string; profile?: string };
    body: Record<string, unknown>;
  },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    path: params.path,
    profile: params.opts.profile,
    body: {
      targetId: params.opts.targetId,
      ...params.body,
    },
  });
}

export async function browserCookies(
  baseUrl: string | undefined,
  opts: { targetId?: string; profile?: string } = {},
): Promise<{ ok: true; targetId: string; cookies: unknown[] }> {
  const suffix = buildStateQuery({ targetId: opts.targetId, profile: opts.profile });
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
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    path: "/cookies/set",
    profile: opts.profile,
    body: { targetId: opts.targetId, cookie: opts.cookie },
  });
}

export async function browserCookiesClear(
  baseUrl: string | undefined,
  opts: { targetId?: string; profile?: string } = {},
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    path: "/cookies/clear",
    profile: opts.profile,
    body: { targetId: opts.targetId },
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
  const suffix = buildStateQuery({ targetId: opts.targetId, key: opts.key, profile: opts.profile });
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
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    path: `/storage/${opts.kind}/set`,
    profile: opts.profile,
    body: {
      targetId: opts.targetId,
      key: opts.key,
      value: opts.value,
    },
  });
}

export async function browserStorageClear(
  baseUrl: string | undefined,
  opts: { kind: "local" | "session"; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    path: `/storage/${opts.kind}/clear`,
    profile: opts.profile,
    body: { targetId: opts.targetId },
  });
}

export async function browserSetOffline(
  baseUrl: string | undefined,
  opts: { offline: boolean; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    path: "/set/offline",
    profile: opts.profile,
    body: { targetId: opts.targetId, offline: opts.offline },
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
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    path: "/set/headers",
    profile: opts.profile,
    body: { targetId: opts.targetId, headers: opts.headers },
  });
}

export async function browserSetHttpCredentials(
  baseUrl: string | undefined,
  opts: HttpCredentialsOptions = {},
): Promise<BrowserActionTargetOk> {
  return await postTargetedProfileJson(baseUrl, {
    path: "/set/credentials",
    opts,
    body: {
      username: opts.username,
      password: opts.password,
      clear: opts.clear,
    },
  });
}

export async function browserSetGeolocation(
  baseUrl: string | undefined,
  opts: GeolocationOptions = {},
): Promise<BrowserActionTargetOk> {
  return await postTargetedProfileJson(baseUrl, {
    path: "/set/geolocation",
    opts,
    body: {
      latitude: opts.latitude,
      longitude: opts.longitude,
      accuracy: opts.accuracy,
      origin: opts.origin,
      clear: opts.clear,
    },
  });
}

export async function browserSetMedia(
  baseUrl: string | undefined,
  opts: {
    colorScheme: "dark" | "light" | "no-preference" | "none";
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    path: "/set/media",
    profile: opts.profile,
    body: {
      targetId: opts.targetId,
      colorScheme: opts.colorScheme,
    },
  });
}

export async function browserSetTimezone(
  baseUrl: string | undefined,
  opts: { timezoneId: string; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    path: "/set/timezone",
    profile: opts.profile,
    body: {
      targetId: opts.targetId,
      timezoneId: opts.timezoneId,
    },
  });
}

export async function browserSetLocale(
  baseUrl: string | undefined,
  opts: { locale: string; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    path: "/set/locale",
    profile: opts.profile,
    body: { targetId: opts.targetId, locale: opts.locale },
  });
}

export async function browserSetDevice(
  baseUrl: string | undefined,
  opts: { name: string; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    path: "/set/device",
    profile: opts.profile,
    body: { targetId: opts.targetId, name: opts.name },
  });
}

export async function browserClearPermissions(
  baseUrl: string | undefined,
  opts: { targetId?: string; profile?: string } = {},
): Promise<BrowserActionOk> {
  return await postProfileJson<BrowserActionOk>(baseUrl, {
    path: "/set/geolocation",
    profile: opts.profile,
    body: { targetId: opts.targetId, clear: true },
  });
}
