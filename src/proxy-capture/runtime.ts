import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { normalizeRequestInitHeadersForFetch } from "../infra/fetch-headers.js";
import { resolveDebugProxySettings, type DebugProxySettings } from "./env.js";
import {
  closeDebugProxyCaptureStore,
  getDebugProxyCaptureStore,
  persistEventPayload,
  safeJsonString,
} from "./store.sqlite.js";
import type {
  CaptureDirection,
  CaptureEventKind,
  CaptureEventRecord,
  CaptureProtocol,
} from "./types.js";

const DEBUG_PROXY_FETCH_PATCH_KEY = Symbol.for("openclaw.debugProxy.fetchPatch");
const REDACTED_CAPTURE_HEADER_VALUE = "[REDACTED]";
const SENSITIVE_CAPTURE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "auth-token",
  "x-access-token",
  "access-token",
]);
const SENSITIVE_CAPTURE_HEADER_NAME_FRAGMENTS = [
  "api-key",
  "apikey",
  "token",
  "secret",
  "password",
  "credential",
  "session",
];

type GlobalFetchPatchedState = {
  originalFetch: typeof globalThis.fetch;
};

type GlobalFetchPatchTarget = typeof globalThis & {
  [DEBUG_PROXY_FETCH_PATCH_KEY]?: GlobalFetchPatchedState;
};

type DebugProxyCaptureStoreLike = Pick<
  ReturnType<typeof getDebugProxyCaptureStore>,
  "upsertSession" | "endSession" | "recordEvent"
>;

export type DebugProxyCaptureRuntimeDeps = {
  getStore?: (dbPath: string, blobDir: string) => DebugProxyCaptureStoreLike;
  closeStore?: typeof closeDebugProxyCaptureStore;
  persistEventPayload?: (
    store: DebugProxyCaptureStoreLike,
    payload: Parameters<typeof persistEventPayload>[1],
  ) => ReturnType<typeof persistEventPayload>;
  safeJsonString?: typeof safeJsonString;
  fetchTarget?: typeof globalThis;
};

function resolveRuntimeDeps(deps: DebugProxyCaptureRuntimeDeps = {}) {
  return {
    getStore: deps.getStore ?? getDebugProxyCaptureStore,
    closeStore: deps.closeStore ?? closeDebugProxyCaptureStore,
    persistEventPayload:
      deps.persistEventPayload ??
      ((store, payload) =>
        persistEventPayload(store as ReturnType<typeof getDebugProxyCaptureStore>, payload)),
    safeJsonString: deps.safeJsonString ?? safeJsonString,
    fetchTarget: deps.fetchTarget ?? globalThis,
  };
}

function protocolFromUrl(rawUrl: string): CaptureProtocol {
  try {
    const url = new URL(rawUrl);
    switch (url.protocol) {
      case "https:":
        return "https";
      case "wss:":
        return "wss";
      case "ws:":
        return "ws";
      default:
        return "http";
    }
  } catch {
    return "http";
  }
}

function resolveUrlString(input: RequestInfo | URL): string | null {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return null;
}

function isSensitiveCaptureHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (SENSITIVE_CAPTURE_HEADER_NAMES.has(normalized)) {
    return true;
  }
  return SENSITIVE_CAPTURE_HEADER_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function redactedCaptureHeaders(
  headers: Headers | Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const entries =
    headers instanceof Headers ? Array.from(headers.entries()) : Object.entries(headers);
  const redacted: Record<string, string> = {};
  for (const [name, value] of entries) {
    redacted[name] = isSensitiveCaptureHeaderName(name) ? REDACTED_CAPTURE_HEADER_VALUE : value;
  }
  return redacted;
}

function createHttpCaptureEventBase(params: {
  settings: DebugProxySettings;
  rawUrl: string;
  url: URL;
  transport?: "http" | "sse";
  direction: CaptureDirection;
  kind: CaptureEventKind;
  flowId: string;
  method: string;
}): CaptureEventRecord {
  return {
    sessionId: params.settings.sessionId,
    ts: Date.now(),
    sourceScope: "openclaw",
    sourceProcess: params.settings.sourceProcess,
    protocol: params.transport ?? protocolFromUrl(params.rawUrl),
    direction: params.direction,
    kind: params.kind,
    flowId: params.flowId,
    method: params.method,
    host: params.url.host,
    path: `${params.url.pathname}${params.url.search}`,
  };
}

function installDebugProxyGlobalFetchPatch(
  settings: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const runtime = resolveRuntimeDeps(deps);
  const fetchTarget = runtime.fetchTarget as GlobalFetchPatchTarget;
  if (typeof fetchTarget.fetch !== "function") {
    return;
  }
  if (fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY]) {
    return;
  }
  const originalFetch = fetchTarget.fetch.bind(fetchTarget);
  fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY] = { originalFetch };
  fetchTarget.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = resolveUrlString(input);
    const normalizedInit = normalizeRequestInitHeadersForFetch(init);
    try {
      const response = await originalFetch(input, normalizedInit);
      if (url && /^https?:/i.test(url)) {
        captureHttpExchange(
          {
            url,
            method:
              (typeof Request !== "undefined" && input instanceof Request
                ? input.method
                : undefined) ??
              normalizedInit?.method ??
              "GET",
            requestHeaders:
              (typeof Request !== "undefined" && input instanceof Request
                ? input.headers
                : undefined) ??
              (normalizedInit?.headers as Headers | Record<string, string> | undefined),
            requestBody:
              (typeof Request !== "undefined" && input instanceof Request
                ? (input as Request & { body?: BodyInit | null }).body
                : undefined) ??
              (normalizedInit as (RequestInit & { body?: BodyInit | null }) | undefined)?.body ??
              null,
            response,
            transport: "http",
            meta: {
              captureOrigin: "global-fetch",
              source: settings.sourceProcess,
            },
          },
          settings,
          deps,
        );
      }
      return response;
    } catch (error) {
      if (url && /^https?:/i.test(url)) {
        const store = runtime.getStore(settings.dbPath, settings.blobDir);
        const parsed = new URL(url);
        store.recordEvent({
          sessionId: settings.sessionId,
          ts: Date.now(),
          sourceScope: "openclaw",
          sourceProcess: settings.sourceProcess,
          protocol: protocolFromUrl(url),
          direction: "local",
          kind: "error",
          flowId: randomUUID(),
          method:
            (typeof Request !== "undefined" && input instanceof Request
              ? input.method
              : undefined) ??
            normalizedInit?.method ??
            "GET",
          host: parsed.host,
          path: `${parsed.pathname}${parsed.search}`,
          errorText: error instanceof Error ? error.message : String(error),
          metaJson: runtime.safeJsonString({ captureOrigin: "global-fetch" }),
        });
      }
      throw error;
    }
  }) as typeof globalThis.fetch;
}

function uninstallDebugProxyGlobalFetchPatch(deps: DebugProxyCaptureRuntimeDeps = {}): void {
  const fetchTarget = resolveRuntimeDeps(deps).fetchTarget as GlobalFetchPatchTarget;
  const state = fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY];
  if (!state) {
    return;
  }
  fetchTarget.fetch = state.originalFetch;
  delete fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY];
}

export function isDebugProxyGlobalFetchPatchInstalled(): boolean {
  return Boolean((globalThis as GlobalFetchPatchTarget)[DEBUG_PROXY_FETCH_PATCH_KEY]);
}

export function initializeDebugProxyCapture(
  mode: string,
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const settings = resolved ?? resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  resolveRuntimeDeps(deps).getStore(settings.dbPath, settings.blobDir).upsertSession({
    id: settings.sessionId,
    startedAt: Date.now(),
    mode,
    sourceScope: "openclaw",
    sourceProcess: settings.sourceProcess,
    proxyUrl: settings.proxyUrl,
    dbPath: settings.dbPath,
    blobDir: settings.blobDir,
  });
  installDebugProxyGlobalFetchPatch(settings, deps);
}

export function finalizeDebugProxyCapture(
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const settings = resolved ?? resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  const runtime = resolveRuntimeDeps(deps);
  runtime.getStore(settings.dbPath, settings.blobDir).endSession(settings.sessionId);
  uninstallDebugProxyGlobalFetchPatch(deps);
  runtime.closeStore();
}

export function captureHttpExchange(
  params: {
    url: string;
    method: string;
    requestHeaders?: Headers | Record<string, string> | undefined;
    requestBody?: BodyInit | Buffer | string | null;
    response: Response;
    transport?: "http" | "sse";
    flowId?: string;
    meta?: Record<string, unknown>;
  },
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const settings = resolved ?? resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  const runtime = resolveRuntimeDeps(deps);
  const store = runtime.getStore(settings.dbPath, settings.blobDir);
  const flowId = params.flowId ?? randomUUID();
  const url = new URL(params.url);
  const requestBody =
    typeof params.requestBody === "string" || Buffer.isBuffer(params.requestBody)
      ? params.requestBody
      : null;
  const requestPayload = runtime.persistEventPayload(store, {
    data: requestBody,
    contentType:
      params.requestHeaders instanceof Headers
        ? (params.requestHeaders.get("content-type") ?? undefined)
        : params.requestHeaders?.["content-type"],
  });
  store.recordEvent({
    ...createHttpCaptureEventBase({
      settings,
      rawUrl: params.url,
      url,
      transport: params.transport,
      direction: "outbound",
      kind: "request",
      flowId,
      method: params.method,
    }),
    contentType:
      params.requestHeaders instanceof Headers
        ? (params.requestHeaders.get("content-type") ?? undefined)
        : params.requestHeaders?.["content-type"],
    headersJson: runtime.safeJsonString(redactedCaptureHeaders(params.requestHeaders)),
    metaJson: runtime.safeJsonString(params.meta),
    ...requestPayload,
  });
  const cloneable =
    params.response &&
    typeof params.response.clone === "function" &&
    typeof params.response.arrayBuffer === "function";
  if (!cloneable) {
    store.recordEvent({
      ...createHttpCaptureEventBase({
        settings,
        rawUrl: params.url,
        url,
        transport: params.transport,
        direction: "inbound",
        kind: "response",
        flowId,
        method: params.method,
      }),
      status: params.response.status,
      contentType:
        typeof params.response.headers?.get === "function"
          ? (params.response.headers.get("content-type") ?? undefined)
          : undefined,
      headersJson:
        params.response.headers && typeof params.response.headers.entries === "function"
          ? runtime.safeJsonString(redactedCaptureHeaders(params.response.headers))
          : undefined,
      metaJson: runtime.safeJsonString({ ...params.meta, bodyCapture: "unavailable" }),
    });
    return;
  }
  void params.response
    .clone()
    .arrayBuffer()
    .then((buffer) => {
      const responsePayload = runtime.persistEventPayload(store, {
        data: Buffer.from(buffer),
        contentType: params.response.headers.get("content-type") ?? undefined,
      });
      store.recordEvent({
        ...createHttpCaptureEventBase({
          settings,
          rawUrl: params.url,
          url,
          transport: params.transport,
          direction: "inbound",
          kind: "response",
          flowId,
          method: params.method,
        }),
        status: params.response.status,
        contentType: params.response.headers.get("content-type") ?? undefined,
        headersJson: runtime.safeJsonString(redactedCaptureHeaders(params.response.headers)),
        metaJson: runtime.safeJsonString(params.meta),
        ...responsePayload,
      });
    })
    .catch((error) => {
      store.recordEvent({
        ...createHttpCaptureEventBase({
          settings,
          rawUrl: params.url,
          url,
          transport: params.transport,
          direction: "local",
          kind: "error",
          flowId,
          method: params.method,
        }),
        errorText: error instanceof Error ? error.message : String(error),
      });
    });
}

export function captureWsEvent(params: {
  url: string;
  direction: "outbound" | "inbound" | "local";
  kind: "ws-open" | "ws-frame" | "ws-close" | "error";
  flowId: string;
  payload?: string | Buffer;
  closeCode?: number;
  errorText?: string;
  meta?: Record<string, unknown>;
}): void {
  const settings = resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  const store = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir);
  const url = new URL(params.url);
  const payload = persistEventPayload(store, {
    data: params.payload,
    contentType: "application/json",
  });
  store.recordEvent({
    sessionId: settings.sessionId,
    ts: Date.now(),
    sourceScope: "openclaw",
    sourceProcess: settings.sourceProcess,
    protocol: protocolFromUrl(params.url),
    direction: params.direction,
    kind: params.kind,
    flowId: params.flowId,
    host: url.host,
    path: `${url.pathname}${url.search}`,
    closeCode: params.closeCode,
    errorText: params.errorText,
    metaJson: safeJsonString(params.meta),
    ...payload,
  });
}
