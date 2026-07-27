import crypto from "node:crypto";
import {
  addTimerTimeoutGraceMs,
  MAX_TIMER_TIMEOUT_MS,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { isBrowserControlHostUnavailableError } from "./browser-node-fallback.js";
import {
  BROWSER_PROXY_ERROR_ENVELOPE,
  parseBrowserProxyFailure,
  type BrowserProxyEnvelope,
  type BrowserProxySuccess,
} from "./browser-proxy-envelope.js";
import {
  applyBrowserProxyPaths,
  callGatewayTool,
  fetchBrowserJson,
  persistBrowserProxyFiles,
} from "./browser-tool.runtime.js";
import { BrowserServiceError } from "./browser/client-fetch.js";

const logger = createSubsystemLogger("browser");
const DEFAULT_BROWSER_PROXY_TIMEOUT_MS = 20_000;
const BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS = 5_000;

class BrowserNodeControlHostUnavailableError extends Error {
  constructor(cause: unknown) {
    super("auto-selected browser node control host unavailable", { cause });
    this.name = "BrowserNodeControlHostUnavailableError";
  }
}

type BrowserProxyRequest = ((params: {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
  signal?: AbortSignal;
}) => Promise<unknown>) & {
  isHostFallbackActive: () => boolean;
};

function unwrapBrowserProxyPayload(
  payload: { payload?: unknown; payloadJSON?: unknown } | null,
): BrowserProxyEnvelope | null {
  if (payload?.payload !== undefined) {
    return payload.payload as BrowserProxyEnvelope;
  }
  if (typeof payload?.payloadJSON !== "string" || !payload.payloadJSON.trim()) {
    return null;
  }
  try {
    return JSON.parse(payload.payloadJSON) as BrowserProxyEnvelope;
  } catch {
    return null;
  }
}

async function callBrowserProxy(params: {
  nodeId: string;
  markControlHostUnavailable: boolean;
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
  signal?: AbortSignal;
}): Promise<BrowserProxySuccess> {
  // Reserve both watchdog windows before clamping so timer saturation cannot
  // make an outer watchdog expire alongside the browser action.
  const proxyTimeoutMs = Math.min(
    resolveTimerTimeoutMs(params.timeoutMs, DEFAULT_BROWSER_PROXY_TIMEOUT_MS),
    MAX_TIMER_TIMEOUT_MS - 2 * BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS,
  );
  const nodeInvokeTimeoutMs =
    addTimerTimeoutGraceMs(proxyTimeoutMs, BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS) ??
    proxyTimeoutMs;
  const gatewayTimeoutMs =
    addTimerTimeoutGraceMs(nodeInvokeTimeoutMs, BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS) ??
    nodeInvokeTimeoutMs;
  let payload: { payload?: unknown; payloadJSON?: unknown } | null;
  try {
    payload = await callGatewayTool<{ payload?: unknown; payloadJSON?: unknown }>(
      "node.invoke",
      { timeoutMs: gatewayTimeoutMs },
      {
        nodeId: params.nodeId,
        command: "browser.proxy",
        // Keep the browser action, node watchdog, and Gateway RPC on distinct
        // budgets so a detailed node timeout can cross both outer boundaries.
        timeoutMs: nodeInvokeTimeoutMs,
        params: {
          method: params.method,
          path: params.path,
          query: params.query,
          body: params.body,
          timeoutMs: proxyTimeoutMs,
          profile: params.profile,
          errorEnvelope: BROWSER_PROXY_ERROR_ENVELOPE,
        },
        idempotencyKey: crypto.randomUUID(),
      },
      {
        scopes: ["operator.admin"],
        ...(params.signal ? { signal: params.signal } : {}),
      },
    );
  } catch (error) {
    if (params.markControlHostUnavailable && isBrowserControlHostUnavailableError(error)) {
      throw new BrowserNodeControlHostUnavailableError(error);
    }
    throw error;
  }
  const parsed = unwrapBrowserProxyPayload(payload);
  const failure = parseBrowserProxyFailure(parsed);
  if (failure) {
    const { status, body } = failure.error;
    throw new BrowserServiceError(body.error, "reason" in body ? body : undefined, status);
  }
  if (!parsed || typeof parsed !== "object" || !("result" in parsed)) {
    throw new Error("browser proxy failed");
  }
  return parsed;
}

async function callLocalBrowserControl(params: Parameters<BrowserProxyRequest>[0]) {
  const url = new URL(params.path, "http://localhost");
  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  if (params.profile) {
    url.searchParams.set("profile", params.profile);
  }
  return await fetchBrowserJson(`${url.pathname}${url.search}`, {
    method: params.method,
    body: params.body === undefined ? undefined : JSON.stringify(params.body),
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
}

export function createBrowserNodeProxyRequest(params: {
  nodeTarget: { nodeId: string; label?: string };
  allowAutomaticHostFallback: boolean;
  signal?: AbortSignal;
}): BrowserProxyRequest {
  let hostFallbackActive = false;
  const dispatch = async (request: Parameters<BrowserProxyRequest>[0]) => {
    // Bind cancellation once so every node action and its safe host fallback
    // inherit their execution signal without overriding an explicit request.
    const requestWithSignal =
      request.signal || params.signal
        ? { ...request, signal: request.signal ?? params.signal }
        : request;
    if (hostFallbackActive) {
      return await callLocalBrowserControl(requestWithSignal);
    }
    try {
      const proxy = await callBrowserProxy({
        nodeId: params.nodeTarget.nodeId,
        markControlHostUnavailable: params.allowAutomaticHostFallback,
        ...requestWithSignal,
      });
      const mapping = await persistBrowserProxyFiles(proxy.files);
      applyBrowserProxyPaths(proxy.result, mapping);
      return proxy.result;
    } catch (error) {
      if (
        !params.allowAutomaticHostFallback ||
        !(error instanceof BrowserNodeControlHostUnavailableError)
      ) {
        throw error;
      }
      // This exact node-host failure occurs before any browser action. Retrying
      // other failures could duplicate a mutating operation.
      hostFallbackActive = true;
      logger.warn(
        `browser node ${params.nodeTarget.label ?? params.nodeTarget.nodeId} control host unavailable; falling back to Gateway host`,
      );
      return await callLocalBrowserControl(requestWithSignal);
    }
  };
  return Object.assign(dispatch, {
    isHostFallbackActive: () => hostFallbackActive,
  });
}
