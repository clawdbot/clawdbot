import { describe, expect, it } from "vitest";
import { resolvePinnedClientMetadata } from "./connect-device-metadata.js";

describe("Watch resolvePinnedClientMetadata", () => {
  it("allows openclaw-watchos platform version refresh without metadata-upgrade approval", () => {
    expect(
      resolvePinnedClientMetadata({
        clientId: "openclaw-watchos",
        clientMode: "node",
        claimedPlatform: "watchOS 27.0",
        claimedDeviceFamily: "Apple Watch",
        pairedPlatform: "watchOS 26.5.1",
        pairedDeviceFamily: "Apple Watch",
      }),
    ).toEqual({
      platformMismatch: false,
      deviceFamilyMismatch: false,
      pinnedPlatform: "watchOS 27.0",
      pinnedDeviceFamily: "Apple Watch",
      refreshPairedPlatform: "watchOS 27.0",
    });
  });

  it.each([
    ["node-host", "watchOS 27.0", "watchOS 26.5.1"],
    ["openclaw-watchos", "watchOS anything", "watchOS previous"],
    ["openclaw-watchos", "watchOS", "watchOS 26.5.1"],
  ])(
    "keeps non-version or non-native Watch platform changes approval-bound for %s",
    (clientId, claimed, paired) => {
      expect(
        resolvePinnedClientMetadata({
          clientId,
          clientMode: "node",
          claimedPlatform: claimed,
          claimedDeviceFamily: "Apple Watch",
          pairedPlatform: paired,
          pairedDeviceFamily: "Apple Watch",
        }),
      ).toMatchObject({
        platformMismatch: true,
        deviceFamilyMismatch: false,
        pinnedPlatform: undefined,
      });
    },
  );
});
