import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buzzConfigAdapter } from "./channel-config.js";

function createMixedCaseAccountConfig(): OpenClawConfig {
  return {
    channels: {
      buzz: {
        accounts: {
          Ada: {
            relayUrl: "wss://ada.example.com",
            privateKey: "22".repeat(32),
          },
        },
      },
    },
  } as OpenClawConfig;
}

describe("buzzConfigAdapter", () => {
  it("updates an existing account without changing its key casing", () => {
    const next = buzzConfigAdapter.setAccountEnabled!({
      cfg: createMixedCaseAccountConfig(),
      accountId: "ada",
      enabled: false,
    });

    expect(next.channels?.buzz?.accounts).toEqual({
      Ada: {
        relayUrl: "wss://ada.example.com",
        privateKey: "22".repeat(32),
        enabled: false,
      },
    });
  });

  it("deletes an existing account regardless of key casing", () => {
    const next = buzzConfigAdapter.deleteAccount!({
      cfg: createMixedCaseAccountConfig(),
      accountId: "ada",
    });

    expect(next.channels?.buzz?.accounts).toBeUndefined();
  });
});
