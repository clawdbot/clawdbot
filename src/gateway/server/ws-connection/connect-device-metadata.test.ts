import { describe, expect, it } from "vitest";
import { resolvePinnedClientMetadata } from "./connect-device-metadata.js";

describe("resolvePinnedClientMetadata", () => {
  it.each([
    ["win32", "windows", "Windows"],
    ["darwin", "macos", "Mac"],
  ])(
    "accepts equivalent runtime alias %s as %s regardless of client mode",
    (pairedPlatform, claimedPlatform, claimedDeviceFamily) => {
      expect(
        resolvePinnedClientMetadata({
          clientId: "test",
          clientMode: "test",
          claimedPlatform,
          claimedDeviceFamily,
          pairedPlatform,
          pairedDeviceFamily: undefined,
        }),
      ).toEqual({
        platformMismatch: false,
        deviceFamilyMismatch: false,
        pinnedPlatform: claimedPlatform,
        pinnedDeviceFamily: undefined,
      });
    },
  );

  it.each([
    ["cli", "probe"],
    ["gateway-client", "backend"],
  ])("accepts the Windows runtime alias for affected caller %s/%s", (clientId, clientMode) => {
    expect(
      resolvePinnedClientMetadata({
        clientId,
        clientMode,
        claimedPlatform: "windows",
        claimedDeviceFamily: "Windows",
        pairedPlatform: "win32",
        pairedDeviceFamily: undefined,
      }),
    ).toMatchObject({
      platformMismatch: false,
      deviceFamilyMismatch: false,
    });
  });

  it.each([
    { pairedPlatform: "linux", claimedDeviceFamily: "Windows" },
    { pairedPlatform: "win32", claimedDeviceFamily: "Linux" },
    { pairedPlatform: "darwin", claimedDeviceFamily: "Windows" },
  ])(
    "keeps non-equivalent runtime tuples approval-bound: %j",
    ({ pairedPlatform, claimedDeviceFamily }) => {
      expect(
        resolvePinnedClientMetadata({
          clientId: "test",
          clientMode: "test",
          claimedPlatform: "windows",
          claimedDeviceFamily,
          pairedPlatform,
          pairedDeviceFamily: undefined,
        }),
      ).toMatchObject({
        platformMismatch: true,
        deviceFamilyMismatch: false,
      });
    },
  );

  it("does not replace a conflicting family pin during a runtime-alias upgrade", () => {
    expect(
      resolvePinnedClientMetadata({
        clientId: "openclaw-tui",
        clientMode: "ui",
        claimedPlatform: "windows",
        claimedDeviceFamily: "Windows",
        pairedPlatform: "win32",
        pairedDeviceFamily: "Linux",
      }),
    ).toMatchObject({
      platformMismatch: true,
      deviceFamilyMismatch: true,
      pinnedDeviceFamily: "Linux",
    });
  });

  it.each([
    ["darwin", "macos"],
    ["win32", "windows"],
  ])(
    "pins legacy node-host platform alias %s to paired canonical %s",
    (claimedPlatform, pairedPlatform) => {
      expect(
        resolvePinnedClientMetadata({
          clientId: "node-host",
          clientMode: "node",
          claimedPlatform,
          claimedDeviceFamily: pairedPlatform === "macos" ? "Mac" : "Windows",
          pairedPlatform,
          pairedDeviceFamily: pairedPlatform === "macos" ? "Mac" : "Windows",
        }),
      ).toEqual({
        platformMismatch: false,
        deviceFamilyMismatch: false,
        pinnedPlatform: pairedPlatform,
        pinnedDeviceFamily: pairedPlatform === "macos" ? "Mac" : "Windows",
      });
    },
  );

  it.each([
    ["darwin", "macos", "Mac"],
    ["win32", "windows", "Windows"],
  ])(
    "normalizes exact legacy node-host platform %s to canonical %s",
    (legacyPlatform, canonicalPlatform, deviceFamily) => {
      expect(
        resolvePinnedClientMetadata({
          clientId: "node-host",
          clientMode: "node",
          claimedPlatform: legacyPlatform,
          claimedDeviceFamily: deviceFamily,
          pairedPlatform: legacyPlatform,
          pairedDeviceFamily: deviceFamily,
        }),
      ).toEqual({
        platformMismatch: false,
        deviceFamilyMismatch: false,
        pinnedPlatform: canonicalPlatform,
        pinnedDeviceFamily: deviceFamily,
      });
    },
  );

  it.each([
    ["macos", "darwin", "Mac"],
    ["windows", "win32", "Windows"],
  ])(
    "pins canonical node-host platform %s over paired legacy alias %s",
    (claimedPlatform, pairedPlatform, deviceFamily) => {
      expect(
        resolvePinnedClientMetadata({
          clientId: "node-host",
          clientMode: "node",
          claimedPlatform,
          claimedDeviceFamily: deviceFamily,
          pairedPlatform,
          pairedDeviceFamily: deviceFamily,
        }),
      ).toEqual({
        platformMismatch: false,
        deviceFamilyMismatch: false,
        pinnedPlatform: claimedPlatform,
        pinnedDeviceFamily: deviceFamily,
      });
    },
  );

  it.each([
    ["openclaw-ios", "iOS 26.5.0", "iOS 26.4.2", "iPhone"],
    ["openclaw-ios", "iPadOS 26.5.0", "iPadOS 26.4.2", "iPad"],
    ["openclaw-ios", "iPadOS 26.5.0", "iOS 26.4.2", "iPad"],
    ["openclaw-android", "Android 16", "Android 15", "Android"],
    ["openclaw-macos", "macOS 26.5.1", "macOS 26.5.0", "Mac"],
    ["openclaw-macos", "macOS 27.0.0", "macOS 26.5.1", "Mac"],
  ])(
    "allows %s platform version refresh without metadata-upgrade approval",
    (clientId, claimedPlatform, pairedPlatform, deviceFamily) => {
      expect(
        resolvePinnedClientMetadata({
          clientId,
          clientMode: "node",
          claimedPlatform,
          claimedDeviceFamily: deviceFamily,
          pairedPlatform,
          pairedDeviceFamily: deviceFamily,
        }),
      ).toEqual({
        platformMismatch: false,
        deviceFamilyMismatch: false,
        pinnedPlatform: claimedPlatform,
        pinnedDeviceFamily: deviceFamily,
        refreshPairedPlatform: claimedPlatform,
      });
    },
  );

  it.each(["node", "ui"])("allows a macOS platform version refresh in %s mode", (clientMode) => {
    expect(
      resolvePinnedClientMetadata({
        clientId: "openclaw-macos",
        clientMode,
        claimedPlatform: "macOS 26.5.2",
        claimedDeviceFamily: "Mac",
        pairedPlatform: "macOS 26.5.1",
        pairedDeviceFamily: "Mac",
      }),
    ).toEqual({
      platformMismatch: false,
      deviceFamilyMismatch: false,
      pinnedPlatform: "macOS 26.5.2",
      pinnedDeviceFamily: "Mac",
      refreshPairedPlatform: "macOS 26.5.2",
    });
  });

  it("accepts a node-host macOS alias against the shared Mac app platform pin", () => {
    expect(
      resolvePinnedClientMetadata({
        clientId: "node-host",
        clientMode: "node",
        claimedPlatform: "macos",
        claimedDeviceFamily: "Mac",
        pairedPlatform: "macOS 26.5.2",
        pairedDeviceFamily: "Mac",
      }),
    ).toEqual({
      platformMismatch: false,
      deviceFamilyMismatch: false,
      pinnedPlatform: "macOS 26.5.2",
      pinnedDeviceFamily: "Mac",
    });
  });

  it("refreshes a shared node-host macOS pin from the native Mac app", () => {
    expect(
      resolvePinnedClientMetadata({
        clientId: "openclaw-macos",
        clientMode: "ui",
        claimedPlatform: "macOS 26.5.2",
        claimedDeviceFamily: "Mac",
        pairedPlatform: "macos",
        pairedDeviceFamily: "Mac",
      }),
    ).toEqual({
      platformMismatch: false,
      deviceFamilyMismatch: false,
      pinnedPlatform: "macOS 26.5.2",
      pinnedDeviceFamily: "Mac",
      refreshPairedPlatform: "macOS 26.5.2",
    });
  });

  it("still requires approval when an iOS device family changes", () => {
    expect(
      resolvePinnedClientMetadata({
        clientId: "openclaw-ios",
        clientMode: "node",
        claimedPlatform: "iOS 26.5.0",
        claimedDeviceFamily: "iPad",
        pairedPlatform: "iOS 26.4.2",
        pairedDeviceFamily: "iPhone",
      }),
    ).toEqual({
      platformMismatch: false,
      deviceFamilyMismatch: true,
      pinnedPlatform: "iOS 26.5.0",
      pinnedDeviceFamily: "iPhone",
      refreshPairedPlatform: "iOS 26.5.0",
    });
  });

  it("still requires approval when a macOS device family changes", () => {
    expect(
      resolvePinnedClientMetadata({
        clientId: "openclaw-macos",
        clientMode: "node",
        claimedPlatform: "macOS 26.5.2",
        claimedDeviceFamily: "VirtualMac",
        pairedPlatform: "macOS 26.5.1",
        pairedDeviceFamily: "Mac",
      }),
    ).toEqual({
      platformMismatch: false,
      deviceFamilyMismatch: true,
      pinnedPlatform: "macOS 26.5.2",
      pinnedDeviceFamily: "Mac",
      refreshPairedPlatform: "macOS 26.5.2",
    });
  });

  it.each([
    ["node-host", "macOS 26.5.2", "macOS 26.5.1"],
    ["openclaw-macos", "macOS anything", "macOS previous"],
    ["openclaw-macos", "macOS", "macOS 26.5.1"],
  ])(
    "keeps non-version macOS platform changes approval-bound for %s",
    (clientId, claimed, paired) => {
      expect(
        resolvePinnedClientMetadata({
          clientId,
          clientMode: "node",
          claimedPlatform: claimed,
          claimedDeviceFamily: "Mac",
          pairedPlatform: paired,
          pairedDeviceFamily: "Mac",
        }),
      ).toMatchObject({
        platformMismatch: true,
        deviceFamilyMismatch: false,
        pinnedPlatform: undefined,
      });
    },
  );

  it("keeps non-native-app platform version changes approval-bound", () => {
    expect(
      resolvePinnedClientMetadata({
        clientId: "node-host",
        clientMode: "node",
        claimedPlatform: "linux 6.9",
        claimedDeviceFamily: "Linux",
        pairedPlatform: "linux 6.8",
        pairedDeviceFamily: "Linux",
      }),
    ).toEqual({
      platformMismatch: true,
      deviceFamilyMismatch: false,
      pinnedPlatform: undefined,
      pinnedDeviceFamily: "Linux",
    });
  });
});
