import { STATE_DIR } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emitTrustedDiagnosticEvent,
  onInternalDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginServiceRegistration } from "./registry-types.js";
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
  service?: PluginServiceRegistration;
}): OpenClawPluginServiceContext {
  const isDiagnosticsExporter =
    params.service?.pluginId === params.service?.service.id &&
    (params.service?.service.id === "diagnostics-otel" ||
      params.service?.service.id === "diagnostics-prometheus");
  const grantsInternalDiagnostics =
    isDiagnosticsExporter &&
    (params.service?.origin === "bundled" || params.service?.trustedOfficialInstall === true);

  return {
    config: params.config,
    workspaceDir: params.workspaceDir,
    stateDir: STATE_DIR,
    logger: createPluginLogger(),
    ...(grantsInternalDiagnostics
      ? {
          internalDiagnostics: {
            emit: emitTrustedDiagnosticEvent,
            onEvent: onInternalDiagnosticEvent,
          },
        }
      : {}),
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
  for (const entry of params.registry.services) {
    const service = entry.service;
    const serviceContext = createServiceContext({
      config: params.config,
      workspaceDir: params.workspaceDir,
      service: entry,
    });
    try {
      await service.start(serviceContext);
      running.push({
        id: service.id,
        stop: service.stop ? () => service.stop?.(serviceContext) : undefined,
      });
    } catch (err) {
      const error = err as Error;
      log.error(
        `plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${error?.message ?? String(err)}`,
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
