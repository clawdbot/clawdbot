import type { IncomingMessage, ServerResponse } from "node:http";

import type { createSubsystemLogger } from "../../logging.js";
import type { PluginRegistry } from "../../plugins/registry.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type PluginHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

export function createGatewayPluginRequestHandler(params: {
  registry: PluginRegistry;
  log: SubsystemLogger;
}): PluginHttpRequestHandler {
  const { registry, log } = params;
  return async (req, res) => {
    if (registry.httpHandlers.length === 0) return false;
    for (const entry of registry.httpHandlers) {
      try {
        const handled = await entry.handler(req, res);
        if (handled) return true;
      } catch (err) {
        log.warn(`plugin http handler failed (${entry.pluginId}): ${String(err)}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Internal Server Error");
        }
        return true;
      }
    }
    return false;
  };
}
