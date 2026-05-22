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
      'openclaw_tool_execution_total{error_category="other",outcome="error",params_kind="unknown",tool="tool"} 1',
    );
    expect(rendered).not.toContain("Bearer");
    expect(rendered).not.toContain("sk-secret");
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
      (event: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) => void
    > = [];
    const emitted: unknown[] = [];
    const exporter = createDiagnosticsPrometheusExporter();
    const unsubscribe = vi.fn();

    exporter.service.start({
      config: {} as never,
      stateDir: "/tmp/openclaw-prometheus-test",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
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
    listeners[0](
      {
        ...baseEvent(),
        type: "model.usage",
        provider: "openai",
        model: "gpt-5.4",
        usage: { input: 12, output: 3, total: 15 },
      },
      trusted,
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

    exporter.service.stop?.();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(exporter.render()).toBe("");
  });
});
