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
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticTraceContext,
  OpenClawPluginService,
} from "../api.js";
import {
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  redactSensitiveText,
} from "../api.js";

const DEFAULT_SERVICE_NAME = "openclaw";
const DROPPED_OTEL_ATTRIBUTE_KEYS = new Set([
  "openclaw.callId",
  "openclaw.chatId",
  "openclaw.messageId",
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
const OTEL_EXPORTER_OTLP_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT";
const OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";
const OTEL_EXPORTER_OTLP_METRICS_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT";
const OTEL_EXPORTER_OTLP_LOGS_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT";
const OTEL_SEMCONV_STABILITY_OPT_IN_ENV = "OTEL_SEMCONV_STABILITY_OPT_IN";
const GEN_AI_LATEST_EXPERIMENTAL_OPT_IN = "gen_ai_latest_experimental";
const GEN_AI_TOKEN_USAGE_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
];
const GEN_AI_OPERATION_DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];

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
type ModelCallLifecycleDiagnosticEvent = Extract<
  DiagnosticEventPayload,
  { type: "model.call.completed" | "model.call.error" }
>;
type ModelFailoverDiagnosticEvent = Extract<DiagnosticEventPayload, { type: "model.failover" }>;
type HarnessRunDiagnosticEvent = Extract<
  DiagnosticEventPayload,
  { type: "harness.run.started" | "harness.run.completed" | "harness.run.error" }
>;
type TelemetryExporterDiagnosticEvent = Extract<
  DiagnosticEventPayload,
  { type: "telemetry.exporter" }
>;
type SessionRecoveryDiagnosticEvent = Extract<
  DiagnosticEventPayload,
  { type: "session.recovery.requested" | "session.recovery.completed" }
>;
type TalkDiagnosticEvent = Extract<DiagnosticEventPayload, { type: "talk.event" }>;

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

function resolveSignalOtelUrl(params: {
  signalEndpoint?: string;
  signalEnvEndpoint?: string;
  endpoint?: string;
  path: string;
}): string | undefined {
  return resolveOtelUrl(
    normalizeEndpoint(params.signalEndpoint ?? params.signalEnvEndpoint) ?? params.endpoint,
    params.path,
  );
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

function errorCategory(err: unknown): string {
  try {
    if (err instanceof Error && typeof err.name === "string" && err.name.trim()) {
      return lowCardinalityAttr(err.name, "Error");
    }
    return lowCardinalityAttr(typeof err, "unknown");
  } catch {
    return "unknown";
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

function hasOtelSemconvOptIn(value: string | undefined, optIn: string): boolean {
  return (
    value
      ?.split(",")
      .map((part) => part.trim())
      .includes(optIn) ?? false
  );
}

function emitLatestGenAiSemconv(): boolean {
  return hasOtelSemconvOptIn(
    process.env[OTEL_SEMCONV_STABILITY_OPT_IN_ENV],
    GEN_AI_LATEST_EXPERIMENTAL_OPT_IN,
  );
}

function genAiOperationName(
  api: string | undefined,
): "chat" | "generate_content" | "text_completion" {
  const normalized = api?.trim().toLowerCase();
  if (!normalized) {
    return "chat";
  }
  if (normalized === "completions" || normalized.endsWith("-completions")) {
    return "text_completion";
  }
  if (normalized === "generate_content" || normalized.includes("generative-ai")) {
    return "generate_content";
  }
  return "chat";
}

function positiveFiniteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function assignPositiveNumberAttr(
  attrs: Record<string, string | number | boolean>,
  key: string,
  value: number | undefined,
): void {
  const normalized = positiveFiniteNumber(value);
  if (normalized !== undefined) {
    attrs[key] = normalized;
  }
}

function assignModelCallSizeTimingAttrs(
  attrs: Record<string, string | number | boolean>,
  evt: {
    requestPayloadBytes?: number;
    responseStreamBytes?: number;
    timeToFirstByteMs?: number;
  },
): void {
  assignPositiveNumberAttr(attrs, "openclaw.model_call.request_bytes", evt.requestPayloadBytes);
  assignPositiveNumberAttr(attrs, "openclaw.model_call.response_bytes", evt.responseStreamBytes);
  assignPositiveNumberAttr(
    attrs,
    "openclaw.model_call.time_to_first_byte_ms",
    evt.timeToFirstByteMs,
  );
}

function assignGenAiSpanIdentityAttrs(
  attrs: Record<string, string | number | boolean>,
  input: { api?: string; model?: string; provider?: string },
): void {
  if (emitLatestGenAiSemconv()) {
    attrs["gen_ai.provider.name"] = lowCardinalityAttr(input.provider);
  } else {
    attrs["gen_ai.system"] = lowCardinalityAttr(input.provider);
  }
  if (input.model) {
    attrs["gen_ai.request.model"] = lowCardinalityAttr(input.model);
  }
  attrs["gen_ai.operation.name"] = genAiOperationName(input.api);
}

function assignGenAiModelCallAttrs(
  attrs: Record<string, string | number | boolean>,
  evt: { api?: string; model?: string; provider?: string },
): void {
  assignGenAiSpanIdentityAttrs(attrs, evt);
}

function addUpstreamRequestIdSpanEvent(
  span: { addEvent?: (name: string, attributes?: Record<string, string>) => void },
  upstreamRequestIdHash: string | undefined,
): void {
  if (!upstreamRequestIdHash) {
    return;
  }
  const boundedHash = lowCardinalityAttr(upstreamRequestIdHash);
  if (boundedHash === "unknown") {
    return;
  }
  span.addEvent?.("openclaw.provider.request", {
    "openclaw.upstreamRequestIdHash": boundedHash,
  });
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

function contextForTrustedTraceContext(
  evt: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
) {
  return metadata.trusted ? contextForTraceContext(evt.trace) : undefined;
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
  let stopActiveTrustedSpans: (() => void) | null = null;

  const stopStarted = async () => {
    const currentUnsubscribe = unsubscribe;
    const currentLogProvider = logProvider;
    const currentSdk = sdk;
    const currentStopActiveTrustedSpans = stopActiveTrustedSpans;

    unsubscribe = null;
    logProvider = null;
    sdk = null;
    stopActiveTrustedSpans = null;

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
      if (!cfg?.enabled || !otel?.enabled) {
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
      const enabledSignals: TelemetryExporterDiagnosticEvent["signal"][] = [
        ...(tracesEnabled ? (["traces"] as const) : []),
        ...(metricsEnabled ? (["metrics"] as const) : []),
        ...(logsEnabled ? (["logs"] as const) : []),
      ];
      if (enabledSignals.length === 0) {
        return;
      }

      const protocol = otel.protocol ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf";
      if (protocol !== "http/protobuf") {
        emitForSignals(enabledSignals, {
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
      const activeTrustedSpans = new Map<string, ReturnType<typeof tracer.startSpan>>();
      const activeTrustedSpanAliases = new Map<string, ReturnType<typeof tracer.startSpan>>();
      const pendingTrustedRunFinalizers = new Map<string, ReturnType<typeof setImmediate>>();
      stopActiveTrustedSpans = () => {
        const stopAt = Date.now();
        for (const handle of pendingTrustedRunFinalizers.values()) {
          clearImmediate(handle);
        }
        pendingTrustedRunFinalizers.clear();
        for (const span of new Set([
          ...activeTrustedSpans.values(),
          ...activeTrustedSpanAliases.values(),
        ])) {
          span.end(stopAt);
        }
        activeTrustedSpans.clear();
        activeTrustedSpanAliases.clear();
      };

      const tokensCounter = meter.createCounter("openclaw.tokens", {
        unit: "1",
        description: "Token usage by type",
      });
      const genAiTokenUsageHistogram = meter.createHistogram("gen_ai.client.token.usage", {
        unit: "{token}",
        description: "Number of input and output tokens used by GenAI client operations",
        advice: {
          explicitBucketBoundaries: GEN_AI_TOKEN_USAGE_BUCKETS,
        },
      });
      const genAiOperationDurationHistogram = meter.createHistogram(
        "gen_ai.client.operation.duration",
        {
          unit: "s",
          description: "GenAI client operation duration",
          advice: {
            explicitBucketBoundaries: GEN_AI_OPERATION_DURATION_BUCKETS,
          },
        },
      );
      const costCounter = meter.createCounter("openclaw.cost.usd", {
        unit: "1",
        description: "Estimated model cost (USD)",
      });
      const durationHistogram = meter.createHistogram("openclaw.run.duration_ms", {
        unit: "ms",
        description: "Agent run duration",
      });
      const harnessDurationHistogram = meter.createHistogram("openclaw.harness.duration_ms", {
        unit: "ms",
        description: "Agent harness lifecycle duration",
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
      const sessionRecoveryRequestedCounter = meter.createCounter(
        "openclaw.session.recovery.requested",
        {
          unit: "1",
          description: "Session recovery attempts requested",
        },
      );
      const sessionRecoveryCompletedCounter = meter.createCounter(
        "openclaw.session.recovery.completed",
        {
          unit: "1",
          description: "Session recovery attempts completed",
        },
      );
      const sessionRecoveryAgeHistogram = meter.createHistogram(
        "openclaw.session.recovery.age_ms",
        {
          unit: "ms",
          description: "Age of sessions selected for recovery",
        },
      );
      const talkEventCounter = meter.createCounter("openclaw.talk.event", {
        unit: "1",
        description: "Talk events emitted by type",
      });
      const talkEventDurationHistogram = meter.createHistogram("openclaw.talk.event.duration_ms", {
        unit: "ms",
        description: "Talk event duration when reported",
      });
      const talkAudioBytesHistogram = meter.createHistogram("openclaw.talk.audio.bytes", {
        unit: "By",
        description: "Talk audio frame byte lengths",
      });
      const runAttemptCounter = meter.createCounter("openclaw.run.attempt", {
        unit: "1",
        description: "Run attempts",
      });
      const toolLoopCounter = meter.createCounter("openclaw.tool.loop", {
        unit: "1",
        description: "Detected repetitive tool-call loop events",
      });
      const modelCallDurationHistogram = meter.createHistogram("openclaw.model_call.duration_ms", {
        unit: "ms",
        description: "Model call duration",
      });
      const modelCallRequestBytesHistogram = meter.createHistogram(
        "openclaw.model_call.request_bytes",
        {
          unit: "By",
          description: "UTF-8 byte size of sanitized model request payloads",
        },
      );
      const modelCallResponseBytesHistogram = meter.createHistogram(
        "openclaw.model_call.response_bytes",
        {
          unit: "By",
          description: "UTF-8 byte size of streamed model response events",
        },
      );
      const modelCallTimeToFirstByteHistogram = meter.createHistogram(
        "openclaw.model_call.time_to_first_byte_ms",
        {
          unit: "ms",
          description: "Elapsed time before the first streamed model response event",
        },
      );
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
      const memoryRssHistogram = meter.createHistogram("openclaw.memory.rss_bytes", {
        unit: "By",
        description: "Resident set size reported by diagnostic memory samples",
      });
      const memoryHeapUsedHistogram = meter.createHistogram("openclaw.memory.heap_used_bytes", {
        unit: "By",
        description: "Heap used bytes reported by diagnostic memory samples",
      });
      const memoryHeapTotalHistogram = meter.createHistogram("openclaw.memory.heap_total_bytes", {
        unit: "By",
        description: "Heap total bytes reported by diagnostic memory samples",
      });
      const memoryExternalHistogram = meter.createHistogram("openclaw.memory.external_bytes", {
        unit: "By",
        description: "External memory bytes reported by diagnostic memory samples",
      });
      const memoryArrayBuffersHistogram = meter.createHistogram(
        "openclaw.memory.array_buffers_bytes",
        {
          unit: "By",
          description: "ArrayBuffer bytes reported by diagnostic memory samples",
        },
      );
      const memoryPressureCounter = meter.createCounter("openclaw.memory.pressure", {
        unit: "1",
        description: "Diagnostic memory pressure events",
      });
      const livenessWarningCounter = meter.createCounter("openclaw.liveness.warning", {
        unit: "1",
        description: "Diagnostic liveness warning events",
      });
      const livenessEventLoopDelayP99Histogram = meter.createHistogram(
        "openclaw.liveness.event_loop_delay_p99_ms",
        {
          unit: "ms",
          description: "P99 event-loop delay reported by diagnostic liveness warnings",
        },
      );
      const livenessEventLoopDelayMaxHistogram = meter.createHistogram(
        "openclaw.liveness.event_loop_delay_max_ms",
        {
          unit: "ms",
          description: "Maximum event-loop delay reported by diagnostic liveness warnings",
        },
      );
      const livenessEventLoopUtilizationHistogram = meter.createHistogram(
        "openclaw.liveness.event_loop_utilization",
        {
          unit: "1",
          description: "Event-loop utilization reported by diagnostic liveness warnings",
        },
      );
      const livenessCpuCoreRatioHistogram = meter.createHistogram(
        "openclaw.liveness.cpu_core_ratio",
        {
          unit: "1",
          description: "CPU core ratio reported by diagnostic liveness warnings",
        },
      );
      const telemetryExporterCounter = meter.createCounter("openclaw.telemetry.exporter.events", {
        unit: "1",
        description: "Diagnostic telemetry exporter lifecycle and failure events",
      });

      let recordLogRecord:
        | ((
            evt: Extract<DiagnosticEventPayload, { type: "log.record" }>,
            metadata: DiagnosticEventMetadata,
          ) => void)
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
        recordLogRecord = (evt, metadata) => {
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
            if (metadata.trusted) {
              addTraceAttributes(attributes, evt.trace);
            }

            const logRecord: LogRecord = {
              body: normalizeOtelLogString(evt.message || "log", MAX_OTEL_LOG_BODY_CHARS),
              severityText: logLevelName,
              severityNumber,
              attributes: redactOtelAttributes(attributes),
              timestamp: evt.ts,
            };
            const logContext = contextForTrustedTraceContext(evt, metadata);
            if (logContext) {
              logRecord.context = logContext;
            }
            otelLogger.emit(logRecord);
          } catch (err) {
            emitExporterEvent({
              exporter: "diagnostics-otel",
              signal: "logs",
              status: "failure",
              reason: "emit_failed",
              errorCategory: errorCategory(err),
            });
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
          startTimeMs?: number;
        } = {},
      ) => {
        const endTimeMs = options.endTimeMs ?? Date.now();
        const startTime =
          typeof options.startTimeMs === "number"
            ? options.startTimeMs
            : typeof durationMs === "number" && durationMs >= 0
              ? endTimeMs - durationMs
              : undefined;
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
      const trustedTraceContext = (
        evt: DiagnosticEventPayload,
        metadata: DiagnosticEventMetadata,
      ) => (metadata.trusted ? normalizeTraceContext(evt.trace) : undefined);
      const activeTrustedParentContext = (
        evt: DiagnosticEventPayload,
        metadata: DiagnosticEventMetadata,
      ) => {
        const parentSpanId = trustedTraceContext(evt, metadata)?.parentSpanId;
        if (!parentSpanId) {
          return undefined;
        }
        const activeParentSpan =
          activeTrustedSpans.get(parentSpanId) ?? activeTrustedSpanAliases.get(parentSpanId);
        if (!activeParentSpan) {
          return undefined;
        }
        return trace.setSpanContext(otelContextApi.active(), activeParentSpan.spanContext());
      };
      const trackTrustedSpan = (
        evt: DiagnosticEventPayload,
        metadata: DiagnosticEventMetadata,
        span: ReturnType<typeof tracer.startSpan>,
      ) => {
        const spanId = trustedTraceContext(evt, metadata)?.spanId;
        if (spanId) {
          activeTrustedSpans.set(spanId, span);
        }
        return span;
      };
      const takeTrackedTrustedSpan = (
        evt: DiagnosticEventPayload,
        metadata: DiagnosticEventMetadata,
      ) => {
        const spanId = trustedTraceContext(evt, metadata)?.spanId;
        if (!spanId) {
          return undefined;
        }
        const span = activeTrustedSpans.get(spanId);
        if (span) {
          activeTrustedSpans.delete(spanId);
        }
        return span;
      };
      const setSpanAttrs = (
        span: ReturnType<typeof tracer.startSpan>,
        attributes: Record<string, string | number | boolean>,
      ) => {
        span.setAttributes?.(redactOtelAttributes(attributes));
      };
      const scheduleTrackedRunSpanFinalize = (
        spanId: string,
        parentSpanId: string | undefined,
        span: ReturnType<typeof tracer.startSpan>,
        endTimeMs: number,
      ) => {
        const existingHandle = pendingTrustedRunFinalizers.get(spanId);
        if (existingHandle) {
          clearImmediate(existingHandle);
        }
        const handle = setImmediate(() => {
          pendingTrustedRunFinalizers.delete(spanId);
          if (activeTrustedSpans.get(spanId) === span) {
            activeTrustedSpans.delete(spanId);
          }
          if (parentSpanId && activeTrustedSpanAliases.get(parentSpanId) === span) {
            activeTrustedSpanAliases.delete(parentSpanId);
          }
          span.end(endTimeMs);
        });
        pendingTrustedRunFinalizers.set(spanId, handle);
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

      const recordModelUsage = (
        evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>,
        metadata: DiagnosticEventMetadata,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.agent": lowCardinalityAttr(evt.agentId),
          "openclaw.provider": evt.provider ?? "unknown",
          "openclaw.model": evt.model ?? "unknown",
        };
        const genAiAttrs: Record<string, string> = {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": lowCardinalityAttr(evt.provider),
          "gen_ai.request.model": lowCardinalityAttr(evt.model),
        };

        const usage = evt.usage;
        if (usage.input) {
          tokensCounter.add(usage.input, { ...attrs, "openclaw.token": "input" });
          genAiTokenUsageHistogram.record(usage.input, {
            ...genAiAttrs,
            "gen_ai.token.type": "input",
          });
        }
        if (usage.output) {
          tokensCounter.add(usage.output, { ...attrs, "openclaw.token": "output" });
          genAiTokenUsageHistogram.record(usage.output, {
            ...genAiAttrs,
            "gen_ai.token.type": "output",
          });
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
        const genAiInputTokens =
          usage.promptTokens ??
          (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "openclaw.tokens.input": usage.input ?? 0,
          "openclaw.tokens.output": usage.output ?? 0,
          "openclaw.tokens.cache_read": usage.cacheRead ?? 0,
          "openclaw.tokens.cache_write": usage.cacheWrite ?? 0,
          "openclaw.tokens.total": usage.total ?? 0,
        };
        assignGenAiSpanIdentityAttrs(spanAttrs, evt);
        assignPositiveNumberAttr(spanAttrs, "gen_ai.usage.input_tokens", genAiInputTokens);
        assignPositiveNumberAttr(spanAttrs, "gen_ai.usage.output_tokens", usage.output);
        assignPositiveNumberAttr(
          spanAttrs,
          "gen_ai.usage.cache_read.input_tokens",
          usage.cacheRead,
        );
        assignPositiveNumberAttr(
          spanAttrs,
          "gen_ai.usage.cache_creation.input_tokens",
          usage.cacheWrite,
        );

        const span = spanWithDuration("openclaw.model.usage", spanAttrs, evt.durationMs, {
          parentContext: activeTrustedParentContext(evt, metadata),
          endTimeMs: evt.ts,
        });
        span.end(evt.ts);
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
          "openclaw.channel": lowCardinalityAttr(evt.channel),
          "openclaw.webhook": lowCardinalityAttr(evt.updateType),
        };
        if (typeof evt.durationMs === "number") {
          webhookDurationHistogram.record(evt.durationMs, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = { ...attrs };
        const span = spanWithDuration("openclaw.webhook.processed", spanAttrs, evt.durationMs);
        span.end();
      };

      const recordWebhookError = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.error" }>,
      ) => {
        const attrs = {
          "openclaw.channel": lowCardinalityAttr(evt.channel),
          "openclaw.webhook": lowCardinalityAttr(evt.updateType),
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
          "openclaw.channel": lowCardinalityAttr(evt.channel),
          "openclaw.source": lowCardinalityAttr(evt.source),
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
          "openclaw.channel": lowCardinalityAttr(evt.channel),
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
        if (evt.reason) {
          spanAttrs["openclaw.reason"] = lowCardinalityAttr(evt.reason, "unknown");
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
        "openclaw.channel": lowCardinalityAttr(evt.channel),
        "openclaw.delivery.kind": lowCardinalityAttr(evt.deliveryKind, "other"),
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

      const recordRunStarted = (
        evt: Extract<DiagnosticEventPayload, { type: "run.started" }>,
        metadata: DiagnosticEventMetadata,
      ) => {
        if (!tracesEnabled || !metadata.trusted) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {};
        addRunAttrs(spanAttrs, evt);
        const span = trackTrustedSpan(
          evt,
          metadata,
          spanWithDuration("openclaw.run", spanAttrs, undefined, {
            parentContext: activeTrustedParentContext(evt, metadata),
            startTimeMs: evt.ts,
          }),
        );
        const parentSpanId = trustedTraceContext(evt, metadata)?.parentSpanId;
        if (parentSpanId && !activeTrustedSpans.has(parentSpanId)) {
          activeTrustedSpanAliases.set(parentSpanId, span);
        }
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

      const sessionRecoveryAttrs = (evt: SessionRecoveryDiagnosticEvent) => {
        const attrs: Record<string, string> = { "openclaw.state": evt.state };
        if (evt.reason) {
          attrs["openclaw.reason"] = redactSensitiveText(evt.reason);
        }
        if (evt.activeWorkKind) {
          attrs["openclaw.active_work_kind"] = evt.activeWorkKind;
        }
        return attrs;
      };

      const recordSessionRecoveryRequested = (
        evt: Extract<DiagnosticEventPayload, { type: "session.recovery.requested" }>,
      ) => {
        const attrs = sessionRecoveryAttrs(evt);
        attrs["openclaw.action"] = evt.allowActiveAbort ? "abort" : "recover";
        sessionRecoveryRequestedCounter.add(1, attrs);
        sessionRecoveryAgeHistogram.record(evt.ageMs, attrs);
      };

      const recordSessionRecoveryCompleted = (
        evt: Extract<DiagnosticEventPayload, { type: "session.recovery.completed" }>,
      ) => {
        const attrs = sessionRecoveryAttrs(evt);
        attrs["openclaw.status"] = evt.status;
        attrs["openclaw.action"] = lowCardinalityAttr(evt.action, "unknown");
        if (evt.outcomeReason) {
          attrs["openclaw.reason"] = redactSensitiveText(evt.outcomeReason);
        }
        sessionRecoveryCompletedCounter.add(1, attrs);
        sessionRecoveryAgeHistogram.record(evt.ageMs, attrs);
      };

      const talkEventAttrs = (evt: TalkDiagnosticEvent): Record<string, string> => ({
        "openclaw.talk.brain": lowCardinalityAttr(evt.brain),
        "openclaw.talk.event_type": lowCardinalityAttr(evt.talkEventType),
        "openclaw.talk.mode": lowCardinalityAttr(evt.mode),
        "openclaw.talk.provider": lowCardinalityAttr(evt.provider),
        "openclaw.talk.transport": lowCardinalityAttr(evt.transport),
      });

      const recordTalkEvent = (evt: TalkDiagnosticEvent, metadata: DiagnosticEventMetadata) => {
        if (!metadata.trusted) {
          return;
        }
        const attrs = talkEventAttrs(evt);
        talkEventCounter.add(1, attrs);
        if (typeof evt.durationMs === "number") {
          talkEventDurationHistogram.record(evt.durationMs, attrs);
        }
        if (typeof evt.byteLength === "number") {
          talkAudioBytesHistogram.record(evt.byteLength, attrs);
        }
      };

      const recordRunAttempt = (evt: Extract<DiagnosticEventPayload, { type: "run.attempt" }>) => {
        runAttemptCounter.add(1, { "openclaw.attempt": evt.attempt });
      };

      const toolLoopAttrs = (
        evt: Extract<DiagnosticEventPayload, { type: "tool.loop" }>,
      ): Record<string, string | number> => ({
        "openclaw.toolName": lowCardinalityAttr(evt.toolName, "tool"),
        "openclaw.loop.level": evt.level,
        "openclaw.loop.action": evt.action,
        "openclaw.loop.detector": evt.detector,
        "openclaw.loop.count": evt.count,
        ...(evt.pairedToolName
          ? { "openclaw.loop.paired_tool": lowCardinalityAttr(evt.pairedToolName, "tool") }
          : {}),
      });

      const recordToolLoop = (evt: Extract<DiagnosticEventPayload, { type: "tool.loop" }>) => {
        const attrs = toolLoopAttrs(evt);
        toolLoopCounter.add(1, attrs);
        if (!tracesEnabled) {
          return;
        }
        const span = spanWithDuration("openclaw.tool.loop", attrs, 0, { endTimeMs: evt.ts });
        if (evt.level === "critical" || evt.action === "block") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `${evt.detector}:${evt.action}`,
          });
        }
        span.end(evt.ts);
      };

      const recordMemoryUsageMetrics = (
        evt: Extract<
          DiagnosticEventPayload,
          { type: "diagnostic.memory.sample" | "diagnostic.memory.pressure" }
        >,
        attrs: Record<string, string> = {},
      ) => {
        memoryRssHistogram.record(evt.memory.rssBytes, attrs);
        memoryHeapUsedHistogram.record(evt.memory.heapUsedBytes, attrs);
        memoryHeapTotalHistogram.record(evt.memory.heapTotalBytes, attrs);
        memoryExternalHistogram.record(evt.memory.externalBytes, attrs);
        memoryArrayBuffersHistogram.record(evt.memory.arrayBuffersBytes, attrs);
      };

      const recordMemorySample = (
        evt: Extract<DiagnosticEventPayload, { type: "diagnostic.memory.sample" }>,
      ) => {
        recordMemoryUsageMetrics(evt);
      };

      const recordMemoryPressure = (
        evt: Extract<DiagnosticEventPayload, { type: "diagnostic.memory.pressure" }>,
      ) => {
        const attrs = {
          "openclaw.memory.level": evt.level,
          "openclaw.memory.reason": evt.reason,
        };
        memoryPressureCounter.add(1, attrs);
        recordMemoryUsageMetrics(evt, attrs);
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          ...attrs,
          "openclaw.memory.rss_bytes": evt.memory.rssBytes,
          "openclaw.memory.heap_used_bytes": evt.memory.heapUsedBytes,
          "openclaw.memory.heap_total_bytes": evt.memory.heapTotalBytes,
          "openclaw.memory.external_bytes": evt.memory.externalBytes,
          "openclaw.memory.array_buffers_bytes": evt.memory.arrayBuffersBytes,
          ...(evt.thresholdBytes !== undefined
            ? { "openclaw.memory.threshold_bytes": evt.thresholdBytes }
            : {}),
          ...(evt.rssGrowthBytes !== undefined
            ? { "openclaw.memory.rss_growth_bytes": evt.rssGrowthBytes }
            : {}),
          ...(evt.windowMs !== undefined ? { "openclaw.memory.window_ms": evt.windowMs } : {}),
        };
        const span = spanWithDuration("openclaw.memory.pressure", spanAttrs, 0, {
          endTimeMs: evt.ts,
        });
        if (evt.level === "critical") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: evt.reason,
          });
        }
        span.end(evt.ts);
      };

      const recordRunCompleted = (
        evt: Extract<DiagnosticEventPayload, { type: "run.completed" }>,
        metadata: DiagnosticEventMetadata,
      ) => {
        const attrs: Record<string, string | number> = {
          "openclaw.outcome": evt.outcome,
          "openclaw.provider": evt.provider ?? "unknown",
          "openclaw.model": evt.model ?? "unknown",
        };
        if (evt.channel) {
          attrs["openclaw.channel"] = evt.channel;
        }
        if (evt.blockedBy) {
          attrs["openclaw.blocked_by"] = lowCardinalityAttr(evt.blockedBy, "unknown");
        }
        durationHistogram.record(evt.durationMs, attrs);
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          "openclaw.outcome": evt.outcome,
        };
        addRunAttrs(spanAttrs, evt);
        if (evt.blockedBy) {
          spanAttrs["openclaw.blocked_by"] = lowCardinalityAttr(evt.blockedBy, "unknown");
        }
        if (evt.errorCategory) {
          spanAttrs["openclaw.errorCategory"] = lowCardinalityAttr(evt.errorCategory, "other");
        }
        const trustedTrace = trustedTraceContext(evt, metadata);
        const trackedSpan = trustedTrace?.spanId
          ? activeTrustedSpans.get(trustedTrace.spanId)
          : undefined;
        const span =
          trackedSpan ??
          spanWithDuration("openclaw.run", spanAttrs, evt.durationMs, {
            parentContext: activeTrustedParentContext(evt, metadata),
            endTimeMs: evt.ts,
          });
        setSpanAttrs(span, spanAttrs);
        if (evt.outcome === "error") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            ...(evt.errorCategory ? { message: redactSensitiveText(evt.errorCategory) } : {}),
          });
        }
        if (trackedSpan && trustedTrace?.spanId) {
          scheduleTrackedRunSpanFinalize(
            trustedTrace.spanId,
            trustedTrace.parentSpanId,
            trackedSpan,
            evt.ts,
          );
          return;
        }
        span.end(evt.ts);
      };

      const harnessRunMetricAttrs = (evt: HarnessRunDiagnosticEvent) => ({
        "openclaw.harness.id": lowCardinalityAttr(evt.harnessId, "unknown"),
        "openclaw.harness.plugin": lowCardinalityAttr(evt.pluginId),
        ...(evt.type === "harness.run.started"
          ? {}
          : {
              "openclaw.outcome": evt.type === "harness.run.error" ? "error" : evt.outcome,
            }),
        "openclaw.provider": lowCardinalityAttr(evt.provider, "unknown"),
        "openclaw.model": lowCardinalityAttr(evt.model, "unknown"),
        ...(evt.channel ? { "openclaw.channel": lowCardinalityAttr(evt.channel) } : {}),
      });

      const recordHarnessRunStarted = (
        evt: Extract<DiagnosticEventPayload, { type: "harness.run.started" }>,
        metadata: DiagnosticEventMetadata,
      ) => {
        if (!tracesEnabled || !metadata.trusted) {
          return;
        }
        trackTrustedSpan(
          evt,
          metadata,
          spanWithDuration("openclaw.harness.run", harnessRunMetricAttrs(evt), undefined, {
            parentContext: activeTrustedParentContext(evt, metadata),
            startTimeMs: evt.ts,
          }),
        );
      };

      const recordHarnessRunCompleted = (
        evt: Extract<DiagnosticEventPayload, { type: "harness.run.completed" }>,
        metadata: DiagnosticEventMetadata,
      ) => {
        harnessDurationHistogram.record(evt.durationMs, harnessRunMetricAttrs(evt));
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          ...harnessRunMetricAttrs(evt),
        };
        if (evt.resultClassification) {
          spanAttrs["openclaw.harness.result_classification"] = lowCardinalityAttr(
            evt.resultClassification,
          );
        }
        if (typeof evt.yieldDetected === "boolean") {
          spanAttrs["openclaw.harness.yield_detected"] = evt.yieldDetected;
        }
        if (evt.itemLifecycle) {
          spanAttrs["openclaw.harness.items.started"] = evt.itemLifecycle.startedCount;
          spanAttrs["openclaw.harness.items.completed"] = evt.itemLifecycle.completedCount;
          spanAttrs["openclaw.harness.items.active"] = evt.itemLifecycle.activeCount;
        }
        const span =
          takeTrackedTrustedSpan(evt, metadata) ??
          spanWithDuration("openclaw.harness.run", spanAttrs, evt.durationMs, {
            parentContext: activeTrustedParentContext(evt, metadata),
            endTimeMs: evt.ts,
          });
        setSpanAttrs(span, spanAttrs);
        if (evt.outcome === "error") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "error",
          });
        }
        span.end(evt.ts);
      };

      const recordHarnessRunError = (
        evt: Extract<DiagnosticEventPayload, { type: "harness.run.error" }>,
        metadata: DiagnosticEventMetadata,
      ) => {
        const errorType = lowCardinalityAttr(evt.errorCategory, "other");
        const attrs = {
          ...harnessRunMetricAttrs(evt),
          "openclaw.harness.phase": evt.phase,
          "openclaw.errorCategory": errorType,
        };
        harnessDurationHistogram.record(evt.durationMs, attrs);
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          ...attrs,
          "error.type": errorType,
          ...(evt.cleanupFailed ? { "openclaw.harness.cleanup_failed": true } : {}),
        };
        const span =
          takeTrackedTrustedSpan(evt, metadata) ??
          spanWithDuration("openclaw.harness.run", spanAttrs, evt.durationMs, {
            parentContext: activeTrustedParentContext(evt, metadata),
            endTimeMs: evt.ts,
          });
        setSpanAttrs(span, spanAttrs);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorType,
        });
        span.end(evt.ts);
      };

      const recordContextAssembled = (
        evt: Extract<DiagnosticEventPayload, { type: "context.assembled" }>,
        metadata: DiagnosticEventMetadata,
      ) => {
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          "openclaw.context.message_count": evt.messageCount,
          "openclaw.context.history_text_chars": evt.historyTextChars,
          "openclaw.context.history_image_blocks": evt.historyImageBlocks,
          "openclaw.context.max_message_text_chars": evt.maxMessageTextChars,
          "openclaw.context.system_prompt_chars": evt.systemPromptChars,
          "openclaw.context.prompt_chars": evt.promptChars,
          "openclaw.context.prompt_images": evt.promptImages,
        };
        addRunAttrs(spanAttrs, evt);
        if (evt.contextTokenBudget !== undefined) {
          spanAttrs["openclaw.context.token_budget"] = evt.contextTokenBudget;
        }
        if (evt.reserveTokens !== undefined) {
          spanAttrs["openclaw.context.reserve_tokens"] = evt.reserveTokens;
        }
        const span = spanWithDuration("openclaw.context.assembled", spanAttrs, 0, {
          parentContext: activeTrustedParentContext(evt, metadata),
          endTimeMs: evt.ts,
        });
        span.end(evt.ts);
      };

      const recordModelFailover = (
        evt: ModelFailoverDiagnosticEvent,
        metadata: DiagnosticEventMetadata,
      ) => {
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          "openclaw.failover.reason": lowCardinalityAttr(evt.reason, "unknown"),
        };
        if (evt.fromProvider) {
          spanAttrs["openclaw.provider"] = evt.fromProvider;
        }
        if (evt.fromModel) {
          spanAttrs["openclaw.model"] = evt.fromModel;
        }
        if (evt.toProvider) {
          spanAttrs["openclaw.failover.to_provider"] = evt.toProvider;
        }
        if (evt.toModel) {
          spanAttrs["openclaw.failover.to_model"] = evt.toModel;
        }
        if (evt.lane) {
          spanAttrs["openclaw.lane"] = lowCardinalityAttr(evt.lane, "unknown");
        }
        if (evt.suspended !== undefined) {
          spanAttrs["openclaw.failover.suspended"] = evt.suspended;
        }
        if (evt.cascadeDepth !== undefined) {
          spanAttrs["openclaw.failover.cascade_depth"] = evt.cascadeDepth;
        }
        const span = spanWithDuration("openclaw.model.failover", spanAttrs, 0, {
          parentContext: activeTrustedParentContext(evt, metadata),
          endTimeMs: evt.ts,
        });
        span.end(evt.ts);
      };

      const modelCallMetricAttrs = (evt: ModelCallLifecycleDiagnosticEvent) => ({
        "openclaw.provider": evt.provider,
        "openclaw.model": evt.model,
        "openclaw.api": lowCardinalityAttr(evt.api),
        "openclaw.transport": lowCardinalityAttr(evt.transport),
      });
      const genAiModelCallMetricAttrs = (
        evt: ModelCallLifecycleDiagnosticEvent,
        errorType?: string,
      ) => ({
        "gen_ai.operation.name": genAiOperationName(evt.api),
        "gen_ai.provider.name": lowCardinalityAttr(evt.provider),
        "gen_ai.request.model": lowCardinalityAttr(evt.model),
        ...(errorType ? { "error.type": errorType } : {}),
      });
      const recordModelCallSizeTimingMetrics = (
        evt: Extract<DiagnosticEventPayload, { type: "model.call.completed" | "model.call.error" }>,
        attrs: ReturnType<typeof modelCallMetricAttrs>,
      ) => {
        const requestPayloadBytes = positiveFiniteNumber(evt.requestPayloadBytes);
        if (requestPayloadBytes !== undefined) {
          modelCallRequestBytesHistogram.record(requestPayloadBytes, attrs);
        }
        const responseStreamBytes = positiveFiniteNumber(evt.responseStreamBytes);
        if (responseStreamBytes !== undefined) {
          modelCallResponseBytesHistogram.record(responseStreamBytes, attrs);
        }
        const timeToFirstByteMs = positiveFiniteNumber(evt.timeToFirstByteMs);
        if (timeToFirstByteMs !== undefined) {
          modelCallTimeToFirstByteHistogram.record(timeToFirstByteMs, attrs);
        }
      };

      const recordModelCallStarted = (
        evt: Extract<DiagnosticEventPayload, { type: "model.call.started" }>,
        metadata: DiagnosticEventMetadata,
      ) => {
        if (!tracesEnabled || !metadata.trusted) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          "openclaw.provider": evt.provider,
          "openclaw.model": evt.model,
        };
        assignGenAiModelCallAttrs(spanAttrs, evt);
        if (evt.api) {
          spanAttrs["openclaw.api"] = evt.api;
        }
        if (evt.transport) {
          spanAttrs["openclaw.transport"] = evt.transport;
        }
        trackTrustedSpan(
          evt,
          metadata,
          spanWithDuration("openclaw.model.call", spanAttrs, undefined, {
            parentContext: activeTrustedParentContext(evt, metadata),
            startTimeMs: evt.ts,
          }),
        );
      };

      const recordModelCallCompleted = (
        evt: Extract<DiagnosticEventPayload, { type: "model.call.completed" }>,
        metadata: DiagnosticEventMetadata,
      ) => {
        const metricAttrs = modelCallMetricAttrs(evt);
        modelCallDurationHistogram.record(evt.durationMs, metricAttrs);
        recordModelCallSizeTimingMetrics(evt, metricAttrs);
        genAiOperationDurationHistogram.record(
          evt.durationMs / 1000,
          genAiModelCallMetricAttrs(evt),
        );
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          "openclaw.provider": evt.provider,
          "openclaw.model": evt.model,
        };
        assignGenAiModelCallAttrs(spanAttrs, evt);
        if (evt.api) {
          spanAttrs["openclaw.api"] = evt.api;
        }
        if (evt.transport) {
          spanAttrs["openclaw.transport"] = evt.transport;
        }
        assignModelCallSizeTimingAttrs(spanAttrs, evt);
        assignOtelModelContentAttributes(
          spanAttrs,
          evt as unknown as Record<string, unknown>,
          contentCapturePolicy,
        );
        const span =
          takeTrackedTrustedSpan(evt, metadata) ??
          spanWithDuration("openclaw.model.call", spanAttrs, evt.durationMs, {
            parentContext: activeTrustedParentContext(evt, metadata),
            endTimeMs: evt.ts,
          });
        setSpanAttrs(span, spanAttrs);
        addUpstreamRequestIdSpanEvent(span, evt.upstreamRequestIdHash);
        span.end(evt.ts);
      };

      const recordModelCallError = (
        evt: Extract<DiagnosticEventPayload, { type: "model.call.error" }>,
        metadata: DiagnosticEventMetadata,
      ) => {
        const errorType = lowCardinalityAttr(evt.errorCategory, "other");
        const metricAttrs = {
          ...modelCallMetricAttrs(evt),
          "openclaw.errorCategory": errorType,
          ...(evt.failureKind
            ? { "openclaw.failureKind": lowCardinalityAttr(evt.failureKind, "other") }
            : {}),
        };
        modelCallDurationHistogram.record(evt.durationMs, metricAttrs);
        recordModelCallSizeTimingMetrics(evt, metricAttrs);
        genAiOperationDurationHistogram.record(
          evt.durationMs / 1000,
          genAiModelCallMetricAttrs(evt, errorType),
        );
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          "openclaw.provider": evt.provider,
          "openclaw.model": evt.model,
          "openclaw.errorCategory": errorType,
          "error.type": errorType,
        };
        if (evt.failureKind) {
          spanAttrs["openclaw.failureKind"] = lowCardinalityAttr(evt.failureKind, "other");
        }
        assignGenAiModelCallAttrs(spanAttrs, evt);
        if (evt.api) {
          spanAttrs["openclaw.api"] = evt.api;
        }
        if (evt.transport) {
          spanAttrs["openclaw.transport"] = evt.transport;
        }
        assignModelCallSizeTimingAttrs(spanAttrs, evt);
        assignOtelModelContentAttributes(
          spanAttrs,
          evt as unknown as Record<string, unknown>,
          contentCapturePolicy,
        );
        const span =
          takeTrackedTrustedSpan(evt, metadata) ??
          spanWithDuration("openclaw.model.call", spanAttrs, evt.durationMs, {
            parentContext: activeTrustedParentContext(evt, metadata),
            endTimeMs: evt.ts,
          });
        setSpanAttrs(span, spanAttrs);
        addUpstreamRequestIdSpanEvent(span, evt.upstreamRequestIdHash);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: redactSensitiveText(evt.errorCategory),
        });
        span.end(evt.ts);
      };

      const toolExecutionBaseAttrs = (
        evt: Extract<
          DiagnosticEventPayload,
          {
            type:
              | "tool.execution.started"
              | "tool.execution.completed"
              | "tool.execution.error"
              | "tool.execution.blocked";
          }
        >,
      ): Record<string, string | number | boolean> => ({
        "openclaw.toolName": evt.toolName,
        "gen_ai.tool.name": evt.toolName,
        ...paramsSummaryAttrs(evt.paramsSummary),
      });

      const recordToolExecutionStarted = (
        evt: Extract<DiagnosticEventPayload, { type: "tool.execution.started" }>,
        metadata: DiagnosticEventMetadata,
      ) => {
        if (!tracesEnabled || !metadata.trusted) {
          return;
        }
        trackTrustedSpan(
          evt,
          metadata,
          spanWithDuration("openclaw.tool.execution", toolExecutionBaseAttrs(evt), undefined, {
            parentContext: activeTrustedParentContext(evt, metadata),
            startTimeMs: evt.ts,
          }),
        );
      };

      const recordToolExecutionCompleted = (
        evt: Extract<DiagnosticEventPayload, { type: "tool.execution.completed" }>,
        metadata: DiagnosticEventMetadata,
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
          ...toolExecutionBaseAttrs(evt),
        };
        addRunAttrs(spanAttrs, evt);
        assignOtelToolContentAttributes(
          spanAttrs,
          evt as unknown as Record<string, unknown>,
          contentCapturePolicy,
        );
        const span =
          takeTrackedTrustedSpan(evt, metadata) ??
          spanWithDuration("openclaw.tool.execution", spanAttrs, evt.durationMs, {
            parentContext: activeTrustedParentContext(evt, metadata),
            endTimeMs: evt.ts,
          });
        setSpanAttrs(span, spanAttrs);
        span.end(evt.ts);
      };

      const recordToolExecutionError = (
        evt: Extract<DiagnosticEventPayload, { type: "tool.execution.error" }>,
        metadata: DiagnosticEventMetadata,
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
          ...toolExecutionBaseAttrs(evt),
          "openclaw.errorCategory": lowCardinalityAttr(evt.errorCategory, "other"),
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
        const span =
          takeTrackedTrustedSpan(evt, metadata) ??
          spanWithDuration("openclaw.tool.execution", spanAttrs, evt.durationMs, {
            parentContext: activeTrustedParentContext(evt, metadata),
            endTimeMs: evt.ts,
          });
        setSpanAttrs(span, spanAttrs);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: redactSensitiveText(evt.errorCategory),
        });
        span.end(evt.ts);
      };

      const recordToolExecutionBlocked = (
        evt: Extract<DiagnosticEventPayload, { type: "tool.execution.blocked" }>,
        metadata: DiagnosticEventMetadata,
      ) => {
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number | boolean> = {
          ...toolExecutionBaseAttrs(evt),
          "openclaw.outcome": "blocked",
          "openclaw.deniedReason": lowCardinalityAttr(evt.deniedReason, "other"),
        };
        addRunAttrs(spanAttrs, evt);
        const span = spanWithDuration("openclaw.tool.execution", spanAttrs, 0, {
          parentContext: activeTrustedParentContext(evt, metadata),
          endTimeMs: evt.ts,
        });
        setSpanAttrs(span, spanAttrs);
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

      const recordLivenessWarning = (
        evt: Extract<DiagnosticEventPayload, { type: "diagnostic.liveness.warning" }>,
      ) => {
        const reason = evt.reasons.join(":");
        const attrs = {
          "openclaw.liveness.reason": lowCardinalityAttr(reason, "unknown"),
        };
        livenessWarningCounter.add(1, attrs);
        queueDepthHistogram.record(evt.queued, { "openclaw.channel": "liveness" });
        if (evt.eventLoopDelayP99Ms !== undefined) {
          livenessEventLoopDelayP99Histogram.record(evt.eventLoopDelayP99Ms, attrs);
        }
        if (evt.eventLoopDelayMaxMs !== undefined) {
          livenessEventLoopDelayMaxHistogram.record(evt.eventLoopDelayMaxMs, attrs);
        }
        if (evt.eventLoopUtilization !== undefined) {
          livenessEventLoopUtilizationHistogram.record(evt.eventLoopUtilization, attrs);
        }
        if (evt.cpuCoreRatio !== undefined) {
          livenessCpuCoreRatioHistogram.record(evt.cpuCoreRatio, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "openclaw.liveness.active": evt.active,
          "openclaw.liveness.waiting": evt.waiting,
          "openclaw.liveness.queued": evt.queued,
          "openclaw.liveness.interval_ms": evt.intervalMs,
          ...(evt.eventLoopDelayP99Ms !== undefined
            ? { "openclaw.liveness.event_loop_delay_p99_ms": evt.eventLoopDelayP99Ms }
            : {}),
          ...(evt.eventLoopDelayMaxMs !== undefined
            ? { "openclaw.liveness.event_loop_delay_max_ms": evt.eventLoopDelayMaxMs }
            : {}),
          ...(evt.eventLoopUtilization !== undefined
            ? { "openclaw.liveness.event_loop_utilization": evt.eventLoopUtilization }
            : {}),
          ...(evt.cpuUserMs !== undefined
            ? { "openclaw.liveness.cpu_user_ms": evt.cpuUserMs }
            : {}),
          ...(evt.cpuSystemMs !== undefined
            ? { "openclaw.liveness.cpu_system_ms": evt.cpuSystemMs }
            : {}),
          ...(evt.cpuTotalMs !== undefined
            ? { "openclaw.liveness.cpu_total_ms": evt.cpuTotalMs }
            : {}),
          ...(evt.cpuCoreRatio !== undefined
            ? { "openclaw.liveness.cpu_core_ratio": evt.cpuCoreRatio }
            : {}),
        };
        const span = spanWithDuration("openclaw.liveness.warning", spanAttrs, 0, {
          endTimeMs: evt.ts,
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: reason,
        });
        span.end(evt.ts);
      };

      const recordDiagnosticPhaseCompleted = (
        evt: Extract<DiagnosticEventPayload, { type: "diagnostic.phase.completed" }>,
      ) => {
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = {
          "openclaw.phase": lowCardinalityAttr(evt.name, "unknown"),
          ...(evt.cpuUserMs !== undefined ? { "openclaw.phase.cpu_user_ms": evt.cpuUserMs } : {}),
          ...(evt.cpuSystemMs !== undefined
            ? { "openclaw.phase.cpu_system_ms": evt.cpuSystemMs }
            : {}),
          ...(evt.cpuTotalMs !== undefined
            ? { "openclaw.phase.cpu_total_ms": evt.cpuTotalMs }
            : {}),
          ...(evt.cpuCoreRatio !== undefined
            ? { "openclaw.phase.cpu_core_ratio": evt.cpuCoreRatio }
            : {}),
        };
        for (const [key, value] of Object.entries(evt.details ?? {})) {
          spanAttrs[`openclaw.phase.detail.${key}`] =
            typeof value === "boolean" ? String(value) : value;
        }
        const span = spanWithDuration("openclaw.diagnostic.phase", spanAttrs, evt.durationMs, {
          endTimeMs: evt.ts,
        });
        span.end(evt.ts);
      };

      const recordTelemetryExporter = (
        evt: TelemetryExporterDiagnosticEvent,
        metadata: DiagnosticEventMetadata,
      ) => {
        if (!metadata.trusted) {
          return;
        }
        telemetryExporterCounter.add(1, {
          "openclaw.exporter": lowCardinalityAttr(evt.exporter, "unknown"),
          "openclaw.signal": evt.signal,
          "openclaw.status": evt.status,
          ...(evt.reason ? { "openclaw.reason": evt.reason } : {}),
          ...(evt.errorCategory
            ? { "openclaw.errorCategory": lowCardinalityAttr(evt.errorCategory, "other") }
            : {}),
        });
      };

      const subscribe = ctx.internalDiagnostics?.onEvent;
      if (!subscribe) {
        ctx.logger.error("diagnostics-otel: internal diagnostics capability unavailable");
        return;
      }

      unsubscribe = subscribe((evt: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) => {
        try {
          switch (evt.type) {
            case "model.usage":
              recordModelUsage(evt, metadata);
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
            case "talk.event":
              recordTalkEvent(evt, metadata);
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
            case "session.long_running":
            case "session.stalled":
              return;
            case "session.stuck":
              recordSessionStuck(evt);
              return;
            case "session.recovery.requested":
              recordSessionRecoveryRequested(evt);
              return;
            case "session.recovery.completed":
              recordSessionRecoveryCompleted(evt);
              return;
            case "run.attempt":
              recordRunAttempt(evt);
              return;
            case "run.progress":
              return;
            case "diagnostic.heartbeat":
              recordHeartbeat(evt);
              return;
            case "diagnostic.liveness.warning":
              recordLivenessWarning(evt);
              return;
            case "diagnostic.phase.completed":
              recordDiagnosticPhaseCompleted(evt);
              return;
            case "run.started":
              recordRunStarted(evt, metadata);
              return;
            case "run.completed":
              recordRunCompleted(evt, metadata);
              return;
            case "harness.run.started":
              recordHarnessRunStarted(evt, metadata);
              return;
            case "harness.run.completed":
              recordHarnessRunCompleted(evt, metadata);
              return;
            case "harness.run.error":
              recordHarnessRunError(evt, metadata);
              return;
            case "context.assembled":
              recordContextAssembled(evt, metadata);
              return;
            case "model.call.started":
              recordModelCallStarted(evt, metadata);
              return;
            case "model.call.completed":
              recordModelCallCompleted(evt, metadata);
              return;
            case "model.call.error":
              recordModelCallError(evt, metadata);
              return;
            case "tool.execution.started":
              recordToolExecutionStarted(evt, metadata);
              return;
            case "tool.execution.completed":
              recordToolExecutionCompleted(evt, metadata);
              return;
            case "tool.execution.error":
              recordToolExecutionError(evt, metadata);
              return;
            case "tool.execution.blocked":
              recordToolExecutionBlocked(evt, metadata);
              return;
            case "exec.process.completed":
              recordExecProcessCompleted(evt);
              return;
            case "log.record":
              recordLogRecord?.(evt, metadata);
              return;
            case "tool.loop":
              recordToolLoop(evt);
              return;
            case "diagnostic.memory.sample":
              recordMemorySample(evt);
              return;
            case "diagnostic.memory.pressure":
              recordMemoryPressure(evt);
              return;
            case "telemetry.exporter":
              recordTelemetryExporter(evt, metadata);
              return;
            case "payload.large":
              return;
            case "model.failover":
              recordModelFailover(evt, metadata);
              return;
          }
        } catch (err) {
          ctx.logger.error(
            `diagnostics-otel: event handler failed (${evt.type}): ${formatError(err)}`,
          );
        }
      });

      emitForSignals(enabledSignals, {
        exporter: "diagnostics-otel",
        status: "started",
        reason: "configured",
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
