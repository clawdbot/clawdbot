import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyZaloPairingApproval } from "./channel.runtime.js";
import { sendMessageZalo } from "./send.js";

vi.mock("./send.js", () => ({
  sendMessageZalo: vi.fn(),
}));

describe("notifyZaloPairingApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ZALO_BOT_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
    expect(sendMessageZalo).not.toHaveBeenCalled();
  });

  it("sends with the token and proxy from the pairing approval account", async () => {
    await notifyZaloPairingApproval({
      cfg: {
        channels: {
          zalo: {
            defaultAccount: "default",
            accounts: {
              default: {
                botToken: "default-token",
                proxy: "http://default-proxy.invalid",
              },
              work: {
                botToken: "work-token",
                proxy: "http://work-proxy.invalid",
              },
            },
          },
        },
      },
      id: "sender-id",
      accountId: "work",
    });

    expect(sendMessageZalo).toHaveBeenCalledOnce();
    expect(sendMessageZalo).toHaveBeenCalledWith("sender-id", expect.any(String), {
      token: "work-token",
      proxy: "http://work-proxy.invalid",
    });
  });
});
