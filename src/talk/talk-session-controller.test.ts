import { describe, expect, it } from "vitest";
import { createTalkSessionController, normalizeTalkTransport } from "./talk-session-controller.js";

function createController() {
  return createTalkSessionController(
    {
      sessionId: "talk-session",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "test",
      maxRecentEvents: 3,
    },
    { now: () => "2026-05-05T00:00:00.000Z" },
  );
}

describe("createTalkSessionController", () => {
  it("emits common envelopes and keeps bounded recent event history", () => {
    const talk = createController();

    talk.emit({ type: "session.started", payload: {} });
    const firstTurn = talk.ensureTurn();
    talk.emit({
      type: "input.audio.delta",
      turnId: firstTurn.turnId,
      payload: { byteLength: 5 },
    });
    talk.emit({
      type: "transcript.done",
      turnId: firstTurn.turnId,
      payload: { text: "hello" },
      final: true,
    });

    expect(firstTurn.event).toMatchObject({
      id: "talk-session:2",
      type: "turn.started",
      sessionId: "talk-session",
      turnId: "turn-1",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "test",
      seq: 2,
      timestamp: "2026-05-05T00:00:00.000Z",
    });
    expect(talk.recentEvents.map((event) => event.type)).toEqual([
      "turn.started",
      "input.audio.delta",
      "transcript.done",
    ]);
  });

  it("rejects stale turn completion before clearing the active turn", () => {
    const talk = createController();
    talk.ensureTurn({ turnId: "turn-old" });
    expect(talk.endTurn({ turnId: "turn-other" })).toEqual({
      ok: false,
      reason: "stale_turn",
    });
    expect(talk.activeTurnId).toBe("turn-old");

    const ended = talk.endTurn({ turnId: "turn-old", payload: { reason: "done" } });

    expect(ended).toMatchObject({
      ok: true,
      turnId: "turn-old",
      event: {
        type: "turn.ended",
        turnId: "turn-old",
        payload: { reason: "done" },
        final: true,
      },
    });
    expect(talk.activeTurnId).toBeUndefined();
  });

  it("tracks output audio lifecycle without duplicate started events", () => {
    const talk = createController();

    const first = talk.startOutputAudio({ payload: { callId: "call-1" } });
    const second = talk.startOutputAudio({ payload: { callId: "call-1" } });
    const done = talk.finishOutputAudio({ payload: { reason: "mark" } });

    expect(first.event).toMatchObject({
      type: "output.audio.started",
      turnId: "turn-1",
    });
    expect(second).toEqual({ turnId: "turn-1" });
    expect(done).toMatchObject({
      type: "output.audio.done",
      turnId: "turn-1",
      payload: { reason: "mark" },
      final: true,
    });
    expect(talk.outputAudioActive).toBe(false);
  });

  it("notifies an event hook for emitted and controller-created events", () => {
    const events: string[] = [];
    const talk = createTalkSessionController(
      {
        sessionId: "talk-session",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
      },
      {
        now: () => "2026-05-05T00:00:00.000Z",
        onEvent: (event) => events.push(event.type),
      },
    );

    talk.emit({ type: "session.started", payload: {} });
    const turn = talk.ensureTurn();
    talk.endTurn({ turnId: turn.turnId });

    expect(events).toEqual(["session.started", "turn.started", "turn.ended"]);
  });

  it("clears stale output audio state when a replacement turn starts", () => {
    const talk = createController();

    talk.startOutputAudio({ turnId: "turn-old" });
    expect(talk.outputAudioActive).toBe(true);

    const current = talk.startTurn({ turnId: "turn-current" });

    expect(current).toMatchObject({
      turnId: "turn-current",
      event: expect.objectContaining({ type: "turn.started", turnId: "turn-current" }),
    });
    expect(talk.activeTurnId).toBe("turn-current");
    expect(talk.outputAudioActive).toBe(false);
  });
});

describe("normalizeTalkTransport", () => {
  it("maps legacy public transport names to canonical names", () => {
    expect(normalizeTalkTransport(undefined)).toBeUndefined();
    expect(normalizeTalkTransport("webrtc-sdp")).toBe("webrtc");
    expect(normalizeTalkTransport("json-pcm-websocket")).toBe("provider-websocket");
    expect(normalizeTalkTransport("gateway-relay")).toBe("gateway-relay");
  });
});
