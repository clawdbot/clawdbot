export const DEFAULT_SERVICE_NAME = "openclaw";
export const DROPPED_OTEL_ATTRIBUTE_KEYS = new Set([
  "openclaw.callId",
  "openclaw.call_id",
  "openclaw.chatId",
  "openclaw.chat_id",
  "openclaw.messageId",
  "openclaw.message_id",
  "openclaw.parentSpanId",
  "openclaw.parent_span_id",
  "openclaw.runId",
  "openclaw.run_id",
  "openclaw.sessionId",
  "openclaw.session_id",
  "openclaw.sessionKey",
  "openclaw.session_key",
  "openclaw.spanId",
  "openclaw.span_id",
  "openclaw.toolCallId",
  "openclaw.tool_call_id",
  "openclaw.traceId",
  "openclaw.trace_id",
]);
export const LOW_CARDINALITY_VALUE_RE = /^[A-Za-z0-9_.:-]{1,120}$/u;
export const SECURITY_TARGET_NAME_VALUE_RE = /^[A-Za-z0-9@/_.:-]{1,256}$/u;
export const MAX_OTEL_LOG_BODY_CHARS = 4 * 1024;
export const MAX_OTEL_LOG_ATTRIBUTE_COUNT = 64;
export const MAX_OTEL_LOG_ATTRIBUTE_VALUE_CHARS = 4 * 1024;
export const LOG_RECORD_EXPORT_FAILURE_REPORT_INTERVAL_MS = 60_000;
export const OTEL_LOG_RAW_ATTRIBUTE_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/u;
export const OTEL_LOG_ATTRIBUTE_KEY_RE = /^[A-Za-z0-9_.:-]{1,96}$/u;
export const BLOCKED_OTEL_LOG_ATTRIBUTE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export const OTEL_EXPORTER_OTLP_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT";
export const OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";
export const OTEL_EXPORTER_OTLP_METRICS_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT";
export const OTEL_EXPORTER_OTLP_LOGS_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT";
export const OTEL_EXPORTER_OTLP_CERTIFICATE_ENV = "OTEL_EXPORTER_OTLP_CERTIFICATE";
export const OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE_ENV = "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE";
export const OTEL_EXPORTER_OTLP_CLIENT_KEY_ENV = "OTEL_EXPORTER_OTLP_CLIENT_KEY";
export const OTEL_SEMCONV_STABILITY_OPT_IN_ENV = "OTEL_SEMCONV_STABILITY_OPT_IN";
export const GEN_AI_LATEST_EXPERIMENTAL_OPT_IN = "gen_ai_latest_experimental";
export const GEN_AI_TOKEN_USAGE_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
];
export const GEN_AI_OPERATION_DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];
// Preserve the SDK's existing finite boundaries so upgrades do not remove
// exported bucket series that dashboards or alerts may already reference.
const OTEL_DEFAULT_HISTOGRAM_BUCKETS = [
  0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
];
// Agent run / harness durations routinely exceed the SDK default's 10s ceiling.
// Extend the existing layout through one hour without changing prior buckets.
export const AGENT_DURATION_MS_BUCKETS = [
  ...OTEL_DEFAULT_HISTOGRAM_BUCKETS,
  15000,
  20000,
  30000,
  45000,
  60000,
  120000,
  180000,
  240000,
  300000,
  600000,
  900000,
  1_800_000,
  3_600_000,
];
// openclaw.context.tokens records context window limit/used token counts, which
// range from a few thousand to >1M for large-context models. Keep the prior
// layout and add common context-window sizes above it.
export const CONTEXT_TOKENS_BUCKETS = [
  ...OTEL_DEFAULT_HISTOGRAM_BUCKETS,
  16000,
  32000,
  64000,
  128000,
  200000,
  400000,
  1_000_000,
  2_000_000,
];
export const MAX_RETAINED_TRUSTED_SPAN_CONTEXTS = 1024;
export const RETAINED_TRUSTED_SPAN_CONTEXT_TIMEOUT_MS = 5_000;
