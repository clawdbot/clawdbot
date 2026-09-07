/** Starts, stops, and inspects plugin service registrations. */
import { STATE_DIR } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGatewayProcessInstanceId } from "../gateway/process-instance.js";
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
import { resolveRuntimeServiceBuildId } from "../version.js";
import {
  createPluginRuntimeCapabilityLease,
  type PluginRuntimeCapabilityLease,
} from "./capability-lease.js";
import { subscribePluginSessionsChanged } from "./gateway-events.js";
import { isPluginJsonValue, type PluginJsonValue } from "./host-hook-json.js";
import { withPluginHttpRouteRegistry } from "./http-registry.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import type { PluginRegistry } from "./registry.js";
import { createPluginServiceCronGetter, type PluginServiceCronHost } from "./service-cron.js";
import { createPluginServiceHealthGeneration } from "./service-health.js";
import { encodeStartupTraceSegment } from "./startup-trace-segment.js";
import type { OpenClawPluginServiceContext, PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");
export const PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS = 5_000;

class PluginServiceStopTimeoutError extends Error {}

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
  getCron?: OpenClawPluginServiceContext["getCron"];
  lease: PluginRuntimeCapabilityLease;
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
          getRuntimeIdentity: () => {
            params.lease.assertActive("runtime diagnostic identity");
            const buildId = resolveRuntimeServiceBuildId();
            return {
              processInstanceId: getGatewayProcessInstanceId(),
              ...(buildId ? { buildId } : {}),
            };
          },
          emit: (event, privateData) => {
            params.lease.assertActive("internal diagnostic emitter");
            emitTrustedDiagnosticEventWithPrivateData(event, privateData);
          },
          onEvent: (listener, filter) => {
            params.lease.assertActive("internal diagnostic listener");
            const trustedListener = isOtelExporter
              ? markTrustedOtelDiagnosticListener(listener)
              : listener;
            return params.lease.retain(onTrustedInternalDiagnosticEvent(trustedListener, filter));
          },
          registerTracePropagationBridge: (bridge) => {
            params.lease.assertActive("diagnostic trace propagation bridge");
            return params.lease.retain(registerDiagnosticTracePropagationBridge(bridge));
          },
          reportExporterHealth: (update) => {
            if (params.lease.isActive()) {
              recordDiagnosticExporterHealth(params.service.service.id, update);
            }
          },
        }
      : undefined;

  return {
    config: params.config,
    workspaceDir: params.workspaceDir,
    stateDir: STATE_DIR,
    logger: createPluginLogger(),
    serviceHealth: params.serviceHealth,
    ...(params.getCron ? { getCron: params.getCron } : {}),
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
  lease: PluginRuntimeCapabilityLease;
}): {
  gatewayEvents?: OpenClawPluginServiceContext["gatewayEvents"];
} {
  // No broadcaster means no gateway events at all: emits have nowhere to go and
  // sessions.changed is queued by the broadcaster itself. Omitting the facade
  // keeps `ctx.gatewayEvents` presence as the capability signal plugins
  // feature-detect; a silently dropping emit would defeat their fallbacks.
  if (!params.broadcast) {
    return {};
  }
  const broadcast = params.broadcast;
  return {
    gatewayEvents: {
      emit: (event, payload: PluginJsonValue, opts) => {
        params.lease.assertActive("gateway event emitter");
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
        params.lease.assertActive("gateway event subscriber");
        return params.lease.retain(subscribePluginSessionsChanged(handler));
      },
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
  reload: (config: OpenClawConfig, serviceIds: ReadonlySet<string>) => Promise<void>;
  stop: (options?: { strict: true; deadlineAtMs: number }) => Promise<void>;
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
  getCronService?: () => PluginServiceCronHost | null | undefined;
  oneShotStopTimeouts?: { eventDrainMs: number; serviceStopMs: number };
  onHandle?: (handle: PluginServicesHandle) => void;
}): Promise<PluginServicesHandle> {
  const healthGeneration = createPluginServiceHealthGeneration(params.registry);
  // Failed starts can still own pending cleanup; retain every issued service.
  const ownedServices: Array<{
    id: string;
    pluginId: string;
    diagnosticsExporter: boolean;
    registration: PluginServiceRegistration;
    stopping: boolean;
    stop?: () => void | Promise<void>;
    cleanup?: Promise<void>;
    startup?: Promise<void>;
    lease: PluginRuntimeCapabilityLease;
  }> = [];
  const runBeforeDeadline = async (
    run: () => void | Promise<void>,
    deadline: number | undefined,
    label: string,
    owner?: string,
  ): Promise<void> => {
    const operation = Promise.resolve(run());
    if (deadline === undefined) {
      return operation;
    }
    const remaining = deadline - Date.now();
    const timeoutError = () =>
      new PluginServiceStopTimeoutError(
        `${label} timed out after ${Math.max(0, remaining)}ms${owner ? ` (${owner})` : ""}`,
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation,
        remaining <= 0
          ? Promise.reject(timeoutError())
          : new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(timeoutError()), remaining);
              timer.unref?.();
            }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const stopService = async (
    entry: (typeof ownedServices)[number],
    failures?: unknown[],
    deadline?: number,
    beforeStop?: Promise<void>,
  ) => {
    entry.stopping = true;
    try {
      const cleanup = () => {
        if (entry.cleanup) {
          return entry.cleanup;
        }
        try {
          // Deadlines bound observers; raw startup still owns the one final cleanup.
          const ready = beforeStop ? beforeStop.then(() => entry.startup) : entry.startup;
          const invokeStop = () =>
            withPluginHttpRouteRegistry(params.registry, () => entry.stop?.(), entry.lease);
          return (entry.cleanup = ready ? ready.then(invokeStop) : Promise.resolve(invokeStop()));
        } catch (error) {
          const failure = createDeferredCore();
          failure.reject(error);
          return (entry.cleanup = failure.promise);
        }
      };
      await runBeforeDeadline(
        cleanup,
        deadline,
        entry.startup ? "plugin service startup settlement" : "plugin service stop",
      );
    } catch (err) {
      log.warn(`plugin service stop failed (${entry.id}): ${String(err)}`);
      failures?.push(
        deadline === undefined
          ? err
          : new Error(
              `plugin service stop failed (plugin=${entry.pluginId}, service=${entry.id}): ${
                err instanceof PluginServiceStopTimeoutError
                  ? err.message
                  : `rejected: ${String(err)}`
              }`,
              { cause: err },
            ),
      );
    } finally {
      entry.lease.revoke();
    }
  };
  const stopServices = async (
    entries: typeof ownedServices,
    failures: unknown[],
    strict: boolean,
    deadline?: number,
  ) => {
    for (const entry of entries) {
      entry.stopping = true;
    }
    const reversed = entries.toReversed();
    const oneShotTimeouts = deadline === undefined ? params.oneShotStopTimeouts : undefined;
    // One-shot registries are already scoped; every cleanup follows the drain, without changing grants.
    const afterDrain = oneShotTimeouts
      ? reversed
      : reversed.filter((entry) => entry.diagnosticsExporter);
    const producers = oneShotTimeouts ? [] : reversed.filter((entry) => !entry.diagnosticsExporter);
    for (const entry of producers) {
      await stopService(entry, strict ? failures : undefined, deadline);
    }
    let exporterReady: Promise<void> | undefined;
    if (afterDrain.length > 0) {
      const owners = afterDrain
        .map((entry) => `plugin=${entry.pluginId}, service=${entry.id}`)
        .join("; ");
      // Exporters follow actual producer cleanup, even after a caller stops waiting.
      const draining = Promise.allSettled([
        ...afterDrain.map((entry) => entry.startup),
        ...producers.map((entry) => entry.cleanup),
      ]).then(() =>
        runBeforeDeadline(
          waitForDiagnosticEventsDrained,
          oneShotTimeouts ? Date.now() + oneShotTimeouts.eventDrainMs : deadline,
          "plugin diagnostic event drain",
          owners,
        ),
      );
      // A bounded drain failure cannot discard the exporter's final stop.
      exporterReady = draining.catch(() => {});
      try {
        await runBeforeDeadline(() => draining, deadline, "plugin diagnostic event drain", owners);
      } catch (error) {
        if (!strict && !oneShotTimeouts) {
          throw error;
        }
        failures.push(error);
      }
    }
    // Fresh one-shot flush budgets start after drain; absolute replacement deadlines span all phases.
    const stopDeadline = oneShotTimeouts ? Date.now() + oneShotTimeouts.serviceStopMs : deadline;
    for (const entry of afterDrain) {
      await stopService(entry, failures, stopDeadline, exporterReady);
    }
  };
  let stopRequested = false;
  let reloadTail = Promise.resolve();
  const handle: PluginServicesHandle = {
    reload: (config, serviceIds) => {
      const reloading = reloadTail.then(async () => {
        await startupSettled;
        if (stopRequested) {
          throw new Error("Plugin services are stopping");
        }
        const selected = ownedServices.filter((entry) => serviceIds.has(entry.id));
        const deadline = Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS;
        const failures: unknown[] = [];
        await stopServices(selected, failures, true, deadline);
        if (failures.length > 0) {
          throw new AggregateError(failures, "plugin service reload cleanup failed");
        }
        for (const entry of selected) {
          if (stopRequested) {
            return;
          }
          await startService(entry.registration, config, true, ownedServices.indexOf(entry));
        }
      });
      reloadTail = reloading.catch(() => {});
      return reloading;
    },
    stop: (options) => {
      stopRequested = true;
      const strict = options?.strict === true;
      const deadline = strict ? options.deadlineAtMs : undefined;
      // Each caller observes the retained cleanup under its own deadline policy.
      const stopPromise = Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        await stopServices(ownedServices, failures, strict, deadline);
        if (!strict && failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            strict
              ? "plugin service replacement cleanup failed"
              : "multiple diagnostics exporters failed to stop",
          );
        }
      });
      void stopPromise.then(healthGeneration.retire, healthGeneration.retire);
      return stopPromise;
    },
  };
  params.onHandle?.(handle);

  const startService = async (
    entry: PluginServiceRegistration,
    config: OpenClawConfig,
    strict = false,
    index = ownedServices.length,
  ): Promise<boolean> => {
    const service = entry.service;
    const traceName = createPluginServiceTraceName(entry);
    const lease = createPluginRuntimeCapabilityLease("plugin service");
    const scopedGatewayEvents = createScopedGatewayEvents({
      pluginId: entry.pluginId,
      broadcast: params.broadcastPluginEvent,
      lease,
    });
    const serviceHealth = healthGeneration.createReporter(entry);
    lease.retain(serviceHealth.revoke);
    serviceHealth.health.clearFailure();
    const serviceContext = createServiceContext({
      config,
      startupTrace: params.startupTrace,
      workspaceDir: params.workspaceDir,
      service: entry,
      serviceHealth: serviceHealth.health,
      gatewayEvents: scopedGatewayEvents.gatewayEvents,
      ...(params.getCronService
        ? {
            getCron: createPluginServiceCronGetter({
              getCron: params.getCronService,
              lease,
              isStopping: () => stopRequested || ownedService.stopping,
            }),
          }
        : {}),
      lease,
    });
    const ownedService: (typeof ownedServices)[number] = {
      id: service.id,
      registration: entry,
      stopping: false,
      pluginId: entry.pluginId,
      diagnosticsExporter: serviceContext.internalDiagnostics !== undefined,
      stop: service.stop ? () => service.stop?.(serviceContext) : undefined,
      lease,
    };
    // Publish before startup yields; preserve the registration's slot across failed reloads.
    ownedServices.splice(index, 1, ownedService);
    try {
      const invokeStart = async () => {
        const settled = createDeferredCore();
        ownedService.startup = settled.promise;
        try {
          await withPluginHttpRouteRegistry(
            params.registry,
            () => service.start(serviceContext),
            lease,
          );
        } finally {
          // Settlement excludes failed-start rollback, which waits for this raw work.
          ownedService.startup = undefined;
          settled.resolve();
        }
      };
      await (params.startupTrace
        ? params.startupTrace.measure(traceName, invokeStart)
        : invokeStart());
      return true;
    } catch (err) {
      serviceContext.serviceHealth?.reportFailure(err);
      const error = err as Error;
      log.error(
        `plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${error?.message ?? String(err)}`,
      );
      // A failed start can already own resources; revoke events only after its cleanup runs.
      // Bound the cleanup: callers await startPluginServices without a timeout, so a hung
      // stop here would wedge plugin reload/startup forever.
      await stopService(
        ownedService,
        undefined,
        Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
      );
      if (strict) {
        throw err;
      }
      return false;
    }
  };
  const startupSettled = (async () => {
    let failedCount = 0;
    for (const entry of params.registry.services) {
      if (stopRequested) {
        break;
      }
      if (!(await startService(entry, params.config))) {
        failedCount += 1;
      }
    }
    params.startupTrace?.detail?.("sidecars.plugin-services.summary", [
      ["serviceCount", params.registry.services.length],
      ["startedCount", ownedServices.length - failedCount],
      ["failedCount", failedCount],
    ]);
  })();
  await startupSettled;
  return handle;
}
