import type { LogRecord, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import type { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import type { DiagnosticEventMetadata, DiagnosticEventPayload } from "../api.js";
import {
  assignOtelLogAttribute,
  assignOtelLogEventAttributes,
  assignOtelSecurityAttributes,
  redactOtelAttributes,
  securitySeverityText,
  shouldCaptureOtelLogBody,
  writeStdoutDiagnosticLogRecord,
} from "./service-attributes.js";
import {
  LOG_RECORD_EXPORT_FAILURE_REPORT_INTERVAL_MS,
  MAX_OTEL_LOG_BODY_CHARS,
} from "./service-constants.js";
import {
  normalizeOtelLogString,
  type OtelContentCapturePolicy,
} from "./service-content-normalization.js";
import { observeOtlpExporterHealth } from "./service-exporter-health.js";
import { errorCategory, formatError } from "./service-exporter.js";
import {
  addTraceAttributes,
  contextForTrustedTraceContext,
  normalizedTrustedTraceContext,
} from "./service-trace-context.js";
import type {
  BuiltOtelLogRecord,
  OtelHttpAgentFactory,
  OtelHttpAgentOptions,
  OtelLogger,
  TelemetryExporterDiagnosticEvent,
} from "./service-types.js";

const LOG_SEVERITY_MAP: Record<string, SeverityNumber> = {
  TRACE: 1 as SeverityNumber,
  DEBUG: 5 as SeverityNumber,
  INFO: 9 as SeverityNumber,
  WARN: 13 as SeverityNumber,
  ERROR: 17 as SeverityNumber,
  FATAL: 21 as SeverityNumber,
};

export function createDiagnosticsLogExporter(params: {
  contentCapturePolicy: OtelContentCapturePolicy;
  emitExporterEvent: (event: Omit<TelemetryExporterDiagnosticEvent, "type" | "seq" | "ts">) => void;
  flushIntervalMs?: number;
  headers?: Record<string, string>;
  logger: OtelLogger;
  logsEnabled: boolean;
  logsToOtlp: boolean;
  logsToStdout: boolean;
  logHttpAgentOptions?: OtelHttpAgentFactory | OtelHttpAgentOptions;
  logUrl?: string;
  resource: Resource;
  serviceName: string;
}) {
  const {
    contentCapturePolicy,
    emitExporterEvent,
    flushIntervalMs,
    headers,
    logger,
    logsEnabled,
    logsToOtlp,
    logsToStdout,
    logHttpAgentOptions,
    logUrl,
    resource,
    serviceName,
  } = params;
  let logProvider: LoggerProvider | null = null;
  const logSeverityMap = LOG_SEVERITY_MAP;
  let recordLogRecord:
    | ((
        evt: Extract<DiagnosticEventPayload, { type: "log.record" }>,
        metadata: DiagnosticEventMetadata,
      ) => void)
    | undefined;
  let recordSecurityEvent:
    | ((
        evt: Extract<DiagnosticEventPayload, { type: "security.event" }>,
        metadata: DiagnosticEventMetadata,
      ) => void)
    | undefined;
  if (logsEnabled) {
    let logRecordExportFailureLastReportedAt = Number.NEGATIVE_INFINITY;
    const failedEmits = new Set<"otlp-http-protobuf" | "stdout" | undefined>();

    let otelLogger: { emit: (logRecord: LogRecord) => void } | undefined;
    if (logsToOtlp) {
      const logExporter = observeOtlpExporterHealth(
        new OTLPLogExporter({
          ...(logUrl ? { url: logUrl } : {}),
          ...(headers ? { headers } : {}),
          ...(logHttpAgentOptions ? { httpAgentOptions: logHttpAgentOptions } : {}),
        }),
        { emitExporterEvent, signal: "logs" },
      );
      const logProcessor = new BatchLogRecordProcessor({
        exporter: logExporter,
        ...(typeof flushIntervalMs === "number"
          ? { scheduledDelayMillis: Math.max(1000, flushIntervalMs) }
          : {}),
      });
      logProvider = new LoggerProvider({
        resource,
        processors: [logProcessor],
      });
      otelLogger = logProvider.getLogger("openclaw");
    }

    const reportLogExportFailure = (
      err: unknown,
      label: "log record" | "security event",
      transport?: "otlp-http-protobuf" | "stdout",
    ) => {
      if (!failedEmits.has(transport)) {
        failedEmits.add(transport);
        emitExporterEvent({
          exporter: "diagnostics-otel",
          signal: "logs",
          ...(transport ? { transport } : {}),
          status: "failure",
          reason: "emit_failed",
          errorCategory: errorCategory(err),
        });
      }
      const now = Date.now();
      if (
        now - logRecordExportFailureLastReportedAt >=
        LOG_RECORD_EXPORT_FAILURE_REPORT_INTERVAL_MS
      ) {
        logRecordExportFailureLastReportedAt = now;
        logger.error(`diagnostics-otel: ${label} export failed: ${formatError(err)}`);
      }
    };
    const reportLogExportRecovery = (transport?: "otlp-http-protobuf" | "stdout") => {
      if (!failedEmits.delete(transport)) {
        return;
      }
      emitExporterEvent({
        exporter: "diagnostics-otel",
        signal: "logs",
        ...(transport ? { transport } : {}),
        status: "recovered",
        reason: "emit_failed",
      });
    };

    const emitLogRecord = (
      { logRecord, traceContext }: BuiltOtelLogRecord,
      label: "log record" | "security event",
    ) => {
      if (logsToOtlp) {
        try {
          otelLogger?.emit(logRecord);
          reportLogExportRecovery("otlp-http-protobuf");
        } catch (error) {
          reportLogExportFailure(error, label, "otlp-http-protobuf");
        }
      }
      if (logsToStdout) {
        try {
          writeStdoutDiagnosticLogRecord({
            logRecord,
            serviceName,
            ...(traceContext ? { traceContext } : {}),
          });
          reportLogExportRecovery("stdout");
        } catch (error) {
          reportLogExportFailure(error, label, "stdout");
        }
      }
    };

    const buildDiagnosticLogRecord = (
      evt: Extract<DiagnosticEventPayload, { type: "log.record" }>,
      metadata: DiagnosticEventMetadata,
    ): BuiltOtelLogRecord => {
      const logLevelName = evt.level || "INFO";
      const severityNumber = logSeverityMap[logLevelName] ?? (9 as SeverityNumber);
      const body = shouldCaptureOtelLogBody(contentCapturePolicy)
        ? normalizeOtelLogString(evt.message || "log", MAX_OTEL_LOG_BODY_CHARS)
        : "log";
      const attributes = Object.create(null) as Record<string, string | number | boolean>;
      assignOtelLogAttribute(attributes, "openclaw.log.level", logLevelName);
      if (evt.loggerName) {
        assignOtelLogAttribute(attributes, "openclaw.logger", evt.loggerName);
      }
      if (evt.loggerParents?.length) {
        assignOtelLogAttribute(attributes, "openclaw.logger.parents", evt.loggerParents.join("."));
      }
      assignOtelLogEventAttributes(attributes, evt.attributes);
      if (evt.code?.line) {
        assignOtelLogAttribute(attributes, "code.lineno", evt.code.line);
      }
      if (evt.code?.functionName) {
        assignOtelLogAttribute(attributes, "code.function", evt.code.functionName);
      }
      const traceContext = normalizedTrustedTraceContext(evt, metadata);
      addTraceAttributes(attributes, traceContext);

      const logRecord: LogRecord = {
        body,
        severityText: logLevelName,
        severityNumber,
        attributes: redactOtelAttributes(attributes),
        timestamp: evt.ts,
      };
      const logContext = contextForTrustedTraceContext(evt, metadata);
      if (logContext) {
        logRecord.context = logContext;
      }
      return { logRecord, ...(traceContext ? { traceContext } : {}) };
    };

    const buildSecurityLogRecord = (
      evt: Extract<DiagnosticEventPayload, { type: "security.event" }>,
      metadata: DiagnosticEventMetadata,
    ): BuiltOtelLogRecord => {
      const severityText = securitySeverityText(evt.severity);
      const attributes = Object.create(null) as Record<string, string | number | boolean>;
      assignOtelSecurityAttributes(attributes, evt);

      const traceContext = normalizedTrustedTraceContext(evt, metadata);
      const logRecord: LogRecord = {
        body: "openclaw.security.event",
        severityText,
        severityNumber: logSeverityMap[severityText] ?? (9 as SeverityNumber),
        attributes: redactOtelAttributes(attributes),
        timestamp: evt.ts,
      };
      const logContext = contextForTrustedTraceContext(evt, metadata);
      if (logContext) {
        logRecord.context = logContext;
      }
      return { logRecord, ...(traceContext ? { traceContext } : {}) };
    };

    recordLogRecord = (evt, metadata) => {
      try {
        const record = buildDiagnosticLogRecord(evt, metadata);
        reportLogExportRecovery();
        emitLogRecord(record, "log record");
      } catch (err) {
        reportLogExportFailure(err, "log record");
      }
    };
    recordSecurityEvent = (evt, metadata) => {
      if (!metadata.trusted) {
        return;
      }
      try {
        const record = buildSecurityLogRecord(evt, metadata);
        reportLogExportRecovery();
        emitLogRecord(record, "security event");
      } catch (err) {
        reportLogExportFailure(err, "security event");
      }
    };
  }
  return { logProvider, recordLogRecord, recordSecurityEvent };
}
