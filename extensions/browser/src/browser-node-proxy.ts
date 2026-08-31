import crypto from "node:crypto";
import {
  addTimerTimeoutGraceMs,
  MAX_TIMER_TIMEOUT_MS,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  BROWSER_PROXY_COMMAND,
  BROWSER_PROXY_UPLOAD_COMMAND,
  browserProxyUploadUnavailableMessage,
} from "./browser-node-commands.js";
import { isBrowserControlHostUnavailableError } from "./browser-node-fallback.js";
import type { BrowserNodeTarget } from "./browser-node-routing.js";
import {
  BROWSER_PROXY_ERROR_ENVELOPE,
  BROWSER_PROXY_OWNED_TAB_CLOSE_PATH,
  parseBrowserProxyFailure,
  parseBrowserProxyRoute,
  type BrowserProxyEnvelope,
  type BrowserProxyRoute,
} from "./browser-proxy-envelope.js";
import {
  isBrowserProxyUploadRequest,
  prepareBrowserProxyUploadRequest,
} from "./browser-proxy-upload.js";
import {
  callGatewayTool,
  fetchBrowserJson,
  persistBrowserProxyResultFiles,
} from "./browser-tool.runtime.js";
import { BrowserServiceError } from "./browser/client-fetch.js";
import {
  parseBrowserSessionTabCloseResult,
  type BrowserSessionTabRoute,
} from "./browser/session-tab-route.js";

const logger = createSubsystemLogger("browser");
const DEFAULT_BROWSER_PROXY_TIMEOUT_MS = 20_000;
const BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS = 5_000;

class BrowserNodeSafeFallbackError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BrowserNodeSafeFallbackError";
  }
}

export type BrowserProxyRequest = ((params: {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
  signal?: AbortSignal;
}) => Promise<unknown>) & {
  isHostFallbackActive: () => boolean;
  route: () => BrowserProxyRoute | undefined;
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
  nodeLabel?: string;
  declaredCommands: readonly string[];
  pendingDeclaredCommands: readonly string[];
  allowAutomaticHostFallback: boolean;
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
  signal?: AbortSignal;
}): Promise<BrowserProxyEnvelope> {
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
  if (
    isBrowserProxyUploadRequest(params) &&
    !params.declaredCommands.includes(BROWSER_PROXY_UPLOAD_COMMAND)
  ) {
    throw new BrowserNodeSafeFallbackError(
      browserProxyUploadUnavailableMessage(params.pendingDeclaredCommands),
    );
  }
  const preparedUpload = await prepareBrowserProxyUploadRequest({
    method: params.method,
    path: params.path,
    body: params.body,
    signal: params.signal,
  });
  const command = preparedUpload.upload ? BROWSER_PROXY_UPLOAD_COMMAND : BROWSER_PROXY_COMMAND;
  let payload: { payload?: unknown; payloadJSON?: unknown } | null;
  try {
    payload = await callGatewayTool<{ payload?: unknown; payloadJSON?: unknown }>(
      "node.invoke",
      { timeoutMs: gatewayTimeoutMs },
      {
        nodeId: params.nodeId,
        command,
        // Keep the browser action, node watchdog, and Gateway RPC on distinct
        // budgets so a detailed node timeout can cross both outer boundaries.
        timeoutMs: nodeInvokeTimeoutMs,
        params: {
          method: params.method,
          path: params.path,
          query: params.query,
          body: preparedUpload.body,
          upload: preparedUpload.upload,
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
    if (params.allowAutomaticHostFallback && isBrowserControlHostUnavailableError(error)) {
      throw new BrowserNodeSafeFallbackError("browser node control host unavailable", error);
    }
    throw error;
  }
  const parsed = unwrapBrowserProxyPayload(payload);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (!("result" in parsed) && !parseBrowserProxyFailure(parsed))
  ) {
    const selectedNode = truncateUtf16Safe(params.nodeLabel?.trim() || params.nodeId, 256);
    throw new Error(
      `Browser proxy returned an invalid response from node ${JSON.stringify(selectedNode)}. Retry with action=status target="host" to check Gateway host browser control.`,
    );
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
  nodeTarget: BrowserNodeTarget;
  allowAutomaticHostFallback: boolean;
  signal?: AbortSignal;
}): BrowserProxyRequest {
  let target: "auto" | "node" | "host" = params.allowAutomaticHostFallback ? "auto" : "node";
  let route: BrowserProxyRoute | undefined;
  const dispatch = async (request: Parameters<BrowserProxyRequest>[0]) => {
    // Bind cancellation once so every node action and its safe host fallback
    // inherit their execution signal without overriding an explicit request.
    const requestWithSignal =
      request.signal || params.signal
        ? { ...request, signal: request.signal ?? params.signal }
        : request;
    if (target === "host") {
      return await callLocalBrowserControl(requestWithSignal);
    }
    try {
      const proxy = await callBrowserProxy({
        nodeId: params.nodeTarget.nodeId,
        nodeLabel: params.nodeTarget.label,
        declaredCommands: params.nodeTarget.commands ?? [],
        pendingDeclaredCommands: params.nodeTarget.pendingDeclaredCommands ?? [],
        allowAutomaticHostFallback: target === "auto",
        ...requestWithSignal,
      });
      // A follow-up snapshot or setting belongs to the browser that already
      // handled this action, even if that node subsequently becomes unavailable.
      target = "node";
      route = parseBrowserProxyRoute(proxy);
      const failure = parseBrowserProxyFailure(proxy);
      if (failure) {
        const { status, body } = failure.error;
        throw new BrowserServiceError(body.error, body, status);
      }
      if (!("result" in proxy)) {
        throw new Error("Browser proxy returned a failure without an error payload.");
      }
      return await persistBrowserProxyResultFiles(proxy.result, proxy.files);
    } catch (error) {
      if (target !== "auto" || !(error instanceof BrowserNodeSafeFallbackError)) {
        throw error;
      }
      // These failures are detected before route dispatch. Retrying any later
      // failure could duplicate a mutating browser action.
      target = "host";
      route = undefined;
      logger.warn(
        `browser node ${params.nodeTarget.label ?? params.nodeTarget.nodeId} unavailable before dispatch (${error.message}); falling back to Gateway host`,
      );
      return await callLocalBrowserControl(requestWithSignal);
    }
  };
  return Object.assign(dispatch, {
    isHostFallbackActive: () => target === "host",
    route: () => route,
  });
}

export function createBrowserNodeSessionTabRoute(
  nodeTarget: BrowserNodeTarget,
): Extract<BrowserSessionTabRoute, { kind: "node-proxy" }> {
  return {
    kind: "node-proxy",
    nodeId: nodeTarget.nodeId,
    closeTarget: async (tab) => {
      const cleanupProxy = createBrowserNodeProxyRequest({
        nodeTarget,
        allowAutomaticHostFallback: false,
      });
      if (tab.ownership?.status === "durable") {
        return parseBrowserSessionTabCloseResult(
          await cleanupProxy({
            method: "POST",
            path: BROWSER_PROXY_OWNED_TAB_CLOSE_PATH,
            body: { ownership: tab.ownership },
            profile: tab.profile,
          }),
        );
      }
      await cleanupProxy({
        method: "DELETE",
        path: `/tabs/${encodeURIComponent(tab.targetId)}`,
        query: { targetIdMode: "raw" },
        profile: tab.profile,
      });
      return { status: "closed" };
    },
  };
}
