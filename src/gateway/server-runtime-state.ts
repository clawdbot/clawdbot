import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import { type CanvasHostHandler, createCanvasHostHandler } from "../canvas-host/server.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  releasePinnedPluginChannelRegistry,
  releasePinnedPluginHttpRouteRegistry,
  resolveActivePluginHttpRouteRegistry,
} from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { ControlUiRootState } from "./control-ui.js";
import type { HooksConfigResolved } from "./hooks.js";
import { isLoopbackHost, resolveGatewayListenHosts } from "./net.js";
import type { GatewayBroadcastFn, GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  type ChatRunEntry,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import {
  attachGatewayUpgradeHandler,
  createGatewayHttpServer,
  type HookClientIpConfig,
} from "./server-http.js";
import type { DedupeEntry } from "./server-shared.js";
import { createGatewayHooksRequestHandler } from "./server/hooks.js";
import { listenGatewayHttpServer } from "./server/http-listen.js";
import {
  createGatewayPluginRequestHandler,
  shouldEnforceGatewayAuthForPluginPath,
  type PluginRoutePathContext,
} from "./server/plugins-http.js";
import {
  createPreauthConnectionBudget,
  type PreauthConnectionBudget,
} from "./server/preauth-connection-budget.js";
import type { ReadinessChecker } from "./server/readiness.js";
import type { GatewayTlsRuntime } from "./server/tls.js";
import type { GatewayWsClient } from "./server/ws-types.js";

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
  pinChannelRegistry?: boolean;
  deps: CliDeps;
  canvasRuntime: RuntimeEnv;
  canvasHostEnabled: boolean;
  allowCanvasHostInTests?: boolean;
  logCanvas: { info: (msg: string) => void; warn: (msg: string) => void };
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  logHooks: ReturnType<typeof createSubsystemLogger>;
  logPlugins: ReturnType<typeof createSubsystemLogger>;
  getReadiness?: ReadinessChecker;
}): Promise<{
  canvasHost: CanvasHostHandler | null;
  releasePluginRouteRegistry: () => void;
  httpServer: HttpServer;
  httpServers: HttpServer[];
  httpBindHosts: string[];
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
  addChatRun: (sessionId: string, entry: ChatRunEntry) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  toolEventRecipients: ReturnType<typeof createToolEventRecipientRegistry>;
}> {
  pinActivePluginHttpRouteRegistry(params.pluginRegistry);
  if (params.pinChannelRegistry !== false) {
    pinActivePluginChannelRegistry(params.pluginRegistry);
  } else {
    releasePinnedPluginChannelRegistry();
  }
  try {
    let canvasHost: CanvasHostHandler | null = null;
    if (params.canvasHostEnabled) {
      try {
        const handler = await createCanvasHostHandler({
          runtime: params.canvasRuntime,
          rootDir: params.cfg.canvasHost?.root,
          basePath: CANVAS_HOST_PATH,
          allowInTests: params.allowCanvasHostInTests,
          liveReload: params.cfg.canvasHost?.liveReload,
        });
        if (handler.rootDir) {
          canvasHost = handler;
          params.logCanvas.info(
            `canvas host mounted at http://${params.bindHost}:${params.port}${CANVAS_HOST_PATH}/ (root ${handler.rootDir})`,
          );
        }
      } catch (err) {
        params.logCanvas.warn(`canvas host failed to start: ${String(err)}`);
      }
    }

    const clients = new Set<GatewayWsClient>();
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    const handleHooksRequest = createGatewayHooksRequestHandler({
      deps: params.deps,
      getHooksConfig: params.hooksConfig,
      getClientIpConfig: params.getHookClientIpConfig,
      bindHost: params.bindHost,
      port: params.port,
      logHooks: params.logHooks,
    });

    const handlePluginRequest = createGatewayPluginRequestHandler({
      registry: params.pluginRegistry,
      log: params.logPlugins,
    });
    const shouldEnforcePluginGatewayAuth = (pathContext: PluginRoutePathContext): boolean => {
      return shouldEnforceGatewayAuthForPluginPath(
        resolveActivePluginHttpRouteRegistry(params.pluginRegistry),
        pathContext,
      );
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
    const httpServers: HttpServer[] = [];
    const httpBindHosts: string[] = [];
    for (const host of bindHosts) {
      const httpServer = createGatewayHttpServer({
        canvasHost,
        clients,
        controlUiEnabled: params.controlUiEnabled,
        controlUiBasePath: params.controlUiBasePath,
        controlUiRoot: params.controlUiRoot,
        openAiChatCompletionsEnabled: params.openAiChatCompletionsEnabled,
        openAiChatCompletionsConfig: params.openAiChatCompletionsConfig,
        openResponsesEnabled: params.openResponsesEnabled,
        openResponsesConfig: params.openResponsesConfig,
        strictTransportSecurityHeader: params.strictTransportSecurityHeader,
        handleHooksRequest,
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth,
        resolvedAuth: params.resolvedAuth,
        getResolvedAuth: params.getResolvedAuth,
        rateLimiter: params.rateLimiter,
        getReadiness: params.getReadiness,
        tlsOptions: params.gatewayTls?.enabled ? params.gatewayTls.tlsOptions : undefined,
      });
      try {
        await listenGatewayHttpServer({
          httpServer,
          bindHost: host,
          port: params.port,
        });
        httpServers.push(httpServer);
        httpBindHosts.push(host);
      } catch (err) {
        if (host === bindHosts[0]) {
          throw err;
        }
        params.log.warn(
          `gateway: failed to bind loopback alias ${host}:${params.port} (${String(err)})`,
        );
      }
    }
    const httpServer = httpServers[0];
    if (!httpServer) {
      throw new Error("Gateway HTTP server failed to start");
    }

    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PREAUTH_PAYLOAD_BYTES,
    });
    const preauthConnectionBudget = createPreauthConnectionBudget();
    for (const server of httpServers) {
      attachGatewayUpgradeHandler({
        httpServer: server,
        wss,
        canvasHost,
        clients,
        preauthConnectionBudget,
        resolvedAuth: params.resolvedAuth,
        getResolvedAuth: params.getResolvedAuth,
        rateLimiter: params.rateLimiter,
      });
    }

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
    const toolEventRecipients = createToolEventRecipientRegistry();

    return {
      canvasHost,
      releasePluginRouteRegistry: () => {
        // Releases both pinned HTTP-route and channel registries set at startup.
        releasePinnedPluginHttpRouteRegistry(params.pluginRegistry);
        // Release unconditionally (no registry arg): the channel pin may have
        // been re-pinned to a deferred-reload registry that differs from the
        // original params.pluginRegistry, so an identity-guarded release would
        // be a no-op and leak the pin across in-process restarts.
        releasePinnedPluginChannelRegistry();
      },
      httpServer,
      httpServers,
      httpBindHosts,
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
      toolEventRecipients,
    };
  } catch (err) {
    releasePinnedPluginHttpRouteRegistry(params.pluginRegistry);
    releasePinnedPluginChannelRegistry();
    throw err;
  }
}
