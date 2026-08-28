// Gateway HTTP server routes control UI, OpenAI-compatible APIs, plugin HTTP
// surfaces, hooks, readiness, auth, and WebSocket upgrades.
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TlsOptions } from "node:tls";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { isCanvasDocumentHttpPath } from "../canvas/constants.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { runHttpConnectionRequest } from "../infra/http-request-lifecycle.js";
import { parseDevicePairingJoinRequestPath } from "../pairing/join-code.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveAssistantIdentity } from "./assistant-identity.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  parseControlUiUserAvatarPath,
  parseControlUiResourcePath,
  type ControlUiResourceRoute,
} from "./control-ui-contract.js";
import { respondNotFound, respondPlainText } from "./control-ui-http-utils.js";
import {
  isControlUiApprovalDocumentPath,
  isControlUiFocusDocumentPath,
  isControlUiPluginManagerRequest,
} from "./control-ui-routing.js";
import type { ControlUiRootState } from "./control-ui.js";
import {
  classifyGatewayProbePath,
  classifyMcpAppStandalonePath,
  classifyNodeWorkerBundleTransferPath,
  classifyNodeWorkspaceTransferPath,
  classifyWorkerGatewayPath,
} from "./gateway-http-route-contracts.js";
import type { AuthorizedGatewayHttpRequest } from "./http-auth-utils.js";
import {
  finishFailedGatewayHttpResponse,
  sendGatewayAuthFailure,
  setDefaultSecurityHeaders,
} from "./http-common.js";
import {
  markGatewayIngressTransport,
  prepareGatewayIngressAttribution,
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
import { handleGatewayProbeRequest } from "./server-http-probes.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { HooksRequestHandler } from "./server/hooks-request-handler.js";
import { runWithGatewayHttpWorkAdmission } from "./server/http-work-admission.js";
import {
  resolvePluginRoutePathContext,
  type PluginRoutePathContext,
} from "./server/plugins-http/path-context.js";
import type { ReadinessChecker, StartupChecker } from "./server/readiness.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { isTerminalConfigEnabled } from "./terminal/enabled.js";
import {
  handleNodeWorkerBundleTransferHttpRequest,
  type NodeWorkerBundleTransferHttpCallback,
} from "./worker-environments/node-worker-bundle-transfer-http.js";
import {
  handleNodeWorkspaceTransferHttpRequest,
  type NodeWorkspaceTransferHttpCallback,
} from "./worker-environments/node-workspace-transfer-http.js";

type PluginHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: PluginGatewayDispatchContext,
) => Promise<boolean>;

type WatchNodeHttpRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
type McpOAuthCallbackHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

const getControlUiModule = createLazyRuntimeModule(() => import("./control-ui.js"));
const getCanvasServeModule = createLazyRuntimeModule(() => import("../canvas/serve.runtime.js"));
const getBoardHttpModule = createLazyRuntimeModule(() => import("./board-http.js"));
const getEmbeddingsHttpModule = createLazyRuntimeModule(() => import("./embeddings-http.js"));
const getManagedMediaAttachmentsModule = createLazyRuntimeModule(
  () => import("./managed-image-attachments.js"),
);
const getMcpAppStandaloneModule = createLazyRuntimeModule(() => import("./mcp-app-standalone.js"));
const getPluginIconHttpModule = createLazyRuntimeModule(() => import("./plugin-icon-http.js"));
const getWorkspaceIconHttpModule = createLazyRuntimeModule(
  () => import("./workspace-icon-http.js"),
);
const getChannelAvatarHttpModule = createLazyRuntimeModule(
  () => import("./channel-avatar-http.js"),
);
const getModelsHttpModule = createLazyRuntimeModule(() => import("./models-http.js"));
const getOpenAiHttpModule = createLazyRuntimeModule(() => import("./openai-http.js"));
const getOpenResponsesHttpModule = createLazyRuntimeModule(() => import("./openresponses-http.js"));
const getSessionHistoryHttpModule = createLazyRuntimeModule(
  () => import("./sessions-history-http.js"),
);
const getSessionKillHttpModule = createLazyRuntimeModule(() => import("./session-kill-http.js"));
const getToolsInvokeHttpModule = createLazyRuntimeModule(() => import("./tools-invoke-http.js"));
const getUserProfilesHttpModule = createLazyRuntimeModule(() => import("./user-profiles-http.js"));
const getDevicePairingJoinHttpModule = createLazyRuntimeModule(
  () => import("./device-pairing-join-http.js"),
);
const getPluginNodeCapabilityAuthModule = createLazyRuntimeModule(
  () => import("./server/plugin-node-capability-auth.js"),
);
const getHttpAuthUtilsModule = createLazyRuntimeModule(() => import("./http-auth-utils.js"));
const getPluginRouteRuntimeScopesModule = createLazyRuntimeModule(
  () => import("./server/plugin-route-runtime-scopes.js"),
);

function isWebSocketUpgradeRequest(req: IncomingMessage): boolean {
  const headerContains = (value: string | readonly string[] | undefined, token: string) =>
    (typeof value === "string" ? [value] : (value ?? [])).some((entry) =>
      entry
        .toLowerCase()
        .split(",")
        .some((part) => part.trim() === token),
    );
  return (
    headerContains(req.headers.upgrade, "websocket") &&
    headerContains(req.headers.connection, "upgrade")
  );
}

type GatewayHttpRequestStage = () => Promise<boolean> | boolean;

/** Creates the gateway HTTP/HTTPS server and ordered request-stage router. */
export function createGatewayHttpServer(opts: {
  clients: Set<GatewayWsClient>;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openAiChatCompletionsConfig?: import("../config/types.gateway.js").GatewayHttpChatCompletionsConfig;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  strictTransportSecurityHeader?: string;
  handleHooksRequest: HooksRequestHandler;
  handleMcpOAuthCallbackRequest?: McpOAuthCallbackHandler;
  handleWatchNodeRequest?: WatchNodeHttpRequestHandler;
  handlePluginRequest?: PluginHttpRequestHandler;
  shouldEnforcePluginGatewayAuth?: (pathContext: PluginRoutePathContext) => boolean;
  isPluginAuthenticatedRoute?: (pathContext: PluginRoutePathContext) => boolean;
  resolvePluginNodeCapabilityRoute?: ResolvePluginNodeCapabilityRoute;
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  /** Strict limiter for the public join-code exchange, including loopback. */
  joinRateLimiter?: AuthRateLimiter;
  /** Authenticator/dispatcher for the reserved node worker bundle namespace. */
  handleNodeWorkerBundleTransferRequest?: NodeWorkerBundleTransferHttpCallback;
  /** Authenticator/dispatcher for the reserved node workspace transfer namespace. */
  handleNodeWorkspaceTransferRequest?: NodeWorkspaceTransferHttpCallback;
  getReadiness?: ReadinessChecker;
  getStartup?: StartupChecker;
  getRuntimeConfig?: () => OpenClawConfig;
  getGatewayRequestContext?: () => GatewayRequestContext | undefined;
  isStartupPluginRuntimeReady?: () => boolean;
  isTerminalEnabled?: () => boolean;
  tlsOptions?: TlsOptions;
  ingressTransport?: GatewayIngressTransport;
  reportUnattributableProxy?: GatewayUnattributableProxyReporter;
}): HttpServer {
  const {
    clients,
    controlUiEnabled,
    controlUiBasePath,
    controlUiRoot,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    handleHooksRequest,
    handlePluginRequest,
    shouldEnforcePluginGatewayAuth,
    resolvePluginNodeCapabilityRoute,
    resolvedAuth,
    rateLimiter,
    joinRateLimiter,
    getReadiness,
    getStartup,
  } = opts;
  const getResolvedAuth = opts.getResolvedAuth ?? (() => resolvedAuth);
  const loadGatewayConfig = opts.getRuntimeConfig ?? getRuntimeConfig;
  const openAiCompatEnabled = openAiChatCompletionsEnabled || openResponsesEnabled;
  const controlUiRouteBasePath =
    controlUiBasePath && controlUiBasePath !== "/" ? controlUiBasePath.replace(/\/$/, "") : "";
  const handleServerRequest = (
    req: IncomingMessage,
    res: ServerResponse,
    expectation?: "continue" | "reject",
  ) => {
    markGatewayIngressTransport(req, opts.ingressTransport ?? { kind: "ordinary" });
    void runHttpConnectionRequest(
      req,
      () =>
        runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () =>
          handleRequest(req, res, expectation),
        ),
      res,
    ).catch((error: unknown) => {
      console.error("[gateway-http] failed to finalize request:", error);
      if (!res.destroyed) {
        res.destroy(error instanceof Error ? error : undefined);
      }
    });
  };
  const httpServer: HttpServer = opts.tlsOptions
    ? createHttpsServer(opts.tlsOptions, handleServerRequest)
    : createHttpServer(handleServerRequest);
  // Node otherwise sends interim/expectation responses before application admission.
  httpServer.on("checkContinue", (req, res) => handleServerRequest(req, res, "continue"));
  httpServer.on("checkExpectation", (req, res) => handleServerRequest(req, res, "reject"));
  httpServer.on("connect", (req, socket) => {
    void runHttpConnectionRequest(
      req,
      async () => {
        socket.destroy();
      },
      "upgrade",
    );
  });

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    expectation?: "continue" | "reject",
  ) {
    setDefaultSecurityHeaders(res, {
      strictTransportSecurity: strictTransportSecurityHeader,
    });
    // Preserve Node's version/token classification while deferring its response
    // until admission; reparsing Expect here would change HTTP/1.0 semantics.
    if (expectation === "reject") {
      res.writeHead(417);
      res.end();
      return;
    }
    if (expectation === "continue") {
      res.writeContinue();
    }

    // Don't interfere with real WebSocket upgrades; ws handles the 'upgrade' event.
    if (isWebSocketUpgradeRequest(req)) {
      return;
    }
    if (req.headers.upgrade !== undefined) {
      res.statusCode = 400;
      res.setHeader("Connection", "close");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Bad Request");
      return;
    }

    try {
      const requestPath = URL.parse(req.url ?? "/", "http://localhost")?.pathname;
      if (requestPath === undefined) {
        sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
        return;
      }
      if (classifyGatewayProbePath(requestPath) === "live") {
        await handleGatewayProbeRequest(
          req,
          res,
          requestPath,
          resolvedAuth,
          [],
          false,
          rateLimiter,
          getReadiness,
          getStartup,
        );
        return;
      }

      const configSnapshot = loadGatewayConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
      const ingressAttribution = prepareGatewayIngressAttribution({
        req,
        trustedProxies,
        allowRealIpFallback,
      });
      const scopedNodeCapability = normalizePluginNodeCapabilityScopedUrl(req.url ?? "/");
      if (scopedNodeCapability.malformedScopedPath) {
        sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
        return;
      }
      if (scopedNodeCapability.rewrittenUrl) {
        // Scoped capability URLs are normalized before auth/routing so built-in handlers,
        // plugin route matching, and audit context all see the same canonical path.
        req.url = scopedNodeCapability.rewrittenUrl;
      }
      const scopedRequestPath = scopedNodeCapability.pathname;
      const pluginPathContext = resolvePluginRoutePathContext(scopedRequestPath);
      const nodeCapability = resolvePluginNodeCapabilityRoute?.(pluginPathContext);
      if (ingressAttribution.kind === "unattributable-proxy") {
        opts.reportUnattributableProxy?.(ingressAttribution);
        if (
          !nodeCapability &&
          handlePluginRequest &&
          opts.isPluginAuthenticatedRoute?.(pluginPathContext) &&
          (await handlePluginRequest(req, res, pluginPathContext, {
            gatewayRequestClientIp: ingressAttribution.remoteAddress,
          }))
        ) {
          return;
        }
        sendGatewayAuthFailure(res, { ok: false, reason: ingressAttribution.reason });
        return;
      }
      const requestClientIp = ingressAttribution.clientIp;
      const resolvedAuthValue = getResolvedAuth();
      const routeAuth = {
        auth: resolvedAuthValue,
        trustedProxies,
        allowRealIpFallback,
        rateLimiter,
      };
      const controlUiRouteOptions = {
        basePath: controlUiBasePath,
        config: configSnapshot,
        ...routeAuth,
      };
      const handleControlUiRequest = async () =>
        (await getControlUiModule()).handleControlUiHttpRequest(req, res, {
          ...controlUiRouteOptions,
          terminalEnabled: opts.isTerminalEnabled?.() ?? isTerminalConfigEnabled(configSnapshot),
          agentId: resolveAssistantIdentity({ cfg: configSnapshot }).agentId,
          root: controlUiRoot,
        });
      const handleStandaloneControlUiRequest = async () => {
        if (!controlUiEnabled) {
          respondNotFound(res);
          return true;
        }
        if (await handleControlUiRequest()) {
          return true;
        }
        respondNotFound(res);
        return true;
      };
      const requestStages: GatewayHttpRequestStage[] = [
        () =>
          handleGatewayProbeRequest(
            req,
            res,
            scopedRequestPath,
            resolvedAuthValue,
            trustedProxies,
            allowRealIpFallback,
            rateLimiter,
            getReadiness,
            getStartup,
          ),
      ];
      const addRequestStage = (
        enabled: boolean,
        stage: GatewayHttpRequestStage,
        admitted = false,
      ) => {
        if (enabled) {
          requestStages.push(admitted ? () => runWithGatewayHttpWorkAdmission(res, stage) : stage);
        }
      };
      const addAdmittedStage = (enabled: boolean, stage: GatewayHttpRequestStage) =>
        addRequestStage(enabled, stage, true);

      const workerGatewayRoute = classifyWorkerGatewayPath(scopedRequestPath);
      addRequestStage(workerGatewayRoute !== "outside", () => {
        respondNotFound(res);
        return true;
      });

      addAdmittedStage(classifyNodeWorkerBundleTransferPath(scopedRequestPath) !== "outside", () =>
        handleNodeWorkerBundleTransferHttpRequest({
          req,
          res,
          clientIp: ingressAttribution.rateLimit.subject.key,
          rateLimiter: joinRateLimiter,
          callback: opts.handleNodeWorkerBundleTransferRequest,
        }),
      );

      addAdmittedStage(classifyNodeWorkspaceTransferPath(scopedRequestPath) !== "outside", () =>
        handleNodeWorkspaceTransferHttpRequest({
          req,
          res,
          clientIp: ingressAttribution.rateLimit.subject.key,
          rateLimiter: joinRateLimiter,
          callback: opts.handleNodeWorkspaceTransferRequest,
        }),
      );

      const devicePairingJoinShortcode = parseDevicePairingJoinRequestPath(scopedRequestPath);
      if (devicePairingJoinShortcode !== null) {
        addAdmittedStage(true, async () =>
          (await getDevicePairingJoinHttpModule()).handleDevicePairingJoinHttpRequest({
            req,
            res,
            shortcode: devicePairingJoinShortcode,
            clientIp: ingressAttribution.rateLimit.subject.key,
            rateLimiter: joinRateLimiter,
          }),
        );
      }

      // Before hooks: an operator hooks.path of "/oauth" would otherwise claim
      // this exact GET and 405 every provider redirect. The claim is exact-path
      // and config-gated, so preceding hooks cannot shadow any hook route.
      addAdmittedStage(
        req.method === "GET" &&
          scopedRequestPath === "/oauth/mcp/callback" &&
          Boolean(opts.handleMcpOAuthCallbackRequest),
        () => opts.handleMcpOAuthCallbackRequest?.(req, res) ?? false,
      );
      // The hook owner claims only its configured base path before entering HTTP admission;
      // this unconditional dispatcher must stay plain so unrelated routes can fall through.
      addRequestStage(true, () => handleHooksRequest(req, res));
      addAdmittedStage(
        Boolean(opts.handleWatchNodeRequest) && scopedRequestPath.startsWith("/api/nodes/watch/"),
        () => opts.handleWatchNodeRequest?.(req, res) ?? false,
      );
      addAdmittedStage(
        openAiCompatEnabled &&
          (scopedRequestPath === "/v1/models" || scopedRequestPath.startsWith("/v1/models/")),
        async () =>
          (await getModelsHttpModule()).handleOpenAiModelsHttpRequest(req, res, routeAuth),
      );
      addAdmittedStage(openAiCompatEnabled && scopedRequestPath === "/v1/embeddings", async () =>
        (await getEmbeddingsHttpModule()).handleOpenAiEmbeddingsHttpRequest(req, res, routeAuth),
      );
      addAdmittedStage(scopedRequestPath === "/tools/invoke", async () =>
        (await getToolsInvokeHttpModule()).handleToolsInvokeHttpRequest(req, res, routeAuth),
      );
      addAdmittedStage(/^\/sessions\/[^/]+\/kill$/.test(scopedRequestPath), async () =>
        (await getSessionKillHttpModule()).handleSessionKillHttpRequest(req, res, routeAuth),
      );
      addAdmittedStage(/^\/sessions\/[^/]+\/history$/.test(scopedRequestPath), async () =>
        (await getSessionHistoryHttpModule()).handleSessionHistoryHttpRequest(req, res, {
          ...routeAuth,
          getResolvedAuth,
        }),
      );
      addAdmittedStage(scopedRequestPath.startsWith("/__openclaw__/board/"), async () =>
        (await getBoardHttpModule()).handleBoardHttpRequest(req, res, {
          resolveGatewayContext: opts.getGatewayRequestContext?.()?.resolveGatewayContext,
        }),
      );
      const userProfileAvatarRoute = parseControlUiUserAvatarPath(
        scopedRequestPath,
        controlUiRouteBasePath,
      );
      addAdmittedStage(userProfileAvatarRoute.matched, async () =>
        (await getUserProfilesHttpModule()).handleUserProfileAvatarHttpRequest(
          req,
          res,
          scopedRequestPath,
          { ...routeAuth, basePath: controlUiRouteBasePath },
        ),
      );
      addAdmittedStage(openResponsesEnabled && scopedRequestPath === "/v1/responses", async () =>
        (await getOpenResponsesHttpModule()).handleOpenResponsesHttpRequest(req, res, {
          ...routeAuth,
          config: openResponsesConfig,
          resolveGatewayContext: opts.getGatewayRequestContext?.()?.resolveGatewayContext,
        }),
      );
      addAdmittedStage(
        openAiChatCompletionsEnabled && scopedRequestPath === "/v1/chat/completions",
        async () =>
          (await getOpenAiHttpModule()).handleOpenAiHttpRequest(req, res, {
            ...routeAuth,
            config: openAiChatCompletionsConfig,
            resolveGatewayContext: opts.getGatewayRequestContext?.()?.resolveGatewayContext,
          }),
      );
      const approvalDocument = isControlUiApprovalDocumentPath({
        basePath: controlUiBasePath,
        pathname: scopedRequestPath,
      });
      const focusDocument = isControlUiFocusDocumentPath({
        basePath: controlUiBasePath,
        pathname: scopedRequestPath,
      });
      addRequestStage(approvalDocument, handleStandaloneControlUiRequest);
      addRequestStage(Boolean(nodeCapability), async () => {
        const { authorizePluginNodeCapabilityRequest } = await getPluginNodeCapabilityAuthModule();
        const ok = await authorizePluginNodeCapabilityRequest({
          req,
          auth: resolvedAuthValue,
          trustedProxies,
          allowRealIpFallback,
          clients,
          nodeCapability: nodeCapability!,
          capability: scopedNodeCapability.capability,
          malformedScopedPath: scopedNodeCapability.malformedScopedPath,
          rateLimiter,
        });
        if (!ok.ok) {
          sendGatewayAuthFailure(res, ok);
          return true;
        }
        return false;
      });
      addRequestStage(
        Boolean(nodeCapability) &&
          isCoreCanvasHostEnabled(configSnapshot) &&
          isCanvasDocumentHttpPath(scopedRequestPath),
        async () => (await getCanvasServeModule()).handleCanvasDocumentHttpRequest(req, res),
      );
      // This page must remain reachable when a plugin route is broken so the
      // operator can disable it. Other explicit plugin routes retain precedence.
      addRequestStage(
        controlUiEnabled &&
          isControlUiPluginManagerRequest({
            basePath: controlUiBasePath,
            pathname: scopedRequestPath,
            method: req.method,
          }),
        handleControlUiRequest,
      );
      const mcpAppRoute = classifyMcpAppStandalonePath(scopedRequestPath);
      if (
        configSnapshot.mcp?.apps?.enabled === true &&
        (mcpAppRoute === "shell" || mcpAppRoute === "view")
      ) {
        requestStages.push(
          async () =>
            await runWithGatewayHttpWorkAdmission(res, async () => {
              const standalone = await getMcpAppStandaloneModule();
              return await standalone.handleMcpAppStandaloneHttpRequest(req, res, {
                sandboxPort: configSnapshot.mcp?.apps?.sandboxPort,
                sandboxOrigin: configSnapshot.mcp?.apps?.sandboxOrigin,
              });
            }),
        );
      }
      // Core and recovery routes run first, then plugin routes, then read-only Control UI
      // surfaces. Non-GET requests the SPA does not claim reach the startup 503 before final 404.
      if (handlePluginRequest) {
        let pluginGatewayAuthSatisfied = false;
        let pluginGatewayRequestAuth: AuthorizedGatewayHttpRequest | undefined;
        let pluginRequestOperatorScopes: string[] | undefined;
        // Auth and dispatch stay separate so authorized context reaches the handler.
        requestStages.push(
          async () => {
            if (
              !(shouldEnforcePluginGatewayAuth ?? shouldEnforceDefaultPluginGatewayAuth)(
                pluginPathContext,
              ) ||
              (await getCachedPluginGatewayAuthBypassPaths(configSnapshot)).has(scopedRequestPath)
            ) {
              return false;
            }
            // Bypass paths come only from activated channel plugins; every other protected
            // route must authorize before runtime scopes are derived.
            const { authorizePluginGatewayHttpRequestOrReply } = await getHttpAuthUtilsModule();
            const { resolvePluginRouteRuntimeOperatorScopes } =
              await getPluginRouteRuntimeScopesModule();
            const authResult = await authorizePluginGatewayHttpRequestOrReply({
              req,
              res,
              ...routeAuth,
              requestPath: scopedRequestPath,
              resolveOperatorScopes: resolvePluginRouteRuntimeOperatorScopes,
            });
            if (!authResult) {
              return true;
            }
            pluginGatewayAuthSatisfied = true;
            pluginGatewayRequestAuth = authResult.requestAuth;
            pluginRequestOperatorScopes = authResult.operatorScopes;
            return false;
          },
          () =>
            handlePluginRequest(req, res, pluginPathContext, {
              gatewayAuthSatisfied: pluginGatewayAuthSatisfied,
              gatewayRequestAuth: pluginGatewayRequestAuth,
              gatewayRequestOperatorScopes: pluginRequestOperatorScopes,
              gatewayRequestClientIp: requestClientIp,
            }),
        );
      }

      addRequestStage(focusDocument, handleStandaloneControlUiRequest);

      addRequestStage(
        scopedRequestPath.startsWith("/api/chat/media/outgoing/") ||
          (controlUiRouteBasePath.length > 0 &&
            scopedRequestPath.startsWith(`${controlUiRouteBasePath}/api/chat/media/outgoing/`)),
        async () =>
          (await getManagedMediaAttachmentsModule()).handleManagedOutgoingMediaHttpRequest(
            req,
            res,
            { ...routeAuth, basePath: controlUiRouteBasePath },
          ),
      );
      addRequestStage(
        controlUiEnabled &&
          (
            [
              "pluginIcon",
              "catalogIcon",
              "linkFavicon",
            ] as const satisfies readonly ControlUiResourceRoute[]
          ).some(
            (route) =>
              parseControlUiResourcePath(route, scopedRequestPath, controlUiRouteBasePath).matched,
          ),
        async () =>
          (await getPluginIconHttpModule()).handlePluginIconHttpRequest(
            req,
            res,
            controlUiRouteOptions,
          ),
      );
      addRequestStage(
        controlUiEnabled &&
          parseControlUiResourcePath("workspaceIcon", scopedRequestPath, controlUiRouteBasePath)
            .matched,
        async () =>
          (await getWorkspaceIconHttpModule()).handleWorkspaceIconHttpRequest(
            req,
            res,
            controlUiRouteOptions,
          ),
      );
      addRequestStage(
        controlUiEnabled &&
          parseControlUiResourcePath("channelAvatar", scopedRequestPath, controlUiRouteBasePath)
            .matched,
        async () =>
          (await getChannelAvatarHttpModule()).handleChannelAvatarHttpRequest(
            req,
            res,
            controlUiRouteOptions,
          ),
      );
      addRequestStage(controlUiEnabled, async () =>
        (await getControlUiModule()).handleControlUiAssistantMediaRequest(req, res, {
          ...controlUiRouteOptions,
          agentId: resolveAssistantIdentity({ cfg: configSnapshot }).agentId,
        }),
      );
      addRequestStage(controlUiEnabled, async () =>
        (await getControlUiModule()).handleControlUiAvatarRequest(req, res, controlUiRouteOptions),
      );
      addRequestStage(controlUiEnabled, handleControlUiRequest);

      // A completed or disconnected response owns the request even when a stage reports fallthrough.
      for (const stage of requestStages) {
        if ((await stage()) || res.destroyed || res.writableEnded) {
          return;
        }
      }

      // Startup owns sidecar readiness. The plugin registry is still empty here, so an
      // unclaimed path may be a plugin route that would otherwise dead-end as a transient 404.
      if (opts.isStartupPluginRuntimeReady?.() === false) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Retry-After", "1");
        respondPlainText(res, 503, "Plugin runtime is starting");
        return;
      }

      respondNotFound(res);
    } catch (err) {
      console.error("[gateway-http] unhandled error in request handler:", err);
      finishFailedGatewayHttpResponse(res);
    }
  }

  return httpServer;
}

export { attachGatewayUpgradeHandler } from "./server-http-upgrades.js";
