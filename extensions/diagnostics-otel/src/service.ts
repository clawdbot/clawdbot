// Diagnostics Otel plugin module implements service behavior.
import { metrics, trace } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { LoggerProvider } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { registerUnhandledRejectionHandler } from "openclaw/plugin-sdk/runtime-env";
import type { OpenClawPluginService } from "../api.js";
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
import { createDiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import { createHarnessRecorders } from "./service-recorders-harness.js";
import { createModelRecorders } from "./service-recorders-model.js";
import { createOperationsRecorders } from "./service-recorders-operations.js";
import { createToolAndSystemRecorders } from "./service-recorders-tools.js";
import { createUsageRecorders } from "./service-recorders-usage.js";
import { createDiagnosticsTraceRuntime } from "./service-traces.js";
import type { OtelLogsExporter, TelemetryExporterDiagnosticEvent } from "./service-types.js";

const OTLP_HTTP_PROTOBUF_PROTOCOL = "http/protobuf";
const OTEL_SIGNAL_PROTOCOL_ENV = {
  traces: OTEL_EXPORTER_OTLP_TRACES_PROTOCOL_ENV,
  metrics: OTEL_EXPORTER_OTLP_METRICS_PROTOCOL_ENV,
  logs: OTEL_EXPORTER_OTLP_LOGS_PROTOCOL_ENV,
} satisfies Record<TelemetryExporterDiagnosticEvent["signal"], string>;

function readNonblankOtelEnv(name: string): string | undefined {
  const value = process.env[name];
  return value?.trim() ? value : undefined;
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

export function createDiagnosticsOtelService(): OpenClawPluginService {
  let sdk: NodeSDK | null = null;
  let logProvider: LoggerProvider | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopActiveTrustedSpans: (() => void) | null = null;
  let unregisterUnhandledRejectionHandler: (() => void) | null = null;

  const stopStarted = async () => {
    const currentUnsubscribe = unsubscribe;
    const currentLogProvider = logProvider;
    const currentSdk = sdk;
    const currentStopActiveTrustedSpans = stopActiveTrustedSpans;
    const currentUnregisterUnhandledRejectionHandler = unregisterUnhandledRejectionHandler;

    unsubscribe = null;
    logProvider = null;
    sdk = null;
    stopActiveTrustedSpans = null;
    unregisterUnhandledRejectionHandler = null;

    const settle = async (...stops: Array<(() => void | Promise<void>) | null>) =>
      (
        await Promise.allSettled(stops.map((stop) => Promise.resolve().then(() => stop?.())))
      ).flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    // Preserve cleanup -> provider flush -> handler removal while attempting every step per phase.
    const failures = await settle(currentUnsubscribe, currentStopActiveTrustedSpans);
    failures.push(
      ...(await settle(
        currentLogProvider ? () => currentLogProvider.shutdown() : null,
        currentSdk ? () => currentSdk.shutdown() : null,
      )),
      ...(await settle(currentUnregisterUnhandledRejectionHandler)),
    );

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
    async start(ctx) {
      await stopStarted();

      const cfg = ctx.config.diagnostics;
      const otel = cfg?.otel;
      if (!cfg || cfg.enabled === false || !otel?.enabled) {
        return;
      }

      const emitExporterEvent = (
        event: Omit<TelemetryExporterDiagnosticEvent, "type" | "seq" | "ts">,
      ) => {
        try {
          ctx.internalDiagnostics?.emit({
            type: "telemetry.exporter",
            ...event,
          });
        } catch {
          // Exporter health must never affect the exporter lifecycle.
        }
      };
      const emitForSignals = (
        signals: TelemetryExporterDiagnosticEvent["signal"][],
        event: Omit<TelemetryExporterDiagnosticEvent, "type" | "seq" | "ts" | "signal">,
      ) => {
        for (const signal of signals) {
          emitExporterEvent({ signal, ...event });
        }
      };
      const tracesEnabled = otel.traces !== false;
      const metricsEnabled = otel.metrics !== false;
      const logsEnabled = otel.logs === true;
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

      const sdkPreloaded = hasPreloadedOtelSdk();
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
      const startedSignals: TelemetryExporterDiagnosticEvent["signal"][] = [
        ...(tracesActive ? (["traces"] as const) : []),
        ...(metricsActive ? (["metrics"] as const) : []),
        ...(logsActive ? (["logs"] as const) : []),
      ];
      if (startedSignals.length === 0) {
        return;
      }

      const sharedEnvEndpoint = process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV];
      const endpoint = normalizeEndpoint(otel.endpoint ?? sharedEnvEndpoint);
      const headers = otel.headers ?? undefined;
      const serviceName =
        otel.serviceName?.trim() || process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME;
      const sampleRate = resolveSampleRate(otel.sampleRate);
      const contentCapturePolicy = resolveContentCapturePolicy(otel.captureContent);

      const resource = resourceFromAttributes({
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
        const traceExporter = tracesToOtlp
          ? new OTLPTraceExporter({
              ...(traceUrl ? { url: traceUrl } : {}),
              ...(headers ? { headers } : {}),
              ...(traceHttpAgentOptions ? { httpAgentOptions: traceHttpAgentOptions } : {}),
            })
          : undefined;
        const spanProcessors =
          traceExporter && typeof otel.flushIntervalMs === "number"
            ? [
                new BatchSpanProcessor(traceExporter, {
                  scheduledDelayMillis: Math.max(1000, otel.flushIntervalMs),
                }),
              ]
            : undefined;

        const metricExporter = metricsToOtlp
          ? new OTLPMetricExporter({
              ...(metricUrl ? { url: metricUrl } : {}),
              ...(headers ? { headers } : {}),
              ...(metricHttpAgentOptions ? { httpAgentOptions: metricHttpAgentOptions } : {}),
            })
          : undefined;

        const metricReader = metricExporter
          ? new PeriodicExportingMetricReader({
              exporter: metricExporter,
              ...(typeof otel.flushIntervalMs === "number"
                ? { exportIntervalMillis: Math.max(1000, otel.flushIntervalMs) }
                : {}),
            })
          : undefined;

        sdk = new NodeSDK({
          resource,
          // Empty arrays are required in mixed-signal cases too; omission lets NodeSDK
          // restore a protocol-rejected exporter from ambient OTEL_* settings.
          ...(spanProcessors
            ? { spanProcessors }
            : traceExporter
              ? { traceExporter }
              : { spanProcessors: [] }),
          metricReaders: metricReader ? [metricReader] : [],
          logRecordProcessors: [],
          ...(sampleRate !== undefined
            ? {
                sampler: new ParentBasedSampler({
                  root: new TraceIdRatioBasedSampler(sampleRate),
                }),
              }
            : {}),
        });

        try {
          sdk.start();
        } catch (err) {
          emitForSignals(
            [
              ...(tracesToOtlp ? (["traces"] as const) : []),
              ...(metricsToOtlp ? (["metrics"] as const) : []),
            ],
            {
              exporter: "diagnostics-otel",
              status: "failure",
              reason: "start_failed",
              errorCategory: errorCategory(err),
            },
          );
          await stopStarted();
          ctx.logger.error(`diagnostics-otel: failed to start SDK: ${formatError(err)}`);
          throw err;
        }
      } else if (sdkPreloaded && (tracesEnabled || metricsEnabled)) {
        ctx.logger.info("diagnostics-otel: using preloaded OpenTelemetry SDK");
      }

      const meter = metrics.getMeter("openclaw");
      const tracer = trace.getTracer("openclaw");
      const diagnosticsTrace = createDiagnosticsTraceRuntime(tracer);
      stopActiveTrustedSpans = diagnosticsTrace.stopActiveTrustedSpans;
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
      logProvider = diagnosticsLogs.logProvider;
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

      unsubscribe = subscribe(
        createDiagnosticsEventHandler({
          logger: ctx.logger,
          recorders,
          recordLogRecord,
          recordSecurityEvent,
        }),
      );

      unregisterUnhandledRejectionHandler = registerUnhandledRejectionHandler((reason) => {
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

      emitForSignals(startedSignals, {
        exporter: "diagnostics-otel",
        status: "started",
        reason: "configured",
      });

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
      await stopStarted();
    },
  } satisfies OpenClawPluginService;
}
