import { describe, expect, it } from "vitest";
import { notifyZaloPairingApproval } from "./channel.runtime.js";

describe("notifyZaloPairingApproval", () => {
  it.each([
    {
      name: "simplified default account",
      cfg: { channels: { zalo: {} } },
      expected:
        "Zalo token not configured for account default (set channels.zalo.accounts.default.botToken or channels.zalo.accounts.default.tokenFile)",
    },
    {
      name: "explicit default account entry",
      cfg: { channels: { zalo: { accounts: { default: {} } } } },
      expected:
        "Zalo token not configured for account default (set channels.zalo.accounts.default.botToken or channels.zalo.accounts.default.tokenFile)",
    },
    {
      name: "named default account",
      cfg: { channels: { zalo: { defaultAccount: "work", accounts: { work: {} } } } },
      expected:
        "Zalo token not configured for account work (set channels.zalo.accounts.work.botToken or channels.zalo.accounts.work.tokenFile)",
    },
    {
      name: "named account with an explicitly blank token override",
      cfg: {
        channels: {
          zalo: {
            defaultAccount: "work",
            botToken: "blocked-top-level-token",
            accounts: { work: { botToken: "" } },
          },
        },
      },
      expected:
        "Zalo token not configured for account work (set channels.zalo.accounts.work.botToken or channels.zalo.accounts.work.tokenFile)",
    },
    {
      name: "named account with an unavailable token file",
      cfg: {
        channels: {
          zalo: {
            defaultAccount: "work",
            botToken: "blocked-top-level-token",
            accounts: { work: { tokenFile: "/private/zalo-missing-work-token" } },
          },
        },
      },
      expected:
        "Zalo token not configured for account work (set channels.zalo.accounts.work.botToken or channels.zalo.accounts.work.tokenFile)",
    },
  ])("reports actionable token paths for $name", async ({ cfg, expected }) => {
    await expect(notifyZaloPairingApproval({ cfg, id: "sender-id" })).rejects.toThrow(expected);
  });

  it("uses the account supplied by the pairing approval event", async () => {
    await expect(
      notifyZaloPairingApproval({
        cfg: {
          channels: {
            zalo: {
              defaultAccount: "default",
              accounts: {
                default: { botToken: "blocked-default-token" },
                work: {},
              },
            },
          },
        },
        id: "sender-id",
        accountId: "work",
      }),
    ).rejects.toThrow(
      "Zalo token not configured for account work (set channels.zalo.accounts.work.botToken or channels.zalo.accounts.work.tokenFile)",
    );
  });
});
