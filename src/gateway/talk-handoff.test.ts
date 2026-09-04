/**
 * Tests talk handoff coordination between gateway sessions and realtime state.
 */
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createTalkHandoff, getTalkHandoff, revokeTalkHandoff } from "./talk-handoff.js";

const requireRecord = createRequireRecord("record", "expected-label-capitalized");

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

    vi.advanceTimersByTime(5001);
    expect(getTalkHandoff(handoff.id)).toBeUndefined();
    vi.useRealTimers();
  });

  it("expires handoffs immediately when the creation clock is invalid", () => {
    const handoff = (() => {
      const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
      try {
        return createTalkHandoff({
          sessionKey: "session:main",
          ttlMs: 5000,
        });
      } finally {
        dateNow.mockRestore();
      }
    })();

    expect(handoff.createdAt).toBe(0);
    expect(handoff.expiresAt).toBe(0);
    expect(getTalkHandoff(handoff.id)).toBeUndefined();
    expect(revokeTalkHandoff(handoff.id)).toEqual({ revoked: false, events: [] });
  });

  it("expires handoffs immediately when expiry would exceed Date bounds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    const handoff = createTalkHandoff({
      sessionKey: "session:main",
      ttlMs: 5000,
    });

    expect(handoff.expiresAt).toBe(0);
    expect(getTalkHandoff(handoff.id)).toBeUndefined();
    expect(revokeTalkHandoff(handoff.id)).toEqual({ revoked: false, events: [] });

    vi.useRealTimers();
  });

  it("revokes a handoff and records its final close event", () => {
    const handoff = createTalkHandoff({ sessionKey: "session:main" });

    expectFields(getTalkHandoff(handoff.id), "stored handoff", {
      roomId: handoff.roomId,
      sessionKey: "session:main",
    });
    const revoked = revokeTalkHandoff(handoff.id);
    expectFields(revoked, "revoke result", {
      revoked: true,
      roomId: handoff.roomId,
    });
    const closed = expectEventFields(requireEvents(revoked, "revoke result"), 0, {
      type: "session.closed",
      sessionId: handoff.roomId,
      final: true,
    });
    expect(requireRecord(closed.payload, "closed payload").reason).toBe("revoked");
    expect(getTalkHandoff(handoff.id)).toBeUndefined();
    expect(revokeTalkHandoff(handoff.id)).toEqual({ revoked: false, events: [] });
  });

  it("isolates simultaneous handoffs for different sessions on the same host", () => {
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
    expectFields(getTalkHandoff(first.id), "first stored handoff", {
      roomId: first.roomId,
      sessionKey: "agent:main:first",
      channel: "browser",
      target: "host:local",
      provider: "openai",
    });
    expectFields(getTalkHandoff(second.id), "second stored handoff", {
      roomId: second.roomId,
      sessionKey: "agent:main:second",
      channel: "browser",
      target: "host:local",
    });
  });
});
