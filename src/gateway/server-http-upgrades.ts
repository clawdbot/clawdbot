import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { WebSocketServer } from "ws";
import { getRuntimeConfig } from "../config/io.js";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import {
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDraining,
  isGatewayWorkAdmissionClosed,
} from "../process/gateway-work-admission.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { NODE_DESKTOP_ATTACH_PATH } from "../shared/node-desktop-stream.js";
import { AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION, type AuthRateLimiter } from "./auth-rate-limit.js";
import type { GatewayAuthResult, ResolvedGatewayAuth } from "./auth.js";
import type { NodeDesktopStreamBroker } from "./desktop/node-stream-broker.js";
import type { DesktopSessionRegistry } from "./desktop/session-registry.js";
import { classifyWorkerGatewayPath } from "./gateway-http-route-contracts.js";
import type { AuthorizedGatewayHttpRequest } from "./http-auth-utils.js";
import {
  markGatewayIngressTransport,
  prepareGatewayIngressAttribution,
  PROXY_ATTRIBUTION_GUIDANCE,
  PROXY_ATTRIBUTION_REQUIRED_REASON,
  type GatewayIngressTransport,
  type GatewayUnattributableProxyReporter,
} from "./ingress-attribution.js";
import { normalizePluginNodeCapabilityScopedUrl } from "./plugin-node-capability.js";
import {
  getCachedPluginGatewayAuthBypassPaths,
  shouldEnforceDefaultPluginGatewayAuth,
  type PluginGatewayDispatchContext,
  type ResolvePluginNodeCapabilityRoute,
} from "./server-http-plugin-auth.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { writeGatewayUpgradeServiceUnavailable } from "./server/http-work-admission.js";
import { resolvePluginRoutePathContext } from "./server/plugins-http/path-context.js";
import type { PluginRoutePathContext } from "./server/plugins-http/path-context.js";
import type { PreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import { markPublicWorkerIngress } from "./server/public-worker-ingress-context.js";
import {
  GATEWAY_WS_CONNECTION_KIND_PROPERTY,
  type GatewayIngressWebSocket,
  type GatewayWsClient,
} from "./server/ws-types.js";

type PluginHttpUpgradeHandler = (
  req: IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: PluginGatewayDispatchContext,
) => Promise<boolean>;

const getPluginNodeCapabilityAuthModule = createLazyRuntimeModule(
  () => import("./server/plugin-node-capability-auth.js"),
);
const getHttpAuthUtilsModule = createLazyRuntimeModule(() => import("./http-auth-utils.js"));
const getPluginRouteRuntimeScopesModule = createLazyRuntimeModule(
  () => import("./server/plugin-route-runtime-scopes.js"),
);

function writeUpgradeAuthFailure(
  socket: { write: (chunk: string) => void },
  auth: GatewayAuthResult,
) {
  if (auth.rateLimited) {
    const retryAfterSeconds =
      auth.retryAfterMs && auth.retryAfterMs > 0 ? Math.ceil(auth.retryAfterMs / 1000) : undefined;
    const body = JSON.stringify({
      error: {
        message: "Too many failed authentication attempts. Please try again later.",
        type: "rate_limited",
      },
    });
    socket.write(
      [
        "HTTP/1.1 429 Too Many Requests",
        ...(retryAfterSeconds ? [`Retry-After: ${retryAfterSeconds}`] : []),
        "Content-Type: application/json; charset=utf-8",
        `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
        "Connection: close",
        "",
        body,
      ].join("\r\n"),
    );
    return;
  }
  if (auth.reason === PROXY_ATTRIBUTION_REQUIRED_REASON) {
    const body = JSON.stringify({
      error: {
        message: `Proxy client attribution is required. ${PROXY_ATTRIBUTION_GUIDANCE}`,
        type: PROXY_ATTRIBUTION_REQUIRED_REASON,
      },
    });
    socket.write(
      [
        "HTTP/1.1 403 Forbidden",
        "Content-Type: application/json; charset=utf-8",
        `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
        "Connection: close",
        "",
        body,
      ].join("\r\n"),
    );
    return;
  }
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
}

function handleBudgetedGatewayWebSocketUpgrade(params: {
  req: IncomingMessage;
  socket: import("node:stream").Duplex;
  head: Buffer;
  wss: WebSocketServer;
  preauthConnectionBudget: PreauthConnectionBudget;
  preauthBudgetKey: string | undefined;
  ingressName: "Gateway" | "Worker";
  prepareSocket?: (socket: GatewayIngressWebSocket) => void;
}): void {
  const { req, socket, head, wss, preauthConnectionBudget, preauthBudgetKey, ingressName } = params;
  if (
    isGatewayWorkAdmissionClosed() &&
    (ingressName === "Worker" ||
      isGatewayRestartDraining() ||
      getGatewaySuspendAdmissionPhase() !== "prepared")
  ) {
    writeGatewayUpgradeServiceUnavailable(socket, `${ingressName} websocket admission closed`);
    socket.destroy();
    return;
  }
  if (wss.listenerCount("connection") === 0) {
    writeGatewayUpgradeServiceUnavailable(socket, `${ingressName} websocket handlers unavailable`);
    socket.destroy();
    return;
  }
  if (!preauthConnectionBudget.acquire(preauthBudgetKey)) {
    writeGatewayUpgradeServiceUnavailable(socket, "Too many unauthenticated sockets");
    socket.destroy();
    return;
  }

  let budgetTransferred = false;
  // The upgrade owns its budget until the connection handler explicitly claims the socket.
  const releaseUpgradeBudget = () => {
    if (!budgetTransferred) {
      budgetTransferred = true;
      preauthConnectionBudget.release(preauthBudgetKey);
    }
  };
  socket.once("close", releaseUpgradeBudget);
  try {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const ingressSocket = ws as GatewayIngressWebSocket;
      ingressSocket["__openclawPreauthBudgetKey"] = preauthBudgetKey;
      params.prepareSocket?.(ingressSocket);
      wss.emit("connection", ws, req);
      if (ingressSocket["__openclawPreauthBudgetClaimed"]) {
        budgetTransferred = true;
        socket.off("close", releaseUpgradeBudget);
      }
    });
  } catch (error) {
    socket.off("close", releaseUpgradeBudget);
    releaseUpgradeBudget();
    throw error;
  }
}

/** Attaches WebSocket and plugin-upgrade routing to an already-created HTTP server. */
export function attachGatewayUpgradeHandler(opts: {
  httpServer: HttpServer;
  wss: WebSocketServer;
  handlePluginUpgrade?: PluginHttpUpgradeHandler;
  shouldEnforcePluginGatewayAuth?: (pathContext: PluginRoutePathContext) => boolean;
  isPluginAuthenticatedRoute?: (pathContext: PluginRoutePathContext) => boolean;
  resolvePluginNodeCapabilityRoute?: ResolvePluginNodeCapabilityRoute;
  clients: Set<GatewayWsClient>;
  preauthConnectionBudget: PreauthConnectionBudget;
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  /** Strict public-ingress limiter; loopback is never exempt. */
  publicRateLimiter?: AuthRateLimiter;
  workerIngressEnabled?: boolean;
  /** Optional logger for error diagnostics. */
  log?: { warn: (msg: string) => void };
  desktopSessionRegistry?: DesktopSessionRegistry;
  nodeDesktopStreamBroker?: NodeDesktopStreamBroker;
  getGatewayRequestContext?: () => GatewayRequestContext | undefined;
  ingressTransport?: GatewayIngressTransport;
  reportUnattributableProxy?: GatewayUnattributableProxyReporter;
}) {
  const {
    httpServer,
    wss,
    handlePluginUpgrade,
    shouldEnforcePluginGatewayAuth,
    resolvePluginNodeCapabilityRoute,
    clients,
    preauthConnectionBudget,
    resolvedAuth,
    rateLimiter,
    publicRateLimiter,
    workerIngressEnabled,
    log,
  } = opts;
  const getResolvedAuth = opts.getResolvedAuth ?? (() => resolvedAuth);
  httpServer.on("upgrade", (req, socket, head) => {
    markGatewayIngressTransport(req, opts.ingressTransport ?? { kind: "ordinary" });
    void runWithDiagnosticTraceContext(createDiagnosticTraceContext(), async () => {
      const configSnapshot = getRuntimeConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
      const ingressAttribution = prepareGatewayIngressAttribution({
        req,
        trustedProxies,
        allowRealIpFallback,
      });
      const requestClientIp =
        ingressAttribution.kind === "unattributable-proxy"
          ? ingressAttribution.remoteAddress
          : ingressAttribution.clientIp;
      const originalRequestPath = URL.parse(req.url ?? "/", "http://localhost")?.pathname;
      const originalWorkerGatewayRoute = originalRequestPath
        ? classifyWorkerGatewayPath(originalRequestPath)
        : "outside";
      if (
        originalWorkerGatewayRoute !== "outside" &&
        ingressAttribution.kind === "unattributable-proxy"
      ) {
        opts.reportUnattributableProxy?.(ingressAttribution);
        writeUpgradeAuthFailure(socket, { ok: false, reason: ingressAttribution.reason });
        socket.destroy();
        return;
      }
      if (originalWorkerGatewayRoute === "worker" && !workerIngressEnabled) {
        writeGatewayUpgradeServiceUnavailable(socket, "Worker websocket ingress unavailable");
        socket.destroy();
        return;
      }
      if (originalWorkerGatewayRoute === "worker") {
        const rateCheck = publicRateLimiter?.check(
          requestClientIp,
          AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION,
        );
        if (rateCheck && !rateCheck.allowed) {
          writeUpgradeAuthFailure(socket, {
            ok: false,
            reason: "rate_limited",
            rateLimited: true,
            retryAfterMs: rateCheck.retryAfterMs,
          });
          socket.destroy();
          return;
        }
        try {
          handleBudgetedGatewayWebSocketUpgrade({
            req,
            socket,
            head,
            wss,
            preauthConnectionBudget,
            preauthBudgetKey: requestClientIp,
            ingressName: "Worker",
            prepareSocket: (workerSocket) => {
              workerSocket[GATEWAY_WS_CONNECTION_KIND_PROPERTY] = "worker";
              markPublicWorkerIngress(workerSocket, {
                clientIp: requestClientIp,
                rateLimiter: publicRateLimiter,
              });
            },
          });
        } catch {
          throw new Error("public worker websocket upgrade failed");
        }
        return;
      }
      if (originalWorkerGatewayRoute !== "outside") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const scopedNodeCapability = normalizePluginNodeCapabilityScopedUrl(req.url ?? "/");
      if (scopedNodeCapability.malformedScopedPath) {
        writeUpgradeAuthFailure(socket, { ok: false, reason: "unauthorized" });
        socket.destroy();
        return;
      }
      if (scopedNodeCapability.rewrittenUrl) {
        req.url = scopedNodeCapability.rewrittenUrl;
      }
      const resolvedAuthLocal = getResolvedAuth();
      const requestPath = scopedNodeCapability.pathname;
      const pathContext = resolvePluginRoutePathContext(requestPath);
      const workerGatewayRoute = classifyWorkerGatewayPath(requestPath);
      if (workerGatewayRoute !== "outside") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const nodeCapability = resolvePluginNodeCapabilityRoute?.(pathContext);
      if (ingressAttribution.kind === "unattributable-proxy") {
        opts.reportUnattributableProxy?.(ingressAttribution);
        if (nodeCapability || !opts.isPluginAuthenticatedRoute?.(pathContext)) {
          writeUpgradeAuthFailure(socket, { ok: false, reason: ingressAttribution.reason });
          socket.destroy();
          return;
        }
      }
      if (nodeCapability) {
        // Node-capability WebSocket upgrades authenticate before plugin upgrade dispatch so
        // plugin handlers never receive unauthorized scoped capability sockets.
        const { authorizePluginNodeCapabilityRequest } = await getPluginNodeCapabilityAuthModule();
        const ok = await authorizePluginNodeCapabilityRequest({
          req,
          auth: resolvedAuthLocal,
          trustedProxies,
          allowRealIpFallback,
          clients,
          nodeCapability,
          capability: scopedNodeCapability.capability,
          malformedScopedPath: scopedNodeCapability.malformedScopedPath,
          rateLimiter,
        });
        if (!ok.ok) {
          writeUpgradeAuthFailure(socket, ok);
          socket.destroy();
          return;
        }
      }
      if (handlePluginUpgrade) {
        let pluginGatewayAuthSatisfied = false;
        let pluginGatewayRequestAuth: AuthorizedGatewayHttpRequest | undefined;
        let pluginGatewayRequestOperatorScopes: string[] | undefined;
        const enforcePluginGatewayAuth = (
          shouldEnforcePluginGatewayAuth ?? shouldEnforceDefaultPluginGatewayAuth
        )(pathContext);
        if (
          enforcePluginGatewayAuth &&
          !(await getCachedPluginGatewayAuthBypassPaths(configSnapshot)).has(requestPath)
        ) {
          const { checkGatewayHttpRequestAuth } = await getHttpAuthUtilsModule();
          const authCheck = await checkGatewayHttpRequestAuth({
            req,
            auth: resolvedAuthLocal,
            trustedProxies,
            allowRealIpFallback,
            rateLimiter,
            cfg: configSnapshot,
          });
          if (!authCheck.ok) {
            writeUpgradeAuthFailure(socket, authCheck.authResult);
            socket.destroy();
            return;
          }
          pluginGatewayAuthSatisfied = true;
          pluginGatewayRequestAuth = authCheck.requestAuth;
          const { resolvePluginRouteRuntimeOperatorScopes } =
            await getPluginRouteRuntimeScopesModule();
          pluginGatewayRequestOperatorScopes = resolvePluginRouteRuntimeOperatorScopes(
            req,
            authCheck.requestAuth,
          );
        }
        if (
          await handlePluginUpgrade(req, socket, head, pathContext, {
            gatewayAuthSatisfied: pluginGatewayAuthSatisfied,
            gatewayRequestAuth: pluginGatewayRequestAuth,
            gatewayRequestOperatorScopes: pluginGatewayRequestOperatorScopes,
            gatewayRequestClientIp: requestClientIp,
          })
        ) {
          return;
        }
      }
      if (ingressAttribution.kind === "unattributable-proxy") {
        writeUpgradeAuthFailure(socket, { ok: false, reason: ingressAttribution.reason });
        socket.destroy();
        return;
      }
      if (requestPath === "/desktop/observe") {
        if (!opts.desktopSessionRegistry) {
          writeGatewayUpgradeServiceUnavailable(socket, "desktop observe unavailable");
          socket.destroy();
          return;
        }
        // Desktop observers are long-lived Gateway sockets, so they obey the same
        // suspension/restart admission boundary as core upgrades. Without this a
        // drained Gateway would keep accepting new desktop streams.
        if (isGatewayWorkAdmissionClosed()) {
          writeGatewayUpgradeServiceUnavailable(socket, "Gateway websocket admission closed");
          socket.destroy();
          return;
        }
        const { handleDesktopObserveUpgrade } = await import("./desktop/observe-bridge.js");
        handleDesktopObserveUpgrade(req, socket, head, {
          registry: opts.desktopSessionRegistry,
        });
        return;
      }
      if (requestPath === NODE_DESKTOP_ATTACH_PATH) {
        const context = opts.getGatewayRequestContext?.();
        if (!opts.nodeDesktopStreamBroker || !context) {
          writeGatewayUpgradeServiceUnavailable(socket, "node desktop attach unavailable");
          socket.destroy();
          return;
        }
        if (isGatewayWorkAdmissionClosed()) {
          writeGatewayUpgradeServiceUnavailable(socket, "Gateway websocket admission closed");
          socket.destroy();
          return;
        }
        await opts.nodeDesktopStreamBroker.handleUpgrade(req, socket, head, context.nodeRegistry);
        return;
      }
      // Plugin-owned upgrade routes have already had the opportunity to claim the socket.
      // Core Gateway control connections remain reachable while suspension is prepared.
      try {
        handleBudgetedGatewayWebSocketUpgrade({
          req,
          socket,
          head,
          wss,
          preauthConnectionBudget,
          preauthBudgetKey: requestClientIp,
          ingressName: "Gateway",
        });
      } catch {
        throw new Error("gateway websocket upgrade failed");
      }
    }).catch((err: unknown) => {
      const remoteAddress = (socket as { remoteAddress?: string }).remoteAddress ?? "unknown";
      const errorMessage = err instanceof Error ? err.message : String(err);
      log?.warn(`ws upgrade error from ${remoteAddress}: ${errorMessage}`);
      socket.destroy();
    });
  });
}
