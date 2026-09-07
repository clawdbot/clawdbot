import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { linePlugin } from "./channel.js";

const userId = `U${"a".repeat(32)}`;
const cfg: OpenClawConfig = {
  channels: {
    line: {
      channelAccessToken: "heartbeat-default-fixture",
      channelSecret: "heartbeat-secret-fixture",
      accounts: {
        secondary: {
          channelAccessToken: "heartbeat-secondary-fixture",
          channelSecret: "heartbeat-secondary-secret-fixture",
        },
      },
    },
  },
};

describe("LINE heartbeat typing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the LINE loading request only for direct chats with the selected account", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const to of [`C${"b".repeat(32)}`, `line:room:R${"c".repeat(32)}`, "", "invalid"]) {
      await linePlugin.heartbeat?.sendTyping?.({ cfg, to });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    await linePlugin.heartbeat?.sendTyping?.({ cfg, to: userId });
    await linePlugin.heartbeat?.sendTyping?.({
      cfg,
      to: `line:user:${userId}`,
      accountId: "secondary",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [index, token] of [
      "heartbeat-default-fixture",
      "heartbeat-secondary-fixture",
    ].entries()) {
      expect(fetchMock).toHaveBeenNthCalledWith(
        index + 1,
        new URL("https://api.line.me/v2/bot/chat/loading/start"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
          body: JSON.stringify({ chatId: userId, loadingSeconds: 20 }),
        }),
      );
    }

    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 400 }));
    await expect(linePlugin.heartbeat?.sendTyping?.({ cfg, to: userId })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
