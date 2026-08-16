import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { isConfiguredBuzzChannel } from "./target.js";
import { resolveBuzzAccount } from "./types.js";

const CHANNEL_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const OTHER_CHANNEL_ID = "45c84a8d-5ed9-4e2c-b846-acedecc82bd1";
const PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

describe("Buzz gateway channel admission", () => {
  const configuredChannelIds = new Set([CHANNEL_ID]);

  it("accepts only configured channel UUIDs", () => {
    expect(isConfiguredBuzzChannel(configuredChannelIds, CHANNEL_ID)).toBe(true);
    expect(isConfiguredBuzzChannel(configuredChannelIds, CHANNEL_ID.toUpperCase())).toBe(true);
    expect(isConfiguredBuzzChannel(configuredChannelIds, OTHER_CHANNEL_ID)).toBe(false);
    expect(isConfiguredBuzzChannel(configuredChannelIds, "not-a-channel")).toBe(false);
  });

  it("canonicalizes accepted group target variants once during account resolution", () => {
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.com",
          privateKey: PRIVATE_KEY,
          groups: {
            [`channel:${CHANNEL_ID.toUpperCase()}`]: { requireMention: false },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveBuzzAccount({ cfg }).config.groups).toEqual({
      [CHANNEL_ID]: { requireMention: false },
    });
  });

  it("defaults group access to allowlist", () => {
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.com",
          privateKey: PRIVATE_KEY,
          groups: { [CHANNEL_ID]: {} },
        },
      },
    } as OpenClawConfig;

    expect(resolveBuzzAccount({ cfg }).config.groupPolicy).toBe("allowlist");
  });
});
