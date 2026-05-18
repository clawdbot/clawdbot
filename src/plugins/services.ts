import { STATE_DIR } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emitTrustedDiagnosticEvent,
  onInternalDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import type { PluginRegistry } from "./registry.js";
import { encodeStartupTraceSegment } from "./startup-trace-segment.js";
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
  startupTrace?: PluginServiceStartupTrace;
  workspaceDir?: string;
  service: PluginServiceRegistration;
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
    ...(params.startupTrace
      ? {
          startupTrace: createScopedPluginServiceStartupTrace(
            params.startupTrace,
            createPluginServiceTraceName(params.service),
          ),
        }
      : {}),
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

function createPluginServiceTraceName(entry: PluginServiceRegistration): string {
  return `sidecars.plugin-services.${encodeStartupTraceSegment(entry.pluginId)}.${encodeStartupTraceSegment(entry.service.id)}`;
}

function createScopedPluginServiceStartupTrace(
  startupTrace: PluginServiceStartupTrace,
  prefix: string,
): PluginServiceStartupTrace {
  const scopeName = (name: string) =>
    `${prefix}.${name
      .split(".")
      .map((segment) => encodeStartupTraceSegment(segment))
      .join(".")}`;
  return {
    measure: (name, run) => startupTrace.measure(scopeName(name), run),
    ...(startupTrace.detail
      ? {
          detail: (name, metrics) => startupTrace.detail?.(scopeName(name), metrics),
        }
      : {}),
  };
}

export type PluginServicesHandle = {
  stop: () => Promise<void>;
};

type PluginServiceStartupTrace = {
  detail?: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};

export async function startPluginServices(params: {
  registry: PluginRegistry;
  config: OpenClawConfig;
  workspaceDir?: string;
  startupTrace?: PluginServiceStartupTrace;
}): Promise<PluginServicesHandle> {
  const running: Array<{
    id: string;
    stop?: () => void | Promise<void>;
  }> = [];
  let failedCount = 0;
  for (const entry of params.registry.services) {
    const service = entry.service;
    const traceName = createPluginServiceTraceName(entry);
    const serviceContext = createServiceContext({
      config: params.config,
      startupTrace: params.startupTrace,
      workspaceDir: params.workspaceDir,
      service: entry,
    });
    try {
      const startService = () => service.start(serviceContext);
      if (params.startupTrace) {
        await params.startupTrace.measure(traceName, startService);
      } else {
        await startService();
      }
      running.push({
        id: service.id,
        stop: service.stop ? () => service.stop?.(serviceContext) : undefined,
      });
    } catch (err) {
      failedCount += 1;
      const error = err as Error;
      log.error(
        `plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${error?.message ?? String(err)}`,
      );
    }
  }
  params.startupTrace?.detail?.("sidecars.plugin-services.summary", [
    ["serviceCount", params.registry.services.length],
    ["startedCount", running.length],
    ["failedCount", failedCount],
  ]);

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
