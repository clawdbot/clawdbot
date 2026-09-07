// Diagnostics Otel plugin module implements service behavior.
import { createNoopMeter, diag, metrics, trace, type SpanContext } from "@opentelemetry/api";
import * as otelCore from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import * as resources from "@opentelemetry/resources";
import type { LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  BasicTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { registerUnhandledRejectionHandler } from "openclaw/plugin-sdk/runtime-env";
import type { DiagnosticTraceContext, OpenClawPluginService } from "../api.js";
import {
  DEFAULT_SERVICE_NAME,
  OTEL_EXPORTER_OTLP_ENDPOINT_ENV,
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT_ENV,
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL_ENV,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT_ENV,
  OTEL_EXPORTER_OTLP_METRICS_PROTOCOL_ENV,
  OTEL_EXPORTER_OTLP_PROTOCOL_ENV,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_ENV,
  OTEL_EXPORTER_OTLP_TRACES_PROTOCOL_ENV,
} from "./service-constants.js";
import {
  hasPreloadedOtelSdk,
  resolveContentCapturePolicy,
} from "./service-content-normalization.js";
import { createDiagnosticsEventHandler } from "./service-events.js";
import {
  createExporterHealthEventEmitter,
  createPublicExporterHealthEventEmitter,
  observeOtlpExporterHealth,
  type ExporterHealthUpdate,
} from "./service-exporter-health.js";
import {
  errorCategory,
  findOtlpExporterError,
  formatError,
  normalizeEndpoint,
  readErrorCode,
  resolveOtelHttpAgentOptions,
  resolveSampleRate,
  resolveSignalOtelUrl,
} from "./service-exporter.js";
import { createDiagnosticsLogExporter } from "./service-logs.js";
import { createDiagnosticsMetrics } from "./service-metrics.js";
import { registerOwnedSdkRuntime } from "./service-propagation.js";
import { createDiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import { createHarnessRecorders } from "./service-recorders-harness.js";
import { createModelRecorders } from "./service-recorders-model.js";
import { createOperationsRecorders } from "./service-recorders-operations.js";
import { createToolAndSystemRecorders } from "./service-recorders-tools.js";
import { createUsageRecorders } from "./service-recorders-usage.js";
import { createDiagnosticsTraceRuntime } from "./service-traces.js";
import type { OtelLogsExporter, TelemetryExporterDiagnosticEvent } from "./service-types.js";

const OTLP_HTTP_PROTOBUF_PROTOCOL = "http/protobuf";
const RESOURCE_DETECTORS = [
  ["host", resources.hostDetector],
  ["os", resources.osDetector],
  ["serviceinstance", resources.serviceInstanceIdDetector],
  ["process", resources.processDetector],
  ["env", resources.envDetector],
] as const;
type ExporterTransport = "otlp-http-protobuf" | "stdout" | "external-sdk";
type ExporterEndpointMode = "configured" | "default_endpoint";
type ExporterRouteState = Pick<ExporterHealthUpdate, "signal" | "status" | "transport">;
type ExporterHealthReporter = {
  reportExporterHealth?: (update: Omit<ExporterHealthUpdate, "exporter">) => void;
};
type PublicExporterEvent = Omit<TelemetryExporterDiagnosticEvent, "type" | "seq" | "ts">;
const OTEL_SIGNAL_PROTOCOL_ENV = {
  traces: OTEL_EXPORTER_OTLP_TRACES_PROTOCOL_ENV,
  metrics: OTEL_EXPORTER_OTLP_METRICS_PROTOCOL_ENV,
  logs: OTEL_EXPORTER_OTLP_LOGS_PROTOCOL_ENV,
} satisfies Record<TelemetryExporterDiagnosticEvent["signal"], string>;

function isOtelSdkDisabled(logger: { warn(message: string): void }): boolean {
  const value = process.env.OTEL_SDK_DISABLED?.trim().toLowerCase();
  if (!value || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  logger.warn(
    "diagnostics-otel: invalid OTEL_SDK_DISABLED value; expected true or false, using false",
  );
  return false;
}

function readNonblankOtelEnv(name: string): string | undefined {
  const value = process.env[name];
  return value?.trim() ? value : undefined;
}

function readPositiveOtelNumber(name: string, fallback: number): number {
  const value = otelCore.getNumberFromEnv(name);
  if (value !== undefined && value <= 0) {
    diag.warn(`${name} (${value}) is invalid, expected number greater than 0, using default.`);
    return fallback;
  }
  return value ?? fallback;
}

function resolveResourceDetectors(): resources.ResourceDetector[] {
  const names = otelCore.getStringListFromEnv("OTEL_NODE_RESOURCE_DETECTORS");
  if (names === undefined) {
    return [resources.envDetector, resources.processDetector, resources.hostDetector];
  }
  if (names.includes("all")) {
    return RESOURCE_DETECTORS.map(([, detector]) => detector);
  }
  if (names.includes("none")) {
    return [];
  }
  return names.flatMap((name) => {
    const detector = RESOURCE_DETECTORS.find(([candidate]) => candidate === name)?.[1];
    if (!detector) {
      diag.warn(
        `Invalid resource detector "${name}" specified in the environment variable OTEL_NODE_RESOURCE_DETECTORS`,
      );
    }
    return detector ? [detector] : [];
  });
}

function resolveSignalProtocol(
  signal: TelemetryExporterDiagnosticEvent["signal"],
  configuredProtocol: string | undefined,
): string {
  return (
    configuredProtocol ??
    readNonblankOtelEnv(OTEL_SIGNAL_PROTOCOL_ENV[signal]) ??
    readNonblankOtelEnv(OTEL_EXPORTER_OTLP_PROTOCOL_ENV) ??
    OTLP_HTTP_PROTOBUF_PROTOCOL
  );
}

function createStartupRollbackError(startupError: unknown, cleanupError: unknown) {
  return new AggregateError(
    [startupError, cleanupError],
    "diagnostics-otel startup failed and rollback cleanup failed",
    { cause: startupError },
  );
}

function publicExporterEventForHealth(
  event: ExporterHealthUpdate,
): PublicExporterEvent | undefined {
  const base = {
    exporter: event.exporter,
    signal: event.signal,
  };
  if (event.status === "recovered") {
    return undefined;
  }
  if (event.status === "started") {
    return { ...base, status: "started", reason: "configured" };
  }
  if (event.status === "dropped") {
    return { ...base, status: "dropped" };
  }
  const reason = event.reason === "export_failed" ? "emit_failed" : event.reason;
  return {
    ...base,
    status: "failure",
    ...(reason && reason !== "default_endpoint" ? { reason } : {}),
    ...(event.errorCategory ? { errorCategory: event.errorCategory } : {}),
  };
}

function diagnosticTraceContextFromSpanContext(spanContext: SpanContext): DiagnosticTraceContext {
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags.toString(16).padStart(2, "0"),
  };
}

type DiagnosticsOtelState = {
  traceProvider?: BasicTracerProvider;
  meterProvider?: MeterProvider;
  logProvider?: LoggerProvider | null;
  unsubscribe?: (() => void) | null;
  unregisterTracePropagationBridge?: (() => void) | null;
  stopActiveTrustedSpans?: (() => void) | null;
  unregisterOwnedSdkRuntime?: (() => void) | null;
  unregisterUnhandledRejectionHandler?: (() => void) | null;
  retireExporterRoutes?: (preserveFailures?: boolean) => void;
};

export function createDiagnosticsOtelService(): OpenClawPluginService {
  let state: DiagnosticsOtelState = {};
  let preserveExporterRoutesOnNextStop = false;

  const stopStarted = async (options?: { preserveExporterRoutes?: boolean }) => {
    const current = state;
    state = options?.preserveExporterRoutes
      ? { retireExporterRoutes: current.retireExporterRoutes }
      : {};

    const settle = async (...stops: Array<(() => void | Promise<void>) | null | undefined>) =>
      (
        await Promise.allSettled(stops.map((stop) => Promise.resolve().then(() => stop?.())))
      ).flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    // Preserve cleanup -> provider flush -> handler removal while attempting every step per phase.
    const failures = await settle(
      current.unregisterTracePropagationBridge,
      current.unsubscribe,
      current.stopActiveTrustedSpans,
      current.unregisterOwnedSdkRuntime,
    );
    const providerFailures = await settle(
      () => current.logProvider?.shutdown(),
      () => current.traceProvider?.shutdown(),
      () => current.meterProvider?.shutdown(),
    );
    failures.push(...providerFailures);
    if (!options?.preserveExporterRoutes) {
      current.retireExporterRoutes?.(providerFailures.length > 0);
    }
    if (providerFailures.length > 0) {
      // Keep final callback failures visible until the next lifecycle call retires them.
      state.retireExporterRoutes = current.retireExporterRoutes;
    }
    failures.push(...(await settle(current.unregisterUnhandledRejectionHandler)));

    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `diagnostics-otel shutdown failed: ${failures.join("; ")}`,
      );
    }
  };

  return {
    id: "diagnostics-otel",
    reload: { configPrefixes: ["diagnostics.otel", "diagnostics.enabled"] },
    async start(ctx) {
      preserveExporterRoutesOnNextStop = false;
      await stopStarted();
      const active = state;

      const cfg = ctx.config.diagnostics;
      const otel = cfg?.otel;
      if (!cfg || cfg.enabled === false || !otel?.enabled) {
        return;
      }

      const sdkDisabled = isOtelSdkDisabled(ctx.logger);
      const sdkPreloaded = hasPreloadedOtelSdk();
      if (!sdkPreloaded) {
        active.unregisterOwnedSdkRuntime = registerOwnedSdkRuntime((message) =>
          ctx.logger.warn(message),
        );
      }
      if (!sdkPreloaded && sdkDisabled) {
        return;
      }
      const exporterRoutes = new Map<string, ExporterRouteState>();
      const internalDiagnostics = ctx.internalDiagnostics;
      const exporterHealthReporter = internalDiagnostics as unknown as
        | ExporterHealthReporter
        | undefined;
      const emitPublicExporterEvent = createPublicExporterHealthEventEmitter((event) => {
        const publicEvent = publicExporterEventForHealth(event);
        if (!publicEvent) {
          return;
        }
        try {
          internalDiagnostics?.emit({
            type: "telemetry.exporter",
            ...publicEvent,
          });
        } catch {
          // Public lifecycle telemetry is best effort.
        }
      });
      const emitExporterEvent = createExporterHealthEventEmitter((event) => {
        const key = `${event.signal}\u0000${event.transport}`;
        if (event.status === "dropped") {
          exporterRoutes.delete(key);
        } else {
          exporterRoutes.set(key, {
            signal: event.signal,
            status: event.status,
            transport: event.transport,
          });
        }
        try {
          const { exporter: _exporter, ...update } = event;
          exporterHealthReporter?.reportExporterHealth?.(update);
        } catch {
          // Exporter health must never affect the exporter lifecycle.
        }
        emitPublicExporterEvent(event);
      });
      const tracesEnabled = otel.traces !== false;
      const metricsEnabled = otel.metrics !== false;
      const logsEnabled = otel.logs === true && !sdkDisabled;
      const logsExporter: OtelLogsExporter = otel.logsExporter ?? "otlp";
      const logsToOtlpRequested =
        logsEnabled && (logsExporter === "otlp" || logsExporter === "both");
      const logsToStdout = logsEnabled && (logsExporter === "stdout" || logsExporter === "both");
      const configuredSignals: TelemetryExporterDiagnosticEvent["signal"][] = [
        ...(tracesEnabled ? (["traces"] as const) : []),
        ...(metricsEnabled ? (["metrics"] as const) : []),
        ...(logsEnabled ? (["logs"] as const) : []),
      ];
      if (configuredSignals.length === 0) {
        return;
      }
      // This capability is the admission gate; no exporter may outlive a denied start.
      const subscribe = ctx.internalDiagnostics?.onEvent;
      if (!subscribe) {
        ctx.logger.error("diagnostics-otel: internal diagnostics capability unavailable");
        return;
      }

      active.retireExporterRoutes = (preserveFailures = false) => {
        for (const route of exporterRoutes.values()) {
          if (preserveFailures && route.status === "failure") {
            continue;
          }
          emitExporterEvent({
            exporter: "diagnostics-otel",
            signal: route.signal,
            transport: route.transport,
            status: "dropped",
          });
        }
      };
      const ownedOtlpSignals: TelemetryExporterDiagnosticEvent["signal"][] = [
        ...(!sdkPreloaded && tracesEnabled ? (["traces"] as const) : []),
        ...(!sdkPreloaded && metricsEnabled ? (["metrics"] as const) : []),
        ...(logsToOtlpRequested ? (["logs"] as const) : []),
      ];
      const supportedOtlpSignals = new Set<TelemetryExporterDiagnosticEvent["signal"]>();
      for (const signal of ownedOtlpSignals) {
        const protocol = resolveSignalProtocol(signal, otel.protocol);
        if (protocol === OTLP_HTTP_PROTOBUF_PROTOCOL) {
          supportedOtlpSignals.add(signal);
          continue;
        }
        emitExporterEvent({
          signal,
          exporter: "diagnostics-otel",
          transport: "otlp-http-protobuf",
          status: "failure",
          reason: "unsupported_protocol",
        });
        ctx.logger.warn(
          `diagnostics-otel: unsupported ${signal} protocol ${protocol}; OTLP export disabled`,
        );
      }
      const tracesToOtlp = !sdkPreloaded && tracesEnabled && supportedOtlpSignals.has("traces");
      const metricsToOtlp = !sdkPreloaded && metricsEnabled && supportedOtlpSignals.has("metrics");
      const logsToOtlp = logsToOtlpRequested && supportedOtlpSignals.has("logs");
      const tracesActive = sdkPreloaded ? tracesEnabled : tracesToOtlp;
      const metricsActive = sdkPreloaded ? metricsEnabled : metricsToOtlp;
      const logsActive = logsToStdout || logsToOtlp;
      if (!tracesActive && !metricsActive && !logsActive) {
        return;
      }

      const hasOwnedOtlpSignal = ownedOtlpSignals.length > 0;
      const sharedEnvEndpoint = hasOwnedOtlpSignal
        ? process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV]
        : undefined;
      const endpoint = hasOwnedOtlpSignal
        ? normalizeEndpoint(otel.endpoint ?? sharedEnvEndpoint)
        : undefined;
      const headers = otel.headers ?? undefined;
      const serviceName =
        otel.serviceName?.trim() || process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME;
      const sampleRate = resolveSampleRate(otel.sampleRate);
      const contentCapturePolicy = resolveContentCapturePolicy(otel.captureContent);

      const resource = resources.resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
      });

      const logUrl = logsToOtlp
        ? resolveSignalOtelUrl({
            signalEndpoint: otel.logsEndpoint,
            signalEnvEndpoint: process.env[OTEL_EXPORTER_OTLP_LOGS_ENDPOINT_ENV],
            sharedEnvEndpoint,
            endpoint,
            path: "v1/logs",
          })
        : undefined;
      const traceUrl = tracesToOtlp
        ? resolveSignalOtelUrl({
            signalEndpoint: otel.tracesEndpoint,
            signalEnvEndpoint: process.env[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_ENV],
            sharedEnvEndpoint,
            endpoint,
            path: "v1/traces",
          })
        : undefined;
      const metricUrl = metricsToOtlp
        ? resolveSignalOtelUrl({
            signalEndpoint: otel.metricsEndpoint,
            signalEnvEndpoint: process.env[OTEL_EXPORTER_OTLP_METRICS_ENDPOINT_ENV],
            sharedEnvEndpoint,
            endpoint,
            path: "v1/metrics",
          })
        : undefined;
      // Validate every owned signal before any SDK can export with downgraded TLS trust.
      const logHttpAgentOptions = logsToOtlp
        ? resolveOtelHttpAgentOptions({ url: logUrl, signalIdentifier: "LOGS" })
        : undefined;
      const traceHttpAgentOptions = tracesToOtlp
        ? resolveOtelHttpAgentOptions({ url: traceUrl, signalIdentifier: "TRACES" })
        : undefined;
      const metricHttpAgentOptions = metricsToOtlp
        ? resolveOtelHttpAgentOptions({ url: metricUrl, signalIdentifier: "METRICS" })
        : undefined;
      if (tracesToOtlp || metricsToOtlp) {
        try {
          // Trace and metric providers stay generation-private; only context and propagation
          // use owner-checked globals so shutdown cannot strand a later generation.
          const detectedResource = resources
            .detectResources({
              detectors: resolveResourceDetectors(),
            })
            .merge(resource);
          const sdkMetricsEnabled = otelCore.getBooleanFromEnv(
            "OTEL_NODE_EXPERIMENTAL_SDK_METRICS",
          );
          const metricExporter = metricsToOtlp
            ? observeOtlpExporterHealth(
                new OTLPMetricExporter({
                  ...(metricUrl ? { url: metricUrl } : {}),
                  ...(headers ? { headers } : {}),
                  ...(metricHttpAgentOptions ? { httpAgentOptions: metricHttpAgentOptions } : {}),
                }),
                { emitExporterEvent, signal: "metrics" },
              )
            : undefined;
          const metricInterval =
            typeof otel.flushIntervalMs === "number"
              ? Math.max(1000, otel.flushIntervalMs)
              : readPositiveOtelNumber("OTEL_METRIC_EXPORT_INTERVAL", 60_000);
          let metricTimeout = readPositiveOtelNumber("OTEL_METRIC_EXPORT_TIMEOUT", 30_000);
          if (metricTimeout > metricInterval) {
            diag.warn(
              `OTEL_METRIC_EXPORT_TIMEOUT (${metricTimeout}) is greater than the active metric export interval (${metricInterval}). Clamping timeout to interval value.`,
            );
            metricTimeout = metricInterval;
          }
          const metricReader = metricExporter
            ? new PeriodicExportingMetricReader({
                exporter: metricExporter,
                exportIntervalMillis: metricInterval,
                exportTimeoutMillis: metricTimeout,
              })
            : undefined;
          if (metricReader) {
            active.meterProvider = new MeterProvider({
              resource: detectedResource,
              readers: [metricReader],
              sdkMetricsEnabled,
            });
          }
          const traceExporter = tracesToOtlp
            ? observeOtlpExporterHealth(
                new OTLPTraceExporter({
                  ...(traceUrl ? { url: traceUrl } : {}),
                  ...(headers ? { headers } : {}),
                  ...(traceHttpAgentOptions ? { httpAgentOptions: traceHttpAgentOptions } : {}),
                }),
                { emitExporterEvent, signal: "traces" },
              )
            : undefined;
          if (traceExporter) {
            const maxQueueSize = readPositiveOtelNumber("OTEL_BSP_MAX_QUEUE_SIZE", 2048);
            const spanProcessor = new BatchSpanProcessor(traceExporter, {
              maxQueueSize,
              maxExportBatchSize: Math.min(
                readPositiveOtelNumber("OTEL_BSP_MAX_EXPORT_BATCH_SIZE", 512),
                maxQueueSize,
              ),
              scheduledDelayMillis:
                typeof otel.flushIntervalMs === "number"
                  ? Math.max(1000, otel.flushIntervalMs)
                  : readPositiveOtelNumber("OTEL_BSP_SCHEDULE_DELAY", 5000),
              exportTimeoutMillis: readPositiveOtelNumber("OTEL_BSP_EXPORT_TIMEOUT", 30_000),
              ...(sdkMetricsEnabled && active.meterProvider
                ? { selfObsMeterProvider: active.meterProvider }
                : {}),
            });
            active.traceProvider = new BasicTracerProvider({
              resource: detectedResource,
              spanProcessors: [spanProcessor],
              ...(sampleRate !== undefined
                ? {
                    sampler: new ParentBasedSampler({
                      root: new TraceIdRatioBasedSampler(sampleRate),
                    }),
                  }
                : {}),
              ...(sdkMetricsEnabled && active.meterProvider
                ? { meterProvider: active.meterProvider }
                : {}),
            });
          }
        } catch (err) {
          for (const [signal, url] of [
            ...(tracesToOtlp ? ([["traces", traceUrl]] as const) : []),
            ...(metricsToOtlp ? ([["metrics", metricUrl]] as const) : []),
          ]) {
            emitExporterEvent({
              exporter: "diagnostics-otel",
              signal,
              transport: "otlp-http-protobuf",
              endpointMode: url ? "configured" : "default_endpoint",
              status: "failure",
              reason: "start_failed",
              errorCategory: errorCategory(err),
            });
          }
          ctx.logger.error(`diagnostics-otel: failed to start SDK: ${formatError(err)}`);
          // startPluginServices performs one mandatory cleanup call after a rejected start.
          // It belongs to this rollback and must not retire the failure it is reporting.
          preserveExporterRoutesOnNextStop = true;
          try {
            await stopStarted({ preserveExporterRoutes: true });
          } catch (cleanupError) {
            ctx.logger.error(
              `diagnostics-otel: SDK startup rollback cleanup failed: ${formatError(cleanupError)}`,
            );
            throw createStartupRollbackError(err, cleanupError);
          }
          throw err;
        }
      } else if (sdkPreloaded && (tracesEnabled || metricsEnabled)) {
        ctx.logger.info("diagnostics-otel: using preloaded OpenTelemetry SDK");
      }

      const meter = !metricsActive
        ? createNoopMeter()
        : active.meterProvider
          ? active.meterProvider.getMeter("openclaw")
          : metrics.getMeter("openclaw");
      const tracer = active.traceProvider
        ? active.traceProvider.getTracer("openclaw")
        : trace.getTracer("openclaw");
      const diagnosticsTrace = createDiagnosticsTraceRuntime(tracer);
      active.stopActiveTrustedSpans = diagnosticsTrace.stopActiveTrustedSpans;
      const diagnosticMetrics = createDiagnosticsMetrics(meter, otel.metricNamePrefix);

      const diagnosticsLogs = createDiagnosticsLogExporter({
        contentCapturePolicy,
        emitExporterEvent,
        flushIntervalMs: otel.flushIntervalMs,
        headers,
        logger: ctx.logger,
        logsEnabled: logsActive,
        logsToOtlp,
        logsToStdout,
        logHttpAgentOptions,
        logUrl,
        resource,
        serviceName,
      });
      active.logProvider = diagnosticsLogs.logProvider;
      const { recordLogRecord, recordSecurityEvent } = diagnosticsLogs;

      const recorderRuntime = createDiagnosticsRecorderRuntime({
        contentCapturePolicy,
        metrics: diagnosticMetrics,
        traces: diagnosticsTrace,
        tracesEnabled: tracesActive,
      });
      const recorders = {
        ...createUsageRecorders(recorderRuntime),
        ...createOperationsRecorders(recorderRuntime),
        ...createHarnessRecorders(recorderRuntime),
        ...createModelRecorders(recorderRuntime),
        ...createToolAndSystemRecorders(recorderRuntime),
      };

      active.unsubscribe = subscribe(
        createDiagnosticsEventHandler({
          logger: ctx.logger,
          recorders,
          recordLogRecord,
          recordSecurityEvent,
        }),
        metricsActive
          ? undefined
          : tracesActive
            ? { exclude: ["gateway.event_loop.sample", "diagnostic.gc"] }
            : { include: ["log.record", "security.event"] },
      );
      if (tracesActive) {
        // Model/tool starts are queued while their lifecycle parents dispatch
        // synchronously. Prepare these child spans before outbound propagation,
        // then let the queued recorder reuse them instead of exporting duplicates.
        active.unregisterTracePropagationBridge =
          ctx.internalDiagnostics?.registerTracePropagationBridge?.({
            shouldPrepareEvent(event) {
              return event.type === "model.call.started" || event.type === "tool.execution.started";
            },
            prepareEvent(event, metadata) {
              if (event.type === "model.call.started") {
                recorders.recordModelCallStarted(event, metadata);
              } else if (event.type === "tool.execution.started") {
                recorders.recordToolExecutionStarted(event, metadata);
              }
            },
            resolveTraceContext(traceContext) {
              const spanContext =
                diagnosticsTrace.exportedSpanContextForDiagnosticTraceContext(traceContext);
              return spanContext ? diagnosticTraceContextFromSpanContext(spanContext) : undefined;
            },
          }) ?? null;
      }

      // Preserve the shipped preloaded-SDK crash guard, but own no handler while disabled.
      if (hasOwnedOtlpSignal || (sdkPreloaded && !sdkDisabled)) {
        active.unregisterUnhandledRejectionHandler = registerUnhandledRejectionHandler((reason) => {
          const otlpError = findOtlpExporterError(reason);
          if (!otlpError) {
            return false;
          }
          const code = readErrorCode(otlpError) ?? "unknown";
          ctx.logger.warn(
            `diagnostics-otel: suppressed OTLP exporter unhandled rejection (code=${String(code)})`,
          );
          return true;
        });
      }

      const emitStarted = (
        signal: TelemetryExporterDiagnosticEvent["signal"],
        transport: ExporterTransport,
        endpointMode?: ExporterEndpointMode,
      ) => {
        emitExporterEvent({
          exporter: "diagnostics-otel",
          signal,
          transport,
          ...(endpointMode ? { endpointMode } : {}),
          status: "started",
          reason: endpointMode ?? "configured",
        });
      };
      if (sdkPreloaded && tracesEnabled) {
        emitStarted("traces", "external-sdk");
      } else if (tracesToOtlp) {
        emitStarted("traces", "otlp-http-protobuf", traceUrl ? "configured" : "default_endpoint");
      }
      if (sdkPreloaded && metricsEnabled) {
        emitStarted("metrics", "external-sdk");
      } else if (metricsToOtlp) {
        emitStarted("metrics", "otlp-http-protobuf", metricUrl ? "configured" : "default_endpoint");
      }
      if (logsToOtlp) {
        emitStarted("logs", "otlp-http-protobuf", logUrl ? "configured" : "default_endpoint");
      }
      if (logsToStdout) {
        emitStarted("logs", "stdout");
      }

      if (logsActive) {
        const label =
          logsToOtlp && logsToStdout
            ? "OTLP/Protobuf + stdout JSONL"
            : logsToStdout
              ? "stdout JSONL"
              : "OTLP/Protobuf";
        ctx.logger.info(`diagnostics-otel: logs exporter enabled (${label})`);
      }
    },
    async stop() {
      const preserveExporterRoutes = preserveExporterRoutesOnNextStop;
      preserveExporterRoutesOnNextStop = false;
      await stopStarted(preserveExporterRoutes ? { preserveExporterRoutes: true } : undefined);
    },
  } satisfies OpenClawPluginService;
}
