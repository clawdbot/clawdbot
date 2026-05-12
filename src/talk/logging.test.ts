import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createTalkLogRecord, recordTalkLogEvent } from "./logging.js";
import { recordTalkObservabilityEvent } from "./observability.js";
import { createTalkEventSequencer } from "./talk-events.js";

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

type ObservedDiagnostic = { event: DiagnosticEventPayload; trusted: boolean };

function stableDiagnosticPayload<TEvent extends DiagnosticEventPayload>(
  event: TEvent,
): Omit<TEvent, "seq" | "trace" | "ts"> {
  expect(event.seq).toBeGreaterThan(0);
  expect(event.ts).toBeGreaterThan(0);
  const { seq: _seq, ts: _ts, trace, ...stable } = event;
  expect(trace).toBeUndefined();
  return stable;
}

function stableLogRecordPayload(event: Extract<DiagnosticEventPayload, { type: "log.record" }>) {
  const { code, loggerParents, ...stable } = stableDiagnosticPayload(event);
  expect(loggerParents).toStrictEqual(["openclaw"]);
  expect(code?.functionName).toBe("recordTalkLogEvent");
  expect(code?.line).toBeGreaterThan(0);
  return stable;
}

function requireObservedDiagnostic<TType extends DiagnosticEventPayload["type"]>(
  observed: readonly ObservedDiagnostic[],
  type: TType,
): { event: Extract<DiagnosticEventPayload, { type: TType }>; trusted: boolean } {
  const event = observed.find(
    (
      entry,
    ): entry is { event: Extract<DiagnosticEventPayload, { type: TType }>; trusted: boolean } =>
      entry.event.type === type,
  );
  if (!event) {
    throw new Error(`Expected ${type} diagnostic event`);
  }
  return event;
}

describe("talk logging", () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-talk-logs-"));
    logFile = path.join(tmpDir, "openclaw.log");
    resetDiagnosticEventsForTest();
    resetLogger();
    setLoggerOverride({ level: "info", file: logFile });
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    setLoggerOverride(null);
    resetLogger();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits bounded lifecycle log records without transcript text or scoped ids", async () => {
    const logs: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "log.record") {
        logs.push(event);
      }
    });
    const events = createTalkEventSequencer({
      sessionId: "talk-session",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
    });
    const talkEvent = events.next({
      type: "output.text.done",
      turnId: "turn-1",
      callId: "call-1",
      itemId: "item-1",
      final: true,
      payload: {
        text: "private transcript should not be logged",
        durationMs: 42,
      },
    });

    expect(createTalkLogRecord(talkEvent)).toEqual({
      level: "info",
      message: "talk event output.text.done",
      attributes: {
        sessionId: "talk-session",
        talkEventType: "output.text.done",
        talkMode: "realtime",
        talkTransport: "gateway-relay",
        talkBrain: "agent-consult",
        talkProvider: "openai",
        talkFinal: true,
        talkDurationMs: 42,
      },
    });

    recordTalkLogEvent(talkEvent);
    await flushDiagnosticEvents();
    unsubscribe();

    expect(logs).toHaveLength(1);
    expect(stableLogRecordPayload(logs[0])).toStrictEqual({
      type: "log.record",
      level: "INFO",
      message: "talk event output.text.done",
      attributes: {
        subsystem: "talk",
        sessionId: "talk-session",
        talkEventType: "output.text.done",
        talkMode: "realtime",
        talkTransport: "gateway-relay",
        talkBrain: "agent-consult",
        talkProvider: "openai",
        talkFinal: true,
        talkDurationMs: 42,
      },
    });
    const serialized = JSON.stringify(logs[0]);
    expect(serialized).not.toContain("private transcript");
    expect(serialized).not.toContain("turn-1");
    expect(serialized).not.toContain("call-1");
    expect(serialized).not.toContain("item-1");

    const fileLog = fs.readFileSync(logFile, "utf8");
    const fileLogRecord = JSON.parse(fileLog.trim()) as Record<string, unknown>;
    expect(fileLogRecord.message).toBe("talk event output.text.done");
    expect(fileLogRecord.session_id).toBe("talk-session");
    expect(fileLog).not.toContain("private transcript");
    expect(fileLog).not.toContain("turn-1");
    expect(fileLog).not.toContain("call-1");
    expect(fileLog).not.toContain("item-1");
  });

  it("drops high-volume delta records from file and OTLP logs", async () => {
    const logs: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "log.record") {
        logs.push(event);
      }
    });
    const events = createTalkEventSequencer({
      sessionId: "talk-session",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
    });

    recordTalkLogEvent(
      events.next({
        type: "transcript.delta",
        turnId: "turn-1",
        payload: { text: "private partial transcript" },
      }),
    );
    recordTalkLogEvent(
      events.next({
        type: "output.audio.delta",
        turnId: "turn-1",
        payload: { byteLength: 320 },
      }),
    );
    await flushDiagnosticEvents();
    unsubscribe();

    expect(logs).toHaveLength(0);
  });

  it("records diagnostics and logs through the combined observability hook", async () => {
    const observed: ObservedDiagnostic[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event, metadata) => {
      observed.push({ event, trusted: metadata.trusted });
    });
    const events = createTalkEventSequencer({
      sessionId: "talk-session",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
    });

    recordTalkObservabilityEvent(
      events.next({
        type: "session.error",
        payload: { message: "provider failure with private detail" },
        final: true,
      }),
    );
    await flushDiagnosticEvents();
    unsubscribe();

    expect(observed).toHaveLength(2);
    const talkEvent = requireObservedDiagnostic(observed, "talk.event");
    const logRecord = requireObservedDiagnostic(observed, "log.record");
    expect(talkEvent.trusted).toBe(true);
    expect(stableDiagnosticPayload(talkEvent.event)).toStrictEqual({
      type: "talk.event",
      sessionId: "talk-session",
      turnId: undefined,
      captureId: undefined,
      talkEventType: "session.error",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
      final: true,
      durationMs: undefined,
      byteLength: undefined,
    });
    expect(logRecord.trusted).toBe(false);
    expect(stableLogRecordPayload(logRecord.event)).toStrictEqual({
      type: "log.record",
      level: "WARN",
      message: "talk event session.error",
      attributes: {
        subsystem: "talk",
        sessionId: "talk-session",
        talkEventType: "session.error",
        talkMode: "realtime",
        talkTransport: "gateway-relay",
        talkBrain: "agent-consult",
        talkProvider: "openai",
        talkFinal: true,
      },
    });
    expect(JSON.stringify(observed)).not.toContain("private detail");
  });
});
