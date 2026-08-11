// Gateway HTTP/WebSocket runtime state factory.
// Builds one server runtime with lazy plugin route handlers.
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { resolveSandboxHostPort } from "../agents/sandbox-host.js";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { resolveCanvasNodeCapability } from "../canvas/constants.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { GatewayTlsRuntime } from "../infra/tls/gateway.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ControlUiRootState } from "./control-ui.js";
import type { HooksConfigResolved } from "./hooks.js";
import type { AuthorizedGatewayHttpRequest } from "./http-auth-utils.js";
import { createSandboxHostHttpServer } from "./mcp-app-sandbox-http.js";
import { isLoopbackHost, resolveGatewayListenHosts } from "./net.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import {
  attachGatewayUpgradeHandler,
  attachWorkerGatewayUpgradeHandler,
  createGatewayHttpServer,
} from "./server-http.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { HookClientIpConfig, HooksRequestHandler } from "./server/hooks-request-handler.js";
import { listenGatewayHttpServer } from "./server/http-listen.js";
import { runWithGatewayHttpWorkAdmission } from "./server/http-work-admission.js";
import type { PluginRoutePathContext } from "./server/plugins-http/path-context.js";
import { shouldEnforceGatewayAuthForPluginPath } from "./server/plugins-http/route-auth.js";
import { findMatchingPluginNodeCapabilityRoute } from "./server/plugins-http/route-capability.js";
import { findMatchingPluginHttpRoutes } from "./server/plugins-http/route-match.js";
import {
  createPreauthConnectionBudget,
  type PreauthConnectionBudget,
} from "./server/preauth-connection-budget.js";
import type { ReadinessChecker } from "./server/readiness.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import type { WorkerDesktopTunnels } from "./worker-environments/desktop-tunnel.js";

type GatewayPluginRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: {
    gatewayAuthSatisfied?: boolean;
    gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
    gatewayRequestOperatorScopes?: readonly string[];
  },
) => Promise<boolean>;

type GatewayPluginUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: {
    gatewayAuthSatisfied?: boolean;
    gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
    gatewayRequestOperatorScopes?: readonly string[];
  },
) => Promise<boolean>;

const loadGatewayPluginsHttpModule = async () => await import("./server/plugins-http.js");

function hasMatchingGatewayPluginRoute(
  registry: PluginRegistry,
  pathContext: PluginRoutePathContext | undefined,
  requiresUpgrade: boolean,
): boolean {
  if (!pathContext) {
    return (registry.httpRoutes ?? []).length > 0;
  }
  const matchingRoutes = findMatchingPluginHttpRoutes(registry, pathContext);
  return requiresUpgrade
    ? matchingRoutes.some((route) => typeof route.handleUpgrade === "function")
    : matchingRoutes.length > 0;
}

/** Creates the HTTP/WebSocket transport for one gateway start. */
export async function createGatewayHttpTransport(params: {
  cfg: import("../config/config.js").OpenClawConfig;
  getRuntimeConfig?: () => import("../config/config.js").OpenClawConfig;
  bindHost: string;
  port: number;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openAiChatCompletionsConfig?: import("../config/types.gateway.js").GatewayHttpChatCompletionsConfig;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  strictTransportSecurityHeader?: string;
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth: () => ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  gatewayTls?: GatewayTlsRuntime;
  hooksConfig: () => HooksConfigResolved | null;
  getHookClientIpConfig: () => HookClientIpConfig;
  pluginRegistry: PluginRegistry;
  getPluginRouteRegistry?: () => PluginRegistry;
  isStartupPluginRuntimeReady?: () => boolean;
  getGatewayRequestContext?: () => GatewayRequestContext | undefined;
  deps: CliDeps;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  logHooks: ReturnType<typeof createSubsystemLogger>;
  logPlugins: ReturnType<typeof createSubsystemLogger>;
  getReadiness?: ReadinessChecker;
  isTerminalEnabled: () => boolean;
  handleWatchNodeRequest?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  workerIngressEnabled?: boolean;
  workerDesktopTunnels?: WorkerDesktopTunnels;
  clients: Set<GatewayWsClient>;
}): Promise<{
  httpServer: HttpServer;
  httpServers: HttpServer[];
  httpBindHosts: string[];
  startListening: () => Promise<void>;
  wss: WebSocketServer;
  preauthConnectionBudget: PreauthConnectionBudget;
  getWorkerIngressEndpoint: () => { host: "127.0.0.1"; port: number } | undefined;
  getMcpAppSandboxPort: () => number | undefined;
  ensureSandboxHostPort: () => Promise<number>;
}> {
  const loadRuntimeConfig = params.getRuntimeConfig ?? (() => params.cfg);
  const resolvePluginRouteRegistry = () =>
    params.getPluginRouteRegistry?.() ?? params.pluginRegistry;

  let loadedHooksRequestHandler: HooksRequestHandler | null = null;
  const handleHooksRequest: HooksRequestHandler = async (req, res) => {
    const hooksConfig = params.hooksConfig();
    if (!hooksConfig) {
      return false;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const basePath = hooksConfig.basePath;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }
    return await runWithGatewayHttpWorkAdmission(res, async () => {
      if (!loadedHooksRequestHandler) {
        // Hooks are cold for most gateway starts; create the handler only after a request
        // matches the configured base path so startup avoids importing hook runtime code.
        const { createGatewayHooksRequestHandler } = await import("./server/hooks.js");
        loadedHooksRequestHandler = createGatewayHooksRequestHandler({
          deps: params.deps,
          getHooksConfig: params.hooksConfig,
          getClientIpConfig: params.getHookClientIpConfig,
          bindHost: params.bindHost,
          port: params.port,
          logHooks: params.logHooks,
        });
      }
      return await loadedHooksRequestHandler(req, res);
    });
  };

  let loadedPluginRequestHandler: GatewayPluginRequestHandler | null = null;
  let loadedPluginUpgradeHandler: GatewayPluginUpgradeHandler | null = null;
  const handlePluginRequest: GatewayPluginRequestHandler = async (
    req,
    res,
    pathContext,
    dispatchContext,
  ) => {
    if (loadedPluginRequestHandler) {
      return await loadedPluginRequestHandler(req, res, pathContext, dispatchContext);
    }
    const registry = resolvePluginRouteRegistry();
    if (!hasMatchingGatewayPluginRoute(registry, pathContext, false)) {
      return false;
    }
    // Keep unrelated core HTTP paths cold; the loaded handler still owns dynamic registry lookup.
    const { createGatewayPluginRequestHandler } = await loadGatewayPluginsHttpModule();
    loadedPluginRequestHandler = createGatewayPluginRequestHandler({
      registry: params.pluginRegistry,
      getRouteRegistry: resolvePluginRouteRegistry,
      log: params.logPlugins,
      getGatewayRequestContext: params.getGatewayRequestContext,
    });
    return await loadedPluginRequestHandler(req, res, pathContext, dispatchContext);
  };
  const handlePluginUpgrade: GatewayPluginUpgradeHandler = async (
    req,
    socket,
    head,
    pathContext,
    dispatchContext,
  ) => {
    if (loadedPluginUpgradeHandler) {
      return await loadedPluginUpgradeHandler(req, socket, head, pathContext, dispatchContext);
    }
    const registry = resolvePluginRouteRegistry();
    if (!hasMatchingGatewayPluginRoute(registry, pathContext, true)) {
      return false;
    }
    // Keep core WebSocket upgrades cold while plugin upgrades follow the current route registry.
    const { createGatewayPluginUpgradeHandler } = await loadGatewayPluginsHttpModule();
    loadedPluginUpgradeHandler = createGatewayPluginUpgradeHandler({
      registry: params.pluginRegistry,
      getRouteRegistry: resolvePluginRouteRegistry,
      log: params.logPlugins,
      getGatewayRequestContext: params.getGatewayRequestContext,
    });
    return await loadedPluginUpgradeHandler(req, socket, head, pathContext, dispatchContext);
  };
  const shouldEnforcePluginGatewayAuth = (pathContext: PluginRoutePathContext): boolean => {
    return shouldEnforceGatewayAuthForPluginPath(resolvePluginRouteRegistry(), pathContext);
  };
  const resolvePluginNodeCapabilityRoute = (pathContext: PluginRoutePathContext) => {
    const coreCanvasCapability = isCoreCanvasHostEnabled(loadRuntimeConfig())
      ? resolveCanvasNodeCapability(pathContext.candidates)
      : undefined;
    if (coreCanvasCapability) {
      return coreCanvasCapability;
    }
    // Plugin capability routes follow the current root registry so auth and dispatch agree.
    return findMatchingPluginNodeCapabilityRoute(resolvePluginRouteRegistry(), pathContext)
      ?.nodeCapability;
  };

  const bindHosts = await resolveGatewayListenHosts(params.bindHost);
  if (!isLoopbackHost(params.bindHost)) {
    params.log.warn(
      "⚠️  Gateway is binding to a non-loopback address. " +
        "Ensure authentication is configured before exposing to public networks.",
    );
  }
  if (params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true) {
    params.log.warn(
      "⚠️  gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true is enabled. " +
        "Host-header origin fallback weakens origin checks and should only be used as break-glass.",
    );
  }
  // Create WebSocketServer first (with noServer: true) so we can attach upgrade handlers
  // before HTTP servers start listening. This prevents a race condition where connections
  // arrive before the upgrade handler is attached, which causes silent 1006 errors.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PREAUTH_PAYLOAD_BYTES,
  });
  const preauthConnectionBudget = createPreauthConnectionBudget();
  const workerPreauthConnectionBudget = createPreauthConnectionBudget();

  const httpServers: HttpServer[] = [];
  const gatewayHttpServers: HttpServer[] = [];
  const httpBindHosts: string[] = [];
  for (const _ of bindHosts) {
    const httpServer = createGatewayHttpServer({
      clients: params.clients,
      controlUiEnabled: params.controlUiEnabled,
      controlUiBasePath: params.controlUiBasePath,
      controlUiRoot: params.controlUiRoot,
      openAiChatCompletionsEnabled: params.openAiChatCompletionsEnabled,
      openAiChatCompletionsConfig: params.openAiChatCompletionsConfig,
      openResponsesEnabled: params.openResponsesEnabled,
      openResponsesConfig: params.openResponsesConfig,
      strictTransportSecurityHeader: params.strictTransportSecurityHeader,
      handleWatchNodeRequest: params.handleWatchNodeRequest,
      handleHooksRequest,
      handlePluginRequest,
      shouldEnforcePluginGatewayAuth,
      resolvePluginNodeCapabilityRoute,
      resolvedAuth: params.resolvedAuth,
      getResolvedAuth: params.getResolvedAuth,
      rateLimiter: params.rateLimiter,
      getReadiness: params.getReadiness,
      getRuntimeConfig: loadRuntimeConfig,
      isStartupPluginRuntimeReady: params.isStartupPluginRuntimeReady,
      isTerminalEnabled: params.isTerminalEnabled,
      tlsOptions: params.gatewayTls?.enabled ? params.gatewayTls.tlsOptions : undefined,
    });
    // Attach upgrade handler BEFORE listening to prevent race condition
    attachGatewayUpgradeHandler({
      httpServer,
      wss,
      handlePluginUpgrade,
      shouldEnforcePluginGatewayAuth,
      resolvePluginNodeCapabilityRoute,
      clients: params.clients,
      preauthConnectionBudget,
      resolvedAuth: params.resolvedAuth,
      getResolvedAuth: params.getResolvedAuth,
      rateLimiter: params.rateLimiter,
      log: params.log,
      workerDesktopTunnels: params.workerDesktopTunnels,
    });
    gatewayHttpServers.push(httpServer);
    httpServers.push(httpServer);
  }
  let workerIngressPort: number | undefined;
  const workerHttpServer = params.workerIngressEnabled
    ? createHttpServer((_req, res) => {
        res.statusCode = 404;
        res.end("Not Found");
      })
    : undefined;
  if (workerHttpServer) {
    attachWorkerGatewayUpgradeHandler({
      httpServer: workerHttpServer,
      wss,
      preauthConnectionBudget: workerPreauthConnectionBudget,
      log: params.log,
    });
  }
  const httpServer = gatewayHttpServers[0];
  if (!httpServer) {
    throw new Error("Gateway HTTP server failed to start");
  }
  let mcpAppSandboxPort: number | undefined;
  let sandboxHostStartPromise: Promise<number> | null = null;
  let startListeningPromise: Promise<void> | null = null;
  let startListeningComplete = false;
  const startSandboxHost = async (): Promise<number> => {
    if (sandboxHostStartPromise) {
      return await sandboxHostStartPromise;
    }
    // MCP Apps retain their eager startup path. Board-only gateways defer the
    // second listener until an admitted HTML widget actually needs isolation.
    sandboxHostStartPromise = (async () => {
      if (httpBindHosts.length === 0) {
        throw new Error("Gateway listener must start before the sandbox host");
      }
      const sandboxPort = resolveSandboxHostPort(params.port, params.cfg.mcp?.apps?.sandboxPort);
      const sandboxServers = bindHosts.map(() =>
        createSandboxHostHttpServer(
          params.gatewayTls?.enabled ? params.gatewayTls.tlsOptions : undefined,
        ),
      );
      // Register before binding so normal runtime cleanup closes a partially
      // started multi-host listener after any later bind failure.
      httpServers.push(...sandboxServers);
      try {
        for (const host of httpBindHosts) {
          const index = bindHosts.indexOf(host);
          const server = sandboxServers[index];
          if (!server) {
            throw new Error(`Missing sandbox host HTTP server for bind host ${host}`);
          }
          await listenGatewayHttpServer({
            httpServer: server,
            bindHost: host,
            port: sandboxPort,
            retryEaddrinuse: false,
            serviceName: "MCP App sandbox",
            endpointScheme: params.gatewayTls?.enabled ? "https" : "http",
          });
        }
      } catch (error) {
        await Promise.all(
          sandboxServers.map(
            (server) =>
              new Promise<void>((resolve) => {
                if (!server.listening) {
                  resolve();
                  return;
                }
                server.close(() => resolve());
              }),
          ),
        );
        for (const server of sandboxServers) {
          const index = httpServers.indexOf(server);
          if (index >= 0) {
            httpServers.splice(index, 1);
          }
        }
        throw error;
      }
      mcpAppSandboxPort = sandboxPort;
      return sandboxPort;
    })();
    const startAttempt = sandboxHostStartPromise;
    void startAttempt.catch(() => {
      // Lazy startup failures are recoverable: the next admitted widget may
      // retry after an occupied port or other transient bind error clears.
      if (sandboxHostStartPromise === startAttempt) {
        sandboxHostStartPromise = null;
      }
    });
    return await startAttempt;
  };
  const ensureSandboxHostPort = async (): Promise<number> => {
    if (!startListeningComplete) {
      if (!startListeningPromise) {
        throw new Error("Gateway listener must start before the sandbox host");
      }
      // Gateway sockets begin accepting independently. Wait for every bind
      // host before freezing the shared sandbox listener set.
      await startListeningPromise;
    }
    return await startSandboxHost();
  };
  const startListening = async (): Promise<void> => {
    if (startListeningPromise) {
      await startListeningPromise;
      return;
    }
    // Listening is idempotent for callers racing startup. A failure is terminal for this runtime
    // state; the startup owner tears down every partially bound HTTP/WS server before retrying.
    startListeningPromise = (async () => {
      const requiredAlias =
        params.bindHost !== "127.0.0.1" && bindHosts.includes("127.0.0.1")
          ? "127.0.0.1"
          : undefined;
      // Claim the trusted local endpoint before exposing the selected interface. This prevents
      // another loopback listener from receiving credentials while startup is still resolving.
      const listenOrder = requiredAlias
        ? [requiredAlias, ...bindHosts.filter((host) => host !== requiredAlias)]
        : bindHosts;
      const boundHosts = new Set<string>();
      for (const host of listenOrder) {
        const index = bindHosts.indexOf(host);
        const server = gatewayHttpServers[index];
        if (!server) {
          throw new Error(`Missing gateway HTTP server for bind host ${host}`);
        }
        // Specific IPv4 modes rely on this canonical local endpoint for authenticated
        // helpers. A collision must fail startup instead of sending credentials to it.
        const requiredLoopbackAlias = host === requiredAlias;
        try {
          await listenGatewayHttpServer({
            httpServer: server,
            bindHost: host,
            port: params.port,
            retryEaddrinuse: !requiredLoopbackAlias,
          });
          boundHosts.add(host);
        } catch (err) {
          if (host === bindHosts[0] || requiredLoopbackAlias) {
            throw err;
          }
          params.log.warn(
            `gateway: failed to bind loopback alias ${host}:${params.port} (${String(err)})`,
          );
        }
      }
      httpBindHosts.push(...bindHosts.filter((host) => boundHosts.has(host)));
      if (httpBindHosts.length === 0) {
        throw new Error("Gateway HTTP server failed to start");
      }
      if (params.cfg.mcp?.apps?.enabled === true) {
        await startSandboxHost();
      }
      if (workerHttpServer) {
        await listenGatewayHttpServer({
          httpServer: workerHttpServer,
          bindHost: "127.0.0.1",
          port: 0,
          retryEaddrinuse: false,
        });
        const address = workerHttpServer.address() as AddressInfo | null;
        if (!address || typeof address === "string") {
          throw new Error("Worker gateway ingress failed to resolve its loopback port");
        }
        workerIngressPort = address.port;
        httpServers.push(workerHttpServer);
      }
      startListeningComplete = true;
    })();
    await startListeningPromise;
  };
  return {
    httpServer,
    httpServers,
    httpBindHosts,
    startListening,
    wss,
    preauthConnectionBudget,
    getWorkerIngressEndpoint: () =>
      workerIngressPort === undefined
        ? undefined
        : { host: "127.0.0.1" as const, port: workerIngressPort },
    getMcpAppSandboxPort: () => mcpAppSandboxPort,
    ensureSandboxHostPort,
  };
}
