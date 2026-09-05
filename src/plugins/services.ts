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
import { resolveRuntimeServiceBuildId } from "../version.js";
import {
  createPluginRuntimeCapabilityLease,
  type PluginRuntimeCapabilityLease,
} from "./capability-lease.js";
import { subscribePluginSessionsChanged } from "./gateway-events.js";
import { isPluginJsonValue, type PluginJsonValue } from "./host-hook-json.js";
import { withPluginHttpRouteRegistry } from "./http-registry.js";
import { runPluginCleanup } from "./plugin-instance-scope.js";
import { getPluginRecordRegistry } from "./registry-lifecycle.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import type { PluginRegistry } from "./registry.js";
import { createPluginServiceCronGetter, type PluginServiceCronHost } from "./service-cron.js";
import { createPluginServiceHealthReporter } from "./service-health.js";
import { encodeStartupTraceSegment } from "./startup-trace-segment.js";
import type { OpenClawPluginServiceContext } from "./types.js";

const log = createSubsystemLogger("plugins");
export const PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS = 5_000;

class PluginServiceReplacementTimeoutError extends Error {}

type TrustedExporterInternalDiagnostics = NonNullable<
  OpenClawPluginServiceContext["internalDiagnostics"]
> & {
  reportExporterHealth: (update: DiagnosticExporterHealthUpdate) => void;
};

export type PluginServicesHandle = {
  reload: (config: OpenClawConfig, serviceIds: ReadonlySet<string>) => Promise<void>;
  stop: (options?: {
    strict: true;
    deadlineAtMs: number;
    pluginIds?: ReadonlySet<string>;
  }) => Promise<void>;
};

type RunningPluginService = {
  owner: RunningPluginService[];
  id: string;
  pluginId: string;
  registration: PluginServiceRegistration;
  registry: PluginRegistry;
  diagnosticsExporter: boolean;
  stop?: () => void | Promise<void>;
  stopping?: Promise<void>;
  startup?: Promise<void>;
  stopRequested: boolean;
  health: NonNullable<OpenClawPluginServiceContext["serviceHealth"]>;
  lease: PluginRuntimeCapabilityLease;
};
const serviceInstances = new WeakMap<
  PluginServicesHandle,
  {
    running: RunningPluginService[];
    pending: Map<PluginServiceRegistration, Promise<void> | undefined>;
  }
>();

export async function startPluginServices(
  params: {
    registry: PluginRegistry;
    config: OpenClawConfig;
    workspaceDir?: string;
    startupTrace?: NonNullable<OpenClawPluginServiceContext["startupTrace"]>;
    broadcastPluginEvent?: GatewayPluginEventBroadcastFn;
    getCronService?: () => PluginServiceCronHost | null | undefined;
    previous?: PluginServicesHandle | null;
  } & (
    | { throwOnStartError: true; onHandle: (handle: PluginServicesHandle) => void }
    | { throwOnStartError?: false; onHandle?: (handle: PluginServicesHandle) => void }
  ),
): Promise<PluginServicesHandle> {
  const running: RunningPluginService[] = [];
  const previous = params.previous && serviceInstances.get(params.previous);
  // Transfer both unissued starts and admitted reloads; only their current owner may restart.
  const pending = new Map(
    params.registry.services.map((entry) => {
      const reloading = previous?.pending.get(entry);
      previous?.pending.delete(entry);
      return [entry, reloading] as const;
    }),
  );
  for (const entry of previous?.running.slice() ?? []) {
    if (pending.has(entry.registration)) {
      if (!pending.get(entry.registration)) {
        pending.delete(entry.registration);
      }
      entry.owner = running;
      running.push(entry);
      previous!.running.splice(previous!.running.indexOf(entry), 1);
    }
  }
  const retained = new Set(running);
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
    entry: (typeof running)[number],
    failures?: unknown[],
    deadline?: number,
  ) => {
    entry.stopRequested = true;
    let stopped = false;
    try {
      if (entry.stop) {
        const record = entry.registry.plugins.find((candidate) => candidate.id === entry.pluginId);
        const registry = record ? getPluginRecordRegistry(entry.registry, record) : entry.registry;
        // Cleanup belongs to the service; each caller owns its wait and deadline.
        // Invoke synchronously so an expired deadline can still observe settled cleanup.
        const cleanup = () => {
          try {
            return (entry.stopping ??= Promise.resolve(
              withPluginHttpRouteRegistry(registry, () => entry.stop?.(), entry.lease),
            ));
          } catch (error) {
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Keep the plugin's original thrown value for all cleanup observers.
            return (entry.stopping = Promise.reject(error));
          }
        };
        await runBeforeDeadline(cleanup, deadline, "plugin service stop");
      }
      stopped = true;
    } catch (err) {
      entry.health.reportFailure(err);
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
      const index = entry.owner.indexOf(entry);
      // Cleanup can settle after handoff; removal follows the current owner.
      // Timed-out stops stay retained so rollback/retry cannot duplicate cleanup.
      if (stopped && index >= 0) {
        entry.owner.splice(index, 1);
      }
    }
  };
  const stopServices = async (
    reversed: RunningPluginService[],
    strict: boolean,
    failures: unknown[],
    deadline?: number,
  ) => {
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
  };
  let closed = false;
  let reloadTail = Promise.resolve();
  const handle: PluginServicesHandle = {
    reload: (config, serviceIds) => {
      const reloading = reloadTail.then(async () => {
        await startupSettled;
        const selected = running.filter((entry) => serviceIds.has(entry.id));
        // Queued reload must not undo an earlier stop of its selected current instances.
        if (closed || selected.some((entry) => entry.stopRequested)) {
          throw new Error("Plugin services are stopping");
        }
        // After admission, stop or handoff consumes pending entries before restart.
        for (const entry of selected) {
          entry.stopRequested = true;
          pending.set(entry.registration, reloading);
        }
        const failures: unknown[] = [];
        try {
          await stopServices(
            selected.toReversed(),
            true,
            failures,
            Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
          );
          if (failures.length > 0) {
            throw new AggregateError(failures, "plugin service reload cleanup failed");
          }
          for (const entry of selected) {
            if (
              pending.delete(entry.registration) &&
              !(await startService(entry.registration, config, failures, true))
            ) {
              throw new AggregateError(failures, "plugin service reload startup failed");
            }
          }
        } finally {
          for (const entry of selected) {
            pending.delete(entry.registration);
          }
        }
      });
      reloadTail = reloading.catch(() => {});
      return reloading;
    },
    stop: (options) => {
      closed ||= options?.pluginIds === undefined;
      for (const entry of pending.keys()) {
        if (!options?.pluginIds || options.pluginIds.has(entry.pluginId)) {
          pending.delete(entry);
        }
      }
      // Capture stop ownership before an unchanged registration can move handles.
      const reversed = running
        .filter((entry) => !options?.pluginIds || options.pluginIds.has(entry.pluginId))
        .toReversed();
      for (const entry of reversed) {
        entry.stopRequested = true;
      }
      const strict = options?.strict === true;
      const deadline = strict ? options.deadlineAtMs : undefined;
      return Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        // Unstarted selected IDs are fenced above; only issued startup can own cleanup.
        try {
          const starting = reversed[0];
          await runBeforeDeadline(
            async () => {
              await Promise.allSettled(reversed.flatMap((entry) => entry.startup ?? []));
            },
            deadline,
            "plugin service startup settlement",
            starting ? `plugin=${starting.pluginId}, service=${starting.id}` : undefined,
          );
        } catch (error) {
          failures.push(error);
          // Startup may resume after replacement timed out; its issued capabilities die now.
          for (const entry of reversed) {
            entry.lease.revoke();
          }
        }
        await stopServices(reversed, strict, failures, deadline);
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
    },
  };
  serviceInstances.set(handle, { running, pending });
  // The issued handle keeps retained services and failed cleanup even when startup rejects.
  params.onHandle?.(handle);

  const startService = async (
    entry: PluginServiceRegistration,
    config: OpenClawConfig,
    failures: unknown[],
    strict = params.throwOnStartError === true,
  ): Promise<boolean> => {
    const service = entry.service;
    const traceName = `sidecars.plugin-services.${encodeStartupTraceSegment(entry.pluginId)}.${encodeStartupTraceSegment(entry.service.id)}`;
    const lease = createPluginRuntimeCapabilityLease("plugin service");
    const pluginId = entry.pluginId;
    const broadcast = params.broadcastPluginEvent;
    // The broadcaster owns delivery and sessions.changed scheduling. Without it,
    // omit this capability so plugins can detect absence and choose their fallback.
    const gatewayEvents: OpenClawPluginServiceContext["gatewayEvents"] = broadcast
      ? {
          emit: (event, payload: PluginJsonValue, opts) => {
            lease.assertActive("gateway event emitter");
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
            broadcast(`plugin.${pluginId}.${event}`, payload, opts.scope);
          },
          onSessionsChanged: (handler) => {
            lease.assertActive("gateway event subscriber");
            return lease.retain(subscribePluginSessionsChanged(handler));
          },
        }
      : undefined;
    const { health, revoke } = createPluginServiceHealthReporter(entry);
    lease.retain(revoke);
    const { startupTrace, workspaceDir } = params;
    const getCron = params.getCronService
      ? createPluginServiceCronGetter({
          getCron: params.getCronService,
          lease,
          isStopping: () => runningService.stopRequested,
        })
      : undefined;
    const isDiagnosticsExporter =
      entry?.pluginId === entry?.service.id &&
      (entry?.service.id === "diagnostics-otel" || entry?.service.id === "diagnostics-prometheus");
    const isOtelExporter = isDiagnosticsExporter && entry.service.id === "diagnostics-otel";
    const grantsInternalDiagnostics =
      isDiagnosticsExporter &&
      (entry?.origin === "bundled" || entry?.trustedOfficialInstall === true);
    const internalDiagnostics: TrustedExporterInternalDiagnostics | undefined =
      grantsInternalDiagnostics
        ? {
            getRuntimeIdentity: () => {
              lease.assertActive("runtime diagnostic identity");
              const buildId = resolveRuntimeServiceBuildId();
              return {
                processInstanceId: getGatewayProcessInstanceId(),
                ...(buildId ? { buildId } : {}),
              };
            },
            emit: (event, privateData) => {
              lease.assertActive("internal diagnostic emitter");
              emitTrustedDiagnosticEventWithPrivateData(event, privateData);
            },
            onEvent: (listener, filter) => {
              lease.assertActive("internal diagnostic listener");
              const trustedListener = isOtelExporter
                ? markTrustedOtelDiagnosticListener(listener)
                : listener;
              return lease.retain(onTrustedInternalDiagnosticEvent(trustedListener, filter));
            },
            registerTracePropagationBridge: (bridge) => {
              lease.assertActive("diagnostic trace propagation bridge");
              return lease.retain(registerDiagnosticTracePropagationBridge(bridge));
            },
            reportExporterHealth: (update) => {
              if (lease.isActive()) {
                recordDiagnosticExporterHealth(entry.service.id, update);
              }
            },
          }
        : undefined;

    const scopeTraceName = (name: string) =>
      `${traceName}.${name.split(".").map(encodeStartupTraceSegment).join(".")}`;
    const serviceContext: OpenClawPluginServiceContext = {
      config,
      workspaceDir,
      stateDir: STATE_DIR,
      logger: {
        info: (msg) => log.info(msg),
        warn: (msg) => log.warn(msg),
        error: (msg) => log.error(msg),
        debug: (msg) => log.debug(msg),
      },
      serviceHealth: health,
      ...(getCron ? { getCron } : {}),
      ...(gatewayEvents ? { gatewayEvents } : {}),
      ...(startupTrace
        ? {
            startupTrace: {
              measure: (name, run) => startupTrace.measure(scopeTraceName(name), run),
              ...(startupTrace.detail
                ? {
                    detail: (name, metrics) => startupTrace.detail?.(scopeTraceName(name), metrics),
                  }
                : {}),
            },
          }
        : {}),
      ...(internalDiagnostics ? { internalDiagnostics } : {}),
    };
    const runningService: RunningPluginService = {
      owner: running,
      id: service.id,
      pluginId: entry.pluginId,
      registration: entry,
      registry: params.registry,
      stopRequested: false,
      diagnosticsExporter: serviceContext.internalDiagnostics !== undefined,
      stop: service.stop
        ? () => runPluginCleanup(service, () => service.stop?.(serviceContext))
        : undefined,
      health,
      lease,
    };
    // Own capabilities before startup yields so a bounded replacement can revoke stale work.
    running.push(runningService);
    try {
      const invokeStart = () =>
        withPluginHttpRouteRegistry(params.registry, () => service.start(serviceContext), lease);
      runningService.startup = runBeforeDeadline(
        () =>
          params.startupTrace ? params.startupTrace.measure(traceName, invokeStart) : invokeStart(),
        strict ? Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS : undefined,
        "plugin service startup",
        `${entry.pluginId}/${service.id}`,
      );
      await runningService.startup;
    } catch (err) {
      failures.push(err);
      serviceContext.serviceHealth?.reportFailure(err);
      const error = err as Error;
      log.error(
        `plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${error?.message ?? String(err)}`,
      );
      // A failed start can already own resources; revoke events only after its cleanup runs.
      // Bound the cleanup: callers await startPluginServices without a timeout, so a hung
      // stop here would wedge plugin reload/startup forever.
      await stopService(
        runningService,
        failures,
        Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
      );
      return false;
    }
    return true;
  };
  let failedCount = 0;
  const failures: unknown[] = [];
  const startupSettled = (async () => {
    for (const [entry, reloading] of pending) {
      if (reloading) {
        try {
          await reloading;
        } catch (error) {
          if (pending.delete(entry)) {
            failures.push(error);
            failedCount += 1;
          }
          continue;
        }
      }
      if (pending.delete(entry) && !(await startService(entry, params.config, failures))) {
        failedCount += 1;
      }
    }
  })();
  await startupSettled;
  params.startupTrace?.detail?.("sidecars.plugin-services.summary", [
    ["serviceCount", params.registry.services.length],
    ["startedCount", running.length],
    ["failedCount", failedCount],
  ]);
  if (params.throwOnStartError && failures.length > 0) {
    for (const entry of running.toReversed()) {
      if (!retained.has(entry)) {
        await stopService(entry, failures, Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
      }
    }
    throw new AggregateError(failures, "plugin services failed to start");
  }
  return handle;
}
