import { OpusError, OpusErrorCode } from "libopus-wasm";
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
    ).toEqual({
      message: "Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)",
      isAbortLike: false,
      isDecodeCorruption: false,
      shouldAttemptPassthrough: true,
      countsAsDecryptFailure: true,
    });
  });

  it("treats WASM bounds traps as recoverable receive failures", () => {
    expect(analyzeVoiceReceiveError(new Error("memory access out of bounds"))).toEqual({
      message: "memory access out of bounds",
      isAbortLike: false,
      isDecodeCorruption: false,
      shouldAttemptPassthrough: false,
      countsAsDecryptFailure: true,
    });
  });

  it("treats corrupt Opus packets as non-recoverable decode noise", () => {
    expect(
      analyzeVoiceReceiveError(
        new OpusError(OpusErrorCode.InvalidPacket, "not inspected", "decode"),
      ),
    ).toEqual({
      message: "not inspected",
      isAbortLike: false,
      isDecodeCorruption: true,
      shouldAttemptPassthrough: false,
      countsAsDecryptFailure: false,
    });
  });

  it("treats structurally equivalent Opus errors as decode corruption", () => {
    const analysis = analyzeVoiceReceiveError({
      name: "OpusError",
      message: "libopus decode failed (-4): corrupted stream",
      code: OpusErrorCode.InvalidPacket,
      codeName: "InvalidPacket",
      operation: "decode",
    });

    expect(analysis).toMatchObject({
      isAbortLike: false,
      isDecodeCorruption: true,
      shouldAttemptPassthrough: false,
      countsAsDecryptFailure: false,
    });
  });

  it("does not classify corrupt Opus packet text without the Opus error contract", () => {
    expect(
      analyzeVoiceReceiveError(new Error("libopus decode failed (-4): corrupted stream")),
    ).toEqual({
      message: "libopus decode failed (-4): corrupted stream",
      isAbortLike: false,
      isDecodeCorruption: false,
      shouldAttemptPassthrough: false,
      countsAsDecryptFailure: false,
    });
  });

  it("treats premature stream close as an expected receive end", () => {
    expect(analyzeVoiceReceiveError(new Error("Premature close"))).toEqual({
      message: "Premature close",
      isAbortLike: true,
      isDecodeCorruption: false,
      shouldAttemptPassthrough: false,
      countsAsDecryptFailure: false,
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
