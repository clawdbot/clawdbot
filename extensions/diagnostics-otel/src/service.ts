import { metrics, trace, SpanStatusCode } from "@opentelemetry/api";
import type { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";

import type { ClawdbotPluginService, DiagnosticEventPayload } from "clawdbot/plugin-sdk";
import { onDiagnosticEvent, registerLogTransport } from "clawdbot/plugin-sdk";

const DEFAULT_SERVICE_NAME = "clawdbot";

function normalizeEndpoint(endpoint?: string): string | undefined {
  const trimmed = endpoint?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

function resolveOtelUrl(endpoint: string | undefined, path: string): string | undefined {
  if (!endpoint) return undefined;
  if (endpoint.includes("/v1/")) return endpoint;
  return `${endpoint}/${path}`;
}

function resolveSampleRate(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return value;
}

export function createDiagnosticsOtelService(): ClawdbotPluginService {
  let sdk: NodeSDK | null = null;
  let logProvider: LoggerProvider | null = null;
  let stopLogTransport: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  return {
    id: "diagnostics-otel",
    async start(ctx) {
      const cfg = ctx.config.diagnostics;
      const otel = cfg?.otel;
      if (!cfg?.enabled || !otel?.enabled) return;

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

      const tracesEnabled = otel.traces !== false;
      const metricsEnabled = otel.metrics !== false;
      const logsEnabled = otel.logs === true;
      if (!tracesEnabled && !metricsEnabled && !logsEnabled) return;

      const resource = new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      });

      const traceUrl = resolveOtelUrl(endpoint, "v1/traces");
      const metricUrl = resolveOtelUrl(endpoint, "v1/metrics");
      const logUrl = resolveOtelUrl(endpoint, "v1/logs");
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

      if (tracesEnabled || metricsEnabled) {
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

        await sdk.start();
      }

      const logSeverityMap: Record<string, SeverityNumber> = {
        TRACE: 1 as SeverityNumber,
        DEBUG: 5 as SeverityNumber,
        INFO: 9 as SeverityNumber,
        WARN: 13 as SeverityNumber,
        ERROR: 17 as SeverityNumber,
        FATAL: 21 as SeverityNumber,
      };

      const meter = metrics.getMeter("clawdbot");
      const tracer = trace.getTracer("clawdbot");

      const tokensCounter = meter.createCounter("clawdbot.tokens", {
        unit: "1",
        description: "Token usage by type",
      });
      const costCounter = meter.createCounter("clawdbot.cost.usd", {
        unit: "1",
        description: "Estimated model cost (USD)",
      });
      const durationHistogram = meter.createHistogram("clawdbot.run.duration_ms", {
        unit: "ms",
        description: "Agent run duration",
      });
      const contextHistogram = meter.createHistogram("clawdbot.context.tokens", {
        unit: "1",
        description: "Context window size and usage",
      });
      const webhookReceivedCounter = meter.createCounter("clawdbot.webhook.received", {
        unit: "1",
        description: "Webhook requests received",
      });
      const webhookErrorCounter = meter.createCounter("clawdbot.webhook.error", {
        unit: "1",
        description: "Webhook processing errors",
      });
      const webhookDurationHistogram = meter.createHistogram("clawdbot.webhook.duration_ms", {
        unit: "ms",
        description: "Webhook processing duration",
      });
      const messageQueuedCounter = meter.createCounter("clawdbot.message.queued", {
        unit: "1",
        description: "Messages queued for processing",
      });
      const messageProcessedCounter = meter.createCounter("clawdbot.message.processed", {
        unit: "1",
        description: "Messages processed by outcome",
      });
      const messageDurationHistogram = meter.createHistogram("clawdbot.message.duration_ms", {
        unit: "ms",
        description: "Message processing duration",
      });
      const queueDepthHistogram = meter.createHistogram("clawdbot.queue.depth", {
        unit: "1",
        description: "Queue depth on enqueue/dequeue",
      });
      const queueWaitHistogram = meter.createHistogram("clawdbot.queue.wait_ms", {
        unit: "ms",
        description: "Queue wait time before execution",
      });
      const laneEnqueueCounter = meter.createCounter("clawdbot.queue.lane.enqueue", {
        unit: "1",
        description: "Command queue lane enqueue events",
      });
      const laneDequeueCounter = meter.createCounter("clawdbot.queue.lane.dequeue", {
        unit: "1",
        description: "Command queue lane dequeue events",
      });
      const sessionStateCounter = meter.createCounter("clawdbot.session.state", {
        unit: "1",
        description: "Session state transitions",
      });
      const sessionStuckCounter = meter.createCounter("clawdbot.session.stuck", {
        unit: "1",
        description: "Sessions stuck in processing",
      });
      const sessionStuckAgeHistogram = meter.createHistogram("clawdbot.session.stuck_age_ms", {
        unit: "ms",
        description: "Age of stuck sessions",
      });
      const runAttemptCounter = meter.createCounter("clawdbot.run.attempt", {
        unit: "1",
        description: "Run attempts",
      });

      if (logsEnabled) {
        const logExporter = new OTLPLogExporter({
          ...(logUrl ? { url: logUrl } : {}),
          ...(headers ? { headers } : {}),
        });
        logProvider = new LoggerProvider({ resource });
        logProvider.addLogRecordProcessor(
          new BatchLogRecordProcessor(logExporter, {
            ...(typeof otel.flushIntervalMs === "number"
              ? { scheduledDelayMillis: Math.max(1000, otel.flushIntervalMs) }
              : {}),
          }),
        );
        const otelLogger = logProvider.getLogger("clawdbot");

        stopLogTransport = registerLogTransport((logObj) => {
          const safeStringify = (value: unknown) => {
            try {
              return JSON.stringify(value);
            } catch {
              return String(value);
            }
          };
          const meta = (logObj as Record<string, unknown>)._meta as
            | {
                logLevelName?: string;
                date?: Date;
                name?: string;
                parentNames?: string[];
                path?: {
                  filePath?: string;
                  fileLine?: string;
                  fileColumn?: string;
                  filePathWithLine?: string;
                  method?: string;
                };
              }
            | undefined;
          const logLevelName = meta?.logLevelName ?? "INFO";
          const severityNumber = logSeverityMap[logLevelName] ?? (9 as SeverityNumber);

          const numericArgs = Object.entries(logObj)
            .filter(([key]) => /^\d+$/.test(key))
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([, value]) => value);

          let bindings: Record<string, unknown> | undefined;
          if (typeof numericArgs[0] === "string" && numericArgs[0].trim().startsWith("{")) {
            try {
              const parsed = JSON.parse(numericArgs[0]);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                bindings = parsed as Record<string, unknown>;
                numericArgs.shift();
              }
            } catch {
              // ignore malformed json bindings
            }
          }

          let message = "";
          if (numericArgs.length > 0 && typeof numericArgs[numericArgs.length - 1] === "string") {
            message = String(numericArgs.pop());
          } else if (numericArgs.length === 1) {
            message = safeStringify(numericArgs[0]);
            numericArgs.length = 0;
          }
          if (!message) {
            message = "log";
          }

          const attributes: Record<string, string | number | boolean> = {
            "clawdbot.log.level": logLevelName,
          };
          if (meta?.name) attributes["clawdbot.logger"] = meta.name;
          if (meta?.parentNames?.length) {
            attributes["clawdbot.logger.parents"] = meta.parentNames.join(".");
          }
          if (bindings) {
            for (const [key, value] of Object.entries(bindings)) {
              if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
                attributes[`clawdbot.${key}`] = value;
              } else if (value != null) {
                attributes[`clawdbot.${key}`] = safeStringify(value);
              }
            }
          }
          if (numericArgs.length > 0) {
            attributes["clawdbot.log.args"] = safeStringify(numericArgs);
          }
          if (meta?.path?.filePath) attributes["code.filepath"] = meta.path.filePath;
          if (meta?.path?.fileLine) attributes["code.lineno"] = Number(meta.path.fileLine);
          if (meta?.path?.method) attributes["code.function"] = meta.path.method;
          if (meta?.path?.filePathWithLine) {
            attributes["clawdbot.code.location"] = meta.path.filePathWithLine;
          }

          otelLogger.emit({
            body: message,
            severityText: logLevelName,
            severityNumber,
            attributes,
            timestamp: meta?.date ?? new Date(),
          });
        });
      }

      const spanWithDuration = (
        name: string,
        attributes: Record<string, string | number>,
        durationMs?: number,
      ) => {
        const startTime =
          typeof durationMs === "number" ? Date.now() - Math.max(0, durationMs) : undefined;
        const span = tracer.startSpan(name, {
          attributes,
          ...(startTime ? { startTime } : {}),
        });
        return span;
      };

      const recordModelUsage = (evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>) => {
        const attrs = {
          "clawdbot.channel": evt.channel ?? "unknown",
          "clawdbot.provider": evt.provider ?? "unknown",
          "clawdbot.model": evt.model ?? "unknown",
        };

        const usage = evt.usage;
        if (usage.input) tokensCounter.add(usage.input, { ...attrs, "clawdbot.token": "input" });
        if (usage.output) tokensCounter.add(usage.output, { ...attrs, "clawdbot.token": "output" });
        if (usage.cacheRead)
          tokensCounter.add(usage.cacheRead, { ...attrs, "clawdbot.token": "cache_read" });
        if (usage.cacheWrite)
          tokensCounter.add(usage.cacheWrite, { ...attrs, "clawdbot.token": "cache_write" });
        if (usage.promptTokens)
          tokensCounter.add(usage.promptTokens, { ...attrs, "clawdbot.token": "prompt" });
        if (usage.total) tokensCounter.add(usage.total, { ...attrs, "clawdbot.token": "total" });

        if (evt.costUsd) costCounter.add(evt.costUsd, attrs);
        if (evt.durationMs) durationHistogram.record(evt.durationMs, attrs);
        if (evt.context?.limit)
          contextHistogram.record(evt.context.limit, {
            ...attrs,
            "clawdbot.context": "limit",
          });
        if (evt.context?.used)
          contextHistogram.record(evt.context.used, {
            ...attrs,
            "clawdbot.context": "used",
          });

        if (!tracesEnabled) return;
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "clawdbot.sessionKey": evt.sessionKey ?? "",
          "clawdbot.sessionId": evt.sessionId ?? "",
          "clawdbot.tokens.input": usage.input ?? 0,
          "clawdbot.tokens.output": usage.output ?? 0,
          "clawdbot.tokens.cache_read": usage.cacheRead ?? 0,
          "clawdbot.tokens.cache_write": usage.cacheWrite ?? 0,
          "clawdbot.tokens.total": usage.total ?? 0,
        };

        const span = spanWithDuration("clawdbot.model.usage", spanAttrs, evt.durationMs);
        span.end();
      };

      const recordWebhookReceived = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.received" }>,
      ) => {
        const attrs = {
          "clawdbot.channel": evt.channel ?? "unknown",
          "clawdbot.webhook": evt.updateType ?? "unknown",
        };
        webhookReceivedCounter.add(1, attrs);
      };

      const recordWebhookProcessed = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.processed" }>,
      ) => {
        const attrs = {
          "clawdbot.channel": evt.channel ?? "unknown",
          "clawdbot.webhook": evt.updateType ?? "unknown",
        };
        if (typeof evt.durationMs === "number") {
          webhookDurationHistogram.record(evt.durationMs, attrs);
        }
        if (!tracesEnabled) return;
        const spanAttrs: Record<string, string | number> = { ...attrs };
        if (evt.chatId !== undefined) spanAttrs["clawdbot.chatId"] = String(evt.chatId);
        const span = spanWithDuration("clawdbot.webhook.processed", spanAttrs, evt.durationMs);
        span.end();
      };

      const recordWebhookError = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.error" }>,
      ) => {
        const attrs = {
          "clawdbot.channel": evt.channel ?? "unknown",
          "clawdbot.webhook": evt.updateType ?? "unknown",
        };
        webhookErrorCounter.add(1, attrs);
        if (!tracesEnabled) return;
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "clawdbot.error": evt.error,
        };
        if (evt.chatId !== undefined) spanAttrs["clawdbot.chatId"] = String(evt.chatId);
        const span = tracer.startSpan("clawdbot.webhook.error", {
          attributes: spanAttrs,
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: evt.error });
        span.end();
      };

      const recordMessageQueued = (
        evt: Extract<DiagnosticEventPayload, { type: "message.queued" }>,
      ) => {
        const attrs = {
          "clawdbot.channel": evt.channel ?? "unknown",
          "clawdbot.source": evt.source ?? "unknown",
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
          "clawdbot.channel": evt.channel ?? "unknown",
          "clawdbot.outcome": evt.outcome ?? "unknown",
        };
        messageProcessedCounter.add(1, attrs);
        if (typeof evt.durationMs === "number") {
          messageDurationHistogram.record(evt.durationMs, attrs);
        }
        if (!tracesEnabled) return;
        const spanAttrs: Record<string, string | number> = { ...attrs };
        if (evt.sessionKey) spanAttrs["clawdbot.sessionKey"] = evt.sessionKey;
        if (evt.sessionId) spanAttrs["clawdbot.sessionId"] = evt.sessionId;
        if (evt.chatId !== undefined) spanAttrs["clawdbot.chatId"] = String(evt.chatId);
        if (evt.messageId !== undefined) spanAttrs["clawdbot.messageId"] = String(evt.messageId);
        if (evt.reason) spanAttrs["clawdbot.reason"] = evt.reason;
        const span = spanWithDuration("clawdbot.message.processed", spanAttrs, evt.durationMs);
        if (evt.outcome === "error") {
          span.setStatus({ code: SpanStatusCode.ERROR, message: evt.error });
        }
        span.end();
      };

      const recordLaneEnqueue = (
        evt: Extract<DiagnosticEventPayload, { type: "queue.lane.enqueue" }>,
      ) => {
        const attrs = { "clawdbot.lane": evt.lane };
        laneEnqueueCounter.add(1, attrs);
        queueDepthHistogram.record(evt.queueSize, attrs);
      };

      const recordLaneDequeue = (
        evt: Extract<DiagnosticEventPayload, { type: "queue.lane.dequeue" }>,
      ) => {
        const attrs = { "clawdbot.lane": evt.lane };
        laneDequeueCounter.add(1, attrs);
        queueDepthHistogram.record(evt.queueSize, attrs);
        if (typeof evt.waitMs === "number") {
          queueWaitHistogram.record(evt.waitMs, attrs);
        }
      };

      const recordSessionState = (
        evt: Extract<DiagnosticEventPayload, { type: "session.state" }>,
      ) => {
        const attrs: Record<string, string> = { "clawdbot.state": evt.state };
        if (evt.reason) attrs["clawdbot.reason"] = evt.reason;
        sessionStateCounter.add(1, attrs);
      };

      const recordSessionStuck = (
        evt: Extract<DiagnosticEventPayload, { type: "session.stuck" }>,
      ) => {
        const attrs: Record<string, string> = { "clawdbot.state": evt.state };
        sessionStuckCounter.add(1, attrs);
        if (typeof evt.ageMs === "number") {
          sessionStuckAgeHistogram.record(evt.ageMs, attrs);
        }
        if (!tracesEnabled) return;
        const spanAttrs: Record<string, string | number> = { ...attrs };
        if (evt.sessionKey) spanAttrs["clawdbot.sessionKey"] = evt.sessionKey;
        if (evt.sessionId) spanAttrs["clawdbot.sessionId"] = evt.sessionId;
        spanAttrs["clawdbot.queueDepth"] = evt.queueDepth ?? 0;
        spanAttrs["clawdbot.ageMs"] = evt.ageMs;
        const span = tracer.startSpan("clawdbot.session.stuck", { attributes: spanAttrs });
        span.setStatus({ code: SpanStatusCode.ERROR, message: "session stuck" });
        span.end();
      };

      const recordRunAttempt = (evt: Extract<DiagnosticEventPayload, { type: "run.attempt" }>) => {
        runAttemptCounter.add(1, { "clawdbot.attempt": evt.attempt });
      };

      const recordHeartbeat = (
        evt: Extract<DiagnosticEventPayload, { type: "diagnostic.heartbeat" }>,
      ) => {
        queueDepthHistogram.record(evt.queued, { "clawdbot.channel": "heartbeat" });
      };

      unsubscribe = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
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
        }
      });

      if (logsEnabled) {
        ctx.logger.info("diagnostics-otel: logs exporter enabled (OTLP/HTTP)");
      }
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      stopLogTransport?.();
      stopLogTransport = null;
      if (logProvider) {
        await logProvider.shutdown().catch(() => undefined);
        logProvider = null;
      }
      if (sdk) {
        await sdk.shutdown().catch(() => undefined);
        sdk = null;
      }
    },
  } satisfies ClawdbotPluginService;
}
