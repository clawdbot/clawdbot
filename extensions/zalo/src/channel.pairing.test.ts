// Zalo tests cover channel pairing plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  sendMessage: hoisted.sendMessage,
}));

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
