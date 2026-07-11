// Gateway HTTP/WebSocket runtime state factory.
// Builds one server runtime with pinned plugin registries and lazy route handlers.
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { CliDeps } from "../cli/deps.types.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  pinActivePluginSessionExtensionRegistry,
  releasePinnedPluginChannelRegistry,
  releasePinnedPluginHttpRouteRegistry,
  releasePinnedPluginSessionExtensionRegistry,
} from "../plugins/runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { ControlUiRootState } from "./control-ui.js";
import type { HooksConfigResolved } from "./hooks.js";
import type { AuthorizedGatewayHttpRequest } from "./http-auth-utils.js";
import { isLoopbackHost, resolveGatewayListenHosts } from "./net.js";
import type { GatewayBroadcastFn, GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  type ChatRunEntry,
  type ChatRunRegistration,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat-state.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import {
  attachGatewayUpgradeHandler,
  createGatewayHttpServer,
  runWithGatewayHttpWorkAdmission,
} from "./server-http.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { DedupeEntry } from "./server-shared.js";
import type { HookClientIpConfig, HooksRequestHandler } from "./server/hooks-request-handler.js";
import { listenGatewayHttpServer } from "./server/http-listen.js";
import type { PluginRoutePathContext } from "./server/plugins-http/path-context.js";
import { shouldEnforceGatewayAuthForPluginPath } from "./server/plugins-http/route-auth.js";
import { findMatchingPluginNodeCapabilityRoute } from "./server/plugins-http/route-capability.js";
import {
  createPreauthConnectionBudget,
  type PreauthConnectionBudget,
} from "./server/preauth-connection-budget.js";
import type { ReadinessChecker } from "./server/readiness.js";
import type { GatewayTlsRuntime } from "./server/tls.js";
import type { GatewayWsClient } from "./server/ws-types.js";

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

/** Creates the HTTP/WebSocket runtime state and pinned plugin registries for one gateway start. */
export async function createGatewayRuntimeState(params: {
  cfg: import("../config/config.js").OpenClawConfig;
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
  getGatewayRequestContext?: () => GatewayRequestContext | undefined;
  pinChannelRegistry?: boolean;
  deps: CliDeps;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  logHooks: ReturnType<typeof createSubsystemLogger>;
  logPlugins: ReturnType<typeof createSubsystemLogger>;
  getReadiness?: ReadinessChecker;
  isTerminalEnabled: () => boolean;
  handleWatchNodeRequest?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
}): Promise<{
  releasePluginRouteRegistry: () => void;
  httpServer: HttpServer;
  httpServers: HttpServer[];
  httpBindHosts: string[];
  startListening: () => Promise<void>;
  wss: WebSocketServer;
  preauthConnectionBudget: PreauthConnectionBudget;
  clients: Set<GatewayWsClient>;
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  agentRunSeq: Map<string, number>;
  dedupe: Map<string, DedupeEntry>;
  chatRunState: ReturnType<typeof createChatRunState>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatDeltaLastBroadcastLen: Map<string, number>;
  addChatRun: (sessionId: string, entry: ChatRunRegistration) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatQueuedTurns: Map<string, import("./chat-queued-turns.js").QueuedChatTurnEntry>;
  toolEventRecipients: ReturnType<typeof createToolEventRecipientRegistry>;
}> {
  pinActivePluginHttpRouteRegistry(params.pluginRegistry);
  pinActivePluginSessionExtensionRegistry(params.pluginRegistry);
  if (params.pinChannelRegistry !== false) {
    pinActivePluginChannelRegistry(params.pluginRegistry);
  } else {
    releasePinnedPluginChannelRegistry();
  }
  try {
    const resolvePluginRouteRegistry = () =>
      params.getPluginRouteRegistry?.() ?? params.pluginRegistry;
    const clients = new Set<GatewayWsClient>();
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

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
      const registry = resolvePluginRouteRegistry();
      if ((registry.httpRoutes ?? []).length === 0) {
        return false;
      }
      if (!loadedPluginRequestHandler) {
        // Route registries can be re-pinned after bootstrap; keep the handler lazy and route
        // lookup dynamic so plugin HTTP routes follow the active registry snapshot.
        const { createGatewayPluginRequestHandler } = await loadGatewayPluginsHttpModule();
        loadedPluginRequestHandler = createGatewayPluginRequestHandler({
          registry: params.pluginRegistry,
          getRouteRegistry: resolvePluginRouteRegistry,
          log: params.logPlugins,
          getGatewayRequestContext: params.getGatewayRequestContext,
        });
      }
      return await loadedPluginRequestHandler(req, res, pathContext, dispatchContext);
    };
    const handlePluginUpgrade: GatewayPluginUpgradeHandler = async (
      req,
      socket,
      head,
      pathContext,
      dispatchContext,
    ) => {
      const registry = resolvePluginRouteRegistry();
      if ((registry.httpRoutes ?? []).length === 0) {
        return false;
      }
      if (!loadedPluginUpgradeHandler) {
        // WebSocket upgrades share the same dynamic route registry as HTTP requests; this keeps
        // reloads from serving stale plugin upgrade handlers.
        const { createGatewayPluginUpgradeHandler } = await loadGatewayPluginsHttpModule();
        loadedPluginUpgradeHandler = createGatewayPluginUpgradeHandler({
          registry: params.pluginRegistry,
          getRouteRegistry: resolvePluginRouteRegistry,
          log: params.logPlugins,
          getGatewayRequestContext: params.getGatewayRequestContext,
        });
      }
      return await loadedPluginUpgradeHandler(req, socket, head, pathContext, dispatchContext);
    };
    const shouldEnforcePluginGatewayAuth = (pathContext: PluginRoutePathContext): boolean => {
      return shouldEnforceGatewayAuthForPluginPath(resolvePluginRouteRegistry(), pathContext);
    };
    const resolvePluginNodeCapabilityRoute = (pathContext: PluginRoutePathContext) =>
      // Capability routes are selected from the current pinned registry so auth decisions and
      // node-capability dispatch agree when plugin routes are reloaded.
      findMatchingPluginNodeCapabilityRoute(resolvePluginRouteRegistry(), pathContext)
        ?.nodeCapability;

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

    const httpServers: HttpServer[] = [];
    const httpBindHosts: string[] = [];
    for (const _ of bindHosts) {
      const httpServer = createGatewayHttpServer({
        clients,
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
        clients,
        preauthConnectionBudget,
        resolvedAuth: params.resolvedAuth,
        getResolvedAuth: params.getResolvedAuth,
        rateLimiter: params.rateLimiter,
        log: params.log,
      });
      httpServers.push(httpServer);
    }
    const httpServer = httpServers[0];
    if (!httpServer) {
      throw new Error("Gateway HTTP server failed to start");
    }
    let startListeningPromise: Promise<void> | null = null;
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
          const server = httpServers[index];
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
      })();
      await startListeningPromise;
    };
    const agentRunSeq = new Map<string, number>();
    const dedupe = new Map<string, DedupeEntry>();
    const chatRunState = createChatRunState();
    const chatRunRegistry = chatRunState.registry;
    const chatRunBuffers = chatRunState.buffers;
    const chatDeltaSentAt = chatRunState.deltaSentAt;
    const chatDeltaLastBroadcastLen = chatRunState.deltaLastBroadcastLen;
    const addChatRun = chatRunRegistry.add;
    const removeChatRun = chatRunRegistry.remove;
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const chatQueuedTurns = new Map<string, import("./chat-queued-turns.js").QueuedChatTurnEntry>();
    const toolEventRecipients = createToolEventRecipientRegistry();

    return {
      releasePluginRouteRegistry: () => {
        // Releases pinned HTTP-route, session-extension, and channel registries.
        // Startup/reload can re-pin them to a registry that differs from bootstrap.
        releasePinnedPluginHttpRouteRegistry();
        releasePinnedPluginSessionExtensionRegistry();
        // Release unconditionally (no registry arg): the channel pin may have
        // been re-pinned to a deferred-reload registry that differs from the
        // original params.pluginRegistry, so an identity-guarded release would
        // be a no-op and leak the pin across in-process restarts.
        releasePinnedPluginChannelRegistry();
      },
      httpServer,
      httpServers,
      httpBindHosts,
      startListening,
      wss,
      preauthConnectionBudget,
      clients,
      broadcast,
      broadcastToConnIds,
      agentRunSeq,
      dedupe,
      chatRunState,
      chatRunBuffers,
      chatDeltaSentAt,
      chatDeltaLastBroadcastLen,
      addChatRun,
      removeChatRun,
      chatAbortControllers,
      chatQueuedTurns,
      toolEventRecipients,
    };
  } catch (err) {
    // If state creation fails after pins are installed, release them immediately so later
    // in-process gateway starts do not inherit a half-created plugin runtime.
    releasePinnedPluginHttpRouteRegistry();
    releasePinnedPluginSessionExtensionRegistry();
    releasePinnedPluginChannelRegistry();
    throw err;
  }
}
