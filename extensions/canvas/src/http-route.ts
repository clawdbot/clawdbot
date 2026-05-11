import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { isCanvasHostEnabled, resolveCanvasHostConfig } from "./config.js";
import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH, handleA2uiHttpRequest } from "./host/a2ui.js";
import { createCanvasHostHandler, type CanvasHostHandler } from "./host/server.js";

export type CanvasHttpRouteHandler = {
  handleHttpRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<boolean>;
  close: () => Promise<void>;
};

export function createCanvasHttpRouteHandler(params: {
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  runtime: RuntimeEnv;
  allowInTests?: boolean;
}): CanvasHttpRouteHandler {
  let hostHandlerPromise: Promise<CanvasHostHandler | null> | null = null;
  const loadHostHandler = async (): Promise<CanvasHostHandler | null> => {
    if (!isCanvasHostEnabled(params.config)) {
      return null;
    }
    hostHandlerPromise ??= (async () => {
      const hostConfig = resolveCanvasHostConfig({
        config: params.config,
        pluginConfig: params.pluginConfig,
      });
      const handler = await createCanvasHostHandler({
        runtime: params.runtime,
        rootDir: hostConfig.root,
        basePath: CANVAS_HOST_PATH,
        allowInTests: params.allowInTests,
        liveReload: hostConfig.liveReload,
      });
      return handler.rootDir ? handler : null;
    })();
    return hostHandlerPromise;
  };

  return {
    async handleHttpRequest(req, res) {
      const handler = await loadHostHandler();
      if (!handler) {
        return false;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === A2UI_PATH || url.pathname.startsWith(`${A2UI_PATH}/`)) {
        return handleA2uiHttpRequest(req, res);
      }
      return handler.handleHttpRequest(req, res);
    },
    async handleUpgrade(req, socket, head) {
      const handler = await loadHostHandler();
      if (!handler) {
        return false;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== CANVAS_WS_PATH) {
        return false;
      }
      return handler.handleUpgrade(req, socket, head);
    },
    async close() {
      const handler = hostHandlerPromise ? await hostHandlerPromise : null;
      await handler?.close();
      hostHandlerPromise = null;
    },
  };
}
