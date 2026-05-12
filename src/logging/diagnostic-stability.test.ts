import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
  resetDiagnosticStabilityRecorderForTest,
  selectDiagnosticStabilitySnapshot,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
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
    await new Promise<void>((resolve) => setImmediate(resolve));

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
    await new Promise<void>((resolve) => setImmediate(resolve));

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
    await new Promise<void>((resolve) => setImmediate(resolve));

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
});
