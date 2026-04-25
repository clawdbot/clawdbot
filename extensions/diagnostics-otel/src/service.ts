import {
  context as otelContextApi,
  metrics,
  trace,
  SpanStatusCode,
  TraceFlags,
} from "@opentelemetry/api";
import type { LogRecord, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type {
  DiagnosticEventPayload,
  DiagnosticTraceContext,
  OpenClawPluginService,
} from "../api.js";
import {
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  onInternalDiagnosticEvent,
  redactSensitiveText,
} from "../api.js";

const DEFAULT_SERVICE_NAME = "openclaw";
const DROPPED_OTEL_ATTRIBUTE_KEYS = new Set([
  "openclaw.callId",
  "openclaw.parentSpanId",
  "openclaw.runId",
  "openclaw.sessionId",
  "openclaw.sessionKey",
  "openclaw.spanId",
  "openclaw.toolCallId",
  "openclaw.traceId",
]);
const LOW_CARDINALITY_VALUE_RE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const MAX_OTEL_CONTENT_ATTRIBUTE_CHARS = 4 * 1024;
const MAX_OTEL_CONTENT_ARRAY_ITEMS = 16;
const MAX_OTEL_LOG_BODY_CHARS = 4 * 1024;
const MAX_OTEL_LOG_ATTRIBUTE_COUNT = 64;
const MAX_OTEL_LOG_ATTRIBUTE_VALUE_CHARS = 4 * 1024;
const LOG_RECORD_EXPORT_FAILURE_REPORT_INTERVAL_MS = 60_000;
const OTEL_LOG_RAW_ATTRIBUTE_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/u;
const OTEL_LOG_ATTRIBUTE_KEY_RE = /^[A-Za-z0-9_.:-]{1,96}$/u;
const BLOCKED_OTEL_LOG_ATTRIBUTE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PRELOADED_OTEL_SDK_ENV = "OPENCLAW_OTEL_PRELOADED";

type OtelContentCapturePolicy = {
  inputMessages: boolean;
  outputMessages: boolean;
  toolInputs: boolean;
  toolOutputs: boolean;
  systemPrompt: boolean;
};

type MessageDeliveryDiagnosticEvent = Extract<
  DiagnosticEventPayload,
  {
    type: "message.delivery.started" | "message.delivery.completed" | "message.delivery.error";
  }
>;

const NO_CONTENT_CAPTURE: OtelContentCapturePolicy = {
  inputMessages: false,
  outputMessages: false,
  toolInputs: false,
  toolOutputs: false,
  systemPrompt: false,
};

function normalizeEndpoint(endpoint?: string): string | undefined {
  const trimmed = endpoint?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

function resolveOtelUrl(endpoint: string | undefined, path: string): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  const endpointWithoutQueryOrFragment = endpoint.split(/[?#]/, 1)[0] ?? endpoint;
  if (/\/v1\/(?:traces|metrics|logs)$/i.test(endpointWithoutQueryOrFragment)) {
    return endpoint;
  }
  return `${endpoint}/${path}`;
}

function resolveSampleRate(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function redactOtelAttributes(attributes: Record<string, string | number | boolean>) {
  const redactedAttributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (DROPPED_OTEL_ATTRIBUTE_KEYS.has(key)) {
      continue;
    }
    redactedAttributes[key] = typeof value === "string" ? redactSensitiveText(value) : value;
  }
  return redactedAttributes;
}

function lowCardinalityAttr(value: string | undefined, fallback = "unknown"): string {
  if (!value) {
    return fallback;
  }
  const redacted = redactSensitiveText(value.trim());
  return LOW_CARDINALITY_VALUE_RE.test(redacted) ? redacted : fallback;
}

function genAiOperationName(api: string | undefined): "chat" | "text_completion" {
  return api === "completions" ? "text_completion" : "chat";
}

function clampOtelLogText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...(truncated)` : value;
}

function normalizeOtelLogString(value: string, maxChars: number): string {
  return clampOtelLogText(redactSensitiveText(value), maxChars);
}

function resolveContentCapturePolicy(value: unknown): OtelContentCapturePolicy {
  if (value === true) {
    return {
      inputMessages: true,
      outputMessages: true,
      toolInputs: true,
      toolOutputs: true,
      systemPrompt: false,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return NO_CONTENT_CAPTURE;
  }

  const config = value as Record<string, unknown>;
  if (config.enabled !== true) {
    return NO_CONTENT_CAPTURE;
  }
  return {
    inputMessages: config.inputMessages === true,
    outputMessages: config.outputMessages === true,
    toolInputs: config.toolInputs === true,
    toolOutputs: config.toolOutputs === true,
    systemPrompt: config.systemPrompt === true,
  };
}

function hasPreloadedOtelSdk(): boolean {
  return process.env[PRELOADED_OTEL_SDK_ENV] === "1";
}

function normalizeOtelContentValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOtelLogString(value, MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value.slice(0, MAX_OTEL_CONTENT_ARRAY_ITEMS)) {
      if (typeof item === "string") {
        items.push(item);
      }
    }
    if (items.length > 0) {
      return normalizeOtelLogString(items.join("\n"), MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
    }
  }
  return undefined;
}

function assignOtelContentAttribute(
  attributes: Record<string, string | number | boolean>,
  key: string,
  value: unknown,
): void {
  const normalized = normalizeOtelContentValue(value);
  if (normalized) {
    attributes[key] = normalized;
  }
}

function assignOtelModelContentAttributes(
  attributes: Record<string, string | number | boolean>,
  event: Record<string, unknown>,
  policy: OtelContentCapturePolicy,
): void {
  if (policy.inputMessages) {
    assignOtelContentAttribute(attributes, "openclaw.content.input_messages", event.inputMessages);
  }
  if (policy.outputMessages) {
    assignOtelContentAttribute(
      attributes,
      "openclaw.content.output_messages",
      event.outputMessages,
    );
  }
  if (policy.systemPrompt) {
    assignOtelContentAttribute(attributes, "openclaw.content.system_prompt", event.systemPrompt);
  }
}

function assignOtelToolContentAttributes(
  attributes: Record<string, string | number | boolean>,
  event: Record<string, unknown>,
  policy: OtelContentCapturePolicy,
): void {
  if (policy.toolInputs) {
    assignOtelContentAttribute(attributes, "openclaw.content.tool_input", event.toolInput);
  }
  if (policy.toolOutputs) {
    assignOtelContentAttribute(attributes, "openclaw.content.tool_output", event.toolOutput);
  }
}

function assignOtelLogAttribute(
  attributes: Record<string, string | number | boolean>,
  key: string,
  value: string | number | boolean,
): void {
  if (Object.keys(attributes).length >= MAX_OTEL_LOG_ATTRIBUTE_COUNT) {
    return;
  }
  if (BLOCKED_OTEL_LOG_ATTRIBUTE_KEYS.has(key)) {
    return;
  }
  if (redactSensitiveText(key) !== key) {
    return;
  }
  if (!OTEL_LOG_ATTRIBUTE_KEY_RE.test(key)) {
    return;
  }
  if (typeof value === "string") {
    attributes[key] = normalizeOtelLogString(value, MAX_OTEL_LOG_ATTRIBUTE_VALUE_CHARS);
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    attributes[key] = value;
    return;
  }
  if (typeof value === "boolean") {
    attributes[key] = value;
  }
}

function normalizeTraceContext(value: unknown): DiagnosticTraceContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<DiagnosticTraceContext>;
  if (!isValidDiagnosticTraceId(candidate.traceId)) {
    return undefined;
  }
  if (candidate.spanId !== undefined && !isValidDiagnosticSpanId(candidate.spanId)) {
    return undefined;
  }
  if (candidate.parentSpanId !== undefined && !isValidDiagnosticSpanId(candidate.parentSpanId)) {
    return undefined;
  }
  if (candidate.traceFlags !== undefined && !isValidDiagnosticTraceFlags(candidate.traceFlags)) {
    return undefined;
  }
  return {
    traceId: candidate.traceId,
    ...(candidate.spanId ? { spanId: candidate.spanId } : {}),
    ...(candidate.parentSpanId ? { parentSpanId: candidate.parentSpanId } : {}),
    ...(candidate.traceFlags ? { traceFlags: candidate.traceFlags } : {}),
  };
}

function assignOtelLogEventAttributes(
  attributes: Record<string, string | number | boolean>,
  eventAttributes: Record<string, string | number | boolean> | undefined,
): void {
  if (!eventAttributes) {
    return;
  }
  for (const rawKey in eventAttributes) {
    if (Object.keys(attributes).length >= MAX_OTEL_LOG_ATTRIBUTE_COUNT) {
      break;
    }
    if (!Object.hasOwn(eventAttributes, rawKey)) {
      continue;
    }
    const key = rawKey.trim();
    if (BLOCKED_OTEL_LOG_ATTRIBUTE_KEYS.has(key)) {
      continue;
    }
    if (redactSensitiveText(key) !== key) {
      continue;
    }
    if (!OTEL_LOG_RAW_ATTRIBUTE_KEY_RE.test(key)) {
      continue;
    }
    assignOtelLogAttribute(attributes, `openclaw.${key}`, eventAttributes[rawKey]);
  }
}

function traceFlagsToOtel(traceFlags: string | undefined): TraceFlags {
  const parsed = Number.parseInt(traceFlags ?? "00", 16);
  return (parsed & TraceFlags.SAMPLED) !== 0 ? TraceFlags.SAMPLED : TraceFlags.NONE;
}

function contextForTraceContext(traceContext: DiagnosticTraceContext | undefined) {
  const normalized = normalizeTraceContext(traceContext);
  if (!normalized?.spanId) {
    return undefined;
  }
  return trace.setSpanContext(otelContextApi.active(), {
    traceId: normalized.traceId,
    spanId: normalized.spanId,
    traceFlags: traceFlagsToOtel(normalized.traceFlags),
    isRemote: true,
  });
}

function addTraceAttributes(
  attributes: Record<string, string | number | boolean>,
  traceContext: DiagnosticTraceContext | undefined,
): void {
  const normalized = normalizeTraceContext(traceContext);
  if (!normalized) {
    return;
  }
  attributes["openclaw.traceId"] = normalized.traceId;
  if (normalized.spanId) {
    attributes["openclaw.spanId"] = normalized.spanId;
  }
  if (normalized.parentSpanId) {
    attributes["openclaw.parentSpanId"] = normalized.parentSpanId;
  }
  if (normalized.traceFlags) {
    attributes["openclaw.traceFlags"] = normalized.traceFlags;
  }
}

export function createDiagnosticsOtelService(): OpenClawPluginService {
  let sdk: NodeSDK | null = null;
  let logProvider: LoggerProvider | null = null;
  let unsubscribe: (() => void) | null = null;

  const stopStarted = async () => {
    const currentUnsubscribe = unsubscribe;
    const currentLogProvider = logProvider;
    const currentSdk = sdk;

    unsubscribe = null;
    logProvider = null;
    sdk = null;

    currentUnsubscribe?.();
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
      if (!cfg?.enabled || !otel?.enabled) {
        return;
      }

      const protocol = otel.protocol ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf";
      if (protocol !== "http/protobuf") {
        ctx.logger.warn(`diagnostics-otel: unsupported protocol ${protocol}`);
        return;
      }

      const endpoint = normalizeEndpoint(otel.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
      const headers = otel.headers ?? undefined;
      const serviceName =
        otel.serviceName?.trim() || process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME;
      const sampleRate = resolveSampleRate(otel.sampleRate);
      const contentCapturePolicy = resolveContentCapturePolicy(otel.captureContent);

      const tracesEnabled = otel.traces !== false;
      const metricsEnabled = otel.metrics !== false;
      const logsEnabled = otel.logs === true;
      if (!tracesEnabled && !metricsEnabled && !logsEnabled) {
        return;
      }
      const sdkPreloaded = hasPreloadedOtelSdk();

      const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
      });

      const logUrl = resolveOtelUrl(endpoint, "v1/logs");
      if (!sdkPreloaded && (tracesEnabled || metricsEnabled)) {
        const traceUrl = resolveOtelUrl(endpoint, "v1/traces");
        const metricUrl = resolveOtelUrl(endpoint, "v1/metrics");
        const traceExporter = tracesEnabled
          ? new OTLPTraceExporter({
              ...(traceUrl ? { url: traceUrl } : {}),
              ...(headers ? { headers } : {}),
            })
          : undefined;

        const metricExporter = metricsEnabled
          ? new OTLPMetricExporter({
              ...(metricUrl ? { url: metricUrl } : {}),
              ...(headers ? { headers } : {}),
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
          ...(traceExporter ? { traceExporter } : {}),
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
          await stopStarted();
          ctx.logger.error(`diagnostics-otel: failed to start SDK: ${formatError(err)}`);
          throw err;
        }
      } else if (sdkPreloaded && (tracesEnabled || metricsEnabled)) {
        ctx.logger.info("diagnostics-otel: using preloaded OpenTelemetry SDK");
      }

      const logSeverityMap: Record<string, SeverityNumber> = {
        TRACE: 1 as SeverityNumber,
        DEBUG: 5 as SeverityNumber,
        INFO: 9 as SeverityNumber,
        WARN: 13 as SeverityNumber,
        ERROR: 17 as SeverityNumber,
        FATAL: 21 as SeverityNumber,
      };

      const meter = metrics.getMeter("openclaw");
      const tracer = trace.getTracer("openclaw");

      const tokensCounter = meter.createCounter("openclaw.tokens", {
        unit: "1",
        description: "Token usage by type",
      });
      const costCounter = meter.createCounter("openclaw.cost.usd", {
        unit: "1",
        description: "Estimated model cost (USD)",
      });
      const durationHistogram = meter.createHistogram("openclaw.run.duration_ms", {
        unit: "ms",
        description: "Agent run duration",
      });
      const contextHistogram = meter.createHistogram("openclaw.context.tokens", {
        unit: "1",
        description: "Context window size and usage",
      });
      const webhookReceivedCounter = meter.createCounter("openclaw.webhook.received", {
        unit: "1",
        description: "Webhook requests received",
      });
      const webhookErrorCounter = meter.createCounter("openclaw.webhook.error", {
        unit: "1",
        description: "Webhook processing errors",
      });
      const webhookDurationHistogram = meter.createHistogram("openclaw.webhook.duration_ms", {
        unit: "ms",
        description: "Webhook processing duration",
      });
      const messageQueuedCounter = meter.createCounter("openclaw.message.queued", {
        unit: "1",
        description: "Messages queued for processing",
      });
      const messageProcessedCounter = meter.createCounter("openclaw.message.processed", {
        unit: "1",
        description: "Messages processed by outcome",
      });
      const messageDurationHistogram = meter.createHistogram("openclaw.message.duration_ms", {
        unit: "ms",
        description: "Message processing duration",
      });
      const messageDeliveryStartedCounter = meter.createCounter(
        "openclaw.message.delivery.started",
        {
          unit: "1",
          description: "Outbound message delivery attempts started",
        },
      );
      const messageDeliveryDurationHistogram = meter.createHistogram(
        "openclaw.message.delivery.duration_ms",
        {
          unit: "ms",
          description: "Outbound message delivery duration",
        },
      );
      const queueDepthHistogram = meter.createHistogram("openclaw.queue.depth", {
        unit: "1",
        description: "Queue depth on enqueue/dequeue",
      });
      const queueWaitHistogram = meter.createHistogram("openclaw.queue.wait_ms", {
        unit: "ms",
        description: "Queue wait time before execution",
      });
      const laneEnqueueCounter = meter.createCounter("openclaw.queue.lane.enqueue", {
        unit: "1",
        description: "Command queue lane enqueue events",
      });
      const laneDequeueCounter = meter.createCounter("openclaw.queue.lane.dequeue", {
        unit: "1",
        description: "Command queue lane dequeue events",
      });
      const sessionStateCounter = meter.createCounter("openclaw.session.state", {
        unit: "1",
        description: "Session state transitions",
      });
      const sessionStuckCounter = meter.createCounter("openclaw.session.stuck", {
        unit: "1",
        description: "Sessions stuck in processing",
      });
      const sessionStuckAgeHistogram = meter.createHistogram("openclaw.session.stuck_age_ms", {
        unit: "ms",
        description: "Age of stuck sessions",
      });
      const runAttemptCounter = meter.createCounter("openclaw.run.attempt", {
        unit: "1",
        description: "Run attempts",
      });
      const modelCallDurationHistogram = meter.createHistogram("openclaw.model_call.duration_ms", {
        unit: "ms",
        description: "Model call duration",
      });
      const toolExecutionDurationHistogram = meter.createHistogram(
        "openclaw.tool.execution.duration_ms",
        {
          unit: "ms",
          description: "Tool execution duration",
        },
      );
      const execProcessDurationHistogram = meter.createHistogram("openclaw.exec.duration_ms", {
        unit: "ms",
        description: "Exec process duration",
      });

      let recordLogRecord:
        | ((evt: Extract<DiagnosticEventPayload, { type: "log.record" }>) => void)
        | undefined;
      if (logsEnabled) {
        let logRecordExportFailureLastReportedAt = Number.NEGATIVE_INFINITY;
        const logExporter = new OTLPLogExporter({
          ...(logUrl ? { url: logUrl } : {}),
          ...(headers ? { headers } : {}),
        });
        const logProcessor = new BatchLogRecordProcessor(
          logExporter,
          typeof otel.flushIntervalMs === "number"
            ? { scheduledDelayMillis: Math.max(1000, otel.flushIntervalMs) }
            : {},
        );
        logProvider = new LoggerProvider({
          resource,
          processors: [logProcessor],
        });
        const otelLogger = logProvider.getLogger("openclaw");
        recordLogRecord = (evt) => {
          try {
            const logLevelName = evt.level || "INFO";
            const severityNumber = logSeverityMap[logLevelName] ?? (9 as SeverityNumber);
            const attributes = Object.create(null) as Record<string, string | number | boolean>;
            assignOtelLogAttribute(attributes, "openclaw.log.level", logLevelName);
            if (evt.loggerName) {
              assignOtelLogAttribute(attributes, "openclaw.logger", evt.loggerName);
            }
            if (evt.loggerParents?.length) {
              assignOtelLogAttribute(
                attributes,
                "openclaw.logger.parents",
                evt.loggerParents.join("."),
              );
            }
            assignOtelLogEventAttributes(attributes, evt.attributes);
            if (evt.code?.line) {
              assignOtelLogAttribute(attributes, "code.lineno", evt.code.line);
            }
            if (evt.code?.functionName) {
              assignOtelLogAttribute(attributes, "code.function", evt.code.functionName);
            }
            addTraceAttributes(attributes, evt.trace);

            const logRecord: LogRecord = {
              body: normalizeOtelLogString(evt.message || "log", MAX_OTEL_LOG_BODY_CHARS),
              severityText: logLevelName,
              severityNumber,
              attributes: redactOtelAttributes(attributes),
              timestamp: evt.ts,
            };
            const logContext = contextForTraceContext(evt.trace);
            if (logContext) {
              logRecord.context = logContext;
            }
            otelLogger.emit(logRecord);
          } catch (err) {
            const now = Date.now();
            if (
              now - logRecordExportFailureLastReportedAt >=
              LOG_RECORD_EXPORT_FAILURE_REPORT_INTERVAL_MS
            ) {
              logRecordExportFailureLastReportedAt = now;
              ctx.logger.error(`diagnostics-otel: log record export failed: ${formatError(err)}`);
            }
          }
        };
      }

      const spanWithDuration = (
        name: string,
        attributes: Record<string, string | number | boolean>,
        durationMs?: number,
        options: {
          parentContext?: ReturnType<typeof contextForTraceContext> | null;
          endTimeMs?: number;
        } = {},
      ) => {
        const endTimeMs = options.endTimeMs ?? Date.now();
        const startTime =
          typeof durationMs === "number" ? endTimeMs - Math.max(0, durationMs) : undefined;
        const parentContext =
          "parentContext" in options ? (options.parentContext ?? undefined) : undefined;
        const span = tracer.startSpan(
          name,
          {
            attributes: redactOtelAttributes(attributes),
            ...(startTime !== undefined ? { startTime } : {}),
          },
          parentContext,
        );
        return span;
      };

      const addRunAttrs = (
        spanAttrs: Record<string, string | number | boolean>,
        evt: {
          runId?: string;
          sessionKey?: string;
          sessionId?: string;
          provider?: string;
          model?: string;
          channel?: string;
          trigger?: string;
        },
      ) => {
        if (evt.provider) {
          spanAttrs["openclaw.provider"] = evt.provider;
        }
        if (evt.model) {
          spanAttrs["openclaw.model"] = evt.model;
        }
        if (evt.channel) {
          spanAttrs["openclaw.channel"] = evt.channel;
        }
        if (evt.trigger) {
          spanAttrs["openclaw.trigger"] = evt.trigger;
        }
      };

      const paramsSummaryAttrs = (
        summary: Extract<
          DiagnosticEventPayload,
          { type: "tool.execution.started" }
        >["paramsSummary"],
      ): Record<string, string | number> => {
        if (!summary) {
          return {};
        }
        return {
          "openclaw.tool.params.kind": summary.kind,
          ...("length" in summary ? { "openclaw.tool.params.length": summary.length } : {}),
        };
      };

      const recordModelUsage = (evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.provider": evt.provider ?? "unknown",
          "openclaw.model": evt.model ?? "unknown",
        };

        const usage = evt.usage;
        if (usage.input) {
          tokensCounter.add(usage.input, { ...attrs, "openclaw.token": "input" });
        }
        if (usage.output) {
          tokensCounter.add(usage.output, { ...attrs, "openclaw.token": "output" });
        }
        if (usage.cacheRead) {
          tokensCounter.add(usage.cacheRead, { ...attrs, "openclaw.token": "cache_read" });
        }
        if (usage.cacheWrite) {
          tokensCounter.add(usage.cacheWrite, { ...attrs, "openclaw.token": "cache_write" });
        }
        if (usage.promptTokens) {
          tokensCounter.add(usage.promptTokens, { ...attrs, "openclaw.token": "prompt" });
        }
        if (usage.total) {
          tokensCounter.add(usage.total, { ...attrs, "openclaw.token": "total" });
        }

        if (evt.costUsd) {
          costCounter.add(evt.costUsd, attrs);
        }
        if (evt.durationMs) {
          durationHistogram.record(evt.durationMs, attrs);
        }
        if (evt.context?.limit) {
          contextHistogram.record(evt.context.limit, {
            ...attrs,
            "openclaw.context": "limit",
          });
        }
        if (evt.context?.used) {
          contextHistogram.record(evt.context.used, {
            ...attrs,
            "openclaw.context": "used",
          });
        }

        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "openclaw.tokens.input": usage.input ?? 0,
          "openclaw.tokens.output": usage.output ?? 0,
          "openclaw.tokens.cache_read": usage.cacheRead ?? 0,
          "openclaw.tokens.cache_write": usage.cacheWrite ?? 0,
          "openclaw.tokens.total": usage.total ?? 0,
        };

        const span = spanWithDuration("openclaw.model.usage", spanAttrs, evt.durationMs);
        span.end();
      };

      const recordWebhookReceived = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.received" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.webhook": evt.updateType ?? "unknown",
        };
        webhookReceivedCounter.add(1, attrs);
      };

      const recordWebhookProcessed = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.processed" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.webhook": evt.updateType ?? "unknown",
        };
        if (typeof evt.durationMs === "number") {
          webhookDurationHistogram.record(evt.durationMs, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = { ...attrs };
        if (evt.chatId !== undefined) {
          spanAttrs["openclaw.chatId"] = String(evt.chatId);
        }
        const span = spanWithDuration("openclaw.webhook.processed", spanAttrs, evt.durationMs);
        span.end();
      };

      const recordWebhookError = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.error" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.webhook": evt.updateType ?? "unknown",
        };
        webhookErrorCounter.add(1, attrs);
        if (!tracesEnabled) {
          return;
        }
        const redactedError = redactSensitiveText(evt.error);
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "openclaw.error": redactedError,
        };
        if (evt.chatId !== undefined) {
          spanAttrs["openclaw.chatId"] = String(evt.chatId);
        }
        const span = tracer.startSpan("openclaw.webhook.error", {
          attributes: spanAttrs,
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: redactedError });
        span.end();
      };

      const recordMessageQueued = (
        evt: Extract<DiagnosticEventPayload, { type: "message.queued" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.source": evt.source ?? "unknown",
        };
        messageQueuedCounter.add(1, attrs);
        if (typeof evt.queueDepth === "number") {
          queueDepthHistogram.record(evt.queueDepth, attrs);
        }
      };

      const recordMessageProcessed = (
        evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.outcome": evt.outcome ?? "unknown",
        };
        messageProcessedCounter.add(1, attrs);
        if (typeof evt.durationMs === "number") {
          messageDurationHistogram.record(evt.durationMs, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = { ...attrs };
        if (evt.chatId !== undefined) {
          spanAttrs["openclaw.chatId"] = String(evt.chatId);
        }
        if (evt.messageId !== undefined) {
          spanAttrs["openclaw.messageId"] = String(evt.messageId);
        }
        if (evt.reason) {
          spanAttrs["openclaw.reason"] = redactSensitiveText(evt.reason);
        }
        const span = spanWithDuration("openclaw.message.processed", spanAttrs, evt.durationMs);
        if (evt.outcome === "error" && evt.error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: redactSensitiveText(evt.error) });
        }
        span.end();
      };

      const messageDeliveryAttrs = (
        evt: MessageDeliveryDiagnosticEvent,
      ): Record<string, string> => ({
        "openclaw.channel": evt.channel,
        "openclaw.delivery.kind": evt.deliveryKind,
      });

      const recordMessageDeliveryStarted = (
        evt: Extract<DiagnosticEventPayload, { type: "message.delivery.started" }>,
      ) => {
        messageDeliveryStartedCounter.add(1, messageDeliveryAttrs(evt));
      };

      const recordMessageDeliveryCompleted = (
        evt: Extract<DiagnosticEventPayload, { type: "message.delivery.completed" }>,
      ) => {
        const attrs = {
          ...messageDeliveryAttrs(evt),
          "openclaw.outcome": "completed",
        };
        messageDeliveryDurationHistogram.record(evt.durationMs, attrs);
        if (!tracesEnabled) {
          return;
        }
        const span = spanWithDuration(
          "openclaw.message.delivery",
          {
            ...attrs,
            "openclaw.delivery.result_count": evt.resultCount,
          },
          evt.durationMs,
          { endTimeMs: evt.ts },
        );
        span.end(evt.ts);
      };

      const recordMessageDeliveryError = (
        evt: Extract<DiagnosticEventPayload, { type: "message.delivery.error" }>,
      ) => {
        const attrs = {
          ...messageDeliveryAttrs(evt),
          "openclaw.outcome": "error",
          "openclaw.errorCategory": lowCardinalityAttr(evt.errorCategory, "other"),
        };
        messageDeliveryDurationHistogram.record(evt.durationMs, attrs);
        if (!tracesEnabled) {
          return;
        }
        const span = spanWithDuration("openclaw.message.delivery", attrs, evt.durationMs, {
          endTimeMs: evt.ts,
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: redactSensitiveText(evt.errorCategory),
        });
        span.end(evt.ts);
      };

      const recordLaneEnqueue = (
        evt: Extract<DiagnosticEventPayload, { type: "queue.lane.enqueue" }>,
      ) => {
        const attrs = { "openclaw.lane": evt.lane };
        laneEnqueueCounter.add(1, attrs);
        queueDepthHistogram.record(evt.queueSize, attrs);
      };

      const recordLaneDequeue = (
        evt: Extract<DiagnosticEventPayload, { type: "queue.lane.dequeue" }>,
      ) => {
        const attrs = { "openclaw.lane": evt.lane };
        laneDequeueCounter.add(1, attrs);
        queueDepthHistogram.record(evt.queueSize, attrs);
        if (typeof evt.waitMs === "number") {
          queueWaitHistogram.record(evt.waitMs, attrs);
        }
      };

      const recordSessionState = (
        evt: Extract<DiagnosticEventPayload, { type: "session.state" }>,
      ) => {
        const attrs: Record<string, string> = { "openclaw.state": evt.state };
        if (evt.reason) {
          attrs["openclaw.reason"] = redactSensitiveText(evt.reason);
        }
        sessionStateCounter.add(1, attrs);
      };

      const recordSessionStuck = (
        evt: Extract<DiagnosticEventPayload, { type: "session.stuck" }>,
      ) => {
        const attrs: Record<string, string> = { "openclaw.state": evt.state };
        sessionStuckCounter.add(1, attrs);
        if (typeof evt.ageMs === "number") {
          sessionStuckAgeHistogram.record(evt.ageMs, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = { ...attrs };
        spanAttrs["openclaw.queueDepth"] = evt.queueDepth ?? 0;
        spanAttrs["openclaw.ageMs"] = evt.ageMs;
        const span = tracer.startSpan("openclaw.session.stuck", { attributes: spanAttrs });
        span.setStatus({ code: SpanStatusCode.ERROR, message: "session stuck" });
        span.end();
      };

      const recordRunAttempt = (evt: Extract<DiagnosticEventPayload, { type: "run.attempt" }>) => {
        runAttemptCounter.add(1, { "openclaw.attempt": evt.attempt });
      };

      const recordRunCompleted = (
        evt: Extract<DiagnosticEventPayload, { type: "run.completed" }>,
      ) => {
        const attrs: Record<string, string | number> = {
          "openclaw.outcome": evt.outcome,
          "openclaw.provider": evt.provider ?? "unknown",
          "openclaw.model": evt.model ?? "unknown",
        };
        if (evt.channel) {
          attrs["openclaw.channel"] = evt.channel;
        }
        durationHistogram.record(evt.durationMs, attrs);
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          "openclaw.outcome": evt.outcome,
        };
        addRunAttrs(spanAttrs, evt);
        if (evt.errorCategory) {
          spanAttrs["openclaw.errorCategory"] = lowCardinalityAttr(evt.errorCategory, "other");
        }
        const span = spanWithDuration("openclaw.run", spanAttrs, evt.durationMs, {
          endTimeMs: evt.ts,
        });
        if (evt.outcome === "error") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            ...(evt.errorCategory ? { message: redactSensitiveText(evt.errorCategory) } : {}),
          });
        }
        span.end(evt.ts);
      };

      const modelCallMetricAttrs = (
        evt: Extract<DiagnosticEventPayload, { type: "model.call.completed" | "model.call.error" }>,
      ) => ({
        "openclaw.provider": evt.provider,
        "openclaw.model": evt.model,
        "openclaw.api": lowCardinalityAttr(evt.api),
        "openclaw.transport": lowCardinalityAttr(evt.transport),
      });

      const recordModelCallCompleted = (
        evt: Extract<DiagnosticEventPayload, { type: "model.call.completed" }>,
      ) => {
        modelCallDurationHistogram.record(evt.durationMs, modelCallMetricAttrs(evt));
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          "openclaw.provider": evt.provider,
          "openclaw.model": evt.model,
          "gen_ai.system": evt.provider,
          "gen_ai.request.model": evt.model,
          "gen_ai.operation.name": genAiOperationName(evt.api),
        };
        if (evt.api) {
          spanAttrs["openclaw.api"] = evt.api;
        }
        if (evt.transport) {
          spanAttrs["openclaw.transport"] = evt.transport;
        }
        assignOtelModelContentAttributes(
          spanAttrs,
          evt as unknown as Record<string, unknown>,
          contentCapturePolicy,
        );
        const span = spanWithDuration("openclaw.model.call", spanAttrs, evt.durationMs, {
          endTimeMs: evt.ts,
        });
        span.end(evt.ts);
      };

      const recordModelCallError = (
        evt: Extract<DiagnosticEventPayload, { type: "model.call.error" }>,
      ) => {
        modelCallDurationHistogram.record(evt.durationMs, {
          ...modelCallMetricAttrs(evt),
          "openclaw.errorCategory": lowCardinalityAttr(evt.errorCategory, "other"),
        });
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          "openclaw.provider": evt.provider,
          "openclaw.model": evt.model,
          "openclaw.errorCategory": lowCardinalityAttr(evt.errorCategory, "other"),
          "gen_ai.system": evt.provider,
          "gen_ai.request.model": evt.model,
          "gen_ai.operation.name": genAiOperationName(evt.api),
        };
        if (evt.api) {
          spanAttrs["openclaw.api"] = evt.api;
        }
        if (evt.transport) {
          spanAttrs["openclaw.transport"] = evt.transport;
        }
        assignOtelModelContentAttributes(
          spanAttrs,
          evt as unknown as Record<string, unknown>,
          contentCapturePolicy,
        );
        const span = spanWithDuration("openclaw.model.call", spanAttrs, evt.durationMs, {
          endTimeMs: evt.ts,
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: redactSensitiveText(evt.errorCategory),
        });
        span.end(evt.ts);
      };

      const recordToolExecutionCompleted = (
        evt: Extract<DiagnosticEventPayload, { type: "tool.execution.completed" }>,
      ) => {
        const attrs = {
          "openclaw.toolName": evt.toolName,
          ...paramsSummaryAttrs(evt.paramsSummary),
        };
        toolExecutionDurationHistogram.record(evt.durationMs, attrs);
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          "openclaw.toolName": evt.toolName,
          "gen_ai.tool.name": evt.toolName,
          ...paramsSummaryAttrs(evt.paramsSummary),
        };
        addRunAttrs(spanAttrs, evt);
        assignOtelToolContentAttributes(
          spanAttrs,
          evt as unknown as Record<string, unknown>,
          contentCapturePolicy,
        );
        const span = spanWithDuration("openclaw.tool.execution", spanAttrs, evt.durationMs, {
          endTimeMs: evt.ts,
        });
        span.end(evt.ts);
      };

      const recordToolExecutionError = (
        evt: Extract<DiagnosticEventPayload, { type: "tool.execution.error" }>,
      ) => {
        const attrs = {
          "openclaw.toolName": evt.toolName,
          "openclaw.errorCategory": lowCardinalityAttr(evt.errorCategory, "other"),
          ...paramsSummaryAttrs(evt.paramsSummary),
        };
        toolExecutionDurationHistogram.record(evt.durationMs, attrs);
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          "openclaw.toolName": evt.toolName,
          "openclaw.errorCategory": lowCardinalityAttr(evt.errorCategory, "other"),
          "gen_ai.tool.name": evt.toolName,
          ...paramsSummaryAttrs(evt.paramsSummary),
        };
        addRunAttrs(spanAttrs, evt);
        if (evt.errorCode) {
          spanAttrs["openclaw.errorCode"] = lowCardinalityAttr(evt.errorCode, "other");
        }
        assignOtelToolContentAttributes(
          spanAttrs,
          evt as unknown as Record<string, unknown>,
          contentCapturePolicy,
        );
        const span = spanWithDuration("openclaw.tool.execution", spanAttrs, evt.durationMs, {
          endTimeMs: evt.ts,
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: redactSensitiveText(evt.errorCategory),
        });
        span.end(evt.ts);
      };

      const recordExecProcessCompleted = (
        evt: Extract<DiagnosticEventPayload, { type: "exec.process.completed" }>,
      ) => {
        const attrs: Record<string, string | number> = {
          "openclaw.exec.target": evt.target,
          "openclaw.exec.mode": evt.mode,
          "openclaw.outcome": evt.outcome,
        };
        if (evt.failureKind) {
          attrs["openclaw.failureKind"] = evt.failureKind;
        }
        execProcessDurationHistogram.record(evt.durationMs, attrs);
        if (!tracesEnabled) {
          return;
        }

        const spanAttrs: Record<string, string | number | boolean> = {
          ...attrs,
          "openclaw.exec.command_length": evt.commandLength,
        };
        if (typeof evt.exitCode === "number") {
          spanAttrs["openclaw.exec.exit_code"] = evt.exitCode;
        }
        if (evt.exitSignal) {
          spanAttrs["openclaw.exec.exit_signal"] = lowCardinalityAttr(evt.exitSignal, "other");
        }
        if (evt.timedOut !== undefined) {
          spanAttrs["openclaw.exec.timed_out"] = evt.timedOut;
        }

        const span = spanWithDuration("openclaw.exec", spanAttrs, evt.durationMs, {
          endTimeMs: evt.ts,
        });
        if (evt.outcome === "failed") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            ...(evt.failureKind ? { message: evt.failureKind } : {}),
          });
        }
        span.end(evt.ts);
      };

      const recordHeartbeat = (
        evt: Extract<DiagnosticEventPayload, { type: "diagnostic.heartbeat" }>,
      ) => {
        queueDepthHistogram.record(evt.queued, { "openclaw.channel": "heartbeat" });
      };

      unsubscribe = onInternalDiagnosticEvent((evt: DiagnosticEventPayload) => {
        try {
          switch (evt.type) {
            case "model.usage":
              recordModelUsage(evt);
              return;
            case "webhook.received":
              recordWebhookReceived(evt);
              return;
            case "webhook.processed":
              recordWebhookProcessed(evt);
              return;
            case "webhook.error":
              recordWebhookError(evt);
              return;
            case "message.queued":
              recordMessageQueued(evt);
              return;
            case "message.processed":
              recordMessageProcessed(evt);
              return;
            case "message.delivery.started":
              recordMessageDeliveryStarted(evt);
              return;
            case "message.delivery.completed":
              recordMessageDeliveryCompleted(evt);
              return;
            case "message.delivery.error":
              recordMessageDeliveryError(evt);
              return;
            case "queue.lane.enqueue":
              recordLaneEnqueue(evt);
              return;
            case "queue.lane.dequeue":
              recordLaneDequeue(evt);
              return;
            case "session.state":
              recordSessionState(evt);
              return;
            case "session.stuck":
              recordSessionStuck(evt);
              return;
            case "run.attempt":
              recordRunAttempt(evt);
              return;
            case "diagnostic.heartbeat":
              recordHeartbeat(evt);
              return;
            case "run.completed":
              recordRunCompleted(evt);
              return;
            case "model.call.completed":
              recordModelCallCompleted(evt);
              return;
            case "model.call.error":
              recordModelCallError(evt);
              return;
            case "tool.execution.completed":
              recordToolExecutionCompleted(evt);
              return;
            case "tool.execution.error":
              recordToolExecutionError(evt);
              return;
            case "exec.process.completed":
              recordExecProcessCompleted(evt);
              return;
            case "log.record":
              recordLogRecord?.(evt);
              return;
            case "tool.loop":
            case "tool.execution.started":
            case "run.started":
            case "model.call.started":
            case "diagnostic.memory.sample":
            case "diagnostic.memory.pressure":
            case "payload.large":
              return;
          }
        } catch (err) {
          ctx.logger.error(
            `diagnostics-otel: event handler failed (${evt.type}): ${formatError(err)}`,
          );
        }
      });

      if (logsEnabled) {
        ctx.logger.info("diagnostics-otel: logs exporter enabled (OTLP/Protobuf)");
      }
    },
    async stop() {
      await stopStarted();
    },
  } satisfies OpenClawPluginService;
}
