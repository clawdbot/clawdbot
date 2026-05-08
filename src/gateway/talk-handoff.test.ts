import { describe, expect, it, vi } from "vitest";
import {
  cancelTalkHandoffTurn,
  clearTalkHandoffsForTest,
  createTalkHandoff,
  endTalkHandoffTurn,
  getTalkHandoff,
  joinTalkHandoff,
  revokeTalkHandoff,
  startTalkHandoffTurn,
  verifyTalkHandoffToken,
} from "./talk-handoff.js";

describe("talk handoff store", () => {
  it("creates an expiring managed-room handoff without storing the plaintext token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T12:00:00.000Z"));
    clearTalkHandoffsForTest();

    const handoff = createTalkHandoff({
      sessionKey: "session:main",
      sessionId: "session-id",
      channel: "discord",
      target: "dm:123",
      provider: "openai",
      model: "gpt-realtime-2",
      voice: "alloy",
      ttlMs: 5000,
    });
    const record = getTalkHandoff(handoff.id);

    expect(handoff).toMatchObject({
      roomId: `talk_${handoff.id}`,
      roomUrl: `/talk/rooms/talk_${handoff.id}`,
      sessionKey: "session:main",
      sessionId: "session-id",
      channel: "discord",
      target: "dm:123",
      provider: "openai",
      model: "gpt-realtime-2",
      voice: "alloy",
      mode: "stt-tts",
      transport: "managed-room",
      brain: "agent-consult",
      createdAt: Date.parse("2026-05-05T12:00:00.000Z"),
      expiresAt: Date.parse("2026-05-05T12:00:05.000Z"),
      room: {
        activeClientId: undefined,
        recentTalkEvents: [
          expect.objectContaining({
            type: "session.started",
            sessionId: `talk_${handoff.id}`,
            transport: "managed-room",
          }),
        ],
      },
    });
    expect(handoff).not.toHaveProperty("tokenHash");
    if (record === undefined) {
      throw new Error("expected stored talk handoff record");
    }
    expect(record.tokenHash).not.toBe(handoff.token);
    expect(verifyTalkHandoffToken(record, handoff.token)).toBe(true);

    vi.advanceTimersByTime(5001);
    expect(getTalkHandoff(handoff.id)).toBeUndefined();
    vi.useRealTimers();
  });

  it("joins and revokes handoffs with only the bearer token", () => {
    clearTalkHandoffsForTest();
    const handoff = createTalkHandoff({ sessionKey: "session:main" });

    expect(joinTalkHandoff(handoff.id, "wrong")).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(joinTalkHandoff(handoff.id, handoff.token)).toMatchObject({
      ok: true,
      events: [expect.objectContaining({ type: "session.ready" })],
      record: expect.objectContaining({
        id: handoff.id,
        roomId: handoff.roomId,
        sessionKey: "session:main",
      }),
    });

    expect(revokeTalkHandoff(handoff.id)).toMatchObject({ revoked: true });
    expect(joinTalkHandoff(handoff.id, handoff.token)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("records managed-room ready, replacement, and close lifecycle events", () => {
    clearTalkHandoffsForTest();
    const handoff = createTalkHandoff({ sessionKey: "session:main" });

    const firstJoin = joinTalkHandoff(handoff.id, handoff.token, { clientId: "conn-1" });
    expect(firstJoin).toMatchObject({
      ok: true,
      events: [
        expect.objectContaining({
          type: "session.ready",
          sessionId: handoff.roomId,
          payload: expect.objectContaining({ clientId: "conn-1" }),
        }),
      ],
      record: {
        room: expect.objectContaining({
          activeClientId: "conn-1",
        }),
      },
    });

    const secondJoin = joinTalkHandoff(handoff.id, handoff.token, { clientId: "conn-2" });
    expect(secondJoin).toMatchObject({
      ok: true,
      events: [
        expect.objectContaining({
          type: "session.replaced",
          sessionId: handoff.roomId,
          payload: expect.objectContaining({
            previousClientId: "conn-1",
            nextClientId: "conn-2",
          }),
        }),
        expect.objectContaining({
          type: "session.ready",
          sessionId: handoff.roomId,
          payload: expect.objectContaining({ clientId: "conn-2" }),
        }),
      ],
      record: {
        room: expect.objectContaining({
          activeClientId: "conn-2",
        }),
      },
    });

    expect(revokeTalkHandoff(handoff.id)).toMatchObject({
      revoked: true,
      activeClientId: "conn-2",
      events: [
        expect.objectContaining({
          type: "session.closed",
          sessionId: handoff.roomId,
          payload: expect.objectContaining({ reason: "revoked" }),
          final: true,
        }),
      ],
    });
  });

  it("records managed-room turn start, end, and cancellation events", () => {
    clearTalkHandoffsForTest();
    const handoff = createTalkHandoff({ sessionKey: "session:main" });
    joinTalkHandoff(handoff.id, handoff.token, { clientId: "conn-1" });

    const start = startTalkHandoffTurn(handoff.id, handoff.token, {
      clientId: "conn-1",
      turnId: "turn-1",
    });
    expect(start).toMatchObject({
      ok: true,
      turnId: "turn-1",
      events: [expect.objectContaining({ type: "turn.started", turnId: "turn-1" })],
      record: {
        room: expect.objectContaining({
          activeClientId: "conn-1",
          activeTurnId: "turn-1",
        }),
      },
    });

    expect(endTalkHandoffTurn(handoff.id, handoff.token)).toMatchObject({
      ok: true,
      turnId: "turn-1",
      events: [
        expect.objectContaining({
          type: "turn.ended",
          turnId: "turn-1",
          final: true,
        }),
      ],
      record: {
        room: expect.not.objectContaining({
          activeTurnId: expect.any(String),
        }),
      },
    });

    expect(cancelTalkHandoffTurn(handoff.id, handoff.token)).toEqual({
      ok: false,
      reason: "no_active_turn",
    });

    startTalkHandoffTurn(handoff.id, handoff.token, { turnId: "turn-2" });
    expect(cancelTalkHandoffTurn(handoff.id, handoff.token, { reason: "barge-in" })).toMatchObject({
      ok: true,
      turnId: "turn-2",
      events: [
        expect.objectContaining({
          type: "turn.cancelled",
          turnId: "turn-2",
          final: true,
          payload: expect.objectContaining({ reason: "barge-in" }),
        }),
      ],
    });
  });

  it("rejects stale managed-room turn completion without clearing the active turn", () => {
    clearTalkHandoffsForTest();
    const handoff = createTalkHandoff({ sessionKey: "session:main" });

    startTalkHandoffTurn(handoff.id, handoff.token, { turnId: "turn-old" });
    startTalkHandoffTurn(handoff.id, handoff.token, { turnId: "turn-current" });

    expect(endTalkHandoffTurn(handoff.id, handoff.token, { turnId: "turn-old" })).toEqual({
      ok: false,
      reason: "stale_turn",
    });
    expect(getTalkHandoff(handoff.id)?.room.talk.activeTurnId).toBe("turn-current");

    expect(cancelTalkHandoffTurn(handoff.id, handoff.token, { turnId: "turn-old" })).toEqual({
      ok: false,
      reason: "stale_turn",
    });
    expect(getTalkHandoff(handoff.id)?.room.talk.activeTurnId).toBe("turn-current");

    expect(endTalkHandoffTurn(handoff.id, handoff.token, { turnId: "turn-current" })).toMatchObject(
      {
        ok: true,
        turnId: "turn-current",
      },
    );
  });

  it("isolates simultaneous handoffs for different sessions on the same host", () => {
    clearTalkHandoffsForTest();

    const first = createTalkHandoff({
      sessionKey: "agent:main:first",
      channel: "browser",
      target: "host:local",
      provider: "openai",
    });
    const second = createTalkHandoff({
      sessionKey: "agent:main:second",
      channel: "browser",
      target: "host:local",
    });

    expect(first.id).not.toBe(second.id);
    expect(first.roomId).not.toBe(second.roomId);
    expect(first.token).not.toBe(second.token);
    expect(joinTalkHandoff(first.id, second.token)).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(joinTalkHandoff(second.id, first.token)).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(joinTalkHandoff(first.id, first.token)).toMatchObject({
      ok: true,
      events: [expect.objectContaining({ type: "session.ready" })],
      record: expect.objectContaining({
        roomId: first.roomId,
        sessionKey: "agent:main:first",
        channel: "browser",
        target: "host:local",
        provider: "openai",
      }),
    });
    expect(joinTalkHandoff(second.id, second.token)).toMatchObject({
      ok: true,
      events: [expect.objectContaining({ type: "session.ready" })],
      record: expect.objectContaining({
        roomId: second.roomId,
        sessionKey: "agent:main:second",
        channel: "browser",
        target: "host:local",
      }),
    });
  });
});
