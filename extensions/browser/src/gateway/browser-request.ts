/**
 * Gateway handler for browser.request, including optional node-host proxy
 * dispatch and local Browser control route dispatch.
 */
import crypto from "node:crypto";
import { clampTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  BROWSER_PROXY_ERROR_ENVELOPE,
  parseBrowserProxyFailure,
  type BrowserProxyEnvelope,
  type BrowserProxyFile,
  type BrowserProxySuccess,
} from "../browser-proxy-envelope.js";
import {
  ErrorCodes,
  applyBrowserProxyPaths,
  createBrowserControlContext,
  createBrowserRouteDispatcher,
  errorShape,
  getRuntimeConfig,
  isBrowserHostLocalRoute,
  isNodeCommandAllowed,
  isPersistentBrowserProfileMutation,
  persistBrowserProxyFiles,
  resolveNodeCommandAllowlist,
  resolveNodeIdFromList,
  resolveRequestedBrowserProfile,
  respondUnavailableOnNodeInvokeError,
  safeParseJson,
  startBrowserControlServiceFromConfig,
  withTimeout,
  type GatewayRequestHandlers,
  type NodeSession,
  type OpenClawConfig,
} from "../core-api.js";

type BrowserRequestParams = {
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  timeoutMs?: number;
};

function isBrowserNode(node: NodeSession) {
  const caps = Array.isArray(node.caps) ? node.caps : [];
  const commands = Array.isArray(node.commands) ? node.commands : [];
  return caps.includes("browser") || commands.includes("browser.proxy");
}

function resolveBrowserNode(nodes: NodeSession[], query: string): NodeSession | null {
  const q = normalizeOptionalString(query) ?? "";
  if (!q) {
    return null;
  }
  const nodeId = resolveNodeIdFromList(nodes, q, false, { allowCompactDisplayName: true });
  return nodes.find((node) => node.nodeId === nodeId) ?? null;
}

function resolveBrowserNodeTarget(params: {
  cfg: OpenClawConfig;
  nodes: NodeSession[];
}): NodeSession | null {
  const policy = params.cfg.gateway?.nodes?.browser;
  const mode = policy?.mode ?? "auto";
  if (mode === "off") {
    return null;
  }
  const browserNodes = params.nodes.filter((node) => isBrowserNode(node));
  if (browserNodes.length === 0) {
    if (normalizeOptionalString(policy?.node)) {
      throw new Error("No connected browser-capable nodes.");
    }
    return null;
  }
  const requested = normalizeOptionalString(policy?.node) ?? "";
  if (requested) {
    const resolved = resolveBrowserNode(browserNodes, requested);
    if (!resolved) {
      throw new Error(`Configured browser node not connected: ${requested}`);
    }
    return resolved;
  }
  if (mode === "manual") {
    return null;
  }
  if (browserNodes.length === 1) {
    return browserNodes[0] ?? null;
  }
  return null;
}

async function persistProxyFiles(files: BrowserProxyFile[] | undefined) {
  return await persistBrowserProxyFiles(files);
}

function applyProxyPaths(result: unknown, mapping: Map<string, string>) {
  applyBrowserProxyPaths(result, mapping);
}

/** Handles one browser.request gateway call and streams a success/error response. */
export async function handleBrowserGatewayRequest({
  params,
  respond,
  context,
}: Parameters<GatewayRequestHandlers["browser.request"]>[0]) {
  const typed = params as BrowserRequestParams;
  const methodRaw = (normalizeOptionalString(typed.method) ?? "").toUpperCase();
  const path = normalizeOptionalString(typed.path) ?? "";
  const query = typed.query && typeof typed.query === "object" ? typed.query : undefined;
  const body = typed.body;
  const timeoutMs = clampTimerTimeoutMs(typed.timeoutMs);

  if (!methodRaw || !path) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "method and path are required"),
    );
    return;
  }
  if (methodRaw !== "GET" && methodRaw !== "POST" && methodRaw !== "DELETE") {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "method must be GET, POST, or DELETE"),
    );
    return;
  }
  const cfg = getRuntimeConfig();
  // System-profile listing and import can only run where the local Keychain and
  // Chrome profiles live, so they must never route to a browser node. Force
  // host-local dispatch even when gateway.nodes.browser auto-selects a node.
  const forceHostLocal = isBrowserHostLocalRoute(methodRaw, path);
  let nodeTarget: NodeSession | null = null;
  if (!forceHostLocal) {
    try {
      nodeTarget = resolveBrowserNodeTarget({
        cfg,
        nodes: context.nodeRegistry.listConnected(),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
      return;
    }
  }

  if (nodeTarget) {
    if (isPersistentBrowserProfileMutation(methodRaw, path)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "browser.request cannot mutate persistent browser profiles over a node proxy",
        ),
      );
      return;
    }
    const allowlist = resolveNodeCommandAllowlist(cfg, nodeTarget);
    const allowed = isNodeCommandAllowed({
      command: "browser.proxy",
      declaredCommands: nodeTarget.commands,
      allowlist,
    });
    if (!allowed.ok) {
      const platform = nodeTarget.platform ?? "unknown";
      const hint = `node command not allowed: ${allowed.reason} (platform: ${platform}, command: browser.proxy)`;
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, hint, {
          details: { reason: allowed.reason, command: "browser.proxy" },
        }),
      );
      return;
    }

    const proxyParams = {
      method: methodRaw,
      path,
      query,
      body,
      timeoutMs,
      profile: resolveRequestedBrowserProfile({ query, body }),
      errorEnvelope: BROWSER_PROXY_ERROR_ENVELOPE,
    };
    const res = await context.nodeRegistry.invoke({
      nodeId: nodeTarget.nodeId,
      command: "browser.proxy",
      params: proxyParams,
      timeoutMs,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!respondUnavailableOnNodeInvokeError(respond, res)) {
      return;
    }
    const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
    const failure = parseBrowserProxyFailure(payload);
    if (failure) {
      const { status, body: errorBody } = failure.error;
      const code = status >= 500 ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST;
      respond(false, undefined, errorShape(code, errorBody.error, { details: errorBody }));
      return;
    }
    const proxy = payload && typeof payload === "object" ? (payload as BrowserProxyEnvelope) : null;
    if (!proxy || !("result" in proxy)) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "browser proxy failed"));
      return;
    }
    const success = proxy as BrowserProxySuccess;
    const mapping = await persistProxyFiles(success.files);
    applyProxyPaths(success.result, mapping);
    respond(true, success.result);
    return;
  }

  // `browser.request` already requires operator.admin. The owning host may run
  // profile administration; the node-proxy branch above stays denied because
  // `browser.proxy` is a separate remote-host authority.
  const ready = await startBrowserControlServiceFromConfig();
  if (!ready) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "browser control is disabled"));
    return;
  }

  let dispatcher;
  try {
    dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    return;
  }

  let result;
  try {
    result = timeoutMs
      ? await withTimeout(
          (signal) =>
            dispatcher.dispatch({
              method: methodRaw,
              path,
              query,
              body,
              signal,
            }),
          timeoutMs,
          "browser request",
        )
      : await dispatcher.dispatch({
          method: methodRaw,
          path,
          query,
          body,
        });
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    return;
  }

  if (result.status >= 400) {
    const message =
      result.body && typeof result.body === "object" && "error" in result.body
        ? String((result.body as { error?: unknown }).error)
        : `browser request failed (${result.status})`;
    const code = result.status >= 500 ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST;
    respond(false, undefined, errorShape(code, message, { details: result.body }));
    return;
  }

  respond(true, result.body);
}

/** Gateway request handler map contributed by the Browser plugin. */
export const browserHandlers: GatewayRequestHandlers = {
  "browser.request": handleBrowserGatewayRequest,
};
