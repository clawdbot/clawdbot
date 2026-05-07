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
import { resolveAssistantIdentity } from "./assistant-identity.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  isLocalDirectRequest,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "./auth.js";
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
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
  type PluginRoutePathContext,
} from "./server/plugins-http/path-context.js";
import type { PreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import type { ReadinessChecker } from "./server/readiness.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type PluginHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: {
    gatewayAuthSatisfied?: boolean;
    gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
    gatewayRequestOperatorScopes?: readonly string[];
  },
) => Promise<boolean>;

type PluginHttpUpgradeHandler = (
  req: IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: {
    gatewayAuthSatisfied?: boolean;
    gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
    gatewayRequestOperatorScopes?: readonly string[];
  },
) => Promise<boolean>;

type ResolvePluginNodeCapabilityRoute = (
  pathContext: PluginRoutePathContext,
) => PluginNodeCapabilitySurface | undefined;

let identityAvatarModulePromise: Promise<typeof import("../agents/identity-avatar.js")> | undefined;
let controlUiModulePromise: Promise<typeof import("./control-ui.js")> | undefined;
let embeddingsHttpModulePromise: Promise<typeof import("./embeddings-http.js")> | undefined;
let managedImageAttachmentsModulePromise:
  | Promise<typeof import("./managed-image-attachments.js")>
  | undefined;
let modelsHttpModulePromise: Promise<typeof import("./models-http.js")> | undefined;
let openAiHttpModulePromise: Promise<typeof import("./openai-http.js")> | undefined;
let openResponsesHttpModulePromise: Promise<typeof import("./openresponses-http.js")> | undefined;
let sessionHistoryHttpModulePromise:
  | Promise<typeof import("./sessions-history-http.js")>
  | undefined;
let sessionKillHttpModulePromise: Promise<typeof import("./session-kill-http.js")> | undefined;
let toolsInvokeHttpModulePromise: Promise<typeof import("./tools-invoke-http.js")> | undefined;
let pluginNodeCapabilityAuthModulePromise:
  | Promise<typeof import("./server/plugin-node-capability-auth.js")>
  | undefined;
let httpAuthUtilsModulePromise: Promise<typeof import("./http-auth-utils.js")> | undefined;
let pluginRouteRuntimeScopesModulePromise:
  | Promise<typeof import("./server/plugin-route-runtime-scopes.js")>
  | undefined;

function getIdentityAvatarModule() {
  identityAvatarModulePromise ??= import("../agents/identity-avatar.js");
  return identityAvatarModulePromise;
}

function getControlUiModule() {
  controlUiModulePromise ??= import("./control-ui.js");
  return controlUiModulePromise;
}

function getEmbeddingsHttpModule() {
  embeddingsHttpModulePromise ??= import("./embeddings-http.js");
  return embeddingsHttpModulePromise;
}

function getManagedImageAttachmentsModule() {
  managedImageAttachmentsModulePromise ??= import("./managed-image-attachments.js");
  return managedImageAttachmentsModulePromise;
}

function getModelsHttpModule() {
  modelsHttpModulePromise ??= import("./models-http.js");
  return modelsHttpModulePromise;
}

function getOpenAiHttpModule() {
  openAiHttpModulePromise ??= import("./openai-http.js");
  return openAiHttpModulePromise;
}

function getOpenResponsesHttpModule() {
  openResponsesHttpModulePromise ??= import("./openresponses-http.js");
  return openResponsesHttpModulePromise;
}

function getSessionHistoryHttpModule() {
  sessionHistoryHttpModulePromise ??= import("./sessions-history-http.js");
  return sessionHistoryHttpModulePromise;
}

function getSessionKillHttpModule() {
  sessionKillHttpModulePromise ??= import("./session-kill-http.js");
  return sessionKillHttpModulePromise;
}

function getToolsInvokeHttpModule() {
  toolsInvokeHttpModulePromise ??= import("./tools-invoke-http.js");
  return toolsInvokeHttpModulePromise;
}

function getPluginNodeCapabilityAuthModule() {
  pluginNodeCapabilityAuthModulePromise ??= import("./server/plugin-node-capability-auth.js");
  return pluginNodeCapabilityAuthModulePromise;
}

function getHttpAuthUtilsModule() {
  httpAuthUtilsModulePromise ??= import("./http-auth-utils.js");
  return httpAuthUtilsModulePromise;
}

function getPluginRouteRuntimeScopesModule() {
  pluginRouteRuntimeScopesModulePromise ??= import("./server/plugin-route-runtime-scopes.js");
  return pluginRouteRuntimeScopesModulePromise;
}

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
    for (const path of resolveBundledChannelGatewayAuthBypassPaths({
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
  const resolved = resolvePluginGatewayAuthBypassPaths(configSnapshot).catch((error) => {
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

function writeUpgradeServiceUnavailable(socket: { write: (chunk: string) => void }, body: string) {
  socket.write(
    "HTTP/1.1 503 Service Unavailable\r\n" +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n` +
      "\r\n" +
      body,
  );
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
  let pluginGatewayAuthSatisfied = false;
  let pluginGatewayRequestAuth: AuthorizedGatewayHttpRequest | undefined;
  let pluginRequestOperatorScopes: string[] | undefined;
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
          }) ?? false
        );
      },
    },
  ];
}

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
      const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
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
        req.url = scopedNodeCapability.rewrittenUrl;
      }
      const scopedRequestPath = new URL(req.url ?? "/", "http://localhost").pathname;
      const pluginPathContext = handlePluginRequest
        ? resolvePluginRoutePathContext(scopedRequestPath)
        : null;
      const resolvedAuth = getResolvedAuth();
      const requestStages: GatewayHttpRequestStage[] = [
        {
          name: "gateway-probes",
          run: () =>
            handleGatewayProbeRequest(
              req,
              res,
              scopedRequestPath,
              resolvedAuth,
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
      if (openAiCompatEnabled && isOpenAiModelsPath(scopedRequestPath)) {
        requestStages.push({
          name: "models",
          run: async () =>
            (await getModelsHttpModule()).handleOpenAiModelsHttpRequest(req, res, {
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
      }
      if (openAiCompatEnabled && isEmbeddingsPath(scopedRequestPath)) {
        requestStages.push({
          name: "embeddings",
          run: async () =>
            (await getEmbeddingsHttpModule()).handleOpenAiEmbeddingsHttpRequest(req, res, {
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
      }
      if (isToolsInvokePath(scopedRequestPath)) {
        requestStages.push({
          name: "tools-invoke",
          run: async () =>
            (await getToolsInvokeHttpModule()).handleToolsInvokeHttpRequest(req, res, {
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
      }
      if (isSessionKillPath(scopedRequestPath)) {
        requestStages.push({
          name: "sessions-kill",
          run: async () =>
            (await getSessionKillHttpModule()).handleSessionKillHttpRequest(req, res, {
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
      }
      if (isSessionHistoryPath(scopedRequestPath)) {
        requestStages.push({
          name: "sessions-history",
          run: async () =>
            (await getSessionHistoryHttpModule()).handleSessionHistoryHttpRequest(req, res, {
              auth: resolvedAuth,
              getResolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
      }
      if (openResponsesEnabled && isOpenResponsesPath(scopedRequestPath)) {
        requestStages.push({
          name: "openresponses",
          run: async () =>
            (await getOpenResponsesHttpModule()).handleOpenResponsesHttpRequest(req, res, {
              auth: resolvedAuth,
              config: openResponsesConfig,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
      }
      if (openAiChatCompletionsEnabled && isOpenAiChatCompletionsPath(scopedRequestPath)) {
        requestStages.push({
          name: "openai",
          run: async () =>
            (await getOpenAiHttpModule()).handleOpenAiHttpRequest(req, res, {
              auth: resolvedAuth,
              config: openAiChatCompletionsConfig,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
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
              auth: resolvedAuth,
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
      // Plugin routes run before the Control UI SPA catch-all so explicitly
      // registered plugin endpoints stay reachable. Core built-in gateway
      // routes above still keep precedence on overlapping paths.
      requestStages.push(
        ...buildPluginRequestStages({
          req,
          res,
          requestPath: scopedRequestPath,
          getGatewayAuthBypassPaths: () => getCachedPluginGatewayAuthBypassPaths(configSnapshot),
          pluginPathContext,
          handlePluginRequest,
          shouldEnforcePluginGatewayAuth,
          resolvedAuth,
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
                auth: resolvedAuth,
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
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
        requestStages.push({
          name: "control-ui-avatar",
          run: async () => {
            const { handleControlUiAvatarRequest } = await getControlUiModule();
            const { resolveAgentAvatar } = await getIdentityAvatarModule();
            return handleControlUiAvatarRequest(req, res, {
              basePath: controlUiBasePath,
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
              resolveAvatar: (agentId) =>
                resolveAgentAvatar(configSnapshot, agentId, { includeUiOverride: true }),
            });
          },
        });
        requestStages.push({
          name: "control-ui-http",
          run: async () =>
            (await getControlUiModule()).handleControlUiHttpRequest(req, res, {
              basePath: controlUiBasePath,
              config: configSnapshot,
              agentId: resolveAssistantIdentity({ cfg: configSnapshot }).agentId,
              root: controlUiRoot,
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
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
      const scopedNodeCapability = normalizePluginNodeCapabilityScopedUrl(req.url ?? "/");
      if (scopedNodeCapability.malformedScopedPath) {
        writeUpgradeAuthFailure(socket, { ok: false, reason: "unauthorized" });
        socket.destroy();
        return;
      }
      if (scopedNodeCapability.rewrittenUrl) {
        req.url = scopedNodeCapability.rewrittenUrl;
      }
      const resolvedAuth = getResolvedAuth();
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathContext = resolvePluginRoutePathContext(url.pathname);
      const nodeCapability = resolvePluginNodeCapabilityRoute?.(pathContext);
      if (nodeCapability) {
        const { authorizePluginNodeCapabilityRequest } = await getPluginNodeCapabilityAuthModule();
        const ok = await authorizePluginNodeCapabilityRequest({
          req,
          auth: resolvedAuth,
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
          !(await getCachedPluginGatewayAuthBypassPaths(configSnapshot)).has(url.pathname)
        ) {
          const { checkGatewayHttpRequestAuth } = await getHttpAuthUtilsModule();
          const authCheck = await checkGatewayHttpRequestAuth({
            req,
            auth: resolvedAuth,
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
          })
        ) {
          return;
        }
      }
      const preauthBudgetKey = resolveRequestClientIp(req, trustedProxies, allowRealIpFallback);
      if (wss.listenerCount("connection") === 0) {
        writeUpgradeServiceUnavailable(socket, "Gateway websocket handlers unavailable");
        socket.destroy();
        return;
      }
      if (!preauthConnectionBudget.acquire(preauthBudgetKey)) {
        writeUpgradeServiceUnavailable(socket, "Too many unauthenticated sockets");
        socket.destroy();
        return;
      }
      let budgetTransferred = false;
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
          ).__openclawPreauthBudgetKey = preauthBudgetKey;
          wss.emit("connection", ws, req);
          const budgetClaimed = Boolean(
            (
              ws as unknown as import("ws").WebSocket & {
                __openclawPreauthBudgetClaimed?: boolean;
              }
            ).__openclawPreauthBudgetClaimed,
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
    }).catch((err) => {
      const remoteAddress = (socket as { remoteAddress?: string }).remoteAddress ?? "unknown";
      const errorMessage = err instanceof Error ? err.message : String(err);
      log?.warn(`ws upgrade error from ${remoteAddress}: ${errorMessage}`);
      socket.destroy();
    });
  });
}
