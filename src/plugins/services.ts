import { STATE_DIR } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "./registry.js";
import type { OpenClawPluginServiceContext, PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");
function createPluginLogger(): PluginLogger {
  return {
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
    debug: (msg) => log.debug(msg),
  };
}

function createServiceContext(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
}): OpenClawPluginServiceContext {
  return {
    config: params.config,
    workspaceDir: params.workspaceDir,
    stateDir: STATE_DIR,
    logger: createPluginLogger(),
  };
}

export type PluginServicesHandle = {
  stop: () => Promise<void>;
};

export async function startPluginServices(params: {
  registry: PluginRegistry;
  config: OpenClawConfig;
  workspaceDir?: string;
}): Promise<PluginServicesHandle> {
  const running: Array<{
    id: string;
    stop?: () => void | Promise<void>;
  }> = [];
  const serviceContext = createServiceContext({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  for (const entry of params.registry.services) {
    const service = entry.service;
    try {
      await service.start(serviceContext);
      running.push({
        id: service.id,
        stop: service.stop ? () => service.stop?.(serviceContext) : undefined,
      });
    } catch (err) {
      const error = err as Error;
      const stack = error?.stack?.trim();
      log.error(
        `plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${error?.message ?? String(err)}${stack ? `\n${stack}` : ""}`,
      );
    }
  }

  return {
    stop: async () => {
      for (const entry of running.toReversed()) {
        if (!entry.stop) {
          continue;
        }
        try {
          await entry.stop();
        } catch (err) {
          log.warn(`plugin service stop failed (${entry.id}): ${String(err)}`);
        }
      }
    },
  };
}
