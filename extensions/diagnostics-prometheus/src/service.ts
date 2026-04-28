import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginService,
} from "../api.js";
import { redactSensitiveText } from "../api.js";

type LabelSet = Record<string, string>;

type CounterSample = {
  help: string;
  labels: LabelSet;
  value: number;
};

type HistogramSample = {
  buckets: number[];
  counts: number[];
  count: number;
  help: string;
  labels: LabelSet;
  sum: number;
};

type GaugeSample = {
  help: string;
  labels: LabelSet;
  value: number;
};

type MetricSnapshot = {
  counters: Map<string, CounterSample>;
  gauges: Map<string, GaugeSample>;
  histograms: Map<string, HistogramSample>;
};

type PrometheusMetricStore = ReturnType<typeof createPrometheusMetricStore>;

const DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
];
const TOKEN_BUCKETS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576];
const BYTE_BUCKETS = [
  1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864, 268435456, 1073741824,
  4294967296, 17179869184,
];
const LOW_CARDINALITY_VALUE_RE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const MAX_PROMETHEUS_SERIES = 2048;
const DROPPED_SERIES_COUNTER_NAME = "openclaw_prometheus_series_dropped_total";

function lowCardinalityLabel(value: string | undefined, fallback = "unknown"): string {
  if (!value) {
    return fallback;
  }
  const redacted = redactSensitiveText(value.trim());
  return LOW_CARDINALITY_VALUE_RE.test(redacted) ? redacted : fallback;
}

function numericValue(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function seconds(ms: number | undefined): number | undefined {
  const value = numericValue(ms);
  return value === undefined ? undefined : value / 1000;
}

function sortedLabels(labels: LabelSet): [string, string][] {
  return Object.entries(labels).toSorted(([left], [right]) => left.localeCompare(right));
}

function metricKey(name: string, labels: LabelSet): string {
  return `${name}|${JSON.stringify(sortedLabels(labels))}`;
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabels(labels: LabelSet): string {
  const entries = sortedLabels(labels);
  if (entries.length === 0) {
    return "";
  }
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

function formatPrometheusNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
}

function createPrometheusMetricStore() {
  const counters = new Map<string, CounterSample>();
  const gauges = new Map<string, GaugeSample>();
  const histograms = new Map<string, HistogramSample>();
  let droppedSeries = 0;

  const canCreateSeries = <T>(map: Map<string, T>, key: string, metricName: string): boolean => {
    if (map.has(key)) {
      return true;
    }
    if (metricName === DROPPED_SERIES_COUNTER_NAME) {
      return true;
    }
    if (counters.size + gauges.size + histograms.size < MAX_PROMETHEUS_SERIES) {
      return true;
    }
    droppedSeries += 1;
    return false;
  };

  const counter = (name: string, help: string, labels: LabelSet, amount = 1) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    const key = metricKey(name, labels);
    if (!canCreateSeries(counters, key, name)) {
      return;
    }
    const existing = counters.get(key);
    if (existing) {
      existing.value += amount;
      return;
    }
    counters.set(key, { help, labels, value: amount });
  };

  const gauge = (name: string, help: string, labels: LabelSet, value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value)) {
      return;
    }
    const key = metricKey(name, labels);
    if (!canCreateSeries(gauges, key, name)) {
      return;
    }
    gauges.set(key, { help, labels, value });
  };

  const histogram = (
    name: string,
    help: string,
    labels: LabelSet,
    value: number | undefined,
    buckets = DURATION_BUCKETS_SECONDS,
  ) => {
    if (value === undefined || !Number.isFinite(value) || value < 0) {
      return;
    }
    const key = metricKey(name, labels);
    if (!canCreateSeries(histograms, key, name)) {
      return;
    }
    let sample = histograms.get(key);
    if (!sample) {
      sample = {
        buckets,
        counts: buckets.map(() => 0),
        count: 0,
        help,
        labels,
        sum: 0,
      };
      histograms.set(key, sample);
    }
    sample.count += 1;
    sample.sum += value;
    for (let index = 0; index < sample.buckets.length; index += 1) {
      const bucket = sample.buckets[index];
      if (bucket !== undefined && value <= bucket) {
        sample.counts[index] = (sample.counts[index] ?? 0) + 1;
      }
    }
  };

  const snapshot = (): MetricSnapshot => {
    const counterSnapshot = new Map(counters);
    if (droppedSeries > 0) {
      counterSnapshot.set(metricKey(DROPPED_SERIES_COUNTER_NAME, {}), {
        help: "Prometheus metric series dropped because the exporter series cap was reached.",
        labels: {},
        value: droppedSeries,
      });
    }
    return {
      counters: counterSnapshot,
      gauges: new Map(gauges),
      histograms: new Map(histograms),
    };
  };

  const reset = () => {
    counters.clear();
    gauges.clear();
    histograms.clear();
    droppedSeries = 0;
  };

  return { counter, gauge, histogram, reset, snapshot };
}

function safeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? (err.message ?? err.name) : String(err);
  return redactSensitiveText(message)
    .replaceAll("\u0000", " ")
    .replace(/[\r\n\t\u2028\u2029]/gu, " ")
    .slice(0, 500);
}

function renderPrometheusMetrics(store: PrometheusMetricStore): string {
  const snapshot = store.snapshot();
  const lines: string[] = [];
  const emitted = new Set<string>();

  const emitHeader = (name: string, type: "counter" | "gauge" | "histogram", help: string) => {
    if (emitted.has(name)) {
      return;
    }
    emitted.add(name);
    lines.push(`# HELP ${name} ${escapeHelp(help)}`);
    lines.push(`# TYPE ${name} ${type}`);
  };

  const counterEntries = [...snapshot.counters.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [key, sample] of counterEntries) {
    const name = key.split("|", 1)[0] ?? "";
    emitHeader(name, "counter", sample.help);
    lines.push(`${name}${formatLabels(sample.labels)} ${formatPrometheusNumber(sample.value)}`);
  }

  const gaugeEntries = [...snapshot.gauges.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [key, sample] of gaugeEntries) {
    const name = key.split("|", 1)[0] ?? "";
    emitHeader(name, "gauge", sample.help);
    lines.push(`${name}${formatLabels(sample.labels)} ${formatPrometheusNumber(sample.value)}`);
  }

  const histogramEntries = [...snapshot.histograms.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [key, sample] of histogramEntries) {
    const name = key.split("|", 1)[0] ?? "";
    emitHeader(name, "histogram", sample.help);
    for (let index = 0; index < sample.buckets.length; index += 1) {
      const bucket = sample.buckets[index];
      if (bucket === undefined) {
        continue;
      }
      lines.push(
        `${name}_bucket${formatLabels({ ...sample.labels, le: String(bucket) })} ${formatPrometheusNumber(sample.counts[index] ?? 0)}`,
      );
    }
    lines.push(
      `${name}_bucket${formatLabels({ ...sample.labels, le: "+Inf" })} ${formatPrometheusNumber(sample.count)}`,
    );
    lines.push(`${name}_sum${formatLabels(sample.labels)} ${formatPrometheusNumber(sample.sum)}`);
    lines.push(
      `${name}_count${formatLabels(sample.labels)} ${formatPrometheusNumber(sample.count)}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

function runLabels(evt: {
  channel?: string;
  model?: string;
  outcome?: string;
  provider?: string;
  trigger?: string;
}): LabelSet {
  return {
    channel: lowCardinalityLabel(evt.channel),
    model: lowCardinalityLabel(evt.model),
    outcome: lowCardinalityLabel(evt.outcome, "unknown"),
    provider: lowCardinalityLabel(evt.provider),
    trigger: lowCardinalityLabel(evt.trigger),
  };
}

function modelCallLabels(evt: {
  api?: string;
  errorCategory?: string;
  model?: string;
  provider?: string;
  transport?: string;
  type: string;
}): LabelSet {
  return {
    api: lowCardinalityLabel(evt.api),
    error_category:
      evt.type === "model.call.error" ? lowCardinalityLabel(evt.errorCategory, "other") : "none",
    model: lowCardinalityLabel(evt.model),
    outcome: evt.type === "model.call.error" ? "error" : "completed",
    provider: lowCardinalityLabel(evt.provider),
    transport: lowCardinalityLabel(evt.transport),
  };
}

function toolExecutionLabels(evt: {
  errorCategory?: string;
  paramsSummary?: { kind: string };
  toolName: string;
  type: string;
}): LabelSet {
  return {
    error_category:
      evt.type === "tool.execution.error"
        ? lowCardinalityLabel(evt.errorCategory, "other")
        : "none",
    outcome: evt.type === "tool.execution.error" ? "error" : "completed",
    params_kind: lowCardinalityLabel(evt.paramsSummary?.kind),
    tool: lowCardinalityLabel(evt.toolName, "tool"),
  };
}

function harnessLabels(evt: {
  channel?: string;
  errorCategory?: string;
  harnessId: string;
  model?: string;
  outcome?: string;
  phase?: string;
  pluginId?: string;
  provider?: string;
  type: string;
}): LabelSet {
  return {
    channel: lowCardinalityLabel(evt.channel),
    error_category:
      evt.type === "harness.run.error" ? lowCardinalityLabel(evt.errorCategory, "other") : "none",
    harness: lowCardinalityLabel(evt.harnessId),
    model: lowCardinalityLabel(evt.model),
    outcome: evt.type === "harness.run.error" ? "error" : lowCardinalityLabel(evt.outcome),
    phase: evt.type === "harness.run.error" ? lowCardinalityLabel(evt.phase) : "none",
    plugin: lowCardinalityLabel(evt.pluginId),
    provider: lowCardinalityLabel(evt.provider),
  };
}

function recordModelUsage(
  store: PrometheusMetricStore,
  evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>,
) {
  const labels = {
    agent: lowCardinalityLabel(evt.agentId),
    channel: lowCardinalityLabel(evt.channel),
    model: lowCardinalityLabel(evt.model),
    provider: lowCardinalityLabel(evt.provider),
  };
  const usage = evt.usage;
  const recordTokens = (tokenType: string, value: number | undefined) => {
    const amount = numericValue(value);
    if (amount === undefined || amount === 0) {
      return;
    }
    store.counter(
      "openclaw_model_tokens_total",
      "Model tokens reported by diagnostic usage events.",
      {
        ...labels,
        token_type: tokenType,
      },
      amount,
    );
    if (tokenType === "input" || tokenType === "output") {
      store.histogram(
        "openclaw_gen_ai_client_token_usage",
        "GenAI token usage distribution for input and output tokens.",
        {
          model: labels.model,
          provider: labels.provider,
          token_type: tokenType,
        },
        amount,
        TOKEN_BUCKETS,
      );
    }
  };

  recordTokens("input", usage.input);
  recordTokens("output", usage.output);
  recordTokens("cache_read", usage.cacheRead);
  recordTokens("cache_write", usage.cacheWrite);
  recordTokens("prompt", usage.promptTokens);
  recordTokens("total", usage.total);

  store.counter(
    "openclaw_model_cost_usd_total",
    "Estimated model cost in USD reported by diagnostic usage events.",
    labels,
    numericValue(evt.costUsd) ?? 0,
  );
  store.histogram(
    "openclaw_model_usage_duration_seconds",
    "Model usage event duration in seconds.",
    labels,
    seconds(evt.durationMs),
  );
}

function recordDiagnosticEvent(
  store: PrometheusMetricStore,
  evt: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
): void {
  if (!metadata.trusted) {
    return;
  }

  switch (evt.type) {
    case "model.usage":
      recordModelUsage(store, evt);
      return;
    case "run.completed":
      store.histogram(
        "openclaw_run_duration_seconds",
        "Agent run duration in seconds.",
        runLabels(evt),
        seconds(evt.durationMs),
      );
      store.counter(
        "openclaw_run_completed_total",
        "Agent runs completed by outcome.",
        runLabels(evt),
      );
      return;
    case "model.call.completed":
    case "model.call.error":
      store.histogram(
        "openclaw_model_call_duration_seconds",
        "Provider model call duration in seconds.",
        modelCallLabels(evt),
        seconds(evt.durationMs),
      );
      store.counter(
        "openclaw_model_call_total",
        "Provider model calls completed by outcome.",
        modelCallLabels(evt),
      );
      return;
    case "tool.execution.completed":
    case "tool.execution.error":
      store.histogram(
        "openclaw_tool_execution_duration_seconds",
        "Tool execution duration in seconds.",
        toolExecutionLabels(evt),
        seconds(evt.durationMs),
      );
      store.counter(
        "openclaw_tool_execution_total",
        "Tool executions completed by outcome.",
        toolExecutionLabels(evt),
      );
      return;
    case "harness.run.completed":
    case "harness.run.error":
      store.histogram(
        "openclaw_harness_run_duration_seconds",
        "Agent harness run duration in seconds.",
        harnessLabels(evt),
        seconds(evt.durationMs),
      );
      store.counter(
        "openclaw_harness_run_total",
        "Agent harness runs completed by outcome.",
        harnessLabels(evt),
      );
      return;
    case "message.processed":
      store.counter("openclaw_message_processed_total", "Inbound messages processed by outcome.", {
        channel: lowCardinalityLabel(evt.channel),
        outcome: evt.outcome,
        reason: lowCardinalityLabel(evt.reason, "none"),
      });
      store.histogram(
        "openclaw_message_processed_duration_seconds",
        "Inbound message processing duration in seconds.",
        {
          channel: lowCardinalityLabel(evt.channel),
          outcome: evt.outcome,
          reason: lowCardinalityLabel(evt.reason, "none"),
        },
        seconds(evt.durationMs),
      );
      return;
    case "message.delivery.completed":
    case "message.delivery.error":
      store.counter(
        "openclaw_message_delivery_total",
        "Outbound message delivery attempts by outcome.",
        {
          channel: lowCardinalityLabel(evt.channel),
          delivery_kind: evt.deliveryKind,
          error_category:
            evt.type === "message.delivery.error"
              ? lowCardinalityLabel(evt.errorCategory, "other")
              : "none",
          outcome: evt.type === "message.delivery.error" ? "error" : "completed",
        },
      );
      store.histogram(
        "openclaw_message_delivery_duration_seconds",
        "Outbound message delivery duration in seconds.",
        {
          channel: lowCardinalityLabel(evt.channel),
          delivery_kind: evt.deliveryKind,
          error_category:
            evt.type === "message.delivery.error"
              ? lowCardinalityLabel(evt.errorCategory, "other")
              : "none",
          outcome: evt.type === "message.delivery.error" ? "error" : "completed",
        },
        seconds(evt.durationMs),
      );
      return;
    case "queue.lane.enqueue":
    case "queue.lane.dequeue":
      store.gauge(
        "openclaw_queue_lane_size",
        "Current diagnostic queue lane size.",
        {
          lane: lowCardinalityLabel(evt.lane),
        },
        numericValue(evt.queueSize),
      );
      if (evt.type === "queue.lane.dequeue") {
        store.histogram(
          "openclaw_queue_lane_wait_seconds",
          "Queue lane wait time in seconds.",
          { lane: lowCardinalityLabel(evt.lane) },
          seconds(evt.waitMs),
        );
      }
      return;
    case "session.state":
      store.counter("openclaw_session_state_total", "Session state observations.", {
        reason: lowCardinalityLabel(evt.reason, "none"),
        state: evt.state,
      });
      if (evt.queueDepth !== undefined) {
        store.gauge(
          "openclaw_session_queue_depth",
          "Latest observed session queue depth.",
          {
            state: evt.state,
          },
          numericValue(evt.queueDepth),
        );
      }
      return;
    case "diagnostic.memory.sample":
      store.gauge(
        "openclaw_memory_bytes",
        "Latest process memory usage by memory kind.",
        { kind: "rss" },
        evt.memory.rssBytes,
      );
      store.gauge(
        "openclaw_memory_bytes",
        "Latest process memory usage by memory kind.",
        { kind: "heap_total" },
        evt.memory.heapTotalBytes,
      );
      store.gauge(
        "openclaw_memory_bytes",
        "Latest process memory usage by memory kind.",
        { kind: "heap_used" },
        evt.memory.heapUsedBytes,
      );
      store.histogram(
        "openclaw_memory_rss_bytes",
        "RSS memory sample distribution in bytes.",
        {},
        numericValue(evt.memory.rssBytes),
        BYTE_BUCKETS,
      );
      return;
    case "diagnostic.memory.pressure":
      store.counter(
        "openclaw_memory_pressure_total",
        "Memory pressure events by level and reason.",
        {
          level: evt.level,
          reason: evt.reason,
        },
      );
      return;
    case "diagnostic.heartbeat":
    case "diagnostic.liveness.warning":
      return;
    case "telemetry.exporter":
      store.counter("openclaw_telemetry_exporter_total", "Telemetry exporter lifecycle events.", {
        exporter: lowCardinalityLabel(evt.exporter),
        reason: lowCardinalityLabel(evt.reason, "none"),
        signal: evt.signal,
        status: evt.status,
      });
      return;
    default:
      return;
  }
}

function createMetricsHandler(store: PrometheusMetricStore): OpenClawPluginHttpRouteHandler {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end("Method Not Allowed");
      return true;
    }

    const body = renderPrometheusMetrics(store);
    res.statusCode = 200;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    res.end(body);
    return true;
  };
}

export function createDiagnosticsPrometheusExporter() {
  const store = createPrometheusMetricStore();
  let unsubscribe: (() => void) | undefined;

  const service = {
    id: "diagnostics-prometheus",
    start(ctx) {
      const subscribe = ctx.internalDiagnostics?.onEvent;
      if (!subscribe) {
        ctx.logger.error("diagnostics-prometheus: internal diagnostics capability unavailable");
        return;
      }
      unsubscribe = subscribe((event, metadata) => {
        try {
          recordDiagnosticEvent(store, event, metadata);
        } catch (err) {
          ctx.logger.error(
            `diagnostics-prometheus: event handler failed (${event.type}): ${safeErrorMessage(err)}`,
          );
        }
      });
      ctx.internalDiagnostics?.emit({
        type: "telemetry.exporter",
        exporter: "diagnostics-prometheus",
        signal: "metrics",
        status: "started",
        reason: "configured",
      });
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      store.reset();
    },
  } satisfies OpenClawPluginService;

  return {
    handler: createMetricsHandler(store),
    render: () => renderPrometheusMetrics(store),
    service,
  };
}

export const __test__ = {
  createPrometheusMetricStore,
  recordDiagnosticEvent,
  renderPrometheusMetrics,
};
