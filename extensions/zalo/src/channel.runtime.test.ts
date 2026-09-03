import { describe, expect, it } from "vitest";
import { notifyZaloPairingApproval } from "./channel.runtime.js";

describe("notifyZaloPairingApproval", () => {
  it.each([
    {
      name: "simplified default account",
      cfg: { channels: { zalo: {} } },
      expected:
        "Zalo token not configured for account default (set channels.zalo.botToken, channels.zalo.tokenFile, or ZALO_BOT_TOKEN)",
    },
    {
      name: "explicit default account entry",
      cfg: { channels: { zalo: { accounts: { default: {} } } } },
      expected:
        "Zalo token not configured for account default (set channels.zalo.accounts.default.botToken, channels.zalo.accounts.default.tokenFile, or ZALO_BOT_TOKEN)",
    },
    {
      name: "named default account",
      cfg: { channels: { zalo: { defaultAccount: "work", accounts: { work: {} } } } },
      expected:
        "Zalo token not configured for account work (set channels.zalo.accounts.work.botToken, channels.zalo.accounts.work.tokenFile)",
    },
  ])("reports actionable token paths for $name", async ({ cfg, expected }) => {
    await expect(notifyZaloPairingApproval({ cfg, id: "sender-id" })).rejects.toThrow(expected);
  });
});
