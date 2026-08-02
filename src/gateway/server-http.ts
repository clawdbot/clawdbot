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
import type { WebSocketServer } from "ws";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { isCanvasDocumentHttpPath } from "../canvas/constants.js";
import { resolveBundledChannelGatewayAuthBypassPaths } from "../channels/plugins/gateway-auth-bypass.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { isGatewayWorkAdmissionClosed } from "../process/gateway-work-admission.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveAssistantIdentity } from "./assistant-identity.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  isLocalDirectRequest,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "./auth.js";
import {
  CONTROL_UI_CATALOG_ICON_PATH_PREFIX,
  CONTROL_UI_PLUGIN_ICON_PATH_PREFIX,
} from "./control-ui-contract.js";
import {
  isControlUiApprovalDocumentPath,
  isControlUiPluginManagerRequest,
} from "./control-ui-routing.js";
import type { ControlUiRootState } from "./control-ui.js";
import {
  classifyGatewayProbePath,
  classifyMcpAppStandalonePath,
} from "./gateway-http-route-contracts.js";
import type { AuthorizedGatewayHttpRequest } from "./http-auth-utils.js";
import {
  finishFailedGatewayHttpResponse,
  sendGatewayAuthFailure,
  setDefaultSecurityHeaders,
} from "./http-common.js";
import { resolveRequestClientIp } from "./net.js";
import {
  normalizePluginNodeCapabilityScopedUrl,
  type PluginNodeCapabilitySurface,
} from "./plugin-node-capability.js";
import type { HooksRequestHandler } from "./server/hooks-request-handler.js";
import {
  runWithGatewayHttpWorkAdmission,
  writeGatewayUpgradeServiceUnavailable,
} from "./server/http-work-admission.js";
import {
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
  type PluginRoutePathContext,
} from "./server/plugins-http/path-context.js";
import type { PreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import type { ReadinessChecker } from "./server/readiness.js";
import {
  GATEWAY_WS_CONNECTION_KIND_PROPERTY,
  GATEWAY_WS_PREAUTH_BUDGET_PROPERTY,
  type GatewayIngressWebSocket,
  type GatewayWsClient,
} from "./server/ws-types.js";
import { isTerminalConfigEnabled } from "./terminal/enabled.js";
import { matchUserProfileAvatarPath } from "./user-profiles-http-path.js";

type PluginGatewayDispatchContext = {
  gatewayAuthSatisfied?: boolean;
  gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
  gatewayRequestOperatorScopes?: readonly string[];
  gatewayRequestClientIp?: string;
};

type PluginHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: PluginGatewayDispatchContext,
) => Promise<boolean>;

type WatchNodeHttpRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type PluginHttpUpgradeHandler = (
  req: IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: PluginGatewayDispatchContext,
) => Promise<boolean>;

type ResolvePluginNodeCapabilityRoute = (
  pathContext: PluginRoutePathContext,
) => PluginNodeCapabilitySurface | undefined;

const getControlUiModule = createLazyRuntimeModule(() => import("./control-ui.js"));
const getCanvasServeModule = createLazyRuntimeModule(() => import("../canvas/serve.runtime.js"));
const getBoardHttpModule = createLazyRuntimeModule(() => import("./board-http.js"));
const getEmbeddingsHttpModule = createLazyRuntimeModule(() => import("./embeddings-http.js"));
const getManagedMediaAttachmentsModule = createLazyRuntimeModule(
  () => import("./managed-image-attachments.js"),
);
const getMcpAppStandaloneModule = createLazyRuntimeModule(() => import("./mcp-app-standalone.js"));
const getPluginIconHttpModule = createLazyRuntimeModule(() => import("./plugin-icon-http.js"));
const getModelsHttpModule = createLazyRuntimeModule(() => import("./models-http.js"));
const getOpenAiHttpModule = createLazyRuntimeModule(() => import("./openai-http.js"));
const getOpenResponsesHttpModule = createLazyRuntimeModule(() => import("./openresponses-http.js"));
const getSessionHistoryHttpModule = createLazyRuntimeModule(
  () => import("./sessions-history-http.js"),
);
const getSessionKillHttpModule = createLazyRuntimeModule(() => import("./session-kill-http.js"));
const getToolsInvokeHttpModule = createLazyRuntimeModule(() => import("./tools-invoke-http.js"));
const getUserProfilesHttpModule = createLazyRuntimeModule(() => import("./user-profiles-http.js"));
const getPluginNodeCapabilityAuthModule = createLazyRuntimeModule(
  () => import("./server/plugin-node-capability-auth.js"),
);
const getHttpAuthUtilsModule = createLazyRuntimeModule(() => import("./http-auth-utils.js"));
const getPluginRouteRuntimeScopesModule = createLazyRuntimeModule(
  () => import("./server/plugin-route-runtime-scopes.js"),
);

const pluginGatewayAuthBypassPathsCache = new WeakMap<
  OpenClawConfig,
  Promise<ReadonlySet<string>>
>();

async function resolvePluginGatewayAuthBypassPaths(
  configSnapshot: OpenClawConfig,
): Promise<Set<string>> {
  const paths = new Set<string>();
  const configuredChannels = configSnapshot.channels;
  if (!configuredChannels || Object.keys(configuredChannels).length === 0) {
    return paths;
  }
  for (const channelId of Object.keys(configuredChannels)) {
    for (const path of await resolveBundledChannelGatewayAuthBypassPaths({
      channelId,
      cfg: configSnapshot,
    })) {
      paths.add(path);
    }
  }
  return paths;
}

function getCachedPluginGatewayAuthBypassPaths(
  configSnapshot: OpenClawConfig,
): Promise<ReadonlySet<string>> {
  const cached = pluginGatewayAuthBypassPathsCache.get(configSnapshot);
  if (cached) {
    return cached;
  }
  const resolved = resolvePluginGatewayAuthBypassPaths(configSnapshot).catch((error: unknown) => {
    pluginGatewayAuthBypassPathsCache.delete(configSnapshot);
    throw error;
  });
  pluginGatewayAuthBypassPathsCache.set(configSnapshot, resolved);
  return resolved;
}

function shouldEnforceDefaultPluginGatewayAuth(pathContext: PluginRoutePathContext): boolean {
  return (
    pathContext.malformedEncoding ||
    pathContext.decodePassLimitReached ||
    isProtectedPluginRoutePathFromContext(pathContext)
  );
}

/** Handles live/ready probe endpoints before normal gateway routing. */
async function handleGatewayProbeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
  resolvedAuth: ResolvedGatewayAuth,
  trustedProxies: string[],
  allowRealIpFallback: boolean,
  getReadiness?: ReadinessChecker,
): Promise<boolean> {
  const status = classifyGatewayProbePath(requestPath);
  if (status === "namespace" || status === "outside") {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  let statusCode: number;
  let body: string;
  if (status === "ready" && getReadiness) {
    // Readiness details expose subsystem names, so only local direct or authenticated
    // callers receive them; unauthenticated remote probes get the aggregate boolean.
    let includeDetails = isLocalDirectRequest(req, trustedProxies, allowRealIpFallback);
    if (!includeDetails && resolvedAuth.mode !== "none") {
      const { getBearerToken, resolveHttpBrowserOriginPolicy } = await getHttpAuthUtilsModule();
      const bearerToken = getBearerToken(req);
      includeDetails = (
        await authorizeHttpGatewayConnect({
          auth: resolvedAuth,
          connectAuth: bearerToken ? { token: bearerToken, password: bearerToken } : null,
          req,
          trustedProxies,
          allowRealIpFallback,
          browserOriginPolicy: resolveHttpBrowserOriginPolicy(req),
        })
      ).ok;
    }
    try {
      const result = getReadiness();
      statusCode = result.ready ? 200 : 503;
      body = JSON.stringify(includeDetails ? result : { ready: result.ready });
    } catch {
      statusCode = 503;
      body = JSON.stringify(
        includeDetails ? { ready: false, failing: ["internal"], uptimeMs: 0 } : { ready: false },
      );
    }
  } else {
    statusCode = 200;
    body = JSON.stringify({ ok: true, status });
  }
  res.statusCode = statusCode;
  res.end(method === "HEAD" ? undefined : body);
  return true;
}

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
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
}

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

type GatewayHttpRequestStage = {
  name: string;
  run: () => Promise<boolean> | boolean;
  continueOnError?: boolean;
};

async function runGatewayHttpRequestStages(
  stages: readonly GatewayHttpRequestStage[],
): Promise<boolean> {
  for (const stage of stages) {
    try {
      if (await stage.run()) {
        return true;
      }
    } catch (err) {
      if (!stage.continueOnError) {
        throw err;
      }
      // Log and skip the failing stage so subsequent stages (control-ui,
      // gateway-probes, etc.) remain reachable. A common trigger is a
      // plugin-owned route/runtime code still failing to load an optional dependency.
      console.error(`[gateway-http] stage "${stage.name}" threw — skipping:`, err);
    }
  }
  return false;
}

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
  handleWatchNodeRequest?: WatchNodeHttpRequestHandler;
  handlePluginRequest?: PluginHttpRequestHandler;
  shouldEnforcePluginGatewayAuth?: (pathContext: PluginRoutePathContext) => boolean;
  resolvePluginNodeCapabilityRoute?: ResolvePluginNodeCapabilityRoute;
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  getReadiness?: ReadinessChecker;
  getRuntimeConfig?: () => OpenClawConfig;
  isStartupPluginRuntimeReady?: () => boolean;
  isTerminalEnabled?: () => boolean;
  tlsOptions?: TlsOptions;
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
    getReadiness,
  } = opts;
  const getResolvedAuth = opts.getResolvedAuth ?? (() => resolvedAuth);
  const loadGatewayConfig = opts.getRuntimeConfig ?? getRuntimeConfig;
  const openAiCompatEnabled = openAiChatCompletionsEnabled || openResponsesEnabled;
  const controlUiRouteBasePath =
    controlUiBasePath && controlUiBasePath !== "/" ? controlUiBasePath.replace(/\/$/, "") : "";
  const handleServerRequest = (req: IncomingMessage, res: ServerResponse) => {
    void runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () =>
      handleRequest(req, res),
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

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    setDefaultSecurityHeaders(res, {
      strictTransportSecurity: strictTransportSecurityHeader,
    });

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
          getResolvedAuth(),
          [],
          false,
          getReadiness,
        );
        return;
      }

      const configSnapshot = loadGatewayConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
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
      const requestStages: GatewayHttpRequestStage[] = [
        {
          name: "gateway-probes",
          run: () =>
            handleGatewayProbeRequest(
              req,
              res,
              scopedRequestPath,
              resolvedAuthValue,
              trustedProxies,
              allowRealIpFallback,
              getReadiness,
            ),
        },
        {
          name: "hooks",
          run: () => handleHooksRequest(req, res),
        },
      ];
      const addRequestStage = (
        name: string,
        enabled: boolean,
        run: GatewayHttpRequestStage["run"],
        admitted = false,
      ) => {
        if (enabled) {
          requestStages.push({
            name,
            run: admitted ? () => runWithGatewayHttpWorkAdmission(res, run) : run,
          });
        }
      };
      const addAdmittedStage = (
        name: string,
        enabled: boolean,
        run: GatewayHttpRequestStage["run"],
      ) => addRequestStage(name, enabled, run, true);

      addAdmittedStage(
        "watch-node",
        Boolean(opts.handleWatchNodeRequest) && scopedRequestPath.startsWith("/api/nodes/watch/"),
        () => opts.handleWatchNodeRequest?.(req, res) ?? false,
      );
      addAdmittedStage(
        "models",
        openAiCompatEnabled &&
          (scopedRequestPath === "/v1/models" || scopedRequestPath.startsWith("/v1/models/")),
        async () =>
          (await getModelsHttpModule()).handleOpenAiModelsHttpRequest(req, res, routeAuth),
      );
      addAdmittedStage(
        "embeddings",
        openAiCompatEnabled && scopedRequestPath === "/v1/embeddings",
        async () =>
          (await getEmbeddingsHttpModule()).handleOpenAiEmbeddingsHttpRequest(req, res, routeAuth),
      );
      addAdmittedStage("tools-invoke", scopedRequestPath === "/tools/invoke", async () =>
        (await getToolsInvokeHttpModule()).handleToolsInvokeHttpRequest(req, res, routeAuth),
      );
      addAdmittedStage(
        "sessions-kill",
        /^\/sessions\/[^/]+\/kill$/.test(scopedRequestPath),
        async () =>
          (await getSessionKillHttpModule()).handleSessionKillHttpRequest(req, res, routeAuth),
      );
      addAdmittedStage(
        "sessions-history",
        /^\/sessions\/[^/]+\/history$/.test(scopedRequestPath),
        async () =>
          (await getSessionHistoryHttpModule()).handleSessionHistoryHttpRequest(req, res, {
            ...routeAuth,
            getResolvedAuth,
          }),
      );
      addAdmittedStage(
        "board-widget",
        scopedRequestPath.startsWith("/__openclaw__/board/"),
        async () => (await getBoardHttpModule()).handleBoardHttpRequest(req, res),
      );
      addAdmittedStage(
        "user-profile-avatar",
        matchUserProfileAvatarPath(scopedRequestPath) !== undefined,
        async () =>
          (await getUserProfilesHttpModule()).handleUserProfileAvatarHttpRequest(
            req,
            res,
            scopedRequestPath,
            routeAuth,
          ),
      );
      addAdmittedStage(
        "openresponses",
        openResponsesEnabled && scopedRequestPath === "/v1/responses",
        async () =>
          (await getOpenResponsesHttpModule()).handleOpenResponsesHttpRequest(req, res, {
            ...routeAuth,
            config: openResponsesConfig,
          }),
      );
      addAdmittedStage(
        "openai",
        openAiChatCompletionsEnabled && scopedRequestPath === "/v1/chat/completions",
        async () =>
          (await getOpenAiHttpModule()).handleOpenAiHttpRequest(req, res, {
            ...routeAuth,
            config: openAiChatCompletionsConfig,
          }),
      );
      addRequestStage(
        "control-ui-approval-document",
        isControlUiApprovalDocumentPath({
          basePath: controlUiBasePath,
          pathname: scopedRequestPath,
        }),
        async () => {
          if (!controlUiEnabled) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("Not Found");
            return true;
          }
          const handled = await handleControlUiRequest();
          if (handled) {
            return true;
          }
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
          return true;
        },
      );
      addRequestStage("node-capability-auth", Boolean(nodeCapability), async () => {
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
        "canvas-documents",
        Boolean(nodeCapability) &&
          isCoreCanvasHostEnabled(configSnapshot) &&
          isCanvasDocumentHttpPath(scopedRequestPath),
        async () => (await getCanvasServeModule()).handleCanvasDocumentHttpRequest(req, res),
      );
      // This page must remain reachable when a plugin route is broken so the
      // operator can disable it. Other explicit plugin routes retain precedence.
      addRequestStage(
        "control-ui-plugin-manager",
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
        requestStages.push({
          name: "mcp-app-standalone",
          run: async () =>
            await runWithGatewayHttpWorkAdmission(res, async () => {
              const standalone = await getMcpAppStandaloneModule();
              return await standalone.handleMcpAppStandaloneHttpRequest(req, res, {
                sandboxPort: configSnapshot.mcp?.apps?.sandboxPort,
                sandboxOrigin: configSnapshot.mcp?.apps?.sandboxOrigin,
              });
            }),
        });
      }
      // Core and recovery routes run first, then plugin routes, then read-only Control UI
      // surfaces. Non-GET requests the SPA does not claim reach the startup 503 before final 404.
      if (handlePluginRequest) {
        const requestClientIp = resolveRequestClientIp(req, trustedProxies, allowRealIpFallback);
        let pluginGatewayAuthSatisfied = false;
        let pluginGatewayRequestAuth: AuthorizedGatewayHttpRequest | undefined;
        let pluginRequestOperatorScopes: string[] | undefined;
        // Auth and dispatch stay separate so authorized context reaches the handler while
        // plugin failures can still fall through to core and Control UI routes.
        requestStages.push(
          {
            name: "plugin-auth",
            run: async () => {
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
          },
          {
            name: "plugin-http",
            continueOnError: true,
            run: () =>
              handlePluginRequest(req, res, pluginPathContext, {
                gatewayAuthSatisfied: pluginGatewayAuthSatisfied,
                gatewayRequestAuth: pluginGatewayRequestAuth,
                gatewayRequestOperatorScopes: pluginRequestOperatorScopes,
                gatewayRequestClientIp: requestClientIp,
              }),
          },
        );
      }

      addRequestStage(
        "chat-managed-media",
        scopedRequestPath.startsWith("/api/chat/media/outgoing/"),
        async () =>
          (await getManagedMediaAttachmentsModule()).handleManagedOutgoingMediaHttpRequest(
            req,
            res,
            routeAuth,
          ),
      );
      addRequestStage(
        "control-ui-catalog-icon",
        controlUiEnabled &&
          [CONTROL_UI_PLUGIN_ICON_PATH_PREFIX, CONTROL_UI_CATALOG_ICON_PATH_PREFIX].some((prefix) =>
            scopedRequestPath.startsWith(`${controlUiRouteBasePath}${prefix}/`),
          ),
        async () =>
          (await getPluginIconHttpModule()).handlePluginIconHttpRequest(
            req,
            res,
            controlUiRouteOptions,
          ),
      );
      addRequestStage("control-ui-assistant-media", controlUiEnabled, async () =>
        (await getControlUiModule()).handleControlUiAssistantMediaRequest(req, res, {
          ...controlUiRouteOptions,
          agentId: resolveAssistantIdentity({ cfg: configSnapshot }).agentId,
        }),
      );
      addRequestStage("control-ui-avatar", controlUiEnabled, async () =>
        (await getControlUiModule()).handleControlUiAvatarRequest(req, res, controlUiRouteOptions),
      );
      addRequestStage("control-ui-http", controlUiEnabled, handleControlUiRequest);

      if (await runGatewayHttpRequestStages(requestStages)) {
        return;
      }

      // Startup owns sidecar readiness. The plugin registry is still empty here, so an
      // unclaimed path may be a plugin route that would otherwise dead-end as a transient 404.
      if (opts.isStartupPluginRuntimeReady?.() === false) {
        res.statusCode = 503;
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Retry-After", "1");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Plugin runtime is starting");
        return;
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    } catch (err) {
      console.error("[gateway-http] unhandled error in request handler:", err);
      finishFailedGatewayHttpResponse(res);
    }
  }

  return httpServer;
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
  if (isGatewayWorkAdmissionClosed()) {
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
  resolvePluginNodeCapabilityRoute?: ResolvePluginNodeCapabilityRoute;
  clients: Set<GatewayWsClient>;
  preauthConnectionBudget: PreauthConnectionBudget;
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  /** Optional logger for error diagnostics. */
  log?: { warn: (msg: string) => void };
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
    log,
  } = opts;
  const getResolvedAuth = opts.getResolvedAuth ?? (() => resolvedAuth);
  httpServer.on("upgrade", (req, socket, head) => {
    void runWithDiagnosticTraceContext(createDiagnosticTraceContext(), async () => {
      const configSnapshot = getRuntimeConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
      const requestClientIp = resolveRequestClientIp(req, trustedProxies, allowRealIpFallback);
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
      const nodeCapability = resolvePluginNodeCapabilityRoute?.(pathContext);
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
      // Plugin-owned upgrade routes have already had the opportunity to claim the socket.
      // Core Gateway upgrades must stop at the HTTP boundary so a client cannot hold an
      // untracked pre-connect socket after suspension or restart admission closes.
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

/** Attach the loopback-only worker ingress and force every accepted socket into worker mode. */
export function attachWorkerGatewayUpgradeHandler(params: {
  httpServer: HttpServer;
  wss: WebSocketServer;
  preauthConnectionBudget: PreauthConnectionBudget;
  log?: { warn: (message: string) => void };
}): void {
  params.httpServer.on("upgrade", (req, socket, head) => {
    try {
      handleBudgetedGatewayWebSocketUpgrade({
        req,
        socket,
        head,
        wss: params.wss,
        preauthConnectionBudget: params.preauthConnectionBudget,
        preauthBudgetKey: req.socket.remoteAddress,
        ingressName: "Worker",
        prepareSocket: (workerSocket) => {
          workerSocket[GATEWAY_WS_CONNECTION_KIND_PROPERTY] = "worker";
          workerSocket[GATEWAY_WS_PREAUTH_BUDGET_PROPERTY] = params.preauthConnectionBudget;
        },
      });
    } catch (error) {
      params.log?.warn(
        `worker websocket upgrade failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      socket.destroy();
    }
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
