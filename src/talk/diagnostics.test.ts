import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { createTalkDiagnosticEvent, recordTalkDiagnosticEvent } from "./diagnostics.js";
import { createTalkEventSequencer } from "./talk-events.js";

describe("talk diagnostics", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("maps talk events to bounded diagnostic events without payload content", async () => {
    const diagnostics: Array<{ event: DiagnosticEventPayload; trusted: boolean }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      diagnostics.push({ event, trusted: metadata.trusted });
    });
    const events = createTalkEventSequencer({
      sessionId: "talk-session",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
    });

    const talkEvent = events.next({
      type: "input.audio.delta",
      turnId: "turn-1",
      payload: {
        byteLength: 320,
        text: "private transcript should not export",
      },
    });

    expect(createTalkDiagnosticEvent(talkEvent)).toEqual({
      type: "talk.event",
      sessionId: "talk-session",
      turnId: "turn-1",
      captureId: undefined,
      talkEventType: "input.audio.delta",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
      final: undefined,
      durationMs: undefined,
      byteLength: 320,
    });

    recordTalkDiagnosticEvent(talkEvent);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics;
    if (!diagnostic) {
      throw new Error("Expected talk diagnostic event");
    }
    expect({
      ...diagnostic,
      event: {
        ...diagnostic.event,
        tsType: typeof diagnostic.event.ts,
        ts: undefined,
      },
    }).toEqual({
      trusted: true,
      event: {
        type: "talk.event",
        sessionId: "talk-session",
        turnId: "turn-1",
        captureId: undefined,
        seq: 1,
        ts: undefined,
        tsType: "number",
        trace: undefined,
        talkEventType: "input.audio.delta",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
        final: undefined,
        durationMs: undefined,
        byteLength: 320,
      },
    });
    expect(JSON.stringify(diagnostic.event)).not.toContain("private transcript");
  });
});
