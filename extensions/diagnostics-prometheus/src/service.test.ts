import { expectDefined } from "@openclaw/normalization-core";
// Diagnostics Prometheus tests cover service plugin behavior.
import type { DiagnosticEventPrivateData } from "openclaw/plugin-sdk/diagnostic-runtime";
// Diagnostics Prometheus tests cover service plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { DiagnosticEventMetadata, DiagnosticEventPayload } from "../api.js";
import { createDiagnosticsPrometheusExporter, testApi } from "./service.js";

const trusted: DiagnosticEventMetadata = Object.freeze({ trusted: true });
const untrusted: DiagnosticEventMetadata = Object.freeze({ trusted: false });

function baseEvent(): Pick<DiagnosticEventPayload, "seq" | "ts"> {
  return { seq: 1, ts: 1700000000000 };
}

describe("diagnostics-prometheus service", () => {
  it("records trusted run metrics without raw diagnostic identifiers", () => {
    const store = testApi.createPrometheusMetricStore();

    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "run.completed",
        runId: "run-should-not-export",
        sessionKey: "session-should-not-export",
        provider: "openai",
        model: "gpt-5.4",
        channel: "discord",
        trigger: "message",
        durationMs: 1500,
        outcome: "completed",
      },
      trusted,
    );

    const rendered = testApi.renderPrometheusMetrics(store);

    expect(rendered).toContain("# TYPE openclaw_run_completed_total counter");
    expect(rendered).toContain(
      'openclaw_run_completed_total{channel="discord",model="gpt-5.4",outcome="completed",provider="openai",trigger="message"} 1',
    );
    expect(rendered).toContain(
      'openclaw_run_duration_seconds_sum{channel="discord",model="gpt-5.4",outcome="completed",provider="openai",trigger="message"} 1.5',
    );
    expect(rendered).not.toContain("run-should-not-export");
    expect(rendered).not.toContain("session-should-not-export");
  });

  it("records hook-blocked run metrics with safe blocker originator only", () => {
    const store = testApi.createPrometheusMetricStore();

    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "run.completed",
        runId: "run-should-not-export",
        sessionKey: "session-should-not-export",
        provider: "openai",
        model: "gpt-5.4",
        channel: "slack",
        trigger: "message",
        durationMs: 250,
        outcome: "blocked",
        blockedBy: "policy-plugin",
      },
      trusted,
    );

    const rendered = testApi.renderPrometheusMetrics(store);

    expect(rendered).toContain(
      'openclaw_run_completed_total{blocked_by="policy-plugin",channel="slack",model="gpt-5.4",outcome="blocked",provider="openai",trigger="message"} 1',
    );
    expect(rendered).not.toContain("run-should-not-export");
    expect(rendered).not.toContain("session-should-not-export");
    expect(rendered).not.toContain("matched secret prompt");
  });

  it("drops untrusted plugin-emitted diagnostic events", () => {
    const store = testApi.createPrometheusMetricStore();

    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "model.call.completed",
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        durationMs: 10,
      },
      untrusted,
    );

    expect(testApi.renderPrometheusMetrics(store)).toBe("");
  });

  it("drops untrusted plugin-emitted diagnostic events that spoof gateway stability signals", () => {
    const store = testApi.createPrometheusMetricStore();

    for (const event of [
      {
        ...baseEvent(),
        type: "webhook.received",
        channel: "telegram",
        updateType: "message",
      },
      {
        ...baseEvent(),
        type: "payload.large",
        surface: "gateway.frame",
        action: "rejected",
        bytes: 2048,
      },
      {
        ...baseEvent(),
        type: "session.stuck",
        state: "processing",
        ageMs: 12_000,
        classification: "stale_session_state",
      },
    ] satisfies DiagnosticEventPayload[]) {
      testApi.recordDiagnosticEvent(store, event, untrusted);
    }

    expect(testApi.renderPrometheusMetrics(store)).toBe("");
  });

  it("records sanitized async diagnostic queue drop summaries from core diagnostics", () => {
    const store = testApi.createPrometheusMetricStore();

    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "diagnostic.async_queue.dropped",
        droppedEvents: 3,
        droppedTrustedEvents: 1,
        droppedUntrustedEvents: 2,
        queueLength: 0,
        maxQueueLength: 10_000,
        drainBatchSize: 100,
      },
      trusted,
    );

    const rendered = testApi.renderPrometheusMetrics(store);

    expect(rendered).toContain(
      'openclaw_diagnostic_async_queue_dropped_total{drop_class="total"} 3',
    );
    expect(rendered).toContain(
      'openclaw_diagnostic_async_queue_dropped_total{drop_class="trusted"} 1',
    );
    expect(rendered).toContain(
      'openclaw_diagnostic_async_queue_dropped_total{drop_class="untrusted"} 2',
    );
    expect(rendered).toContain("openclaw_diagnostic_async_queue_length 0");
  });

  it("redacts and bounds label values", () => {
    const store = testApi.createPrometheusMetricStore();

    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "tool.execution.error",
        toolName: "shell\nbad",
        durationMs: 25,
        errorCategory: "Bearer sk-secret-token-value",
      },
      trusted,
    );

    const rendered = testApi.renderPrometheusMetrics(store);

    expect(rendered).toContain(
      'openclaw_tool_execution_total{error_category="other",outcome="error",params_kind="unknown",tool="tool",tool_owner="none",tool_source="core"} 1',
    );
    expect(rendered).not.toContain("Bearer");
    expect(rendered).not.toContain("sk-secret");
  });

  it("records operator-critical diagnostic signals missing from generic run metrics", () => {
    const store = testApi.createPrometheusMetricStore();

    for (const event of [
      {
        ...baseEvent(),
        type: "tool.execution.blocked",
        toolName: "browser",
        toolSource: "mcp",
        toolOwner: "browser-tools",
        deniedReason: "tools.deny",
        reason: "matched browser",
        paramsSummary: { kind: "object" },
      },
      {
        ...baseEvent(),
        type: "model.failover",
        lane: "session:Agent:qa:otel-trace-smoke",
        fromProvider: "anthropic",
        fromModel: "claude-opus-4-6",
        toProvider: "openai",
        toModel: "gpt-5.4",
        reason: "overloaded",
        suspended: true,
      },
    ] satisfies DiagnosticEventPayload[]) {
      testApi.recordDiagnosticEvent(store, event, trusted);
    }
    for (const event of [
      {
        ...baseEvent(),
        type: "session.stuck",
        sessionId: "session-should-not-export",
        sessionKey: "key-should-not-export",
        state: "processing",
        ageMs: 12_000,
        classification: "stale_session_state",
        reason: "startup-sweep",
      },
      {
        ...baseEvent(),
        type: "payload.large",
        surface: "gateway.frame",
        action: "rejected",
        bytes: 2048,
        limitBytes: 1024,
        channel: "web",
        pluginId: "agent:qa:otel-trace-smoke",
        reason: "body-too-large",
      },
    ] satisfies DiagnosticEventPayload[]) {
      testApi.recordDiagnosticEvent(store, event, trusted);
    }

    const rendered = testApi.renderPrometheusMetrics(store);

    expect(rendered).toContain(
      'openclaw_tool_execution_blocked_total{denied_reason="tools.deny",params_kind="object",tool="browser",tool_owner="browser-tools",tool_source="mcp"} 1',
    );
    expect(rendered).toContain(
      'openclaw_model_failover_total{from_model="claude-opus-4-6",from_provider="anthropic",lane="session",reason="overloaded",suspended="true",to_model="gpt-5.4",to_provider="openai"} 1',
    );
    expect(rendered).toContain(
      'openclaw_session_stuck_total{reason="startup-sweep",state="processing"} 1',
    );
    expect(rendered).toContain(
      'openclaw_session_stuck_age_seconds_sum{reason="startup-sweep",state="processing"} 12',
    );
    expect(rendered).toContain(
      'openclaw_payload_large_total{action="rejected",channel="web",plugin="none",reason="body-too-large",surface="gateway.frame"} 1',
    );
    expect(rendered).toContain(
      'openclaw_payload_large_bytes_sum{action="rejected",channel="web",plugin="none",reason="body-too-large",surface="gateway.frame"} 2048',
    );
    expect(rendered).not.toContain("session-should-not-export");
    expect(rendered).not.toContain("key-should-not-export");
    expect(rendered).not.toContain("Agent:qa:otel-trace-smoke");
  });

  it("records webhook ingress and liveness warning metrics", () => {
    const store = testApi.createPrometheusMetricStore();

    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "webhook.received",
        channel: "telegram",
        updateType: "message",
        chatId: "chat-should-not-export",
      },
      trusted,
    );
    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "webhook.processed",
        channel: "telegram",
        updateType: "message",
        chatId: "chat-should-not-export",
        durationMs: 250,
      },
      trusted,
    );
    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "webhook.error",
        channel: "telegram",
        updateType: "message",
        chatId: "chat-should-not-export",
        error: "Bearer sk-secret",
      },
      trusted,
    );
    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "diagnostic.liveness.warning",
        reasons: ["event_loop_delay", "cpu"],
        intervalMs: 30_000,
        eventLoopDelayP99Ms: 250,
        eventLoopDelayMaxMs: 900,
        eventLoopUtilization: 0.95,
        cpuCoreRatio: 1.4,
        active: 2,
        waiting: 1,
        queued: 4,
      },
      trusted,
    );

    const rendered = testApi.renderPrometheusMetrics(store);

    expect(rendered).toContain(
      'openclaw_webhook_received_total{channel="telegram",webhook="message"} 1',
    );
    expect(rendered).toContain(
      'openclaw_webhook_error_total{channel="telegram",webhook="message"} 1',
    );
    expect(rendered).toContain(
      'openclaw_webhook_duration_seconds_sum{channel="telegram",webhook="message"} 0.25',
    );
    expect(rendered).toContain('openclaw_liveness_warning_total{reason="event_loop_delay:cpu"} 1');
    expect(rendered).toContain('openclaw_liveness_sessions{state="active"} 2');
    expect(rendered).toContain(
      'openclaw_liveness_event_loop_delay_p99_seconds_sum{reason="event_loop_delay:cpu"} 0.25',
    );
    expect(rendered).toContain(
      'openclaw_liveness_cpu_core_ratio_sum{reason="event_loop_delay:cpu"} 1.4',
    );
    expect(rendered).not.toContain("chat-should-not-export");
    expect(rendered).not.toContain("sk-secret");
  });

  it("drops session-shaped agent labels", () => {
    const store = testApi.createPrometheusMetricStore();

    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "model.usage",
        agentId: "Agent:qa:otel-trace-smoke",
        provider: "openai",
        model: "gpt-5.4",
        usage: { input: 12 },
      },
      trusted,
    );

    const rendered = testApi.renderPrometheusMetrics(store);

    expect(rendered).toContain(
      'openclaw_model_tokens_total{agent="unknown",channel="unknown",model="gpt-5.4",provider="openai",token_type="input"} 12',
    );
    expect(rendered).not.toContain("Agent:qa:otel-trace-smoke");
  });

  it("drops session-shaped queue lane labels", () => {
    const store = testApi.createPrometheusMetricStore();

    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "queue.lane.enqueue",
        lane: "session:Agent:qa:otel-trace-smoke",
        queueSize: 2,
      },
      trusted,
    );

    const rendered = testApi.renderPrometheusMetrics(store);

    expect(rendered).toContain('openclaw_queue_lane_size{lane="session"} 2');
    expect(rendered).not.toContain("Agent:qa:otel-trace-smoke");
  });

  it("keeps only the bounded prefix from scoped queue lane labels", () => {
    const store = testApi.createPrometheusMetricStore();

    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "queue.lane.enqueue",
        lane: "dreaming-narrative:session-main",
        queueSize: 2,
      },
      trusted,
    );

    const rendered = testApi.renderPrometheusMetrics(store);

    expect(rendered).toContain('openclaw_queue_lane_size{lane="dreaming-narrative"} 2');
    expect(rendered).not.toContain("session-main");
  });

  it("records skill usage metrics without raw paths or session identifiers", () => {
    const store = testApi.createPrometheusMetricStore();

    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "skill.used",
        agentId: "main",
        runId: "run-should-not-export",
        sessionKey: "session-should-not-export",
        skillName: "tiny-llm-brainstorm",
        skillSource: "workspace",
        activation: "read",
        toolName: "read",
      },
      trusted,
    );

    const rendered = testApi.renderPrometheusMetrics(store);

    expect(rendered).toContain("# TYPE openclaw_skill_used_total counter");
    expect(rendered).toContain(
      'openclaw_skill_used_total{activation="read",agent="main",skill="tiny-llm-brainstorm",source="workspace"} 1',
    );
    expect(rendered).not.toContain("run-should-not-export");
    expect(rendered).not.toContain("session-should-not-export");
    expect(rendered).not.toContain("SKILL.md");
  });

  it("bounds messaging labels without exporting raw chat identifiers", () => {
    const store = testApi.createPrometheusMetricStore();

    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "message.delivery.started",
        channel: "matrix",
        deliveryKind: "text",
        sessionKey: "session-should-not-export",
      },
      trusted,
    );
    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "message.processed",
        channel: "telegram/custom",
        chatId: "chat-should-not-export",
        messageId: "message-should-not-export",
        outcome: "completed",
        reason: "progress draft / message tool 123",
        durationMs: 25,
      },
      trusted,
    );
    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "message.delivery.error",
        channel: "discord/custom",
        deliveryKind: "progress draft" as never,
        durationMs: 50,
        errorCategory: "TimeoutError",
      },
      trusted,
    );

    const rendered = testApi.renderPrometheusMetrics(store);

    expect(rendered).toContain(
      'openclaw_message_delivery_started_total{channel="matrix",delivery_kind="text"} 1',
    );
    expect(rendered).toContain(
      'openclaw_message_processed_total{channel="unknown",outcome="completed",reason="none"} 1',
    );
    expect(rendered).toContain(
      'openclaw_message_delivery_total{channel="unknown",delivery_kind="other",error_category="TimeoutError",outcome="error"} 1',
    );
    expect(rendered).not.toContain("chat-should-not-export");
    expect(rendered).not.toContain("message-should-not-export");
    expect(rendered).not.toContain("session-should-not-export");
    expect(rendered).not.toContain("progress draft");
  });

  it("records inbound dispatch and session turn telemetry", () => {
    const store = testApi.createPrometheusMetricStore();

    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "message.received",
        channel: "telegram",
        source: "webhook",
      },
      trusted,
    );
    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "message.dispatch.started",
        channel: "telegram",
        source: "webhook",
      },
      trusted,
    );
    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "message.dispatch.completed",
        channel: "telegram",
        source: "webhook",
        durationMs: 250,
        outcome: "completed",
      },
      trusted,
    );
    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "message.dispatch.completed",
        channel: "telegram/custom",
        source: "webhook with secret sk-test",
        durationMs: 300,
        outcome: "completed",
        reason: "progress draft / message tool 123",
      },
      trusted,
    );
    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "session.turn.created",
        runId: "run-should-not-export",
        agentId: "agent.default",
        channel: "telegram",
        trigger: "user",
      },
      trusted,
    );

    const rendered = testApi.renderPrometheusMetrics(store);

    expect(rendered).toContain(
      'openclaw_message_received_total{channel="telegram",source="webhook"} 1',
    );
    expect(rendered).toContain(
      'openclaw_message_dispatch_started_total{channel="telegram",source="webhook"} 1',
    );
    expect(rendered).toContain(
      'openclaw_message_dispatch_completed_total{channel="telegram",outcome="completed",reason="none",source="webhook"} 1',
    );
    expect(rendered).toContain(
      'openclaw_message_dispatch_duration_seconds_sum{channel="telegram",outcome="completed",reason="none",source="webhook"} 0.25',
    );
    expect(rendered).toContain(
      'openclaw_message_dispatch_completed_total{channel="unknown",outcome="completed",reason="none",source="unknown"} 1',
    );
    expect(rendered).toContain(
      'openclaw_message_dispatch_duration_seconds_sum{channel="unknown",outcome="completed",reason="none",source="unknown"} 0.3',
    );
    expect(rendered).toContain(
      'openclaw_session_turn_created_total{agent="agent.default",channel="telegram",trigger="user"} 1',
    );
    expect(rendered).not.toContain("run-should-not-export");
  });

  it("records session recovery and talk metrics without exporting raw ids or content", () => {
    const store = testApi.createPrometheusMetricStore();

    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "session.recovery.completed",
        sessionId: "session-should-not-export",
        sessionKey: "key-should-not-export",
        state: "processing",
        stateGeneration: 2,
        ageMs: 12_000,
        queueDepth: 1,
        reason: "startup-sweep",
        activeWorkKind: "tool_call",
        allowActiveAbort: true,
        status: "released",
        action: "abort-active-run",
      },
      trusted,
    );
    testApi.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "talk.event",
        sessionId: "talk-session-should-not-export",
        turnId: "turn-should-not-export",
        talkEventType: "input.audio.delta",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
        byteLength: 320,
      },
      trusted,
    );

    const rendered = testApi.renderPrometheusMetrics(store);

    expect(rendered).toContain(
      'openclaw_session_recovery_total{action="abort-active-run",active_work_kind="tool_call",state="processing",status="released"} 1',
    );
    expect(rendered).toContain(
      'openclaw_session_recovery_age_seconds_sum{action="abort-active-run",active_work_kind="tool_call",state="processing",status="released"} 12',
    );
    expect(rendered).toContain(
      'openclaw_talk_event_total{brain="agent-consult",event_type="input.audio.delta",mode="realtime",provider="openai",transport="gateway-relay"} 1',
    );
    expect(rendered).toContain(
      'openclaw_talk_audio_bytes_sum{brain="agent-consult",event_type="input.audio.delta",mode="realtime",provider="openai",transport="gateway-relay"} 320',
    );
    expect(rendered).not.toContain("session-should-not-export");
    expect(rendered).not.toContain("key-should-not-export");
    expect(rendered).not.toContain("talk-session-should-not-export");
    expect(rendered).not.toContain("turn-should-not-export");
  });

  it("caps metric series growth and reports dropped series", () => {
    const store = testApi.createPrometheusMetricStore();

    for (let index = 0; index < 2100; index += 1) {
      testApi.recordDiagnosticEvent(
        store,
        {
          ...baseEvent(),
          type: "model.call.completed",
          runId: `run-${index}`,
          callId: `call-${index}`,
          provider: "openai",
          model: `model.${index}`,
          durationMs: 10,
        },
        trusted,
      );
    }

    const rendered = testApi.renderPrometheusMetrics(store);

    expect(rendered).toContain("# TYPE openclaw_prometheus_series_dropped_total counter");
    expect(rendered).toContain("openclaw_prometheus_series_dropped_total ");
  });

  it("subscribes to internal diagnostics and renders scrape text", () => {
    const listeners: Array<
      (
        event: DiagnosticEventPayload,
        metadata: DiagnosticEventMetadata,
        privateData: DiagnosticEventPrivateData,
      ) => void
    > = [];
    const emitted: unknown[] = [];
    const error = vi.fn();
    const exporter = createDiagnosticsPrometheusExporter();
    const unsubscribe = vi.fn();

    exporter.service.start({
      config: {} as never,
      stateDir: "/tmp/openclaw-prometheus-test",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error,
        debug: vi.fn(),
      },
      internalDiagnostics: {
        emit: (event) => emitted.push(event),
        onEvent: (listener) => {
          listeners.push(listener);
          return unsubscribe;
        },
      },
    });

    expect(listeners).toHaveLength(1);
    expectDefined(listeners[0], "Prometheus diagnostics listener")(
      {
        ...baseEvent(),
        type: "model.usage",
        provider: "openai",
        model: "gpt-5.4",
        usage: { input: 12, output: 3, total: 15 },
      },
      trusted,
      {},
    );

    expect(emitted).toStrictEqual([
      {
        type: "telemetry.exporter",
        exporter: "diagnostics-prometheus",
        signal: "metrics",
        status: "started",
        reason: "configured",
      },
    ]);
    expect(exporter.render()).toContain(
      'openclaw_model_tokens_total{agent="unknown",channel="unknown",model="gpt-5.4",provider="openai",token_type="input"} 12',
    );

    const prefix = "x".repeat(499);
    const usage = {} as Extract<DiagnosticEventPayload, { type: "model.usage" }>["usage"];
    Object.defineProperty(usage, "input", {
      get() {
        throw new Error(`${prefix}😀`);
      },
    });
    expectDefined(listeners[0], "Prometheus diagnostics listener")(
      {
        ...baseEvent(),
        type: "model.usage",
        provider: "openai",
        model: "gpt-5.4",
        usage,
      },
      trusted,
      {},
    );
    expect(error).toHaveBeenCalledWith(
      `diagnostics-prometheus: event handler failed (model.usage): ${prefix}`,
    );

    exporter.service.stop?.();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(exporter.render()).toBe("");
  });
});
