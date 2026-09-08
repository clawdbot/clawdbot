import type { Meter, MetricOptions } from "@opentelemetry/api";
import {
  AGENT_DURATION_MS_BUCKETS,
  CONTEXT_TOKENS_BUCKETS,
  GEN_AI_OPERATION_DURATION_BUCKETS,
  GEN_AI_TOKEN_USAGE_BUCKETS,
} from "./service-constants.js";

const DEFAULT_METRIC_NAME_PREFIX = "openclaw.";

export function createDiagnosticsMetrics(
  meter: Meter,
  metricNamePrefix = DEFAULT_METRIC_NAME_PREFIX,
) {
  const resolveMetricName = (name: `openclaw.${string}`) =>
    `${metricNamePrefix}${name.slice(DEFAULT_METRIC_NAME_PREFIX.length)}`;
  const createCounter = (name: `openclaw.${string}`, options?: MetricOptions) =>
    meter.createCounter(resolveMetricName(name), options);
  const createHistogram = (name: `openclaw.${string}`, options?: MetricOptions) =>
    meter.createHistogram(resolveMetricName(name), options);

  return {
    gcDurationHistogram: createHistogram("openclaw.gc.duration_ms", {
      unit: "ms",
      description: "Elapsed garbage collection duration for the hosting JavaScript isolate",
      advice: { explicitBucketBoundaries: AGENT_DURATION_MS_BUCKETS },
    }),
    gatewayEventLoopDelayMaxHistogram: createHistogram("openclaw.gateway.event_loop.delay_max_ms", {
      unit: "ms",
      description: "Maximum event-loop delay per completed Gateway observation window",
      advice: { explicitBucketBoundaries: AGENT_DURATION_MS_BUCKETS },
    }),
    gatewayEventLoopObservedCounter: createCounter("openclaw.gateway.event_loop.observed_ms", {
      unit: "ms",
      description: "Elapsed time covered by completed Gateway event-loop observation windows",
    }),
    gatewayRpcRequestsCounter: createCounter("openclaw.gateway.rpc.requests", {
      unit: "1",
      description: "Authenticated Gateway WebSocket requests received",
    }),
    gatewayRpcOutcomesCounter: createCounter("openclaw.gateway.rpc.outcomes", {
      unit: "1",
      description: "Gateway RPC observations by phase and outcome",
    }),
    gatewayRpcFirstResponseHistogram: createHistogram("openclaw.gateway.rpc.first_response_ms", {
      unit: "ms",
      description: "Elapsed time until the first Gateway RPC response is sent",
      advice: { explicitBucketBoundaries: AGENT_DURATION_MS_BUCKETS },
    }),
    gatewayRpcHandlerHistogram: createHistogram("openclaw.gateway.rpc.handler_ms", {
      unit: "ms",
      description: "Gateway RPC handler duration until return or throw",
      advice: { explicitBucketBoundaries: AGENT_DURATION_MS_BUCKETS },
    }),
    gatewayRpcAdmissionHistogram: createHistogram("openclaw.gateway.rpc.admission_ms", {
      unit: "ms",
      description: "Elapsed time from Gateway RPC receipt until handler invocation",
      advice: { explicitBucketBoundaries: AGENT_DURATION_MS_BUCKETS },
    }),
    gatewayRpcQueueWaitHistogram: createHistogram("openclaw.gateway.rpc.queue_wait_ms", {
      unit: "ms",
      description: "Gateway operator request start queue wait",
      advice: { explicitBucketBoundaries: AGENT_DURATION_MS_BUCKETS },
    }),
    tokensCounter: createCounter("openclaw.tokens", {
      unit: "1",
      description: "Token usage by type",
    }),
    genAiTokenUsageHistogram: meter.createHistogram("gen_ai.client.token.usage", {
      unit: "{token}",
      description: "Number of input and output tokens used by GenAI client operations",
      advice: {
        explicitBucketBoundaries: GEN_AI_TOKEN_USAGE_BUCKETS,
      },
    }),
    genAiOperationDurationHistogram: meter.createHistogram("gen_ai.client.operation.duration", {
      unit: "s",
      description: "GenAI client operation duration",
      advice: {
        explicitBucketBoundaries: GEN_AI_OPERATION_DURATION_BUCKETS,
      },
    }),
    costCounter: createCounter("openclaw.cost.usd", {
      unit: "1",
      description: "Estimated model cost (USD)",
    }),
    durationHistogram: createHistogram("openclaw.run.duration_ms", {
      unit: "ms",
      description: "Agent run duration",
      advice: { explicitBucketBoundaries: AGENT_DURATION_MS_BUCKETS },
    }),
    harnessDurationHistogram: createHistogram("openclaw.harness.duration_ms", {
      unit: "ms",
      description: "Agent harness lifecycle duration",
      advice: { explicitBucketBoundaries: AGENT_DURATION_MS_BUCKETS },
    }),
    contextHistogram: createHistogram("openclaw.context.tokens", {
      unit: "1",
      description: "Context window size and usage",
      advice: { explicitBucketBoundaries: CONTEXT_TOKENS_BUCKETS },
    }),
    webhookReceivedCounter: createCounter("openclaw.webhook.received", {
      unit: "1",
      description: "Webhook requests received",
    }),
    webhookErrorCounter: createCounter("openclaw.webhook.error", {
      unit: "1",
      description: "Webhook processing errors",
    }),
    webhookDurationHistogram: createHistogram("openclaw.webhook.duration_ms", {
      unit: "ms",
      description: "Webhook processing duration",
    }),
    messageQueuedCounter: createCounter("openclaw.message.queued", {
      unit: "1",
      description: "Messages queued for processing",
    }),
    messageReceivedCounter: createCounter("openclaw.message.received", {
      unit: "1",
      description: "Inbound messages received",
    }),
    messageDispatchStartedCounter: createCounter("openclaw.message.dispatch.started", {
      unit: "1",
      description: "Inbound message dispatch attempts started",
    }),
    messageDispatchCompletedCounter: createCounter("openclaw.message.dispatch.completed", {
      unit: "1",
      description: "Inbound message dispatch attempts completed",
    }),
    messageDispatchDurationHistogram: createHistogram("openclaw.message.dispatch.duration_ms", {
      unit: "ms",
      description: "Inbound message dispatch duration",
    }),
    messageProcessedCounter: createCounter("openclaw.message.processed", {
      unit: "1",
      description: "Messages processed by outcome",
    }),
    messageDurationHistogram: createHistogram("openclaw.message.duration_ms", {
      unit: "ms",
      description: "Message processing duration",
    }),
    messageDeliveryStartedCounter: createCounter("openclaw.message.delivery.started", {
      unit: "1",
      description: "Outbound message delivery attempts started",
    }),
    messageDeliveryDurationHistogram: createHistogram("openclaw.message.delivery.duration_ms", {
      unit: "ms",
      description: "Outbound message delivery duration",
    }),
    queueDepthHistogram: createHistogram("openclaw.queue.depth", {
      unit: "1",
      description: "Queue depth on enqueue/dequeue",
    }),
    queueWaitHistogram: createHistogram("openclaw.queue.wait_ms", {
      unit: "ms",
      description: "Queue wait time before execution",
    }),
    laneEnqueueCounter: createCounter("openclaw.queue.lane.enqueue", {
      unit: "1",
      description: "Command queue lane enqueue events",
    }),
    laneDequeueCounter: createCounter("openclaw.queue.lane.dequeue", {
      unit: "1",
      description: "Command queue lane dequeue events",
    }),
    sessionStateCounter: createCounter("openclaw.session.state", {
      unit: "1",
      description: "Session state transitions",
    }),
    sessionTurnCreatedCounter: createCounter("openclaw.session.turn.created", {
      unit: "1",
      description: "Agent session turns created",
    }),
    sessionStuckCounter: createCounter("openclaw.session.stuck", {
      unit: "1",
      description: "Sessions stuck in processing",
    }),
    sessionStuckAgeHistogram: createHistogram("openclaw.session.stuck_age_ms", {
      unit: "ms",
      description: "Age of stuck sessions",
    }),
    sessionRecoveryRequestedCounter: createCounter("openclaw.session.recovery.requested", {
      unit: "1",
      description: "Session recovery attempts requested",
    }),
    sessionRecoveryCompletedCounter: createCounter("openclaw.session.recovery.completed", {
      unit: "1",
      description: "Session recovery attempts completed",
    }),
    sessionRecoveryAgeHistogram: createHistogram("openclaw.session.recovery.age_ms", {
      unit: "ms",
      description: "Age of sessions selected for recovery",
    }),
    talkEventCounter: createCounter("openclaw.talk.event", {
      unit: "1",
      description: "Talk events emitted by type",
    }),
    talkEventDurationHistogram: createHistogram("openclaw.talk.event.duration_ms", {
      unit: "ms",
      description: "Talk event duration when reported",
    }),
    talkAudioBytesHistogram: createHistogram("openclaw.talk.audio.bytes", {
      unit: "By",
      description: "Talk audio frame byte lengths",
    }),
    runAttemptCounter: createCounter("openclaw.run.attempt", {
      unit: "1",
      description: "Run attempts",
    }),
    toolLoopCounter: createCounter("openclaw.tool.loop", {
      unit: "1",
      description: "Detected repetitive tool-call loop events",
    }),
    skillUsedCounter: createCounter("openclaw.skill.used", {
      unit: "1",
      description: "Skills used by agent runs",
    }),
    modelCallDurationHistogram: createHistogram("openclaw.model_call.duration_ms", {
      unit: "ms",
      description: "Model call duration",
    }),
    modelCallRequestBytesHistogram: createHistogram("openclaw.model_call.request_bytes", {
      unit: "By",
      description: "UTF-8 byte size of sanitized model request payloads",
    }),
    modelCallResponseBytesHistogram: createHistogram("openclaw.model_call.response_bytes", {
      unit: "By",
      description: "UTF-8 byte size of bounded streamed model response payloads",
    }),
    modelCallTimeToFirstByteHistogram: createHistogram(
      "openclaw.model_call.time_to_first_byte_ms",
      {
        unit: "ms",
        description: "Elapsed time before the first streamed model response event",
      },
    ),
    modelFailoverCounter: createCounter("openclaw.model.failover", {
      unit: "1",
      description: "Model failovers by source, destination, lane, and reason",
    }),
    toolExecutionDurationHistogram: createHistogram("openclaw.tool.execution.duration_ms", {
      unit: "ms",
      description: "Tool execution duration",
    }),
    toolExecutionBlockedCounter: createCounter("openclaw.tool.execution.blocked", {
      unit: "1",
      description: "Tool executions blocked by policy or sandbox diagnostics",
    }),
    execProcessDurationHistogram: createHistogram("openclaw.exec.duration_ms", {
      unit: "ms",
      description: "Exec process duration",
    }),
    memoryRssHistogram: createHistogram("openclaw.memory.rss_bytes", {
      unit: "By",
      description: "Resident set size reported by diagnostic memory samples",
    }),
    memoryHeapUsedHistogram: createHistogram("openclaw.memory.heap_used_bytes", {
      unit: "By",
      description: "Heap used bytes reported by diagnostic memory samples",
    }),
    memoryHeapTotalHistogram: createHistogram("openclaw.memory.heap_total_bytes", {
      unit: "By",
      description: "Heap total bytes reported by diagnostic memory samples",
    }),
    memoryExternalHistogram: createHistogram("openclaw.memory.external_bytes", {
      unit: "By",
      description: "External memory bytes reported by diagnostic memory samples",
    }),
    memoryArrayBuffersHistogram: createHistogram("openclaw.memory.array_buffers_bytes", {
      unit: "By",
      description: "ArrayBuffer bytes reported by diagnostic memory samples",
    }),
    memoryPressureCounter: createCounter("openclaw.memory.pressure", {
      unit: "1",
      description: "Diagnostic memory pressure events",
    }),
    asyncQueueDroppedCounter: createCounter("openclaw.diagnostic.async_queue.dropped", {
      unit: "1",
      description: "Async diagnostic queue drops by dropped event class",
    }),
    payloadLargeCounter: createCounter("openclaw.payload.large", {
      unit: "1",
      description: "Oversized payload diagnostics by surface and action",
    }),
    payloadLargeBytesHistogram: createHistogram("openclaw.payload.large_bytes", {
      unit: "By",
      description: "Oversized payload byte sizes by surface and action",
    }),
    livenessWarningCounter: createCounter("openclaw.liveness.warning", {
      unit: "1",
      description: "Diagnostic liveness warning events",
    }),
    livenessEventLoopDelayP99Histogram: createHistogram(
      "openclaw.liveness.event_loop_delay_p99_ms",
      {
        unit: "ms",
        description: "P99 event-loop delay reported by diagnostic liveness warnings",
      },
    ),
    livenessEventLoopDelayMaxHistogram: createHistogram(
      "openclaw.liveness.event_loop_delay_max_ms",
      {
        unit: "ms",
        description: "Maximum event-loop delay reported by diagnostic liveness warnings",
      },
    ),
    livenessEventLoopUtilizationHistogram: createHistogram(
      "openclaw.liveness.event_loop_utilization",
      {
        unit: "1",
        description: "Event-loop utilization reported by diagnostic liveness warnings",
      },
    ),
    livenessCpuCoreRatioHistogram: createHistogram("openclaw.liveness.cpu_core_ratio", {
      unit: "1",
      description:
        "Whole-process CPU usage in core equivalents, including worker and native threads; can exceed 1.",
    }),
    telemetryExporterCounter: createCounter("openclaw.telemetry.exporter.events", {
      unit: "1",
      description: "Diagnostic telemetry exporter lifecycle and failure events",
    }),
  };
}

export type DiagnosticsMetrics = ReturnType<typeof createDiagnosticsMetrics>;
