import { sleep } from "openclaw/plugin-sdk/runtime-env";

type QaBrowserGateway = {
  call: (
    method: string,
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ) => Promise<unknown>;
};

type QaBrowserEnv = {
  gateway: QaBrowserGateway;
};

type QaBrowserRequestParams = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
};

type QaBrowserOpenTabParams = {
  url: string;
  profile?: string;
  timeoutMs?: number;
};

type QaBrowserSnapshotParams = {
  profile?: string;
  targetId?: string;
  format?: "ai" | "aria";
  limit?: number;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  frame?: string;
  labels?: boolean;
  mode?: "efficient";
  maxChars?: number;
  timeoutMs?: number;
};

type QaBrowserActRequest = {
  kind: string;
  targetId?: string;
  ref?: string;
  doubleClick?: boolean;
  button?: string;
  modifiers?: string[];
  text?: string;
  submit?: boolean;
  slowly?: boolean;
  key?: string;
  delayMs?: number;
  startRef?: string;
  endRef?: string;
  values?: string[];
  fields?: Array<Record<string, unknown>>;
  width?: number;
  height?: number;
  timeMs?: number;
  selector?: string;
  url?: string;
  loadState?: string;
  textGone?: string;
  timeoutMs?: number;
  fn?: string;
};

type QaBrowserActParams = {
  profile?: string;
  request: QaBrowserActRequest;
  timeoutMs?: number;
};

type QaBrowserStatus = {
  enabled?: boolean;
  running?: boolean;
  cdpReady?: boolean;
};

type QaBrowserReadyParams = {
  profile?: string;
  timeoutMs?: number;
  intervalMs?: number;
};

function normalizeBrowserQuery(
  query: QaBrowserRequestParams["query"],
): Record<string, string> | undefined {
  if (!query) {
    return undefined;
  }
  const normalized = Object.fromEntries(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function resolveBrowserTimeoutMs(timeoutMs: number | undefined, fallbackMs: number) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return fallbackMs;
  }
  return Math.max(1, Math.floor(timeoutMs));
}

export async function callQaBrowserRequest<T = unknown>(
  env: QaBrowserEnv,
  params: QaBrowserRequestParams,
): Promise<T> {
  const timeoutMs = resolveBrowserTimeoutMs(params.timeoutMs, 20_000);
  const payload = await env.gateway.call(
    "browser.request",
    {
      method: params.method,
      path: params.path,
      query: normalizeBrowserQuery(params.query),
      body: params.body,
      timeoutMs,
    },
    { timeoutMs },
  );
  return payload as T;
}

export async function qaBrowserOpenTab<T = unknown>(
  env: QaBrowserEnv,
  params: QaBrowserOpenTabParams,
): Promise<T> {
  return await callQaBrowserRequest<T>(env, {
    method: "POST",
    path: "/tabs/open",
    query: params.profile ? { profile: params.profile } : undefined,
    body: { url: params.url },
    timeoutMs: resolveBrowserTimeoutMs(params.timeoutMs, 20_000),
  });
}

export async function qaBrowserSnapshot<T = unknown>(
  env: QaBrowserEnv,
  params: QaBrowserSnapshotParams = {},
): Promise<T> {
  return await callQaBrowserRequest<T>(env, {
    method: "GET",
    path: "/snapshot",
    query: {
      profile: params.profile,
      targetId: params.targetId,
      format: params.format ?? "ai",
      limit: params.limit,
      interactive: params.interactive,
      compact: params.compact,
      depth: params.depth,
      selector: params.selector,
      frame: params.frame,
      labels: params.labels,
      mode: params.mode,
      maxChars: params.maxChars,
    },
    timeoutMs: resolveBrowserTimeoutMs(params.timeoutMs, 20_000),
  });
}

export async function qaBrowserAct<T = unknown>(
  env: QaBrowserEnv,
  params: QaBrowserActParams,
): Promise<T> {
  return await callQaBrowserRequest<T>(env, {
    method: "POST",
    path: "/act",
    query: params.profile ? { profile: params.profile } : undefined,
    body: params.request,
    timeoutMs: resolveBrowserTimeoutMs(params.timeoutMs, 20_000),
  });
}

function isQaBrowserReady(status: QaBrowserStatus | null | undefined) {
  return status?.enabled === true && status?.running === true && status?.cdpReady === true;
}

export async function waitForQaBrowserReady<T extends QaBrowserStatus = QaBrowserStatus>(
  env: QaBrowserEnv,
  params: QaBrowserReadyParams = {},
): Promise<T> {
  const timeoutMs = resolveBrowserTimeoutMs(params.timeoutMs, 20_000);
  const intervalMs = resolveBrowserTimeoutMs(params.intervalMs, 250);
  const startedAt = Date.now();
  let lastStatus: QaBrowserStatus | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastStatus = await callQaBrowserRequest<QaBrowserStatus>(env, {
      method: "GET",
      path: "/",
      query: params.profile ? { profile: params.profile } : undefined,
      timeoutMs: Math.min(timeoutMs, 5_000),
    });
    if (isQaBrowserReady(lastStatus)) {
      return lastStatus as T;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `browser control not ready after ${timeoutMs}ms${
      lastStatus ? ` (${JSON.stringify(lastStatus)})` : ""
    }`,
  );
}
