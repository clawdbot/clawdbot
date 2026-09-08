// Zalo tests cover channel pairing plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  proxyFetch: vi.fn(),
}));

vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  sendMessage: hoisted.sendMessage,
}));

vi.mock("./proxy.js", () => ({ resolveZaloProxyFetch: hoisted.proxyFetch }));

import { zaloPlugin } from "./channel.js";

const PAIRING_CFG = {
  channels: {
    zalo: {
      defaultAccount: "alpha",
      accounts: {
        alpha: { botToken: "token-alpha" },
        beta: { botToken: "token-beta" },
      },
    },
  },
};

describe("zaloPlugin pairing.notifyApproval", () => {
  beforeEach(() => {
    hoisted.sendMessage.mockReset();
    hoisted.sendMessage.mockResolvedValue({ ok: true, result: { message_id: "z-1" } });
    hoisted.proxyFetch.mockReset();
  });

  it("rejects an unsuccessful approval notification", async () => {
    hoisted.sendMessage.mockResolvedValue({ ok: false });
    await expect(
      zaloPlugin.pairing!.notifyApproval!({
        cfg: PAIRING_CFG,
        id: "paired-user",
        accountId: "beta",
      }),
    ).rejects.toThrow("Failed to send message");
  });

  it("uses the approved account's configured proxy", async () => {
    const fetcher = vi.fn();
    hoisted.proxyFetch.mockReturnValue(fetcher);
    await zaloPlugin.pairing!.notifyApproval!({
      cfg: {
        channels: {
          zalo: {
            ...PAIRING_CFG.channels.zalo,
            accounts: {
              ...PAIRING_CFG.channels.zalo.accounts,
              beta: { botToken: "token-beta", proxy: "http://proxy-beta.test:8080" },
            },
          },
        },
      },
      id: "paired-user",
      accountId: "beta",
    });
    expect(hoisted.proxyFetch).toHaveBeenCalledExactlyOnceWith("http://proxy-beta.test:8080");
    expect(hoisted.sendMessage).toHaveBeenCalledExactlyOnceWith(
      "token-beta",
      {
        chat_id: "paired-user",
        text: "✅ OpenClaw access approved. Send a message to start chatting.",
      },
      fetcher,
    );
  });

  it.each([
    { name: "the approved account", accountId: "beta", token: "token-beta" },
    {
      name: "the default account when no account was approved",
      accountId: undefined,
      token: "token-alpha",
    },
  ])("sends the approval from $name", async ({ accountId, token }) => {
    const notifyApproval = zaloPlugin.pairing?.notifyApproval;
    if (!notifyApproval) {
      throw new Error("zalo pairing.notifyApproval unavailable");
    }

    await notifyApproval({
      cfg: PAIRING_CFG,
      id: "paired-user",
      ...(accountId ? { accountId } : {}),
    });

    expect(hoisted.sendMessage).toHaveBeenCalledExactlyOnceWith(
      token,
      { chat_id: "paired-user", text: expect.any(String) },
      undefined,
    );
  });
});
