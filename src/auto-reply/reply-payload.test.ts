// Reply payload tests cover internal reply metadata contracts.
import { describe, expect, it } from "vitest";
import { readPairingQrReplyChannelData } from "./reply-payload.js";

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
