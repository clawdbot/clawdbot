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

  it("records a bounded payload-free projection of diagnostic events", () => {
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

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.count).toBe(2);
    expect(snapshot.summary.byType).toMatchObject({
      "webhook.error": 1,
      "tool.loop": 1,
    });
    expect(snapshot.events[0]).toMatchObject({
      type: "webhook.error",
      channel: "telegram",
    });
    expect(snapshot.events[0]).not.toHaveProperty("error");
    expect(snapshot.events[0]).not.toHaveProperty("chatId");
    expect(snapshot.events[1]).toMatchObject({
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

    expect(snapshot.events[0]).toMatchObject({
      type: "payload.large",
      reason: "json_body_limit",
    });
    expect(snapshot.events[1]).toMatchObject({
      type: "message.processed",
      outcome: "error",
    });
    expect(snapshot.events[1]).not.toHaveProperty("reason");
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

    expect(snapshot.summary.memory).toMatchObject({
      latest: {
        rssBytes: 120,
        heapUsedBytes: 50,
      },
      maxRssBytes: 120,
      maxHeapUsedBytes: 50,
      pressureCount: 1,
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
    expect(snapshot.events[0]).toMatchObject({ seq: 6, queueDepth: 5 });
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
    expect(snapshot.events).toMatchObject([
      {
        seq: 3,
        type: "payload.large",
        action: "chunked",
      },
    ]);
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

    expect(selected).toMatchObject({
      count: 2,
      firstSeq: 2,
      lastSeq: 3,
      events: [{ seq: 3, type: "payload.large", action: "chunked" }],
      summary: {
        byType: {
          "payload.large": 2,
        },
        payloadLarge: {
          count: 2,
          rejected: 1,
          chunked: 1,
        },
      },
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
