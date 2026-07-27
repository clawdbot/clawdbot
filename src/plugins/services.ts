/** Starts, stops, and inspects plugin service registrations. */
import { STATE_DIR } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayPluginEventBroadcastFn } from "../gateway/server-broadcast-types.js";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  onTrustedInternalDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPluginJsonValue, type PluginJsonValue } from "./host-hook-json.js";
import { withPluginHttpRouteRegistry } from "./http-registry.js";
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
  gatewayEvents?: OpenClawPluginServiceContext["gatewayEvents"];
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
    ...(params.gatewayEvents ? { gatewayEvents: params.gatewayEvents } : {}),
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
            emit: emitTrustedDiagnosticEventWithPrivateData,
            onEvent: onTrustedInternalDiagnosticEvent,
          },
        }
      : {}),
  };
}

function createScopedGatewayEvents(params: {
  pluginId: string;
  broadcast?: GatewayPluginEventBroadcastFn;
}): {
  gatewayEvents?: OpenClawPluginServiceContext["gatewayEvents"];
  revoke: () => void;
} {
  if (!params.broadcast) {
    return { revoke: () => undefined };
  }
  let active = true;
  return {
    gatewayEvents: {
      emit: (event, payload: PluginJsonValue, opts) => {
        if (!active) {
          throw new Error("plugin service gateway event emitter is no longer active");
        }
        if (!/^[a-z][a-z0-9_-]*$/u.test(event)) {
          throw new Error(`invalid plugin gateway event name: ${event}`);
        }
        if (!isPluginJsonValue(payload)) {
          throw new Error("plugin gateway event payload must be bounded JSON");
        }
        if (
          opts?.scope !== "operator.read" &&
          opts?.scope !== "operator.write" &&
          opts?.scope !== "operator.admin"
        ) {
          throw new Error("plugin gateway event scope must be an operator scope");
        }
        params.broadcast?.(`plugin.${params.pluginId}.${event}`, payload, opts.scope);
      },
    },
    revoke: () => {
      active = false;
    },
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
  broadcastPluginEvent?: GatewayPluginEventBroadcastFn;
}): Promise<PluginServicesHandle> {
  const running: Array<{
    id: string;
    stop?: () => void | Promise<void>;
    revokeGatewayEvents: () => void;
  }> = [];
  let failedCount = 0;
  for (const entry of params.registry.services) {
    const service = entry.service;
    const traceName = createPluginServiceTraceName(entry);
    const scopedGatewayEvents = createScopedGatewayEvents({
      pluginId: entry.pluginId,
      broadcast: params.broadcastPluginEvent,
    });
    const serviceContext = createServiceContext({
      config: params.config,
      startupTrace: params.startupTrace,
      workspaceDir: params.workspaceDir,
      service: entry,
      gatewayEvents: scopedGatewayEvents.gatewayEvents,
    });
    try {
      const startService = () =>
        withPluginHttpRouteRegistry(params.registry, () => service.start(serviceContext));
      if (params.startupTrace) {
        await params.startupTrace.measure(traceName, startService);
      } else {
        await startService();
      }
      running.push({
        id: service.id,
        stop: service.stop ? () => service.stop?.(serviceContext) : undefined,
        revokeGatewayEvents: scopedGatewayEvents.revoke,
      });
    } catch (err) {
      scopedGatewayEvents.revoke();
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
        try {
          if (entry.stop) {
            await withPluginHttpRouteRegistry(params.registry, () => entry.stop?.());
          }
        } catch (err) {
          log.warn(`plugin service stop failed (${entry.id}): ${String(err)}`);
        } finally {
          entry.revokeGatewayEvents();
        }
      }
    },
  };
}
