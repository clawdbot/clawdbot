// Discord tests cover realtime.wake name followup plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordRealtimeVoiceSession } from "./realtime.js";

type WakeNameFollowupTestSession = {
  armWakeNameFollowup: () => void;
  consumePendingWakeNameFollowup: () => unknown;
  pendingWakeNameFollowup?: unknown;
  speakerTurns: {
    consumeAudioContext: () => unknown;
    peekAudioTurn: () => unknown;
  };
};

function createSession(): WakeNameFollowupTestSession {
  return new DiscordRealtimeVoiceSession({
    cfg: {},
    discordConfig: { voice: { realtime: {} } },
    entry: {
      voiceSessionKey: "voice-1",
      route: { agentId: "agent-1" },
    },
    mode: "agent-proxy",
    runAgentTurn: vi.fn(),
  } as never) as unknown as WakeNameFollowupTestSession;
}

describe("DiscordRealtimeVoiceSession wake-name follow-up cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms and consumes a valid wake-name follow-up", () => {
    const session = createSession();
    session.speakerTurns = {
      consumeAudioContext: vi.fn(() => ({
        userId: "u1",
        speakerLabel: "Ada",
        senderIsOwner: true,
      })),
      peekAudioTurn: vi.fn(() => undefined),
    };

    session.armWakeNameFollowup();

    expect(session.consumePendingWakeNameFollowup()).toMatchObject({
      context: { userId: "u1", speakerLabel: "Ada" },
    });
  });

  it("does not arm follow-ups when the expiry would exceed Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    const session = createSession();
    session.speakerTurns = {
      consumeAudioContext: vi.fn(() => ({
        userId: "u1",
        speakerLabel: "Ada",
        senderIsOwner: true,
      })),
      peekAudioTurn: vi.fn(() => undefined),
    };

    session.armWakeNameFollowup();

    expect(session.pendingWakeNameFollowup).toBeUndefined();
    expect(session.consumePendingWakeNameFollowup()).toBeUndefined();
  });
});
