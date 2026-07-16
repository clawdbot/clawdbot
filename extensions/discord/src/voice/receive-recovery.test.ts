import { describe, expect, it, vi } from "vitest";
import {
  analyzeVoiceReceiveError,
  createVoiceReceiveRecoveryState,
  enableDaveReceivePassthrough,
  noteVoiceDecryptFailure,
} from "./receive-recovery.js";

describe("voice receive recovery", () => {
  it("treats passthrough-disabled decrypt errors as decrypt failures", () => {
    expect(
      analyzeVoiceReceiveError(
        new Error("Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)"),
      ),
    ).toMatchObject({
      shouldAttemptPassthrough: true,
      countsAsDecryptFailure: true,
    });
  });

  it("gates recovery after repeated decrypt failures in the same window", () => {
    const state = createVoiceReceiveRecoveryState();

    expect(noteVoiceDecryptFailure(state, 1_000)).toEqual({
      firstFailure: true,
      shouldRecover: false,
    });
    expect(noteVoiceDecryptFailure(state, 2_000)).toEqual({
      firstFailure: false,
      shouldRecover: false,
    });
    expect(noteVoiceDecryptFailure(state, 3_000)).toEqual({
      firstFailure: false,
      shouldRecover: true,
    });
  });

  it("enables passthrough only for ready DAVE sessions", () => {
    const setPassthroughMode = vi.fn();
    const onVerbose = vi.fn();
    const onWarn = vi.fn();

    expect(
      enableDaveReceivePassthrough({
        target: {
          guildId: "g1",
          channelId: "c1",
          connection: {
            state: {
              status: "ready",
              networking: {
                state: {
                  code: "networking-ready",
                  dave: {
                    session: {
                      setPassthroughMode,
                    },
                  },
                },
              },
            },
          },
        },
        sdk: {
          VoiceConnectionStatus: { Ready: "ready" },
          NetworkingStatusCode: { Ready: "networking-ready", Resuming: "networking-resuming" },
        },
        reason: "test",
        expirySeconds: 15,
        onVerbose,
        onWarn,
      }),
    ).toBe(true);

    expect(setPassthroughMode).toHaveBeenCalledWith(true, 15);
    expect(onVerbose).toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
  });
});
