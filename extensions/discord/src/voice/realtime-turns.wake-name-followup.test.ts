import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordRealtimeTurns } from "./realtime-turns.js";

type WakeNameFollowupTestTurns = {
  armWakeNameFollowup: () => void;
  consumePendingWakeNameFollowup: () => unknown;
  pendingWakeNameFollowup?: unknown;
  speakerTurns: {
    consumeAudioContext: () => unknown;
    peekAudioTurn: () => unknown;
  };
};

function createTurns(): WakeNameFollowupTestTurns {
  return new DiscordRealtimeTurns({
    bridge: () => null,
    entry: {
      guildId: "g1",
      channelId: "1001",
      voiceSessionKey: "voice-1",
      route: { agentId: "agent-1" },
    },
    getHumanParticipantCount: () => 1,
    onAcceptedTranscript: vi.fn(),
    playback: {
      enqueueExactSpeechMessage: vi.fn(),
      handleBargeIn: vi.fn(),
      hasInterruptibleOutputAudio: () => false,
      isBargeInEnabled: () => false,
      isOutputAudioActive: () => false,
      outputAudioMs: () => 0,
      sendWakeNameAck: vi.fn(),
      speakControlResult: vi.fn(),
    },
    providerEpoch: () => 0,
    providerId: () => "openai",
    realtimeConfig: () => ({}),
    recordInputAudio: () => false,
    stopped: () => false,
    wakeNamePolicy: () => "always",
    wakeNames: () => ["OpenClaw"],
  } as never) as unknown as WakeNameFollowupTestTurns;
}

describe("DiscordRealtimeTurns wake-name follow-up cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms and consumes a valid wake-name follow-up", () => {
    const turns = createTurns();
    turns.speakerTurns = {
      consumeAudioContext: vi.fn(() => ({
        userId: "u1",
        speakerLabel: "Ada",
        senderIsOwner: true,
      })),
      peekAudioTurn: vi.fn(() => undefined),
    };

    turns.armWakeNameFollowup();

    expect(turns.consumePendingWakeNameFollowup()).toMatchObject({
      context: { userId: "u1", speakerLabel: "Ada" },
    });
  });

  it("does not arm follow-ups when the expiry would exceed Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    const turns = createTurns();
    turns.speakerTurns = {
      consumeAudioContext: vi.fn(() => ({
        userId: "u1",
        speakerLabel: "Ada",
        senderIsOwner: true,
      })),
      peekAudioTurn: vi.fn(() => undefined),
    };

    turns.armWakeNameFollowup();

    expect(turns.pendingWakeNameFollowup).toBeUndefined();
    expect(turns.consumePendingWakeNameFollowup()).toBeUndefined();
  });
});
