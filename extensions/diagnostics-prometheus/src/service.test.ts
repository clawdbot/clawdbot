import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
// Diagnostics Prometheus tests cover service plugin behavior.
import type { DiagnosticEventPrivateData } from "openclaw/plugin-sdk/diagnostic-runtime";
// Diagnostics Prometheus tests cover service plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { DiagnosticEventMetadata, DiagnosticEventPayload } from "../api.js";
import { createDiagnosticsPrometheusExporter } from "./service.js";
import {
  baseEvent,
  createMetricsHarness,
  trusted,
  untrusted,
  type ExporterHealthReport,
  type TrustedExporterInternalDiagnostics,
} from "./service.test-helpers.js";

describe("diagnostics-prometheus service", () => {
  it("records Gateway RPC timings by method and outcomes without method multiplication", () => {
    const metrics = createMetricsHarness();
    const base = {
      ...baseEvent(),
      type: "gateway.rpc" as const,
      method: "sessions.list",
      trace: { traceId: "4bf92f3577b34da6a3ce929d0e0e4736" },
    };
    for (const event of [
      { ...base, phase: "received" },
      { ...base, phase: "response", outcome: "ok", durationMs: 250 },
      { ...base, phase: "handler", outcome: "returned", durationMs: 400, admissionMs: 100 },
      {
        ...base,
        phase: "dispatch",
        outcome: "returned",
        durationMs: 500,
        queueWaitMs: 75,
        response: "sent",
      },
      { ...base, method: "health", phase: "response", outcome: "ok", durationMs: 10 },
      { ...base, method: "health", phase: "response", outcome: "error", durationMs: 20 },
    ] satisfies DiagnosticEventPayload[]) {
      metrics.record(event, trusted);
    }

    const rendered = metrics.render();
    expect(rendered).toContain('openclaw_gateway_rpc_requests_total{method="sessions.list"} 1');
    for (const [method, metric, sum, count] of [
      ["sessions.list", "first_response", 0.25, 1],
      ["sessions.list", "handler", 0.4, 1],
      ["sessions.list", "admission", 0.1, 1],
      ["sessions.list", "queue_wait", 0.075, 1],
      ["health", "first_response", 0.03, 2],
    ]) {
      expect(rendered).toContain(
        `openclaw_gateway_rpc_${metric}_seconds_sum{method="${method}"} ${sum}`,
      );
      expect(rendered).toContain(
        `openclaw_gateway_rpc_${metric}_seconds_count{method="${method}"} ${count}`,
      );
    }
    expect(rendered).toContain(
      'openclaw_gateway_rpc_outcomes_total{outcome="ok",phase="response"} 2',
    );
    expect(rendered).not.toContain(base.trace.traceId);
    expect(rendered).not.toMatch(/openclaw_gateway_rpc_outcomes_total\{[^\n]*method=/);
    metrics.stop();
  });

  it("keeps rejected and unsent RPC observations out of response and handler timings", () => {
    const metrics = createMetricsHarness();
    const base = { ...baseEvent(), type: "gateway.rpc" as const, method: "unknown" };
    for (const event of [
      { ...base, phase: "received" },
      { ...base, phase: "response", outcome: "unavailable", durationMs: 20 },
      { ...base, phase: "response", outcome: "suppressed", durationMs: 30 },
      {
        ...base,
        phase: "dispatch",
        outcome: "rejected",
        durationMs: 30,
        response: "suppressed",
      },
    ] satisfies DiagnosticEventPayload[]) {
      metrics.record(event, trusted);
    }
    metrics.record({ ...base, phase: "response", outcome: "ok", durationMs: 50 }, untrusted);
    const rendered = metrics.render();
    expect(rendered).toContain('openclaw_gateway_rpc_requests_total{method="unknown"} 1');
    for (const outcome of ["unavailable", "suppressed"]) {
      expect(rendered).toContain(
        `openclaw_gateway_rpc_outcomes_total{outcome="${outcome}",phase="response"} 1`,
      );
    }
    expect(rendered).toContain(
      'openclaw_gateway_rpc_outcomes_total{outcome="rejected",phase="dispatch"} 1',
    );
    for (const metric of ["first_response", "handler", "admission", "queue_wait"]) {
      expect(rendered).not.toContain(`openclaw_gateway_rpc_${metric}_seconds`);
    }
    metrics.stop();
  });

  it("records trusted run metrics without raw diagnostic identifiers", () => {
    const metrics = createMetricsHarness();

    metrics.record(
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

    const rendered = metrics.render();

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
    const metrics = createMetricsHarness();

    metrics.record(
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

    const rendered = metrics.render();

    expect(rendered).toContain(
      'openclaw_run_completed_total{blocked_by="policy-plugin",channel="slack",model="gpt-5.4",outcome="blocked",provider="openai",trigger="message"} 1',
    );
    expect(rendered).not.toContain("run-should-not-export");
    expect(rendered).not.toContain("session-should-not-export");
    expect(rendered).not.toContain("matched secret prompt");
  });

  it("drops untrusted plugin-emitted diagnostic events", () => {
    const metrics = createMetricsHarness();

    metrics.record(
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

    expect(metrics.render()).toBe("");
  });

  it("separates request and turn model-call metrics by observation unit", () => {
    const metrics = createMetricsHarness();

    metrics.record(
      {
        ...baseEvent(),
        type: "model.call.completed",
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        api: "openai-responses",
        transport: "http",
        durationMs: 250,
      },
      trusted,
    );
    metrics.record(
      {
        ...baseEvent(),
        type: "model.call.completed",
        runId: "run-1",
        callId: "call-2",
        provider: "anthropic",
        model: "claude-opus-4-7",
        api: "claude-code",
        transport: "stdio-live",
        observationUnit: "turn",
        durationMs: 2500,
      },
      trusted,
    );

    const rendered = metrics.render();
    expect(rendered).toContain(
      'openclaw_model_call_total{api="openai-responses",error_category="none",model="gpt-5.4",observation_unit="request",outcome="completed",provider="openai",transport="http"} 1',
    );
    expect(rendered).toContain(
      'openclaw_model_call_duration_seconds_sum{api="claude-code",error_category="none",model="claude-opus-4-7",observation_unit="turn",outcome="completed",provider="anthropic",transport="stdio-live"} 2.5',
    );
  });

  it("drops untrusted plugin-emitted diagnostic events that spoof gateway stability signals", () => {
    const metrics = createMetricsHarness();

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
      metrics.record(event, untrusted);
    }

    expect(metrics.render()).toBe("");
  });

  it("records sanitized async diagnostic queue drop summaries from core diagnostics", () => {
    const metrics = createMetricsHarness();

    metrics.record(
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

    const rendered = metrics.render();

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

  it("records one metric for one signal-level exporter lifecycle fact", () => {
    const metrics = createMetricsHarness();

    metrics.record(
      {
        ...baseEvent(),
        type: "telemetry.exporter",
        exporter: "diagnostics-otel",
        signal: "logs",
        status: "started",
        reason: "configured",
      },
      trusted,
    );

    const rendered = metrics.render();
    expect(rendered).toContain(
      'openclaw_telemetry_exporter_total{exporter="diagnostics-otel",reason="configured",signal="logs",status="started"} 1',
    );
    expect(rendered).not.toContain(
      'openclaw_telemetry_exporter_total{exporter="diagnostics-otel",reason="configured",signal="logs",status="started"} 2',
    );
  });

  it("redacts and bounds label values", () => {
    const metrics = createMetricsHarness();

    metrics.record(
      {
        ...baseEvent(),
        type: "tool.execution.error",
        toolName: "shell\nbad",
        durationMs: 25,
        errorCategory: "Bearer sk-secret-token-value",
      },
      trusted,
    );

    const rendered = metrics.render();

    expect(rendered).toContain(
      'openclaw_tool_execution_total{error_category="other",outcome="error",params_kind="unknown",tool="tool",tool_owner="none",tool_source="core"} 1',
    );
    expect(rendered).not.toContain("Bearer");
    expect(rendered).not.toContain("sk-secret");
  });

  it("records operator-critical diagnostic signals missing from generic run metrics", () => {
    const metrics = createMetricsHarness();

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
      metrics.record(event, trusted);
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
      metrics.record(event, trusted);
    }

    const rendered = metrics.render();

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
    const metrics = createMetricsHarness();

    metrics.record(
      {
        ...baseEvent(),
        type: "webhook.received",
        channel: "telegram",
        updateType: "message",
        chatId: "chat-should-not-export",
      },
      trusted,
    );
    metrics.record(
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
    metrics.record(
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
    metrics.record(
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

    const rendered = metrics.render();

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
    const metrics = createMetricsHarness();

    metrics.record(
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

    const rendered = metrics.render();

    expect(rendered).toContain(
      'openclaw_model_tokens_total{agent="unknown",channel="unknown",model="gpt-5.4",provider="openai",token_type="input"} 12',
    );
    expect(rendered).not.toContain("Agent:qa:otel-trace-smoke");
  });

  it("aggregates plugin usage without adding a plugin label", () => {
    const metrics = createMetricsHarness();
    const record = (input: number) =>
      metrics.record(
        {
          ...baseEvent(),
          type: "model.usage",
          agentId: "main",
          provider: "openai",
          model: "gpt-5.4",
          usage: { input, total: input },
        },
        Object.freeze({ trusted: true, internal: true }),
      );

    record(12);
    record(8);
    const rendered = metrics.render();

    expect(rendered).toContain(
      'openclaw_model_tokens_total{agent="main",channel="unknown",model="gpt-5.4",provider="openai",token_type="input"} 20',
    );
    expect(rendered).toContain(
      'openclaw_model_tokens_total{agent="main",channel="unknown",model="gpt-5.4",provider="openai",token_type="total"} 20',
    );
    expect(rendered).not.toContain("plugin=");
    expect(rendered).not.toContain("llm-task");
    expect(rendered).not.toContain("another-plugin");
  });

  it("drops session-shaped queue lane labels", () => {
    const metrics = createMetricsHarness();

    metrics.record(
      {
        ...baseEvent(),
        type: "queue.lane.enqueue",
        lane: "session:Agent:qa:otel-trace-smoke",
        queueSize: 2,
      },
      trusted,
    );

    const rendered = metrics.render();

    expect(rendered).toContain('openclaw_queue_lane_size{lane="session"} 2');
    expect(rendered).not.toContain("Agent:qa:otel-trace-smoke");
  });

  it("keeps only the bounded prefix from scoped queue lane labels", () => {
    const metrics = createMetricsHarness();

    metrics.record(
      {
        ...baseEvent(),
        type: "queue.lane.enqueue",
        lane: "dreaming-narrative:session-main",
        queueSize: 2,
      },
      trusted,
    );

    const rendered = metrics.render();

    expect(rendered).toContain('openclaw_queue_lane_size{lane="dreaming-narrative"} 2');
    expect(rendered).not.toContain("session-main");
  });

  it("records skill usage metrics without raw paths or session identifiers", () => {
    const metrics = createMetricsHarness();

    metrics.record(
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

    const rendered = metrics.render();

    expect(rendered).toContain("# TYPE openclaw_skill_used_total counter");
    expect(rendered).toContain(
      'openclaw_skill_used_total{activation="read",agent="main",skill="tiny-llm-brainstorm",source="workspace"} 1',
    );
    expect(rendered).not.toContain("run-should-not-export");
    expect(rendered).not.toContain("session-should-not-export");
    expect(rendered).not.toContain("SKILL.md");
  });

  it("bounds messaging labels without exporting raw chat identifiers", () => {
    const metrics = createMetricsHarness();

    metrics.record(
      {
        ...baseEvent(),
        type: "message.delivery.started",
        channel: "matrix",
        deliveryKind: "text",
        sessionKey: "session-should-not-export",
      },
      trusted,
    );
    metrics.record(
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
    metrics.record(
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

    const rendered = metrics.render();

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
    const metrics = createMetricsHarness();

    metrics.record(
      {
        ...baseEvent(),
        type: "message.received",
        channel: "telegram",
        source: "webhook",
      },
      trusted,
    );
    metrics.record(
      {
        ...baseEvent(),
        type: "message.dispatch.started",
        channel: "telegram",
        source: "webhook",
      },
      trusted,
    );
    metrics.record(
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
    metrics.record(
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
    metrics.record(
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

    const rendered = metrics.render();

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
    const metrics = createMetricsHarness();

    metrics.record(
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
    metrics.record(
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

    const rendered = metrics.render();

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

  it("keeps existing operational samples updating when RPC timings fill the shared cap", () => {
    const metrics = createMetricsHarness();
    const queue = {
      ...baseEvent(),
      type: "queue.lane.dequeue" as const,
      lane: "main",
      queueSize: 1,
      waitMs: 10,
    };
    metrics.record(queue, trusted);
    // This covers the current core-method table's cardinality without importing core internals.
    for (let index = 0; index < 426; index += 1) {
      const base = { ...baseEvent(), type: "gateway.rpc" as const, method: `core.method.${index}` };
      for (const event of [
        { ...base, phase: "received" },
        { ...base, phase: "response", outcome: "ok", durationMs: 10 },
        { ...base, phase: "handler", outcome: "returned", durationMs: 10, admissionMs: 1 },
        {
          ...base,
          phase: "dispatch",
          outcome: "returned",
          durationMs: 11,
          queueWaitMs: 1,
          response: "sent",
        },
      ] satisfies DiagnosticEventPayload[]) {
        metrics.record(event, trusted);
      }
    }
    expect(metrics.render()).toContain("openclaw_prometheus_series_dropped_total 87");
    metrics.record({ ...queue, queueSize: 2 }, trusted);
    const existing = metrics.render();
    expect(existing).toContain('openclaw_queue_lane_size{lane="main"} 2');
    expect(existing).toContain('openclaw_queue_lane_wait_seconds_count{lane="main"} 2');
    expect(existing).toContain("openclaw_prometheus_series_dropped_total 87");
    metrics.record({ ...queue, lane: "later" }, trusted);
    expect(metrics.render()).toContain("openclaw_prometheus_series_dropped_total 89");
    expect(metrics.render()).not.toContain('lane="later"');
    metrics.stop();
  });

  it("caps metric series growth and reports dropped series", () => {
    const metrics = createMetricsHarness();

    for (let index = 0; index < 2100; index += 1) {
      metrics.record(
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

    const rendered = metrics.render();

    expect(rendered).toContain("# TYPE openclaw_prometheus_series_dropped_total counter");
    expect(rendered).toContain("openclaw_prometheus_series_dropped_total ");
    metrics.record(
      { ...baseEvent(), type: "gateway.rpc", method: "health", phase: "received" },
      trusted,
    );
    const saturated = metrics.render();
    expect(saturated).not.toContain("openclaw_gateway_rpc_requests_total");
    expect(saturated).not.toBe(rendered);
    metrics.stop();
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
    const healthReports: ExporterHealthReport[] = [];
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
        reportExporterHealth: (update) => {
          healthReports.push(update);
          throw new Error("private exporter health callback failure");
        },
      } as TrustedExporterInternalDiagnostics,
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
    expect(healthReports).toStrictEqual([
      {
        signal: "metrics",
        transport: "prometheus-scrape",
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
    expect(emitted.at(-1)).toStrictEqual({
      type: "telemetry.exporter",
      exporter: "diagnostics-prometheus",
      signal: "metrics",
      status: "dropped",
    });
    expect(healthReports.at(-1)).toStrictEqual({
      signal: "metrics",
      transport: "prometheus-scrape",
      status: "dropped",
    });
    expect(exporter.render()).toBe("");
  });
});

describe("metrics HTTP handler", () => {
  it("sends byte-accurate representation metadata on HEAD", async () => {
    const metrics = createMetricsHarness();
    metrics.record(
      {
        ...baseEvent(),
        type: "run.completed",
        runId: "run-1",
        sessionKey: "session-1",
        provider: "openai",
        model: "gpt-5.4",
        channel: "discord",
        trigger: "message",
        durationMs: 1500,
        outcome: "completed",
      },
      trusted,
    );
    const server = createServer((req, res) => {
      void metrics.handler(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    try {
      const base = `http://127.0.0.1:${address.port}/api/diagnostics/prometheus`;
      const get = await fetch(base);
      const getBody = await get.text();
      const head = await fetch(base, { method: "HEAD" });
      const headBody = await head.arrayBuffer();
      const getBodyBytes = Buffer.byteLength(getBody);
      expect(get.status).toBe(200);
      expect(getBodyBytes).toBeGreaterThan(0);
      expect(get.headers.get("content-length")).toBe(String(getBodyBytes));
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(getBodyBytes));
      expect(headBody.byteLength).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      metrics.stop();
    }
  });
});
