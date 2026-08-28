// Reply payload tests cover internal reply metadata contracts.
import { describe, expect, it } from "vitest";
import { isReplyPayloadTerminalContent, readPairingQrReplyChannelData } from "./reply-payload.js";

describe("pairing QR reply channel data", () => {
  it("reads the private pairing QR payload metadata", () => {
    const channelData = {
      openclawPairingQr: {
        setupCode: "setup-code",
        expiresAtMs: 1_800_000_000_000,
      },
    };

    expect(readPairingQrReplyChannelData({ channelData })).toEqual({
      setupCode: "setup-code",
      expiresAtMs: 1_800_000_000_000,
    });
  });

  it("ignores malformed pairing QR metadata", () => {
    expect(
      readPairingQrReplyChannelData({
        channelData: {
          openclawPairingQr: {
            setupCode: "",
            expiresAtMs: 0,
          },
        },
      }),
    ).toBeUndefined();
  });
});

describe("reply payload terminal content", () => {
  it.each([
    ["text", { text: "answer" }, true],
    ["media", { mediaUrl: "file:///tmp/answer.png" }, true],
    ["reasoning", { text: "thinking", isReasoning: true }, false],
    ["commentary", { text: "working", isCommentary: true }, false],
    ["status", { text: "compacting", isStatusNotice: true }, false],
    [
      "TTS supplement",
      {
        mediaUrl: "file:///tmp/answer.mp3",
        ttsSupplement: { spokenText: "answer", visibleTextAlreadyDelivered: true },
      },
      false,
    ],
  ] as const)("classifies %s payloads", (_name, payload, expected) => {
    expect(isReplyPayloadTerminalContent(payload)).toBe(expected);
  });
});
