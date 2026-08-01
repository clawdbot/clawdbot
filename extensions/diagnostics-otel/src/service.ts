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
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT_ENV,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_ENV,
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

    currentUnregisterUnhandledRejectionHandler?.();
    currentUnsubscribe?.();
    currentStopActiveTrustedSpans?.();
    if (currentLogProvider) {
      await currentLogProvider.shutdown().catch(() => undefined);
    }
    if (currentSdk) {
      await currentSdk.shutdown().catch(() => undefined);
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
      const logsToOtlp = logsEnabled && (logsExporter === "otlp" || logsExporter === "both");
      const logsToStdout = logsEnabled && (logsExporter === "stdout" || logsExporter === "both");
      const otlpSignals: TelemetryExporterDiagnosticEvent["signal"][] = [
        ...(tracesEnabled ? (["traces"] as const) : []),
        ...(metricsEnabled ? (["metrics"] as const) : []),
        ...(logsToOtlp ? (["logs"] as const) : []),
      ];
      const enabledSignals: TelemetryExporterDiagnosticEvent["signal"][] = [
        ...(tracesEnabled ? (["traces"] as const) : []),
        ...(metricsEnabled ? (["metrics"] as const) : []),
        ...(logsEnabled ? (["logs"] as const) : []),
      ];
      if (enabledSignals.length === 0) {
        return;
      }

      const envProtocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
      const protocol = otel.protocol ?? (envProtocol?.trim() ? envProtocol : "http/protobuf");
      if (otlpSignals.length > 0 && protocol !== "http/protobuf") {
        emitForSignals(otlpSignals, {
          exporter: "diagnostics-otel",
          status: "failure",
          reason: "unsupported_protocol",
        });
        ctx.logger.warn(`diagnostics-otel: unsupported protocol ${protocol}`);
        return;
      }

      const endpoint = normalizeEndpoint(
        otel.endpoint ?? process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV],
      );
      const headers = otel.headers ?? undefined;
      const serviceName =
        otel.serviceName?.trim() || process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME;
      const sampleRate = resolveSampleRate(otel.sampleRate);
      const contentCapturePolicy = resolveContentCapturePolicy(otel.captureContent);
      const sdkPreloaded = hasPreloadedOtelSdk();

      const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
      });

      const logUrl = resolveSignalOtelUrl({
        signalEndpoint: otel.logsEndpoint,
        signalEnvEndpoint: process.env[OTEL_EXPORTER_OTLP_LOGS_ENDPOINT_ENV],
        endpoint,
        path: "v1/logs",
      });
      if (!sdkPreloaded && (tracesEnabled || metricsEnabled)) {
        const traceUrl = resolveSignalOtelUrl({
          signalEndpoint: otel.tracesEndpoint,
          signalEnvEndpoint: process.env[OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_ENV],
          endpoint,
          path: "v1/traces",
        });
        const metricUrl = resolveSignalOtelUrl({
          signalEndpoint: otel.metricsEndpoint,
          signalEnvEndpoint: process.env[OTEL_EXPORTER_OTLP_METRICS_ENDPOINT_ENV],
          endpoint,
          path: "v1/metrics",
        });
        const traceHttpAgentOptions = resolveOtelHttpAgentOptions({
          url: traceUrl,
          signalIdentifier: "TRACES",
          logger: ctx.logger,
        });
        const metricHttpAgentOptions = resolveOtelHttpAgentOptions({
          url: metricUrl,
          signalIdentifier: "METRICS",
          logger: ctx.logger,
        });
        const traceExporter = tracesEnabled
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

        const metricExporter = metricsEnabled
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
          ...(spanProcessors ? { spanProcessors } : traceExporter ? { traceExporter } : {}),
          ...(metricReader ? { metricReader } : {}),
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
              ...(tracesEnabled ? (["traces"] as const) : []),
              ...(metricsEnabled ? (["metrics"] as const) : []),
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
      const diagnosticMetrics = createDiagnosticsMetrics(meter);

      const diagnosticsLogs = createDiagnosticsLogExporter({
        contentCapturePolicy,
        emitExporterEvent,
        flushIntervalMs: otel.flushIntervalMs,
        headers,
        logger: ctx.logger,
        logsEnabled,
        logsToOtlp,
        logsToStdout,
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
        tracesEnabled,
      });
      const recorders = {
        ...createUsageRecorders(recorderRuntime),
        ...createOperationsRecorders(recorderRuntime),
        ...createHarnessRecorders(recorderRuntime),
        ...createModelRecorders(recorderRuntime),
        ...createToolAndSystemRecorders(recorderRuntime),
      };
      const subscribe = ctx.internalDiagnostics?.onEvent;
      if (!subscribe) {
        ctx.logger.error("diagnostics-otel: internal diagnostics capability unavailable");
        return;
      }

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

      emitForSignals(enabledSignals, {
        exporter: "diagnostics-otel",
        status: "started",
        reason: "configured",
      });

      if (logsEnabled) {
        const label =
          logsExporter === "both"
            ? "OTLP/Protobuf + stdout JSONL"
            : logsExporter === "stdout"
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
