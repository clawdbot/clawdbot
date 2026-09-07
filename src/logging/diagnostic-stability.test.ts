// Diagnostic stability tests cover stable diagnostic output under repeated events.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
  recordDiagnosticExporterHealth,
  resetDiagnosticStabilityRecorderForTest,
  selectDiagnosticStabilitySnapshot,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
  type DiagnosticExporterHealthUpdate,
  type DiagnosticStabilitySnapshot,
} from "./diagnostic-stability.js";

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

describe("diagnostic stability recorder", () => {
  beforeEach(() => {
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
  });

  it("records a bounded payload-free projection of diagnostic events", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "webhook.error",
      channel: "telegram",
      chatId: "chat-secret",
      error: "raw upstream error with content",
    });
    emitDiagnosticEvent({
      type: "tool.loop",
      sessionId: "session-1",
      toolName: "poll",
      level: "warning",
      action: "warn",
      detector: "known_poll_no_progress",
      count: 3,
      message: "message that should not be stored",
    });
    emitDiagnosticEvent({
      type: "talk.event",
      sessionId: "talk-session-secret",
      turnId: "talk-turn-secret",
      captureId: "talk-capture-secret",
      talkEventType: "latency.metrics",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
      final: true,
      durationMs: 12,
      byteLength: 345,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.count).toBe(3);
    expectFields(snapshot.summary.byType, {
      "webhook.error": 1,
      "tool.loop": 1,
      "talk.event": 1,
    });
    expectFields(snapshot.events[0], {
      type: "webhook.error",
      channel: "telegram",
    });
    expect(snapshot.events[0]).not.toHaveProperty("error");
    expect(snapshot.events[0]).not.toHaveProperty("chatId");
    expectFields(snapshot.events[1], {
      type: "tool.loop",
      toolName: "poll",
      level: "warning",
      action: "warn",
      detector: "known_poll_no_progress",
      count: 3,
    });
    expect(snapshot.events[1]).not.toHaveProperty("message");
    expect(snapshot.events[1]).not.toHaveProperty("sessionId");
    expect(snapshot.events[1]).not.toHaveProperty("sessionKey");
    expectFields(snapshot.events[2], {
      type: "talk.event",
      talkEventType: "latency.metrics",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
      final: true,
      durationMs: 12,
      bytes: 345,
    });
    expect(snapshot.events[2]).not.toHaveProperty("sessionId");
    expect(snapshot.events[2]).not.toHaveProperty("turnId");
    expect(snapshot.events[2]).not.toHaveProperty("captureId");
  });

  it("keeps stable reason codes but drops free-form reason text", () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "payload.large",
      surface: "gateway.http.json",
      action: "rejected",
      reason: "json_body_limit",
    });
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "error",
      reason: "raw error with user content",
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expectFields(snapshot.events[0], {
      type: "payload.large",
      reason: "json_body_limit",
    });
    expectFields(snapshot.events[1], {
      type: "message.processed",
      outcome: "error",
    });
    expect(snapshot.events[1]).not.toHaveProperty("reason");
  });

  it("records exec approval followup suppression metadata", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "exec.approval.followup_suppressed",
      approvalId: "approval-123",
      reason: "session_rebound",
      phase: "direct_delivery",
    });

    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });
    expectFields(snapshot.summary.byType, {
      "exec.approval.followup_suppressed": 1,
    });
    expectFields(snapshot.events[0], {
      type: "exec.approval.followup_suppressed",
      approvalId: "approval-123",
      reason: "session_rebound",
      phase: "direct_delivery",
    });
  });

  it("summarizes inbound delivery proof events without message content", () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "message.received",
      channel: "signal",
      sessionKey: "agent:main:signal:direct:u1",
      messageId: "msg-secret",
      chatId: "chat-secret",
      source: "dispatchInboundMessage",
    });
    emitDiagnosticEvent({
      type: "message.dispatch.started",
      channel: "signal",
      sessionKey: "agent:main:signal:direct:u1",
      source: "replyResolver",
    });
    emitDiagnosticEvent({
      type: "message.dispatch.completed",
      channel: "signal",
      sessionKey: "agent:main:signal:direct:u1",
      source: "replyResolver",
      durationMs: 12,
      outcome: "completed",
    });
    emitDiagnosticEvent({
      type: "session.turn.created",
      runId: "run-1",
      sessionKey: "agent:main:signal:direct:u1",
      sessionId: "session-secret",
      agentId: "main",
      channel: "signal",
      trigger: "user",
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.summary.byType).toMatchObject({
      "message.received": 1,
      "message.dispatch.started": 1,
      "message.dispatch.completed": 1,
      "session.turn.created": 1,
    });
    expect(snapshot.events).toEqual([
      expect.objectContaining({
        type: "message.received",
        channel: "signal",
        source: "dispatchInboundMessage",
      }),
      expect.objectContaining({
        type: "message.dispatch.started",
        channel: "signal",
        source: "replyResolver",
      }),
      expect.objectContaining({
        type: "message.dispatch.completed",
        channel: "signal",
        source: "replyResolver",
        outcome: "completed",
      }),
      expect.objectContaining({
        type: "session.turn.created",
        channel: "signal",
        source: "main",
        outcome: "user",
      }),
    ]);
    for (const event of snapshot.events) {
      expect(event).not.toHaveProperty("messageId");
      expect(event).not.toHaveProperty("chatId");
      expect(event).not.toHaveProperty("sessionId");
      expect(event).not.toHaveProperty("sessionKey");
    }
  });

  it("summarizes assembled context diagnostics without prompt text", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "context.assembled",
      runId: "run-secret",
      sessionId: "session-secret",
      provider: "openai",
      model: "gpt-5.4",
      channel: "telegram",
      trigger: "user-message",
      messageCount: 4,
      historyTextChars: 1200,
      historyImageBlocks: 1,
      maxMessageTextChars: 800,
      systemPromptChars: 300,
      promptChars: 100,
      promptImages: 1,
      contextTokenBudget: 200_000,
      reserveTokens: 20_000,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expectFields(snapshot.events[0], {
      type: "context.assembled",
      provider: "openai",
      model: "gpt-5.4",
      channel: "telegram",
      count: 4,
      context: { limit: 200_000 },
    });
    expect(snapshot.events[0]).not.toHaveProperty("runId");
    expect(snapshot.events[0]).not.toHaveProperty("sessionId");
    expect(snapshot.events[0]).not.toHaveProperty("promptChars");
    expect(snapshot.events[0]).not.toHaveProperty("systemPromptChars");
  });

  it("projects run.execution_phase into the dedicated phase fields", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "run.execution_phase",
      runId: "run-1",
      sessionId: "sid-1",
      sessionKey: "sk-1",
      phase: "model_call_started",
      provider: "anthropic",
      model: "claude",
      tool: "read",
      firstModelCallStarted: true,
    });
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expectFields(snapshot.events[0], {
      type: "run.execution_phase",
      phase: "model_call_started",
      provider: "anthropic",
      model: "claude",
      toolName: "read",
    });
    expect(snapshot.events[0]).not.toHaveProperty("reason");
  });

  it("sanitizes tool and model diagnostic error categories", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "tool.execution.error",
      toolName: "read",
      durationMs: 1,
      errorCategory: "bad reason\nwith content",
    });
    emitDiagnosticEvent({
      type: "model.call.error",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 1,
      requestPayloadBytes: 1234,
      responseStreamBytes: 567,
      timeToFirstByteMs: 89,
      errorCategory: "TypeError",
      failureKind: "terminated",
      memory: {
        rssBytes: 100,
        heapTotalBytes: 80,
        heapUsedBytes: 40,
        externalBytes: 20,
        arrayBuffersBytes: 10,
      },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expectFields(snapshot.events[0], {
      type: "tool.execution.error",
      toolName: "read",
    });
    expect(snapshot.events[0]).not.toHaveProperty("reason");
    expectFields(snapshot.events[1], {
      type: "model.call.error",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 1,
      requestBytes: 1234,
      responseBytes: 567,
      timeToFirstByteMs: 89,
      reason: "TypeError",
      failureKind: "terminated",
      memory: {
        rssBytes: 100,
        heapTotalBytes: 80,
        heapUsedBytes: 40,
        externalBytes: 20,
        arrayBuffersBytes: 10,
      },
    });
    expect(JSON.stringify(snapshot.events[1])).not.toContain("call-1");
  });

  it("summarizes memory and large payload events", () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "diagnostic.memory.sample",
      memory: {
        rssBytes: 100,
        heapTotalBytes: 80,
        heapUsedBytes: 40,
        externalBytes: 10,
        arrayBuffersBytes: 5,
      },
    });
    emitDiagnosticEvent({
      type: "diagnostic.memory.pressure",
      level: "warning",
      reason: "rss_threshold",
      thresholdBytes: 90,
      memory: {
        rssBytes: 120,
        heapTotalBytes: 90,
        heapUsedBytes: 50,
        externalBytes: 10,
        arrayBuffersBytes: 5,
      },
    });
    emitDiagnosticEvent({
      type: "payload.large",
      surface: "gateway.http.json",
      action: "rejected",
      bytes: 1024,
      limitBytes: 512,
      reason: "content-length",
    });

    const snapshot = getDiagnosticStabilitySnapshot();

    expectFields(snapshot.summary.memory, {
      maxRssBytes: 120,
      maxHeapUsedBytes: 50,
      pressureCount: 1,
    });
    expectFields(snapshot.summary.memory?.latest, {
      rssBytes: 120,
      heapUsedBytes: 50,
    });
    expect(snapshot.summary.payloadLarge).toEqual({
      count: 1,
      rejected: 1,
      truncated: 0,
      chunked: 0,
      bySurface: {
        "gateway.http.json": 1,
      },
    });
  });

  it("keeps the newest events when capacity is exceeded", () => {
    startDiagnosticStabilityRecorder();

    for (let index = 0; index < 1005; index += 1) {
      emitDiagnosticEvent({
        type: "message.queued",
        source: "test",
        queueDepth: index,
      });
    }

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 1000 });

    expect(snapshot.capacity).toBe(1000);
    expect(snapshot.count).toBe(1000);
    expect(snapshot.dropped).toBe(5);
    expect(snapshot.firstSeq).toBe(6);
    expect(snapshot.lastSeq).toBe(1005);
    expectFields(snapshot.events[0], { seq: 6, queueDepth: 5 });
  });

  it("keeps trusted exporter state sticky and rejects spoofed untrusted facts", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "telemetry.exporter",
      exporter: "diagnostics-otel",
      signal: "traces",
      status: "failure",
      reason: "emit_failed",
    });
    recordDiagnosticExporterHealth("diagnostics-otel", {
      signal: "traces",
      transport: "otlp-http-protobuf",
      endpointMode: "default_endpoint",
      status: "started",
      reason: "configured",
    });
    recordDiagnosticExporterHealth("diagnostics-otel", {
      signal: "traces",
      transport: "otlp-http-protobuf",
      endpointMode: "default_endpoint",
      status: "failure",
      reason: "export_failed",
      errorCategory: "https://collector.example/private",
    });
    for (let index = 0; index < 1005; index += 1) {
      emitDiagnosticEvent({
        type: "message.queued",
        source: "test",
        queueDepth: index,
      });
    }
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({
      type: "telemetry.exporter",
      limit: 1000,
    });
    const defaultSnapshot = getDiagnosticStabilitySnapshot({ limit: 1000 });

    expect(snapshot.capacity).toBe(16);
    expect(snapshot.count).toBe(1);
    expect(snapshot.events).toEqual([
      expect.objectContaining({
        type: "telemetry.exporter",
        source: "diagnostics-otel",
        target: "traces",
        transport: "otlp-http-protobuf",
        outcome: "failure",
        reason: "export_failed",
        mode: "default_endpoint",
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("collector.example");
    expect(defaultSnapshot.count).toBe(1000);
    expect(defaultSnapshot.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message.queued",
          source: "test",
        }),
      ]),
    );
    expect(defaultSnapshot.events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "telemetry.exporter" })]),
    );
  });

  it("retains exporter ownership through recovery", async () => {
    startDiagnosticStabilityRecorder();

    recordDiagnosticExporterHealth("diagnostics-otel", {
      signal: "metrics",
      transport: "otlp-http-protobuf",
      endpointMode: "configured",
      status: "started",
      reason: "configured",
    });
    recordDiagnosticExporterHealth("diagnostics-otel", {
      signal: "metrics",
      transport: "otlp-http-protobuf",
      status: "failure",
      reason: "export_failed",
    });
    recordDiagnosticExporterHealth("diagnostics-otel", {
      signal: "metrics",
      transport: "otlp-http-protobuf",
      status: "recovered",
      reason: "export_failed",
    });
    await waitForDiagnosticEventsDrained();

    expect(
      getDiagnosticStabilitySnapshot({
        type: "telemetry.exporter",
        limit: 1000,
      }).events,
    ).toEqual([
      expect.objectContaining({
        target: "metrics",
        outcome: "recovered",
        reason: "export_failed",
        mode: "configured",
      }),
    ]);
  });

  it("preserves explicit and dependency-default ownership on startup failures", async () => {
    startDiagnosticStabilityRecorder();

    recordDiagnosticExporterHealth("diagnostics-otel", {
      signal: "traces",
      transport: "otlp-http-protobuf",
      endpointMode: "default_endpoint",
      status: "failure",
      reason: "start_failed",
    });
    recordDiagnosticExporterHealth("diagnostics-otel", {
      signal: "metrics",
      transport: "otlp-http-protobuf",
      endpointMode: "configured",
      status: "failure",
      reason: "start_failed",
    });
    await waitForDiagnosticEventsDrained();

    expect(
      getDiagnosticStabilitySnapshot({
        type: "telemetry.exporter",
        limit: 1000,
      }).events,
    ).toEqual([
      expect.objectContaining({
        target: "traces",
        transport: "otlp-http-protobuf",
        outcome: "failure",
        reason: "start_failed",
        mode: "default_endpoint",
      }),
      expect.objectContaining({
        target: "metrics",
        transport: "otlp-http-protobuf",
        outcome: "failure",
        reason: "start_failed",
        mode: "configured",
      }),
    ]);
  });

  it("keeps safe generic codes while dropping unsafe sources and redacting transports", async () => {
    startDiagnosticStabilityRecorder();

    recordDiagnosticExporterHealth("diagnostics-prometheus", {
      signal: "metrics",
      transport: "prometheus-scrape",
      status: "started",
      reason: "configured",
    });
    recordDiagnosticExporterHealth("custom-exporter", {
      signal: "logs",
      transport: "collector.internal:4318",
      endpointMode:
        "https://private.example/mode" as DiagnosticExporterHealthUpdate["endpointMode"],
      status: "failure",
      reason: "queue_full",
      errorCategory: "TypeError",
    });
    recordDiagnosticExporterHealth("https://private.example/exporter", {
      signal: "traces",
      transport: "vendor-proto",
      status: "failure",
      reason: "export_failed",
    });
    recordDiagnosticExporterHealth("diagnostics-otel", {
      signal: "private-signal",
      transport: "otlp-http-protobuf",
      status: "failure",
      reason: "export_failed",
    } as unknown as DiagnosticExporterHealthUpdate);
    recordDiagnosticExporterHealth("diagnostics-otel", {
      signal: "traces",
      transport: "otlp-http-protobuf",
      status: "private-status",
      reason: "export_failed",
    } as unknown as DiagnosticExporterHealthUpdate);
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({
      type: "telemetry.exporter",
      limit: 1000,
    });
    expect(snapshot.events).toEqual([
      expect.objectContaining({
        source: "diagnostics-prometheus",
        transport: "prometheus-scrape",
      }),
      expect.objectContaining({
        source: "custom-exporter",
        outcome: "failure",
        reason: "queue_full",
        errorCategory: "TypeError",
      }),
    ]);
    expect(snapshot.events[1]).not.toHaveProperty("transport");
    expect(snapshot.events[1]).not.toHaveProperty("mode");
    expect(JSON.stringify(snapshot)).not.toContain("collector.internal");
    expect(JSON.stringify(snapshot)).not.toContain("private.example");
    expect(JSON.stringify(snapshot)).not.toContain("private-signal");
    expect(JSON.stringify(snapshot)).not.toContain("private-status");
  });

  it("replaces retired routes while retaining every current logs both route", async () => {
    startDiagnosticStabilityRecorder();
    const emitExporter = (event: DiagnosticExporterHealthUpdate & { exporter: string }) => {
      const { exporter, ...update } = event;
      recordDiagnosticExporterHealth(exporter, update);
    };

    emitExporter({
      exporter: "diagnostics-otel",
      signal: "traces",
      transport: "otlp-http-protobuf",
      status: "started",
      reason: "configured",
    });
    emitExporter({
      exporter: "diagnostics-otel",
      signal: "traces",
      transport: "otlp-http-protobuf",
      status: "dropped",
    });
    emitExporter({
      exporter: "diagnostics-otel",
      signal: "traces",
      transport: "external-sdk",
      status: "started",
      reason: "configured",
    });
    await waitForDiagnosticEventsDrained();

    expect(
      getDiagnosticStabilitySnapshot({ type: "telemetry.exporter", limit: 1000 }).events,
    ).toEqual([
      expect.objectContaining({
        target: "traces",
        transport: "external-sdk",
        outcome: "started",
      }),
    ]);

    emitExporter({
      exporter: "diagnostics-otel",
      signal: "traces",
      transport: "external-sdk",
      status: "dropped",
    });
    emitExporter({
      exporter: "diagnostics-otel",
      signal: "traces",
      transport: "otlp-http-protobuf",
      status: "failure",
      reason: "unsupported_protocol",
    });
    emitExporter({
      exporter: "diagnostics-otel",
      signal: "logs",
      transport: "otlp-http-protobuf",
      status: "started",
      reason: "configured",
    });
    emitExporter({
      exporter: "diagnostics-otel",
      signal: "logs",
      transport: "stdout",
      status: "started",
      reason: "configured",
    });
    await waitForDiagnosticEventsDrained();

    let events = getDiagnosticStabilitySnapshot({
      type: "telemetry.exporter",
      limit: 1000,
    }).events;
    expect(events.filter((event) => event.target === "traces")).toEqual([
      expect.objectContaining({
        transport: "otlp-http-protobuf",
        outcome: "failure",
        reason: "unsupported_protocol",
      }),
    ]);
    expect(events.filter((event) => event.target === "logs")).toEqual([
      expect.objectContaining({ transport: "otlp-http-protobuf", outcome: "started" }),
      expect.objectContaining({ transport: "stdout", outcome: "started" }),
    ]);

    emitExporter({
      exporter: "diagnostics-otel",
      signal: "traces",
      transport: "otlp-http-protobuf",
      status: "dropped",
    });
    emitExporter({
      exporter: "diagnostics-otel",
      signal: "traces",
      transport: "otlp-http-protobuf",
      status: "started",
      reason: "configured",
    });
    await waitForDiagnosticEventsDrained();

    expect(
      getDiagnosticStabilitySnapshot({ type: "telemetry.exporter", limit: 1000 }).events.filter(
        (event) => event.target === "traces",
      ),
    ).toEqual([
      expect.objectContaining({
        transport: "otlp-http-protobuf",
        outcome: "started",
      }),
    ]);

    emitExporter({
      exporter: "diagnostics-otel",
      signal: "logs",
      transport: "otlp-http-protobuf",
      status: "dropped",
    });
    emitExporter({
      exporter: "diagnostics-otel",
      signal: "logs",
      transport: "stdout",
      status: "dropped",
    });
    emitExporter({
      exporter: "diagnostics-otel",
      signal: "logs",
      transport: "stdout",
      status: "started",
      reason: "configured",
    });
    await waitForDiagnosticEventsDrained();

    events = getDiagnosticStabilitySnapshot({
      type: "telemetry.exporter",
      limit: 1000,
    }).events;
    expect(events.filter((event) => event.target === "logs")).toEqual([
      expect.objectContaining({ transport: "stdout", outcome: "started" }),
    ]);

    emitExporter({
      exporter: "diagnostics-otel",
      signal: "logs",
      transport: "stdout",
      status: "dropped",
    });
    emitExporter({
      exporter: "diagnostics-otel",
      signal: "logs",
      transport: "otlp-http-protobuf",
      status: "started",
      reason: "configured",
    });
    emitExporter({
      exporter: "diagnostics-otel",
      signal: "logs",
      transport: "stdout",
      status: "started",
      reason: "configured",
    });
    await waitForDiagnosticEventsDrained();

    events = getDiagnosticStabilitySnapshot({
      type: "telemetry.exporter",
      limit: 1000,
    }).events;
    expect(events.filter((event) => event.target === "logs")).toEqual([
      expect.objectContaining({ transport: "otlp-http-protobuf", outcome: "started" }),
      expect.objectContaining({ transport: "stdout", outcome: "started" }),
    ]);
  });

  it("filters snapshots by type, sequence, and limit", () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });
    emitDiagnosticEvent({ type: "payload.large", surface: "chat.history", action: "truncated" });
    emitDiagnosticEvent({ type: "payload.large", surface: "chat.history", action: "chunked" });

    const snapshot = getDiagnosticStabilitySnapshot({
      type: "payload.large",
      sinceSeq: 2,
      limit: 1,
    });

    expect(snapshot.count).toBe(1);
    expect(snapshot.events).toHaveLength(1);
    expectFields(snapshot.events[0], {
      seq: 3,
      type: "payload.large",
      action: "chunked",
    });
  });

  it("records sanitized trusted model request instrumentation", async () => {
    startDiagnosticStabilityRecorder();

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "private-run-id",
      callId: "private-call-id",
      sessionKey: "private-session-key",
      provider: "openai",
      model: "gpt-5.4",
      observationUnit: "request",
    });
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticStabilitySnapshot({ type: "model.call.started" }).events).toEqual([
      expect.objectContaining({
        type: "model.call.started",
        provider: "openai",
        model: "gpt-5.4",
      }),
    ]);
    expect(JSON.stringify(getDiagnosticStabilitySnapshot())).not.toContain("private-");
  });

  it("keeps async queue drop summaries after drained queued events for sinceSeq polling", async () => {
    startDiagnosticStabilityRecorder();

    for (let index = 0; index < 10_001; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `overflow-run-${index}`,
        callId: `overflow-call-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const midDrainSnapshot = getDiagnosticStabilitySnapshot({ limit: 1000 });
    expect(midDrainSnapshot.lastSeq).toBe(100);
    expect(
      midDrainSnapshot.events.some((event) => event.type === "diagnostic.async_queue.dropped"),
    ).toBe(false);

    await waitForDiagnosticEventsDrained();

    const sinceMidDrain = getDiagnosticStabilitySnapshot({
      sinceSeq: midDrainSnapshot.lastSeq,
      limit: 1000,
    });
    const dropSummary = sinceMidDrain.events.find(
      (event) => event.type === "diagnostic.async_queue.dropped",
    );
    expectFields(dropSummary, {
      type: "diagnostic.async_queue.dropped",
      droppedEvents: 1,
      droppedUntrustedEvents: 1,
      queueLength: 0,
      maxQueueLength: 10_000,
      drainBatchSize: 100,
    });
    expect(
      sinceMidDrain.events.filter((event) => event.type === "model.call.started"),
    ).not.toHaveLength(0);
    expect(sinceMidDrain.lastSeq).toBeGreaterThan(10_000);
  });

  it("applies query filters to persisted snapshots without mutating the source", () => {
    const snapshot: DiagnosticStabilitySnapshot = {
      generatedAt: "2026-04-22T12:00:00.000Z",
      capacity: 1000,
      count: 3,
      dropped: 0,
      firstSeq: 1,
      lastSeq: 3,
      events: [
        { seq: 1, ts: 1, type: "webhook.received" },
        { seq: 2, ts: 2, type: "payload.large", surface: "chat.history", action: "rejected" },
        { seq: 3, ts: 3, type: "payload.large", surface: "chat.history", action: "chunked" },
      ],
      summary: {
        byType: {
          "webhook.received": 1,
          "payload.large": 2,
        },
      },
    };

    const selected = selectDiagnosticStabilitySnapshot(snapshot, {
      type: "payload.large",
      limit: 1,
    });

    expectFields(selected, {
      count: 2,
      firstSeq: 2,
      lastSeq: 3,
    });
    expect(selected.events).toHaveLength(1);
    expectFields(selected.events[0], {
      seq: 3,
      type: "payload.large",
      action: "chunked",
    });
    expectFields(selected.summary.byType, {
      "payload.large": 2,
    });
    expectFields(selected.summary.payloadLarge, {
      count: 2,
      rejected: 1,
      chunked: 1,
    });
    expect(snapshot.events).toHaveLength(3);
  });

  it("normalizes external stability query params consistently", () => {
    expect(
      normalizeDiagnosticStabilityQuery(
        {
          limit: "25",
          type: " payload.large ",
          sinceSeq: "2",
        },
        { defaultLimit: 10 },
      ),
    ).toEqual({
      limit: 25,
      type: "payload.large",
      sinceSeq: 2,
    });
    expect(normalizeDiagnosticStabilityQuery({}, { defaultLimit: 10 })).toEqual({
      limit: 10,
      type: undefined,
      sinceSeq: undefined,
    });
    expect(() => normalizeDiagnosticStabilityQuery({ limit: 0 })).toThrow(
      "limit must be between 1 and 1000",
    );
    expect(() => normalizeDiagnosticStabilityQuery({ sinceSeq: -1 })).toThrow(
      "sinceSeq must be a non-negative integer",
    );
  });

  it("rejects non-decimal stability query integer strings", () => {
    for (const malformed of ["0x2", "1e2", "+5", " 5 "]) {
      expect(() => normalizeDiagnosticStabilityQuery({ limit: malformed })).toThrow(
        "limit must be a non-negative integer",
      );
      expect(() => normalizeDiagnosticStabilityQuery({ sinceSeq: malformed })).toThrow(
        "sinceSeq must be a non-negative integer",
      );
    }
    expect(normalizeDiagnosticStabilityQuery({ sinceSeq: "0" }).sinceSeq).toBe(0);
    expect(normalizeDiagnosticStabilityQuery({ limit: "42" }).limit).toBe(42);
    expect(normalizeDiagnosticStabilityQuery({ limit: 7 }).limit).toBe(7);
  });

  it("rejects unsafe integers for stability query limit and sinceSeq", () => {
    const safe = Number.MAX_SAFE_INTEGER;
    const unsafe = safe + 1;
    // sinceSeq has no upper bound: safe integers are accepted, unsafe rejected.
    expect(normalizeDiagnosticStabilityQuery({ sinceSeq: safe }).sinceSeq).toBe(safe);
    expect(() => normalizeDiagnosticStabilityQuery({ sinceSeq: unsafe })).toThrow(
      "sinceSeq must be a non-negative integer",
    );
    expect(normalizeDiagnosticStabilityQuery({ sinceSeq: String(safe) }).sinceSeq).toBe(safe);
    expect(() => normalizeDiagnosticStabilityQuery({ sinceSeq: String(unsafe) })).toThrow(
      "sinceSeq must be a non-negative integer",
    );
    // limit is additionally capped at 1000: a safe but out-of-range value hits
    // the range error, while an unsafe integer is rejected by the integer gate
    // first, identically for numeric and string input.
    expect(() => normalizeDiagnosticStabilityQuery({ limit: safe })).toThrow(
      "limit must be between 1 and 1000",
    );
    expect(() => normalizeDiagnosticStabilityQuery({ limit: unsafe })).toThrow(
      "limit must be a non-negative integer",
    );
    expect(() => normalizeDiagnosticStabilityQuery({ limit: String(unsafe) })).toThrow(
      "limit must be a non-negative integer",
    );
  });
});
