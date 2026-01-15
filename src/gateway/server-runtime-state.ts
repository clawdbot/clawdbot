import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import { type CanvasHostHandler, createCanvasHostHandler } from "../canvas-host/server.js";
import type { CliDeps } from "../cli/deps.js";
import type { createSubsystemLogger } from "../logging.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { HooksConfigResolved } from "./hooks.js";
import { createGatewayHooksRequestHandler } from "./server/hooks.js";
import { listenGatewayHttpServer } from "./server/http-listen.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { type ChatRunEntry, createChatRunState } from "./server-chat.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import type { DedupeEntry } from "./server-shared.js";
import type { PluginRegistry } from "../plugins/registry.js";

export async function createGatewayRuntimeState(params: {
  cfg: {
    canvasHost?: { root?: string; enabled?: boolean; liveReload?: boolean };
  };
  bindHost: string;
  port: number;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  openAiChatCompletionsEnabled: boolean;
  resolvedAuth: ResolvedGatewayAuth;
  hooksConfig: () => HooksConfigResolved | null;
  pluginRegistry: PluginRegistry;
  deps: CliDeps;
  canvasRuntime: RuntimeEnv;
  canvasHostEnabled: boolean;
  allowCanvasHostInTests?: boolean;
  logCanvas: { info: (msg: string) => void; warn: (msg: string) => void };
  logHooks: ReturnType<typeof createSubsystemLogger>;
  logPlugins: ReturnType<typeof createSubsystemLogger>;
}): Promise<{
  canvasHost: CanvasHostHandler | null;
  httpServer: HttpServer;
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  agentRunSeq: Map<string, number>;
  dedupe: Map<string, DedupeEntry>;
  chatRunState: ReturnType<typeof createChatRunState>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  addChatRun: (sessionId: string, entry: ChatRunEntry) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
}> {
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

  const handleHooksRequest = createGatewayHooksRequestHandler({
    deps: params.deps,
    getHooksConfig: params.hooksConfig,
    bindHost: params.bindHost,
    port: params.port,
    logHooks: params.logHooks,
  });

  const handlePluginRequest = createGatewayPluginRequestHandler({
    registry: params.pluginRegistry,
    log: params.logPlugins,
  });

  const httpServer = createGatewayHttpServer({
    canvasHost,
    controlUiEnabled: params.controlUiEnabled,
    controlUiBasePath: params.controlUiBasePath,
    openAiChatCompletionsEnabled: params.openAiChatCompletionsEnabled,
    handleHooksRequest,
    handlePluginRequest,
    resolvedAuth: params.resolvedAuth,
  });

  await listenGatewayHttpServer({
    httpServer,
    bindHost: params.bindHost,
    port: params.port,
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  attachGatewayUpgradeHandler({ httpServer, wss, canvasHost });

  const clients = new Set<GatewayWsClient>();
  const { broadcast } = createGatewayBroadcaster({ clients });
  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map<string, DedupeEntry>();
  const chatRunState = createChatRunState();
  const chatRunRegistry = chatRunState.registry;
  const chatRunBuffers = chatRunState.buffers;
  const chatDeltaSentAt = chatRunState.deltaSentAt;
  const addChatRun = chatRunRegistry.add;
  const removeChatRun = chatRunRegistry.remove;
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();

  return {
    canvasHost,
    httpServer,
    wss,
    clients,
    broadcast,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
  };
}
