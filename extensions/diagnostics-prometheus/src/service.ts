// Diagnostics Prometheus plugin module implements service behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginService,
} from "../api.js";
import { isInternalDiagnosticEventMetadata, redactSensitiveText } from "../api.js";

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
const RATIO_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 2, 4, 8, 16];
const LOW_CARDINALITY_VALUE_RE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const MAX_PROMETHEUS_SERIES = 2048;
const DROPPED_SERIES_COUNTER_NAME = "openclaw_prometheus_series_dropped_total";
function lowCardinalityLabel(value: string | undefined, fallback = "unknown"): string {
  if (!value) {
    return fallback;
  }
  const redacted = redactSensitiveText(value.trim());
  const redactedLower = redacted.toLowerCase();
  if (redactedLower.startsWith("agent:") || redactedLower.includes(":agent:")) {
    return fallback;
  }
  return LOW_CARDINALITY_VALUE_RE.test(redacted) ? redacted : fallback;
}

function lowCardinalityQueueLaneLabel(value: string | undefined, fallback = "unknown"): string {
  if (!value) {
    return fallback;
  }
  const redacted = redactSensitiveText(value.trim());
  const redactedLower = redacted.toLowerCase();
  if (redactedLower.startsWith("agent:")) {
    return fallback;
  }
  const scopedLaneIndex = redacted.indexOf(":");
  const lane = scopedLaneIndex >= 0 ? redacted.slice(0, scopedLaneIndex) : redacted;
  return LOW_CARDINALITY_VALUE_RE.test(lane) ? lane : fallback;
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
  return truncateUtf16Safe(
    redactSensitiveText(message)
      .replaceAll("\u0000", " ")
      .replace(/[\r\n\t\u2028\u2029]/gu, " "),
    500,
  );
}

function shouldRecordDiagnosticEvent(metadata: DiagnosticEventMetadata): boolean {
  return metadata.trusted || isInternalDiagnosticEventMetadata(metadata);
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
  blockedBy?: string;
  channel?: string;
  model?: string;
  outcome?: string;
  provider?: string;
  trigger?: string;
}): LabelSet {
  return {
    ...(evt.blockedBy ? { blocked_by: lowCardinalityLabel(evt.blockedBy) } : {}),
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

function modelFailoverLabels(
  evt: Extract<DiagnosticEventPayload, { type: "model.failover" }>,
): LabelSet {
  return {
    from_model: lowCardinalityLabel(evt.fromModel),
    from_provider: lowCardinalityLabel(evt.fromProvider),
    lane: lowCardinalityQueueLaneLabel(evt.lane),
    reason: lowCardinalityLabel(evt.reason, "other"),
    suspended: evt.suspended === undefined ? "unknown" : String(evt.suspended),
    to_model: lowCardinalityLabel(evt.toModel),
    to_provider: lowCardinalityLabel(evt.toProvider),
  };
}

function toolExecutionLabels(evt: {
  errorCategory?: string;
  paramsSummary?: { kind: string };
  toolName: string;
  toolOwner?: string;
  toolSource?: string;
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
    tool_owner: lowCardinalityLabel(evt.toolOwner, "none"),
    tool_source: lowCardinalityLabel(evt.toolSource, "core"),
  };
}

function toolExecutionBlockedLabels(
  evt: Extract<DiagnosticEventPayload, { type: "tool.execution.blocked" }>,
): LabelSet {
  return {
    denied_reason: lowCardinalityLabel(evt.deniedReason, "other"),
    params_kind: lowCardinalityLabel(evt.paramsSummary?.kind),
    tool: lowCardinalityLabel(evt.toolName, "tool"),
    tool_owner: lowCardinalityLabel(evt.toolOwner, "none"),
    tool_source: lowCardinalityLabel(evt.toolSource, "core"),
  };
}

function skillLabels(evt: {
  activation: string;
  agentId?: string;
  skillName: string;
  skillSource?: string;
}): LabelSet {
  return {
    activation: lowCardinalityLabel(evt.activation, "unknown"),
    agent: lowCardinalityLabel(evt.agentId),
    skill: lowCardinalityLabel(evt.skillName, "skill"),
    source: lowCardinalityLabel(evt.skillSource),
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

function webhookLabels(
  evt: Extract<
    DiagnosticEventPayload,
    { type: "webhook.received" | "webhook.processed" | "webhook.error" }
  >,
): LabelSet {
  return {
    channel: lowCardinalityLabel(evt.channel),
    webhook: lowCardinalityLabel(evt.updateType),
  };
}

function sessionStuckLabels(
  evt: Extract<DiagnosticEventPayload, { type: "session.stuck" }>,
): LabelSet {
  return {
    reason: lowCardinalityLabel(evt.reason, "none"),
    state: evt.state,
  };
}

function sessionRecoveryLabels(
  evt: Extract<
    DiagnosticEventPayload,
    { type: "session.recovery.requested" | "session.recovery.completed" }
  >,
): LabelSet {
  return {
    action:
      evt.type === "session.recovery.completed"
        ? lowCardinalityLabel(evt.action, "unknown")
        : evt.allowActiveAbort
          ? "abort"
          : "recover",
    active_work_kind: lowCardinalityLabel(evt.activeWorkKind, "none"),
    state: evt.state,
    status: evt.type === "session.recovery.completed" ? evt.status : "requested",
  };
}

function livenessLabels(
  evt: Extract<DiagnosticEventPayload, { type: "diagnostic.liveness.warning" }>,
): LabelSet {
  return {
    reason: lowCardinalityLabel(evt.reasons.join(":"), "unknown"),
  };
}

function payloadLargeLabels(
  evt: Extract<DiagnosticEventPayload, { type: "payload.large" }>,
): LabelSet {
  return {
    action: evt.action,
    channel: lowCardinalityLabel(evt.channel, "none"),
    plugin: lowCardinalityLabel(evt.pluginId, "none"),
    reason: lowCardinalityLabel(evt.reason, "none"),
    surface: lowCardinalityLabel(evt.surface, "unknown"),
  };
}

function talkLabels(evt: Extract<DiagnosticEventPayload, { type: "talk.event" }>): LabelSet {
  return {
    brain: lowCardinalityLabel(evt.brain),
    event_type: lowCardinalityLabel(evt.talkEventType),
    mode: lowCardinalityLabel(evt.mode),
    provider: lowCardinalityLabel(evt.provider),
    transport: lowCardinalityLabel(evt.transport),
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
  if (!shouldRecordDiagnosticEvent(metadata)) {
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
    case "model.failover":
      store.counter(
        "openclaw_model_failover_total",
        "Model failovers by source, destination, lane, and reason.",
        modelFailoverLabels(evt),
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
    case "tool.execution.blocked":
      store.counter(
        "openclaw_tool_execution_blocked_total",
        "Tool executions blocked by policy or sandbox diagnostics.",
        toolExecutionBlockedLabels(evt),
      );
      return;
    case "skill.used":
      store.counter("openclaw_skill_used_total", "Skills used by agent runs.", skillLabels(evt));
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
    case "webhook.received":
      store.counter(
        "openclaw_webhook_received_total",
        "Webhook requests received by channel and update type.",
        webhookLabels(evt),
      );
      return;
    case "webhook.processed":
      store.histogram(
        "openclaw_webhook_duration_seconds",
        "Webhook processing duration in seconds.",
        webhookLabels(evt),
        seconds(evt.durationMs),
      );
      return;
    case "webhook.error":
      store.counter(
        "openclaw_webhook_error_total",
        "Webhook processing errors by channel and update type.",
        webhookLabels(evt),
      );
      return;
    case "message.delivery.started":
      store.counter(
        "openclaw_message_delivery_started_total",
        "Outbound message delivery attempts started.",
        {
          channel: lowCardinalityLabel(evt.channel),
          delivery_kind: lowCardinalityLabel(evt.deliveryKind, "other"),
        },
      );
      return;
    case "message.received":
      store.counter("openclaw_message_received_total", "Inbound messages received by channel.", {
        channel: lowCardinalityLabel(evt.channel),
        source: lowCardinalityLabel(evt.source),
      });
      return;
    case "message.dispatch.started":
      store.counter(
        "openclaw_message_dispatch_started_total",
        "Inbound message dispatch attempts started by channel.",
        {
          channel: lowCardinalityLabel(evt.channel),
          source: lowCardinalityLabel(evt.source),
        },
      );
      return;
    case "message.dispatch.completed":
      store.counter(
        "openclaw_message_dispatch_completed_total",
        "Inbound message dispatch attempts completed by outcome.",
        {
          channel: lowCardinalityLabel(evt.channel),
          outcome: evt.outcome,
          reason: lowCardinalityLabel(evt.reason, "none"),
          source: lowCardinalityLabel(evt.source),
        },
      );
      store.histogram(
        "openclaw_message_dispatch_duration_seconds",
        "Inbound message dispatch duration in seconds.",
        {
          channel: lowCardinalityLabel(evt.channel),
          outcome: evt.outcome,
          reason: lowCardinalityLabel(evt.reason, "none"),
          source: lowCardinalityLabel(evt.source),
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
          delivery_kind: lowCardinalityLabel(evt.deliveryKind, "other"),
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
          delivery_kind: lowCardinalityLabel(evt.deliveryKind, "other"),
          error_category:
            evt.type === "message.delivery.error"
              ? lowCardinalityLabel(evt.errorCategory, "other")
              : "none",
          outcome: evt.type === "message.delivery.error" ? "error" : "completed",
        },
        seconds(evt.durationMs),
      );
      return;
    case "talk.event":
      store.counter("openclaw_talk_event_total", "Talk events emitted by type.", talkLabels(evt));
      store.histogram(
        "openclaw_talk_event_duration_seconds",
        "Talk event duration in seconds when reported.",
        talkLabels(evt),
        seconds(evt.durationMs),
      );
      store.histogram(
        "openclaw_talk_audio_bytes",
        "Talk audio frame byte lengths.",
        talkLabels(evt),
        numericValue(evt.byteLength),
        BYTE_BUCKETS,
      );
      return;
    case "session.recovery.requested":
    case "session.recovery.completed":
      store.counter(
        "openclaw_session_recovery_total",
        "Session recovery observations by status and action.",
        sessionRecoveryLabels(evt),
      );
      store.histogram(
        "openclaw_session_recovery_age_seconds",
        "Age of sessions selected for recovery in seconds.",
        sessionRecoveryLabels(evt),
        seconds(evt.ageMs),
      );
      return;
    case "queue.lane.enqueue":
    case "queue.lane.dequeue":
      store.gauge(
        "openclaw_queue_lane_size",
        "Current diagnostic queue lane size.",
        {
          lane: lowCardinalityQueueLaneLabel(evt.lane),
        },
        numericValue(evt.queueSize),
      );
      if (evt.type === "queue.lane.dequeue") {
        store.histogram(
          "openclaw_queue_lane_wait_seconds",
          "Queue lane wait time in seconds.",
          { lane: lowCardinalityQueueLaneLabel(evt.lane) },
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
    case "session.stuck":
      store.counter(
        "openclaw_session_stuck_total",
        "Stale session bookkeeping observations with no active work.",
        sessionStuckLabels(evt),
      );
      store.histogram(
        "openclaw_session_stuck_age_seconds",
        "Age of stale session bookkeeping observations in seconds.",
        sessionStuckLabels(evt),
        seconds(evt.ageMs),
      );
      return;
    case "session.turn.created":
      store.counter("openclaw_session_turn_created_total", "Agent session turns created.", {
        agent: lowCardinalityLabel(evt.agentId),
        channel: lowCardinalityLabel(evt.channel),
        trigger: evt.trigger,
      });
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
    case "diagnostic.liveness.warning":
      store.counter(
        "openclaw_liveness_warning_total",
        "Diagnostic liveness warning events.",
        livenessLabels(evt),
      );
      store.gauge(
        "openclaw_liveness_sessions",
        "Latest session counts reported with diagnostic liveness warnings.",
        { state: "active" },
        numericValue(evt.active),
      );
      store.gauge(
        "openclaw_liveness_sessions",
        "Latest session counts reported with diagnostic liveness warnings.",
        { state: "waiting" },
        numericValue(evt.waiting),
      );
      store.gauge(
        "openclaw_liveness_sessions",
        "Latest session counts reported with diagnostic liveness warnings.",
        { state: "queued" },
        numericValue(evt.queued),
      );
      store.histogram(
        "openclaw_liveness_event_loop_delay_p99_seconds",
        "P99 event-loop delay reported by diagnostic liveness warnings in seconds.",
        livenessLabels(evt),
        seconds(evt.eventLoopDelayP99Ms),
      );
      store.histogram(
        "openclaw_liveness_event_loop_delay_max_seconds",
        "Maximum event-loop delay reported by diagnostic liveness warnings in seconds.",
        livenessLabels(evt),
        seconds(evt.eventLoopDelayMaxMs),
      );
      store.histogram(
        "openclaw_liveness_event_loop_utilization_ratio",
        "Event-loop utilization reported by diagnostic liveness warnings.",
        livenessLabels(evt),
        numericValue(evt.eventLoopUtilization),
        RATIO_BUCKETS,
      );
      store.histogram(
        "openclaw_liveness_cpu_core_ratio",
        "CPU core ratio reported by diagnostic liveness warnings.",
        livenessLabels(evt),
        numericValue(evt.cpuCoreRatio),
        RATIO_BUCKETS,
      );
      return;
    case "diagnostic.async_queue.dropped":
      store.counter(
        "openclaw_diagnostic_async_queue_dropped_total",
        "Async diagnostic queue drops by dropped event class.",
        { drop_class: "total" },
        numericValue(evt.droppedEvents),
      );
      if (evt.droppedTrustedEvents !== undefined) {
        store.counter(
          "openclaw_diagnostic_async_queue_dropped_total",
          "Async diagnostic queue drops by dropped event class.",
          { drop_class: "trusted" },
          numericValue(evt.droppedTrustedEvents),
        );
      }
      if (evt.droppedUntrustedEvents !== undefined) {
        store.counter(
          "openclaw_diagnostic_async_queue_dropped_total",
          "Async diagnostic queue drops by dropped event class.",
          { drop_class: "untrusted" },
          numericValue(evt.droppedUntrustedEvents),
        );
      }
      if (evt.droppedPriorityEvents !== undefined) {
        store.counter(
          "openclaw_diagnostic_async_queue_dropped_total",
          "Async diagnostic queue drops by dropped event class.",
          { drop_class: "priority" },
          numericValue(evt.droppedPriorityEvents),
        );
      }
      store.gauge(
        "openclaw_diagnostic_async_queue_length",
        "Latest async diagnostic queue length after a drop summary.",
        {},
        numericValue(evt.queueLength),
      );
      return;
    case "diagnostic.heartbeat":
      return;
    case "telemetry.exporter":
      store.counter("openclaw_telemetry_exporter_total", "Telemetry exporter lifecycle events.", {
        exporter: lowCardinalityLabel(evt.exporter),
        reason: lowCardinalityLabel(evt.reason, "none"),
        signal: evt.signal,
        status: evt.status,
      });
      return;
    case "payload.large":
      store.counter(
        "openclaw_payload_large_total",
        "Oversized payload diagnostics by surface and action.",
        payloadLargeLabels(evt),
      );
      store.histogram(
        "openclaw_payload_large_bytes",
        "Oversized payload byte sizes by surface and action.",
        payloadLargeLabels(evt),
        numericValue(evt.bytes),
        BYTE_BUCKETS,
      );
    default:
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

export const testApi = {
  createPrometheusMetricStore,
  recordDiagnosticEvent,
  renderPrometheusMetrics,
};
export { testApi as __test__ };
