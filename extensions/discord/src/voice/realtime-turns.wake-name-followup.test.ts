import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    agentCommandMock,
    beginSpeakerTurn,
    createJoinedAgentProxyFixture,
    lastAgentCommandArgs,
  }) => {
    it.each([
      {
        name: "accepts a speaker's wake-name follow-up with valid expiry",
        now: 1_700_000_000_000,
        accepted: true,
      },
      {
        name: "rejects a speaker's wake-name follow-up with expiry outside the Date range",
        now: 8_640_000_000_000_000,
        accepted: false,
      },
    ])("$name", async ({ now, accepted }) => {
      const { bridgeParams, entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: true } } },
      });
      vi.useFakeTimers();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        beginSpeakerTurn(entry, { senderIsOwner: false }).close();
        bridgeParams.onTranscript?.("user", "OpenClaw", true);
        bridgeParams.onTranscript?.("user", "Summarize this note.", true);
        await vi.advanceTimersByTimeAsync(260);

        expect(agentCommandMock).toHaveBeenCalledTimes(accepted ? 1 : 0);
        if (accepted) {
          expect(lastAgentCommandArgs().senderIsOwner).toBe(false);
        }
      } finally {
        clock.mockRestore();
        vi.useRealTimers();
        await manager.destroy();
      }
    });
  },
);
