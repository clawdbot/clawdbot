// Discord tests cover receive recovery plugin behavior.
import { DAVESession, NetworkingStatusCode, VoiceConnectionStatus } from "@discordjs/voice";
import { VoiceOpcodes, type VoiceSendPayload } from "discord-api-types/voice/v8";
import { OpusError } from "libopus-wasm";
import { describe, expect, it, vi } from "vitest";
import {
  analyzeVoiceReceiveError,
  createVoiceReceiveRecoveryState,
  enableDaveReceivePassthrough,
  noteVoiceDecryptFailure,
  recoverDaveZeroTransition,
} from "./receive-recovery.js";

const OPUS_INVALID_PACKET_CODE = -4;

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
      analyzeVoiceReceiveError(new OpusError(OPUS_INVALID_PACKET_CODE, "not inspected", "decode")),
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
      code: OPUS_INVALID_PACKET_CODE,
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

  it("recovers transition zero through the real DAVE invalidation and key-package events", () => {
    const dave = new DAVESession(1, "bot", "c1", { decryptionFailureTolerance: 0 });
    const keyPackage = Buffer.from("new-key-package");
    const nativeSession = {
      decrypt: vi.fn(() => {
        throw new Error("UnencryptedWhenPassthroughDisabled");
      }),
      getSerializedKeyPackage: vi.fn(() => keyPackage),
      ready: true,
      reinit: vi.fn(),
      setPassthroughMode: vi.fn(),
    };
    dave.session = nativeSession as unknown as NonNullable<typeof dave.session>;
    dave.lastTransitionId = 0;
    const gateway = {
      sendBinaryMessage: vi.fn(),
      sendPacket: vi.fn(),
    };
    dave.on("invalidateTransition", (transitionId) => {
      gateway.sendPacket({
        op: VoiceOpcodes.DaveMlsInvalidCommitWelcome,
        d: { transition_id: transitionId },
      });
    });
    dave.on("keyPackage", (nextKeyPackage) => {
      gateway.sendBinaryMessage(VoiceOpcodes.DaveMlsKeyPackage, nextKeyPackage);
    });
    const onWarn = vi.fn();

    expect(() => dave.decrypt(Buffer.from("encrypted-audio"), "speaker")).toThrow(
      "UnencryptedWhenPassthroughDisabled",
    );

    expect(
      recoverDaveZeroTransition({
        target: {
          guildId: "g1",
          channelId: "c1",
          connection: {
            state: {
              status: VoiceConnectionStatus.Ready,
              networking: {
                state: {
                  code: NetworkingStatusCode.Ready,
                  dave,
                },
              },
            },
          },
        },
        sdk: { VoiceConnectionStatus, NetworkingStatusCode },
        onWarn,
      }),
    ).toBe("recovered");

    expect(nativeSession.reinit).toHaveBeenCalledWith(1, "bot", "c1");
    expect(gateway.sendPacket).toHaveBeenCalledWith({
      op: VoiceOpcodes.DaveMlsInvalidCommitWelcome,
      d: { transition_id: 0 },
    });
    expect(gateway.sendBinaryMessage).toHaveBeenCalledWith(
      VoiceOpcodes.DaveMlsKeyPackage,
      keyPackage,
    );
    expect(gateway.sendPacket.mock.invocationCallOrder[0]).toBeLessThan(
      gateway.sendBinaryMessage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(dave.reinitializing).toBe(true);
    expect(dave.decrypt(Buffer.from("encrypted-audio"), "speaker")).toBeNull();
    expect(onWarn).not.toHaveBeenCalled();
  });

  it.each([
    { label: "gateway invalidation", failure: "invalidation" },
    { label: "native reinitialization", failure: "native" },
    { label: "gateway key-package delivery", failure: "key-package" },
  ])("reports the poisoned session when $label fails", ({ failure }) => {
    const dave = new DAVESession(1, "bot", "c1", { decryptionFailureTolerance: 0 });
    const nativeSession = {
      decrypt: vi.fn(() => {
        throw new Error("UnencryptedWhenPassthroughDisabled");
      }),
      getSerializedKeyPackage: vi.fn(() => Buffer.from("new-key-package")),
      ready: true,
      reinit: vi.fn(() => {
        if (failure === "native") {
          throw new Error("native DAVE reinitialization failed");
        }
      }),
      setPassthroughMode: vi.fn(),
    };
    dave.session = nativeSession as unknown as NonNullable<typeof dave.session>;
    dave.lastTransitionId = 0;
    const gateway = {
      sendPacket: vi.fn((_packet: VoiceSendPayload) => {
        if (failure === "invalidation") {
          throw new Error("voice gateway invalidation failed");
        }
      }),
      sendBinaryMessage: vi.fn((_opcode: VoiceOpcodes, _keyPackage: Buffer) => {
        if (failure === "key-package") {
          throw new Error("voice gateway key-package delivery failed");
        }
      }),
    };
    dave.on("invalidateTransition", (transitionId) => {
      gateway.sendPacket({
        op: VoiceOpcodes.DaveMlsInvalidCommitWelcome,
        d: { transition_id: transitionId },
      });
    });
    dave.on("keyPackage", (keyPackage) => {
      gateway.sendBinaryMessage(VoiceOpcodes.DaveMlsKeyPackage, keyPackage);
    });
    const onWarn = vi.fn();

    expect(
      recoverDaveZeroTransition({
        target: {
          guildId: "g1",
          channelId: "c1",
          connection: {
            state: {
              status: VoiceConnectionStatus.Ready,
              networking: {
                state: { code: NetworkingStatusCode.Ready, dave },
              },
            },
          },
        },
        sdk: { VoiceConnectionStatus, NetworkingStatusCode },
        onWarn,
      }),
    ).toBe("failed");

    expect(dave.reinitializing).toBe(true);
    expect(dave.decrypt(Buffer.from("encrypted-audio"), "speaker")).toBeNull();
    expect(gateway.sendPacket).toHaveBeenCalledWith({
      op: VoiceOpcodes.DaveMlsInvalidCommitWelcome,
      d: { transition_id: 0 },
    });
    expect(gateway.sendBinaryMessage).toHaveBeenCalledTimes(failure === "key-package" ? 1 : 0);
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("failed to recover DAVE transition 0"),
    );
  });

  it("keeps bounded recovery when a real DAVE debug listener fails before invalidation", () => {
    const dave = new DAVESession(1, "bot", "c1", { decryptionFailureTolerance: 0 });
    dave.lastTransitionId = 0;
    dave.on("debug", () => {
      throw new Error("debug subscriber unavailable");
    });
    const onWarn = vi.fn();

    expect(
      recoverDaveZeroTransition({
        target: {
          guildId: "g1",
          channelId: "c1",
          connection: {
            state: {
              status: VoiceConnectionStatus.Ready,
              networking: {
                state: { code: NetworkingStatusCode.Ready, dave },
              },
            },
          },
        },
        sdk: { VoiceConnectionStatus, NetworkingStatusCode },
        onWarn,
      }),
    ).toBe("not-attempted");

    expect(dave.reinitializing).toBe(false);
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("failed to recover DAVE transition 0"),
    );
  });

  it.each([
    {
      label: "non-zero transitions",
      lastTransitionId: 1,
      reinitializing: false,
      connectionStatus: VoiceConnectionStatus.Ready,
      networkingStatus: NetworkingStatusCode.Ready,
    },
    {
      label: "missing transitions",
      lastTransitionId: undefined,
      reinitializing: false,
      connectionStatus: VoiceConnectionStatus.Ready,
      networkingStatus: NetworkingStatusCode.Ready,
    },
    {
      label: "reinitializing sessions",
      lastTransitionId: 0,
      reinitializing: true,
      connectionStatus: VoiceConnectionStatus.Ready,
      networkingStatus: NetworkingStatusCode.Ready,
    },
    {
      label: "resuming networking",
      lastTransitionId: 0,
      reinitializing: false,
      connectionStatus: VoiceConnectionStatus.Ready,
      networkingStatus: NetworkingStatusCode.Resuming,
    },
    {
      label: "disconnected voice connections",
      lastTransitionId: 0,
      reinitializing: false,
      connectionStatus: VoiceConnectionStatus.Disconnected,
      networkingStatus: NetworkingStatusCode.Ready,
    },
  ])("does not invalidate $label", (scenario) => {
    const { lastTransitionId, reinitializing, connectionStatus, networkingStatus } = scenario;
    const recoverFromInvalidTransition = vi.fn();

    expect(
      recoverDaveZeroTransition({
        target: {
          guildId: "g1",
          channelId: "c1",
          connection: {
            state: {
              status: connectionStatus,
              networking: {
                state: {
                  code: networkingStatus,
                  dave: {
                    lastTransitionId,
                    reinitializing,
                    recoverFromInvalidTransition,
                  },
                },
              },
            },
          },
        },
        sdk: { VoiceConnectionStatus, NetworkingStatusCode },
        onWarn: vi.fn(),
      }),
    ).toBe("not-attempted");

    expect(recoverFromInvalidTransition).not.toHaveBeenCalled();
  });

  it("keeps bounded recovery available when transition invalidation throws", () => {
    const onWarn = vi.fn();
    const recoverFromInvalidTransition = vi.fn(() => {
      throw new Error("voice gateway unavailable");
    });

    expect(
      recoverDaveZeroTransition({
        target: {
          guildId: "g1",
          channelId: "c1",
          connection: {
            state: {
              status: VoiceConnectionStatus.Ready,
              networking: {
                state: {
                  code: NetworkingStatusCode.Ready,
                  dave: {
                    lastTransitionId: 0,
                    reinitializing: false,
                    recoverFromInvalidTransition,
                  },
                },
              },
            },
          },
        },
        sdk: { VoiceConnectionStatus, NetworkingStatusCode },
        onWarn,
      }),
    ).toBe("not-attempted");

    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("failed to recover DAVE transition 0"),
    );
  });
});
