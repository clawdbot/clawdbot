/** Starts, stops, and inspects plugin service registrations. */
import { STATE_DIR } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayPluginEventBroadcastFn } from "../gateway/server-broadcast-types.js";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";
import { registerDiagnosticTracePropagationBridge } from "../infra/diagnostic-trace-propagation.js";
import {
  recordDiagnosticExporterHealth,
  type DiagnosticExporterHealthUpdate,
} from "../logging/diagnostic-stability.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createDeferredCore } from "../shared/deferred.js";
import { subscribePluginSessionsChanged } from "./gateway-events.js";
import { isPluginJsonValue, type PluginJsonValue } from "./host-hook-json.js";
import { withPluginHttpRouteRegistry } from "./http-registry.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import type { PluginRegistry } from "./registry.js";
import { createPluginServiceHealthGeneration } from "./service-health.js";
import { encodeStartupTraceSegment } from "./startup-trace-segment.js";
import type { OpenClawPluginServiceContext, PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");
type TrustedExporterInternalDiagnostics = NonNullable<
  OpenClawPluginServiceContext["internalDiagnostics"]
> & {
  reportExporterHealth: (update: DiagnosticExporterHealthUpdate) => void;
};

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
  serviceHealth: NonNullable<OpenClawPluginServiceContext["serviceHealth"]>;
  gatewayEvents?: OpenClawPluginServiceContext["gatewayEvents"];
}): OpenClawPluginServiceContext {
  const isDiagnosticsExporter =
    params.service?.pluginId === params.service?.service.id &&
    (params.service?.service.id === "diagnostics-otel" ||
      params.service?.service.id === "diagnostics-prometheus");
  const isOtelExporter = isDiagnosticsExporter && params.service.service.id === "diagnostics-otel";
  const grantsInternalDiagnostics =
    isDiagnosticsExporter &&
    (params.service?.origin === "bundled" || params.service?.trustedOfficialInstall === true);
  const internalDiagnostics: TrustedExporterInternalDiagnostics | undefined =
    grantsInternalDiagnostics
      ? {
          emit: emitTrustedDiagnosticEventWithPrivateData,
          onEvent: isOtelExporter
            ? (listener) =>
                onTrustedInternalDiagnosticEvent(markTrustedOtelDiagnosticListener(listener))
            : onTrustedInternalDiagnosticEvent,
          registerTracePropagationBridge: registerDiagnosticTracePropagationBridge,
          reportExporterHealth: (update) =>
            recordDiagnosticExporterHealth(params.service.service.id, update),
        }
      : undefined;

  return {
    config: params.config,
    workspaceDir: params.workspaceDir,
    stateDir: STATE_DIR,
    logger: createPluginLogger(),
    serviceHealth: params.serviceHealth,
    ...(params.gatewayEvents ? { gatewayEvents: params.gatewayEvents } : {}),
    ...(params.startupTrace
      ? {
          startupTrace: createScopedPluginServiceStartupTrace(
            params.startupTrace,
            createPluginServiceTraceName(params.service),
          ),
        }
      : {}),
    ...(internalDiagnostics ? { internalDiagnostics } : {}),
  };
}

function createScopedGatewayEvents(params: {
  pluginId: string;
  broadcast?: GatewayPluginEventBroadcastFn;
}): {
  gatewayEvents?: OpenClawPluginServiceContext["gatewayEvents"];
  revoke: () => void;
} {
  // No broadcaster means no gateway events at all: emits have nowhere to go and
  // sessions.changed is queued by the broadcaster itself. Omitting the facade
  // keeps `ctx.gatewayEvents` presence as the capability signal plugins
  // feature-detect; a silently dropping emit would defeat their fallbacks.
  if (!params.broadcast) {
    return { revoke: () => undefined };
  }
  const broadcast = params.broadcast;
  let active = true;
  const subscriptions = new Set<() => void>();
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
        broadcast(`plugin.${params.pluginId}.${event}`, payload, opts.scope);
      },
      onSessionsChanged: (handler) => {
        if (!active) {
          throw new Error("plugin service gateway event subscriber is no longer active");
        }
        const unsubscribe = subscribePluginSessionsChanged(handler);
        let subscribed = true;
        const release = () => {
          if (!subscribed) {
            return;
          }
          subscribed = false;
          subscriptions.delete(release);
          unsubscribe();
        };
        subscriptions.add(release);
        return release;
      },
    },
    revoke: () => {
      active = false;
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
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
  onHandle?: (handle: PluginServicesHandle) => void;
}): Promise<PluginServicesHandle> {
  const healthGeneration = createPluginServiceHealthGeneration(params.registry);
  const running: Array<{
    id: string;
    diagnosticsExporter: boolean;
    stop?: () => void | Promise<void>;
    revokeGatewayEvents: () => void;
    revokeServiceHealth: () => void;
  }> = [];
  const stopService = async (entry: (typeof running)[number], failures?: unknown[]) => {
    try {
      if (entry.stop) {
        await withPluginHttpRouteRegistry(params.registry, () => entry.stop?.());
      }
    } catch (err) {
      log.warn(`plugin service stop failed (${entry.id}): ${String(err)}`);
      failures?.push(err);
    } finally {
      entry.revokeGatewayEvents();
      entry.revokeServiceHealth();
    }
  };
  const startupSettled = createDeferredCore();
  void startupSettled.promise.catch(() => {});
  let stopRequested = false;
  let stopPromise: Promise<void> | undefined;
  const handle: PluginServicesHandle = {
    stop: () => {
      stopRequested = true;
      // Store the shared promise before plugin cleanup runs so shutdown cannot start twice.
      if (!stopPromise) {
        stopPromise = Promise.resolve().then(async () => {
          await startupSettled.promise.catch(() => {});
          const reversed = running.toReversed();
          const diagnosticsExporters = reversed.filter((entry) => entry.diagnosticsExporter);
          const exporterFailures: unknown[] = [];
          const stopServices = async (services: typeof reversed, failures?: unknown[]) => {
            for (const entry of services) {
              await stopService(entry, failures);
            }
          };
          await stopServices(reversed.filter((entry) => !entry.diagnosticsExporter));
          if (diagnosticsExporters.length > 0) {
            // Producers stop first; this barrier preserves their queued tail before exporters detach.
            await waitForDiagnosticEventsDrained();
          }
          // Ordinary plugin cleanup stays warn-and-continue. Trusted diagnostics
          // exporter failures propagate because they can mean telemetry was lost.
          await stopServices(diagnosticsExporters, exporterFailures);
          if (exporterFailures.length === 1) {
            throw exporterFailures[0];
          }
          if (exporterFailures.length > 1) {
            throw new AggregateError(
              exporterFailures,
              "multiple diagnostics exporters failed to stop",
            );
          }
        });
        void stopPromise.then(healthGeneration.retire, healthGeneration.retire);
      }
      return stopPromise;
    },
  };
  params.onHandle?.(handle);

  try {
    let failedCount = 0;
    for (const entry of params.registry.services) {
      if (stopRequested) {
        break;
      }
      const service = entry.service;
      const traceName = createPluginServiceTraceName(entry);
      const scopedGatewayEvents = createScopedGatewayEvents({
        pluginId: entry.pluginId,
        broadcast: params.broadcastPluginEvent,
      });
      const serviceHealth = healthGeneration.createReporter(entry);
      const serviceContext = createServiceContext({
        config: params.config,
        startupTrace: params.startupTrace,
        workspaceDir: params.workspaceDir,
        service: entry,
        serviceHealth: serviceHealth.health,
        gatewayEvents: scopedGatewayEvents.gatewayEvents,
      });
      const runningService = {
        id: service.id,
        diagnosticsExporter: serviceContext.internalDiagnostics !== undefined,
        stop: service.stop ? () => service.stop?.(serviceContext) : undefined,
        revokeGatewayEvents: scopedGatewayEvents.revoke,
        revokeServiceHealth: serviceHealth.revoke,
      };
      try {
        const startService = () =>
          withPluginHttpRouteRegistry(params.registry, () => service.start(serviceContext));
        if (params.startupTrace) {
          await params.startupTrace.measure(traceName, startService);
        } else {
          await startService();
        }
        running.push(runningService);
      } catch (err) {
        failedCount += 1;
        serviceContext.serviceHealth?.reportFailure(err);
        const error = err as Error;
        log.error(
          `plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${error?.message ?? String(err)}`,
        );
        // A failed start can already own resources; revoke events only after its cleanup runs.
        await stopService(runningService);
      }
    }
    params.startupTrace?.detail?.("sidecars.plugin-services.summary", [
      ["serviceCount", params.registry.services.length],
      ["startedCount", running.length],
      ["failedCount", failedCount],
    ]);
    startupSettled.resolve();
    return handle;
  } catch (error) {
    startupSettled.reject(error);
    throw error;
  }
}
