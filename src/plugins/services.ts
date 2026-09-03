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
import {
  createPluginRuntimeCapabilityLease,
  type PluginRuntimeCapabilityLease,
} from "./capability-lease.js";
import { subscribePluginSessionsChanged } from "./gateway-events.js";
import { isPluginJsonValue, type PluginJsonValue } from "./host-hook-json.js";
import { withPluginHttpRouteRegistry } from "./http-registry.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import type { PluginRegistry } from "./registry.js";
import { createPluginServiceHealthGeneration } from "./service-health.js";
import { encodeStartupTraceSegment } from "./startup-trace-segment.js";
import type { OpenClawPluginServiceContext, PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");
export const PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS = 5_000;

class PluginServiceReplacementTimeoutError extends Error {}

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
          emit: (event, privateData) => {
            params.lease.assertActive("internal diagnostic emitter");
            emitTrustedDiagnosticEventWithPrivateData(event, privateData);
          },
          onEvent: (listener) => {
            params.lease.assertActive("internal diagnostic listener");
            const trustedListener = isOtelExporter
              ? markTrustedOtelDiagnosticListener(listener)
              : listener;
            return params.lease.retain(onTrustedInternalDiagnosticEvent(trustedListener));
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
  onHandle?: (handle: PluginServicesHandle) => void;
}): Promise<PluginServicesHandle> {
  const healthGeneration = createPluginServiceHealthGeneration(params.registry);
  // Failed starts can still own pending cleanup; retain every issued service.
  const ownedServices: Array<{
    id: string;
    pluginId: string;
    diagnosticsExporter: boolean;
    stop?: () => void | Promise<void>;
    cleanup?: Promise<void>;
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
      new PluginServiceReplacementTimeoutError(
        `${label} timed out after ${PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS}ms${owner ? ` (${owner})` : ""}`,
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
  ) => {
    try {
      if (entry.stop) {
        // Cleanup belongs to the service, not a caller's deadline. Keep even rejected
        // cleanup; invoke synchronously so expired deadlines accept settled cleanup.
        const cleanup = () => {
          try {
            return (entry.cleanup ??= Promise.resolve(
              withPluginHttpRouteRegistry(params.registry, () => entry.stop?.(), entry.lease),
            ));
          } catch (error) {
            return (entry.cleanup = (async () => {
              throw error;
            })());
          }
        };
        await runBeforeDeadline(cleanup, deadline, "plugin service stop");
      }
    } catch (err) {
      log.warn(`plugin service stop failed (${entry.id}): ${String(err)}`);
      failures?.push(
        deadline === undefined
          ? err
          : new Error(
              `plugin service stop failed (plugin=${entry.pluginId}, service=${entry.id}): ${
                err instanceof PluginServiceReplacementTimeoutError
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
  let stopRequested = false;
  const handle: PluginServicesHandle = {
    stop: (options) => {
      stopRequested = true;
      const strict = options?.strict === true;
      const deadline = strict ? options.deadlineAtMs : undefined;
      // Each caller waits under its own policy; onHandle may run before startupSettled exists.
      const stopPromise = Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        try {
          const starting = ownedServices.at(-1);
          await runBeforeDeadline(
            () => startupSettled.catch(() => {}),
            deadline,
            "plugin service startup settlement",
            starting ? `plugin=${starting.pluginId}, service=${starting.id}` : undefined,
          );
        } catch (error) {
          failures.push(error);
          // Startup may resume after replacement timed out; its issued capabilities die now.
          for (const entry of ownedServices) {
            entry.lease.revoke();
          }
        }
        const reversed = ownedServices.toReversed();
        const diagnosticsExporters = reversed.filter((entry) => entry.diagnosticsExporter);
        for (const entry of reversed.filter((candidate) => !candidate.diagnosticsExporter)) {
          await stopService(entry, strict ? failures : undefined, deadline);
        }
        if (diagnosticsExporters.length > 0) {
          // Producers stop first; this barrier preserves their queued tail before exporters detach.
          try {
            await runBeforeDeadline(
              waitForDiagnosticEventsDrained,
              deadline,
              "plugin diagnostic event drain",
              diagnosticsExporters
                .map((entry) => `plugin=${entry.pluginId}, service=${entry.id}`)
                .join("; "),
            );
          } catch (error) {
            if (!strict) {
              throw error;
            }
            failures.push(error);
          }
        }
        // Ordinary plugin cleanup stays warn-and-continue. Trusted diagnostics
        // exporter failures propagate because they can mean telemetry was lost.
        for (const entry of diagnosticsExporters) {
          await stopService(entry, failures, deadline);
        }
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

  const startupSettled = (async () => {
    let failedCount = 0;
    for (const entry of params.registry.services) {
      if (stopRequested) {
        break;
      }
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
      const serviceContext = createServiceContext({
        config: params.config,
        startupTrace: params.startupTrace,
        workspaceDir: params.workspaceDir,
        service: entry,
        serviceHealth: serviceHealth.health,
        gatewayEvents: scopedGatewayEvents.gatewayEvents,
        lease,
      });
      const ownedService = {
        id: service.id,
        pluginId: entry.pluginId,
        diagnosticsExporter: serviceContext.internalDiagnostics !== undefined,
        stop: service.stop ? () => service.stop?.(serviceContext) : undefined,
        lease,
      };
      // Own capabilities before startup yields so a bounded replacement can revoke stale work.
      ownedServices.push(ownedService);
      try {
        const startService = () =>
          withPluginHttpRouteRegistry(params.registry, () => service.start(serviceContext), lease);
        if (params.startupTrace) {
          await params.startupTrace.measure(traceName, startService);
        } else {
          await startService();
        }
      } catch (err) {
        failedCount += 1;
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
