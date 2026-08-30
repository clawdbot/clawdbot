// Reply payload tests cover internal reply metadata contracts.
import { describe, expect, it } from "vitest";
import {
  isCommandReplyForDelivery,
  isReplyPayloadTerminalContent,
  markCommandReplyForDelivery,
  readPairingQrReplyChannelData,
} from "./reply-payload.js";

describe("command reply delivery", () => {
  it("requires a non-empty reply whose payloads were all produced by the command owner", () => {
    expect(isCommandReplyForDelivery(undefined)).toBe(false);
    expect(isCommandReplyForDelivery([])).toBe(false);
    expect(isCommandReplyForDelivery([{ text: "unmarked" }])).toBe(false);
    expect(isCommandReplyForDelivery(markCommandReplyForDelivery({ text: "ack" }))).toBe(true);

    const marked = { text: "ack" };
    markCommandReplyForDelivery(marked);
    expect(isCommandReplyForDelivery([marked, { text: "unmarked" }])).toBe(false);
  });
});

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
