import {
  withBrowserStewardGatewayApproval,
  type BrowserStewardGatewayApprovalClaim,
} from "openclaw/plugin-sdk/browser-steward-runtime";
import {
  addTimerTimeoutGraceMs,
  MAX_TIMER_TIMEOUT_MS,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  BROWSER_PROXY_UPLOAD_COMMAND,
  browserProxyUploadUnavailableMessage,
} from "./browser-node-commands.js";
import { isBrowserControlHostUnavailableError } from "./browser-node-fallback.js";
import type { BrowserNodeTarget } from "./browser-node-routing.js";
import {
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
  agentSessionKey?: string;
  agentId?: string;
  browserNodeSessionLease?: string;
  browserStewardGatewayApproval?: BrowserStewardGatewayApprovalFactory;
  signal?: AbortSignal;
}) => Promise<unknown>) & {
  isHostFallbackActive: () => boolean;
  route: () => BrowserProxyRoute | undefined;
};

/**
 * Browser-owned Gateway path for retained node-tab cleanup. It is deliberately
 * narrower than a general Gateway client and is never exposed to model input.
 */
export type BrowserOwnedGatewayRequest = (params: {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  profile?: string;
  nodeId: string;
  browserNodeSessionLease?: string;
  timeoutMs: number;
}) => Promise<unknown>;

type BrowserStewardGatewayApprovalFactory = (params: {
  command: string;
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  upload?: unknown;
  profile?: string;
  agentSessionKey?: string;
  agentId?: string;
  nodeId?: string;
  browserNodeSessionLease?: string;
  allowAutomaticHostFallback?: boolean;
}) => BrowserStewardGatewayApprovalClaim;

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
  agentSessionKey?: string;
  agentId?: string;
  browserNodeSessionLease?: string;
  browserStewardGatewayApproval?: BrowserStewardGatewayApprovalFactory;
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
  let payload: { payload?: unknown; payloadJSON?: unknown } | null;
  const browserStewardGatewayApproval = params.browserStewardGatewayApproval?.({
    command: preparedUpload.upload ? BROWSER_PROXY_UPLOAD_COMMAND : "browser.proxy",
    method: params.method,
    path: params.path,
    query: params.query,
    body: preparedUpload.body,
    upload: preparedUpload.upload,
    profile: params.profile,
    agentSessionKey: params.agentSessionKey,
    agentId: params.agentId,
    nodeId: params.nodeId,
    browserNodeSessionLease: params.browserNodeSessionLease,
    allowAutomaticHostFallback: params.allowAutomaticHostFallback,
  });
  const call = () =>
    callGatewayTool<{ payload?: unknown; payloadJSON?: unknown }>(
      "browser.request",
      { timeoutMs: gatewayTimeoutMs },
      {
        nodeId: params.nodeId,
        allowAutomaticHostFallback: params.allowAutomaticHostFallback,
        includeRoute: true,
        // Keep the browser action and Gateway RPC on distinct budgets so a
        // detailed node timeout can cross the outer Gateway boundary.
        timeoutMs: nodeInvokeTimeoutMs,
        method: params.method,
        path: params.path,
        query: params.query,
        body: preparedUpload.body,
        upload: preparedUpload.upload,
        profile: params.profile,
        agentSessionKey: params.agentSessionKey,
        agentId: params.agentId,
        browserNodeSessionLease: params.browserNodeSessionLease,
        browserProxyTimeoutMs: proxyTimeoutMs,
      },
      {
        scopes: ["operator.admin"],
        ...(browserStewardGatewayApproval ? { requireAgentRuntimeIdentity: true } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      },
    );
  try {
    payload = browserStewardGatewayApproval
      ? await withBrowserStewardGatewayApproval(browserStewardGatewayApproval, call)
      : await call();
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
  agentSessionKey?: string;
  agentId?: string;
  browserNodeSessionLease?: string;
  browserStewardGatewayApproval?: BrowserStewardGatewayApprovalFactory;
  signal?: AbortSignal;
}): BrowserProxyRequest {
  let hostFallbackActive = false;
  let route: BrowserProxyRoute | undefined;
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
        nodeLabel: params.nodeTarget.label,
        declaredCommands: params.nodeTarget.commands ?? [],
        pendingDeclaredCommands: params.nodeTarget.pendingDeclaredCommands ?? [],
        allowAutomaticHostFallback: params.allowAutomaticHostFallback,
        agentSessionKey: params.agentSessionKey,
        agentId: params.agentId,
        browserNodeSessionLease: params.browserNodeSessionLease,
        ...requestWithSignal,
        browserStewardGatewayApproval: params.browserStewardGatewayApproval,
      });
      route = parseBrowserProxyRoute(proxy);
      if (route?.status === "host-fallback") {
        hostFallbackActive = true;
      }
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
      if (!params.allowAutomaticHostFallback || !(error instanceof BrowserNodeSafeFallbackError)) {
        throw error;
      }
      // These failures are detected before route dispatch. Retrying any later
      // failure could duplicate a mutating browser action.
      hostFallbackActive = true;
      route = undefined;
      logger.warn(
        `browser node ${params.nodeTarget.label ?? params.nodeTarget.nodeId} unavailable before dispatch (${error.message}); falling back to Gateway host`,
      );
      return await callLocalBrowserControl(requestWithSignal);
    }
  };
  return Object.assign(dispatch, {
    isHostFallbackActive: () => hostFallbackActive,
    route: () => route,
  });
}

export function createBrowserNodeSessionTabRoute(params: {
  nodeTarget: BrowserNodeTarget;
  agentSessionKey?: string;
  agentId?: string;
  browserNodeSessionLease?: string;
  browserStewardGatewayApproval?: BrowserStewardGatewayApprovalFactory;
  browserOwnedGatewayRequest?: BrowserOwnedGatewayRequest;
}): Extract<BrowserSessionTabRoute, { kind: "node-proxy" }> {
  return {
    kind: "node-proxy",
    nodeId: params.nodeTarget.nodeId,
    closeTarget: async (tab) => {
      // Session cleanup commonly runs after the originating agent turn, when
      // no ambient signed identity remains. Keep this effect on the Browser
      // plugin's lifecycle-owned Gateway path and bind it to the retained
      // node, lease, and exact tab-close request instead of reconstructing a
      // model/agent operation proof.
      if (params.browserOwnedGatewayRequest) {
        if (tab.ownership?.status === "durable") {
          return parseBrowserSessionTabCloseResult(
            await params.browserOwnedGatewayRequest({
              method: "POST",
              path: BROWSER_PROXY_OWNED_TAB_CLOSE_PATH,
              body: { ownership: tab.ownership },
              profile: tab.profile,
              nodeId: params.nodeTarget.nodeId,
              ...(params.browserNodeSessionLease
                ? { browserNodeSessionLease: params.browserNodeSessionLease }
                : {}),
              timeoutMs: DEFAULT_BROWSER_PROXY_TIMEOUT_MS,
            }),
          );
        }
        await params.browserOwnedGatewayRequest({
          method: "DELETE",
          path: `/tabs/${encodeURIComponent(tab.targetId)}`,
          query: { targetIdMode: "raw" },
          profile: tab.profile,
          nodeId: params.nodeTarget.nodeId,
          ...(params.browserNodeSessionLease
            ? { browserNodeSessionLease: params.browserNodeSessionLease }
            : {}),
          timeoutMs: DEFAULT_BROWSER_PROXY_TIMEOUT_MS,
        });
        return { status: "closed" };
      }
      const cleanupProxy = createBrowserNodeProxyRequest({
        nodeTarget: params.nodeTarget,
        allowAutomaticHostFallback: false,
        agentSessionKey: params.agentSessionKey,
        agentId: params.agentId,
        browserNodeSessionLease: params.browserNodeSessionLease,
        browserStewardGatewayApproval: params.browserStewardGatewayApproval,
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
