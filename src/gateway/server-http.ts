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
  isControlUiApprovalDocumentPath,
  isControlUiPluginManagerRequest,
} from "./control-ui-routing.js";
import type { ControlUiRootState } from "./control-ui.js";
import type { AuthorizedGatewayHttpRequest } from "./http-auth-utils.js";
import { sendGatewayAuthFailure, setDefaultSecurityHeaders } from "./http-common.js";
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

type PluginHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: {
    gatewayAuthSatisfied?: boolean;
    gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
    gatewayRequestOperatorScopes?: readonly string[];
    gatewayRequestClientIp?: string;
  },
) => Promise<boolean>;

type WatchNodeHttpRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type PluginHttpUpgradeHandler = (
  req: IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: {
    gatewayAuthSatisfied?: boolean;
    gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
    gatewayRequestOperatorScopes?: readonly string[];
    gatewayRequestClientIp?: string;
  },
) => Promise<boolean>;

type ResolvePluginNodeCapabilityRoute = (
  pathContext: PluginRoutePathContext,
) => PluginNodeCapabilitySurface | undefined;

const getControlUiModule = createLazyRuntimeModule(() => import("./control-ui.js"));

const getEmbeddingsHttpModule = createLazyRuntimeModule(() => import("./embeddings-http.js"));

const getManagedImageAttachmentsModule = createLazyRuntimeModule(
  () => import("./managed-image-attachments.js"),
);

const getModelsHttpModule = createLazyRuntimeModule(() => import("./models-http.js"));

const getOpenAiHttpModule = createLazyRuntimeModule(() => import("./openai-http.js"));

const getOpenResponsesHttpModule = createLazyRuntimeModule(() => import("./openresponses-http.js"));

const getSessionHistoryHttpModule = createLazyRuntimeModule(
  () => import("./sessions-history-http.js"),
);

const getSessionKillHttpModule = createLazyRuntimeModule(() => import("./session-kill-http.js"));

const getToolsInvokeHttpModule = createLazyRuntimeModule(() => import("./tools-invoke-http.js"));

const getPluginNodeCapabilityAuthModule = createLazyRuntimeModule(
  () => import("./server/plugin-node-capability-auth.js"),
);

const getHttpAuthUtilsModule = createLazyRuntimeModule(() => import("./http-auth-utils.js"));

const getPluginRouteRuntimeScopesModule = createLazyRuntimeModule(
  () => import("./server/plugin-route-runtime-scopes.js"),
);

const GATEWAY_PROBE_STATUS_BY_PATH = new Map<string, "live" | "ready">([
  ["/health", "live"],
  ["/healthz", "live"],
  ["/ready", "ready"],
  ["/readyz", "ready"],
]);
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

function isOpenAiModelsPath(pathname: string): boolean {
  return pathname === "/v1/models" || pathname.startsWith("/v1/models/");
}

function isEmbeddingsPath(pathname: string): boolean {
  return pathname === "/v1/embeddings";
}

function isOpenAiChatCompletionsPath(pathname: string): boolean {
  return pathname === "/v1/chat/completions";
}

function isOpenResponsesPath(pathname: string): boolean {
  return pathname === "/v1/responses";
}

function isToolsInvokePath(pathname: string): boolean {
  return pathname === "/tools/invoke";
}

function isManagedOutgoingImagePath(pathname: string): boolean {
  return pathname.startsWith("/api/chat/media/outgoing/");
}

function isSessionKillPath(pathname: string): boolean {
  return /^\/sessions\/[^/]+\/kill$/.test(pathname);
}

function isSessionHistoryPath(pathname: string): boolean {
  return /^\/sessions\/[^/]+\/history$/.test(pathname);
}

function shouldEnforceDefaultPluginGatewayAuth(pathContext: PluginRoutePathContext): boolean {
  return (
    pathContext.malformedEncoding ||
    pathContext.decodePassLimitReached ||
    isProtectedPluginRoutePathFromContext(pathContext)
  );
}

async function canRevealReadinessDetails(params: {
  req: IncomingMessage;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
}): Promise<boolean> {
  // Readiness details expose subsystem names; show them only to local direct callers or
  // requests that prove gateway auth, while unauthenticated remote probes get a boolean.
  if (isLocalDirectRequest(params.req, params.trustedProxies, params.allowRealIpFallback)) {
    return true;
  }
  if (params.resolvedAuth.mode === "none") {
    return false;
  }

  const { getBearerToken, resolveHttpBrowserOriginPolicy } = await getHttpAuthUtilsModule();
  const bearerToken = getBearerToken(params.req);
  const authResult = await authorizeHttpGatewayConnect({
    auth: params.resolvedAuth,
    connectAuth: bearerToken ? { token: bearerToken, password: bearerToken } : null,
    req: params.req,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
    browserOriginPolicy: resolveHttpBrowserOriginPolicy(params.req),
  });
  return authResult.ok;
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
  const status = GATEWAY_PROBE_STATUS_BY_PATH.get(requestPath);
  if (!status) {
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
    const includeDetails = await canRevealReadinessDetails({
      req,
      resolvedAuth,
      trustedProxies,
      allowRealIpFallback,
    });
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
    socket.write(
      [
        "HTTP/1.1 429 Too Many Requests",
        retryAfterSeconds ? `Retry-After: ${retryAfterSeconds}` : undefined,
        "Content-Type: application/json; charset=utf-8",
        "Connection: close",
        "",
        JSON.stringify({
          error: {
            message: "Too many failed authentication attempts. Please try again later.",
            type: "rate_limited",
          },
        }),
      ]
        .filter(Boolean)
        .join("\r\n"),
    );
    return;
  }
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
}

function parseGatewayRequestPath(rawUrl: string | undefined): string | undefined {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

type GatewayHttpRequestStage = {
  name: string;
  run: () => Promise<boolean> | boolean;
  continueOnError?: boolean;
};

export async function runGatewayHttpRequestStages(
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

function buildPluginRequestStages(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  getGatewayAuthBypassPaths: () => Promise<ReadonlySet<string>>;
  pluginPathContext: PluginRoutePathContext | null;
  handlePluginRequest?: PluginHttpRequestHandler;
  shouldEnforcePluginGatewayAuth?: (pathContext: PluginRoutePathContext) => boolean;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
}): GatewayHttpRequestStage[] {
  if (!params.handlePluginRequest) {
    return [];
  }
  const requestClientIp = resolveRequestClientIp(
    params.req,
    params.trustedProxies,
    params.allowRealIpFallback,
  );
  let pluginGatewayAuthSatisfied = false;
  let pluginGatewayRequestAuth: AuthorizedGatewayHttpRequest | undefined;
  let pluginRequestOperatorScopes: string[] | undefined;
  // Plugin auth and plugin dispatch are separate stages so route handlers receive the
  // gateway-auth context while plugin failures can still fall through to core/Control UI routes.
  return [
    {
      name: "plugin-auth",
      run: async () => {
        const pathContext =
          params.pluginPathContext ?? resolvePluginRoutePathContext(params.requestPath);
        if (
          !(params.shouldEnforcePluginGatewayAuth ?? shouldEnforceDefaultPluginGatewayAuth)(
            pathContext,
          )
        ) {
          return false;
        }
        if ((await params.getGatewayAuthBypassPaths()).has(params.requestPath)) {
          return false;
        }
        // Bypass paths come only from activated channel plugins' gateway-auth
        // artifacts (bundled or installed); all other protected plugin routes must
        // produce an AuthorizedGatewayHttpRequest before runtime scopes are derived.
        const { authorizeGatewayHttpRequestOrReply } = await getHttpAuthUtilsModule();
        const requestAuth = await authorizeGatewayHttpRequestOrReply({
          req: params.req,
          res: params.res,
          auth: params.resolvedAuth,
          trustedProxies: params.trustedProxies,
          allowRealIpFallback: params.allowRealIpFallback,
          rateLimiter: params.rateLimiter,
        });
        if (!requestAuth) {
          return true;
        }
        pluginGatewayAuthSatisfied = true;
        pluginGatewayRequestAuth = requestAuth;
        const { resolvePluginRouteRuntimeOperatorScopes } =
          await getPluginRouteRuntimeScopesModule();
        pluginRequestOperatorScopes = resolvePluginRouteRuntimeOperatorScopes(
          params.req,
          requestAuth,
        );
        return false;
      },
    },
    {
      name: "plugin-http",
      continueOnError: true,
      run: () => {
        const pathContext =
          params.pluginPathContext ?? resolvePluginRoutePathContext(params.requestPath);
        return (
          params.handlePluginRequest?.(params.req, params.res, pathContext, {
            gatewayAuthSatisfied: pluginGatewayAuthSatisfied,
            gatewayRequestAuth: pluginGatewayRequestAuth,
            gatewayRequestOperatorScopes: pluginRequestOperatorScopes,
            gatewayRequestClientIp: requestClientIp,
          }) ?? false
        );
      },
    },
  ];
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
  handlePluginUpgrade?: PluginHttpUpgradeHandler;
  shouldEnforcePluginGatewayAuth?: (pathContext: PluginRoutePathContext) => boolean;
  resolvePluginNodeCapabilityRoute?: ResolvePluginNodeCapabilityRoute;
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  getReadiness?: ReadinessChecker;
  getRuntimeConfig?: () => OpenClawConfig;
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
  const httpServer: HttpServer = opts.tlsOptions
    ? createHttpsServer(opts.tlsOptions, (req, res) => {
        void handleRequestWithTrace(req, res);
      })
    : createHttpServer((req, res) => {
        void handleRequestWithTrace(req, res);
      });

  function handleRequestWithTrace(req: IncomingMessage, res: ServerResponse) {
    return runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () =>
      handleRequest(req, res),
    );
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    setDefaultSecurityHeaders(res, {
      strictTransportSecurity: strictTransportSecurityHeader,
    });

    // Don't interfere with WebSocket upgrades; ws handles the 'upgrade' event.
    if ((req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      return;
    }

    try {
      const requestPath = parseGatewayRequestPath(req.url);
      if (requestPath === undefined) {
        sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
        return;
      }
      if (GATEWAY_PROBE_STATUS_BY_PATH.get(requestPath) === "live") {
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
      const pluginPathContext = handlePluginRequest
        ? resolvePluginRoutePathContext(scopedRequestPath)
        : null;
      const resolvedAuthValue = getResolvedAuth();
      const handleControlUiRequest = async () =>
        (await getControlUiModule()).handleControlUiHttpRequest(req, res, {
          basePath: controlUiBasePath,
          config: configSnapshot,
          terminalEnabled:
            opts.isTerminalEnabled?.() ?? configSnapshot.gateway?.terminal?.enabled === true,
          agentId: resolveAssistantIdentity({ cfg: configSnapshot }).agentId,
          root: controlUiRoot,
          auth: resolvedAuthValue,
          trustedProxies,
          allowRealIpFallback,
          rateLimiter,
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
      if (opts.handleWatchNodeRequest && scopedRequestPath.startsWith("/api/nodes/watch/")) {
        requestStages.push({
          name: "watch-node",
          run: () =>
            runWithGatewayHttpWorkAdmission(
              res,
              () => opts.handleWatchNodeRequest?.(req, res) ?? false,
            ),
        });
      }
      if (openAiCompatEnabled && isOpenAiModelsPath(scopedRequestPath)) {
        requestStages.push({
          name: "models",
          run: async () =>
            await runWithGatewayHttpWorkAdmission(res, async () =>
              (await getModelsHttpModule()).handleOpenAiModelsHttpRequest(req, res, {
                auth: resolvedAuthValue,
                trustedProxies,
                allowRealIpFallback,
                rateLimiter,
              }),
            ),
        });
      }
      if (openAiCompatEnabled && isEmbeddingsPath(scopedRequestPath)) {
        requestStages.push({
          name: "embeddings",
          run: async () =>
            await runWithGatewayHttpWorkAdmission(res, async () =>
              (await getEmbeddingsHttpModule()).handleOpenAiEmbeddingsHttpRequest(req, res, {
                auth: resolvedAuthValue,
                trustedProxies,
                allowRealIpFallback,
                rateLimiter,
              }),
            ),
        });
      }
      if (isToolsInvokePath(scopedRequestPath)) {
        requestStages.push({
          name: "tools-invoke",
          run: async () =>
            await runWithGatewayHttpWorkAdmission(res, async () =>
              (await getToolsInvokeHttpModule()).handleToolsInvokeHttpRequest(req, res, {
                auth: resolvedAuthValue,
                trustedProxies,
                allowRealIpFallback,
                rateLimiter,
              }),
            ),
        });
      }
      if (isSessionKillPath(scopedRequestPath)) {
        requestStages.push({
          name: "sessions-kill",
          run: async () =>
            await runWithGatewayHttpWorkAdmission(res, async () =>
              (await getSessionKillHttpModule()).handleSessionKillHttpRequest(req, res, {
                auth: resolvedAuthValue,
                trustedProxies,
                allowRealIpFallback,
                rateLimiter,
              }),
            ),
        });
      }
      if (isSessionHistoryPath(scopedRequestPath)) {
        requestStages.push({
          name: "sessions-history",
          run: async () =>
            await runWithGatewayHttpWorkAdmission(res, async () =>
              (await getSessionHistoryHttpModule()).handleSessionHistoryHttpRequest(req, res, {
                auth: resolvedAuthValue,
                getResolvedAuth,
                trustedProxies,
                allowRealIpFallback,
                rateLimiter,
              }),
            ),
        });
      }
      if (openResponsesEnabled && isOpenResponsesPath(scopedRequestPath)) {
        requestStages.push({
          name: "openresponses",
          run: async () =>
            await runWithGatewayHttpWorkAdmission(res, async () =>
              (await getOpenResponsesHttpModule()).handleOpenResponsesHttpRequest(req, res, {
                auth: resolvedAuthValue,
                config: openResponsesConfig,
                trustedProxies,
                allowRealIpFallback,
                rateLimiter,
              }),
            ),
        });
      }
      if (openAiChatCompletionsEnabled && isOpenAiChatCompletionsPath(scopedRequestPath)) {
        requestStages.push({
          name: "openai",
          run: async () =>
            await runWithGatewayHttpWorkAdmission(res, async () =>
              (await getOpenAiHttpModule()).handleOpenAiHttpRequest(req, res, {
                auth: resolvedAuthValue,
                config: openAiChatCompletionsConfig,
                trustedProxies,
                allowRealIpFallback,
                rateLimiter,
              }),
            ),
        });
      }
      if (
        isControlUiApprovalDocumentPath({
          basePath: controlUiBasePath,
          pathname: scopedRequestPath,
        })
      ) {
        requestStages.push({
          name: "control-ui-approval-document",
          run: async () => {
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
        });
      }
      if (
        handlePluginRequest &&
        pluginPathContext &&
        resolvePluginNodeCapabilityRoute?.(pluginPathContext)
      ) {
        const nodeCapability = resolvePluginNodeCapabilityRoute(pluginPathContext);
        requestStages.push({
          name: "plugin-node-capability-auth",
          run: async () => {
            if (!nodeCapability) {
              return false;
            }
            const { authorizePluginNodeCapabilityRequest } =
              await getPluginNodeCapabilityAuthModule();
            const ok = await authorizePluginNodeCapabilityRequest({
              req,
              auth: resolvedAuthValue,
              trustedProxies,
              allowRealIpFallback,
              clients,
              nodeCapability,
              capability: scopedNodeCapability.capability,
              malformedScopedPath: scopedNodeCapability.malformedScopedPath,
              rateLimiter,
            });
            if (!ok.ok) {
              sendGatewayAuthFailure(res, ok);
              return true;
            }
            return false;
          },
        });
      }
      if (
        controlUiEnabled &&
        isControlUiPluginManagerRequest({
          basePath: controlUiBasePath,
          pathname: scopedRequestPath,
          method: req.method,
        })
      ) {
        // This page must remain reachable when a plugin route is broken so the
        // operator can disable it. Other explicit plugin routes retain precedence.
        requestStages.push({
          name: "control-ui-plugin-manager",
          run: async () =>
            (await getControlUiModule()).handleControlUiHttpRequest(req, res, {
              basePath: controlUiBasePath,
              config: configSnapshot,
              terminalEnabled:
                opts.isTerminalEnabled?.() ?? configSnapshot.gateway?.terminal?.enabled === true,
              agentId: resolveAssistantIdentity({ cfg: configSnapshot }).agentId,
              root: controlUiRoot,
              auth: resolvedAuthValue,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
      }
      // Plugin routes run before the general Control UI SPA catch-all so
      // explicitly registered endpoints stay reachable. Core routes and the
      // plugin recovery surface staged above keep precedence.
      requestStages.push(
        ...buildPluginRequestStages({
          req,
          res,
          requestPath: scopedRequestPath,
          getGatewayAuthBypassPaths: () => getCachedPluginGatewayAuthBypassPaths(configSnapshot),
          pluginPathContext,
          handlePluginRequest,
          shouldEnforcePluginGatewayAuth,
          resolvedAuth: resolvedAuthValue,
          trustedProxies,
          allowRealIpFallback,
          rateLimiter,
        }),
      );

      if (isManagedOutgoingImagePath(scopedRequestPath)) {
        requestStages.push({
          name: "chat-managed-image-media",
          run: async () =>
            (await getManagedImageAttachmentsModule()).handleManagedOutgoingImageHttpRequest(
              req,
              res,
              {
                auth: resolvedAuthValue,
                trustedProxies,
                allowRealIpFallback,
                rateLimiter,
              },
            ),
        });
      }

      if (controlUiEnabled) {
        requestStages.push({
          name: "control-ui-assistant-media",
          run: async () =>
            (await getControlUiModule()).handleControlUiAssistantMediaRequest(req, res, {
              basePath: controlUiBasePath,
              config: configSnapshot,
              agentId: resolveAssistantIdentity({ cfg: configSnapshot }).agentId,
              auth: resolvedAuthValue,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
        requestStages.push({
          name: "control-ui-avatar",
          run: async () => {
            const { handleControlUiAvatarRequest } = await getControlUiModule();
            return handleControlUiAvatarRequest(req, res, {
              basePath: controlUiBasePath,
              config: configSnapshot,
              auth: resolvedAuthValue,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            });
          },
        });
        requestStages.push({
          name: "control-ui-http",
          run: handleControlUiRequest,
        });
      }

      if (await runGatewayHttpRequestStages(requestStages)) {
        return;
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    } catch (err) {
      console.error("[gateway-http] unhandled error in request handler:", err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
    }
  }

  return httpServer;
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
      if (isGatewayWorkAdmissionClosed()) {
        writeGatewayUpgradeServiceUnavailable(socket, "Gateway websocket admission closed");
        socket.destroy();
        return;
      }
      const preauthBudgetKey = requestClientIp;
      if (wss.listenerCount("connection") === 0) {
        writeGatewayUpgradeServiceUnavailable(socket, "Gateway websocket handlers unavailable");
        socket.destroy();
        return;
      }
      if (!preauthConnectionBudget.acquire(preauthBudgetKey)) {
        writeGatewayUpgradeServiceUnavailable(socket, "Too many unauthenticated sockets");
        socket.destroy();
        return;
      }
      let budgetTransferred = false;
      // The socket owns the preauth budget until the WebSocket connection handler claims it;
      // close/error paths release here to avoid leaking unauthenticated connection slots.
      const releaseUpgradeBudget = () => {
        if (budgetTransferred) {
          return;
        }
        budgetTransferred = true;
        preauthConnectionBudget.release(preauthBudgetKey);
      };
      socket.once("close", releaseUpgradeBudget);
      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          (
            ws as unknown as import("ws").WebSocket & {
              __openclawPreauthBudgetClaimed?: boolean;
              __openclawPreauthBudgetKey?: string;
            }
          )["__openclawPreauthBudgetKey"] = preauthBudgetKey;
          wss.emit("connection", ws, req);
          const budgetClaimed = Boolean(
            (
              ws as unknown as import("ws").WebSocket & {
                __openclawPreauthBudgetClaimed?: boolean;
              }
            )["__openclawPreauthBudgetClaimed"],
          );
          if (budgetClaimed) {
            budgetTransferred = true;
            socket.off("close", releaseUpgradeBudget);
          }
        });
      } catch {
        socket.off("close", releaseUpgradeBudget);
        releaseUpgradeBudget();
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
    if (isGatewayWorkAdmissionClosed()) {
      writeGatewayUpgradeServiceUnavailable(socket, "Worker websocket admission closed");
      socket.destroy();
      return;
    }
    const preauthBudgetKey = req.socket.remoteAddress;
    if (params.wss.listenerCount("connection") === 0) {
      writeGatewayUpgradeServiceUnavailable(socket, "Worker websocket handlers unavailable");
      socket.destroy();
      return;
    }
    if (!params.preauthConnectionBudget.acquire(preauthBudgetKey)) {
      writeGatewayUpgradeServiceUnavailable(socket, "Too many unauthenticated sockets");
      socket.destroy();
      return;
    }
    let budgetTransferred = false;
    const releaseUpgradeBudget = () => {
      if (budgetTransferred) {
        return;
      }
      budgetTransferred = true;
      params.preauthConnectionBudget.release(preauthBudgetKey);
    };
    socket.once("close", releaseUpgradeBudget);
    try {
      params.wss.handleUpgrade(req, socket, head, (ws) => {
        const workerSocket = ws as GatewayIngressWebSocket;
        workerSocket[GATEWAY_WS_CONNECTION_KIND_PROPERTY] = "worker";
        workerSocket[GATEWAY_WS_PREAUTH_BUDGET_PROPERTY] = params.preauthConnectionBudget;
        workerSocket["__openclawPreauthBudgetKey"] = preauthBudgetKey;
        params.wss.emit("connection", ws, req);
        if (workerSocket["__openclawPreauthBudgetClaimed"]) {
          budgetTransferred = true;
          socket.off("close", releaseUpgradeBudget);
        }
      });
    } catch (error) {
      socket.off("close", releaseUpgradeBudget);
      releaseUpgradeBudget();
      params.log?.warn(
        `worker websocket upgrade failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      socket.destroy();
    }
  });
}
