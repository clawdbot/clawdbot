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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function expectFields(
  value: unknown,
  label: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expected] of Object.entries(fields)) {
    expect(record[key]).toEqual(expected);
  }
  return record;
}

function requireRoom(value: unknown, label = "handoff room"): Record<string, unknown> {
  return requireRecord(requireRecord(value, label).room, `${label} room`);
}

function requireEvents(value: unknown, label = "handoff result"): unknown[] {
  return requireArray(requireRecord(value, label).events, `${label} events`);
}

function expectEventFields(
  events: unknown[],
  index: number,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return expectFields(events[index], `event ${index}`, fields);
}

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

    const handoffRecord = expectFields(handoff, "created handoff", {
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
    });
    const room = requireRecord(handoffRecord.room, "created handoff room");
    expect(room.activeClientId).toBeUndefined();
    const events = requireArray(room.recentTalkEvents, "recent talk events");
    expectEventFields(events, 0, {
      type: "session.started",
      sessionId: `talk_${handoff.id}`,
      transport: "managed-room",
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
    const join = joinTalkHandoff(handoff.id, handoff.token);
    const joinRecord = expectFields(join, "join result", {
      ok: true,
    });
    expectEventFields(requireEvents(joinRecord), 0, { type: "session.ready" });
    expectFields(joinRecord.record, "joined record", {
      id: handoff.id,
      roomId: handoff.roomId,
      sessionKey: "session:main",
    });

    expectFields(revokeTalkHandoff(handoff.id), "revoke result", { revoked: true });
    expect(joinTalkHandoff(handoff.id, handoff.token)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("records managed-room ready, replacement, and close lifecycle events", () => {
    clearTalkHandoffsForTest();
    const handoff = createTalkHandoff({ sessionKey: "session:main" });

    const firstJoin = joinTalkHandoff(handoff.id, handoff.token, { clientId: "conn-1" });
    expectFields(firstJoin, "first join", {
      ok: true,
    });
    const firstReady = expectEventFields(requireEvents(firstJoin, "first join"), 0, {
      type: "session.ready",
      sessionId: handoff.roomId,
    });
    expect(requireRecord(firstReady.payload, "first ready payload").clientId).toBe("conn-1");
    expect(
      requireRoom(requireRecord(firstJoin, "first join").record, "first join record")
        .activeClientId,
    ).toBe("conn-1");

    const secondJoin = joinTalkHandoff(handoff.id, handoff.token, { clientId: "conn-2" });
    expectFields(secondJoin, "second join", {
      ok: true,
    });
    const secondEvents = requireEvents(secondJoin, "second join");
    const replaced = expectEventFields(secondEvents, 0, {
      type: "session.replaced",
      sessionId: handoff.roomId,
    });
    expectFields(requireRecord(replaced.payload, "replaced payload"), "replaced payload", {
      previousClientId: "conn-1",
      nextClientId: "conn-2",
    });
    const ready = expectEventFields(secondEvents, 1, {
      type: "session.ready",
      sessionId: handoff.roomId,
    });
    expect(requireRecord(ready.payload, "ready payload").clientId).toBe("conn-2");
    expect(
      requireRoom(requireRecord(secondJoin, "second join").record, "second join record")
        .activeClientId,
    ).toBe("conn-2");

    const revoked = revokeTalkHandoff(handoff.id);
    expectFields(revoked, "revoke result", {
      revoked: true,
      activeClientId: "conn-2",
    });
    const closed = expectEventFields(requireEvents(revoked, "revoke result"), 0, {
      type: "session.closed",
      sessionId: handoff.roomId,
      final: true,
    });
    expect(requireRecord(closed.payload, "closed payload").reason).toBe("revoked");
  });

  it("records managed-room turn start, end, and cancellation events", () => {
    clearTalkHandoffsForTest();
    const handoff = createTalkHandoff({ sessionKey: "session:main" });
    joinTalkHandoff(handoff.id, handoff.token, { clientId: "conn-1" });

    const start = startTalkHandoffTurn(handoff.id, handoff.token, {
      clientId: "conn-1",
      turnId: "turn-1",
    });
    expectFields(start, "turn start", {
      ok: true,
      turnId: "turn-1",
    });
    expectEventFields(requireEvents(start, "turn start"), 0, {
      type: "turn.started",
      turnId: "turn-1",
    });
    expectFields(
      requireRoom(requireRecord(start, "turn start").record, "turn start record"),
      "turn room",
      {
        activeClientId: "conn-1",
        activeTurnId: "turn-1",
      },
    );

    const ended = endTalkHandoffTurn(handoff.id, handoff.token);
    expectFields(ended, "turn end", {
      ok: true,
      turnId: "turn-1",
    });
    expectEventFields(requireEvents(ended, "turn end"), 0, {
      type: "turn.ended",
      turnId: "turn-1",
      final: true,
    });
    expect(
      requireRoom(requireRecord(ended, "turn end").record, "turn end record").activeTurnId,
    ).toBeUndefined();

    expect(cancelTalkHandoffTurn(handoff.id, handoff.token)).toEqual({
      ok: false,
      reason: "no_active_turn",
    });

    startTalkHandoffTurn(handoff.id, handoff.token, { turnId: "turn-2" });
    const cancelled = cancelTalkHandoffTurn(handoff.id, handoff.token, { reason: "barge-in" });
    expectFields(cancelled, "turn cancellation", {
      ok: true,
      turnId: "turn-2",
    });
    const cancelledEvent = expectEventFields(requireEvents(cancelled, "turn cancellation"), 0, {
      type: "turn.cancelled",
      turnId: "turn-2",
      final: true,
    });
    expect(requireRecord(cancelledEvent.payload, "cancelled payload").reason).toBe("barge-in");
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

    expectFields(
      endTalkHandoffTurn(handoff.id, handoff.token, { turnId: "turn-current" }),
      "current turn end",
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
    const firstJoin = joinTalkHandoff(first.id, first.token);
    const firstJoinRecord = expectFields(firstJoin, "first join", {
      ok: true,
    });
    expectEventFields(requireEvents(firstJoin), 0, { type: "session.ready" });
    expectFields(firstJoinRecord.record, "first joined record", {
      roomId: first.roomId,
      sessionKey: "agent:main:first",
      channel: "browser",
      target: "host:local",
      provider: "openai",
    });
    const secondJoin = joinTalkHandoff(second.id, second.token);
    const secondJoinRecord = expectFields(secondJoin, "second join", {
      ok: true,
    });
    expectEventFields(requireEvents(secondJoin), 0, { type: "session.ready" });
    expectFields(secondJoinRecord.record, "second joined record", {
      roomId: second.roomId,
      sessionKey: "agent:main:second",
      channel: "browser",
      target: "host:local",
    });
  });
});
