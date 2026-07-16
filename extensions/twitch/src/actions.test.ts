import { describe, expect, it, vi, beforeEach } from "vitest";
import { twitchMessageActions } from "./actions.js";
import { resolveTwitchAccountContext } from "./config.js";
import { twitchOutbound } from "./outbound.js";

vi.mock("./config.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  resolveTwitchAccountContext: vi.fn(),
}));

vi.mock("./outbound.js", () => ({
  twitchOutbound: {
    sendText: vi.fn(),
  },
}));

describe("twitchMessageActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses configured defaultAccount when action accountId is omitted", async () => {
    vi.mocked(resolveTwitchAccountContext)
      .mockImplementationOnce(() => ({
        accountId: "secondary",
        account: {
          channel: "secondary-channel",
          username: "secondary",
          accessToken: "oauth:secondary-token",
          clientId: "secondary-client",
          enabled: true,
        },
        tokenResolution: { source: "config", token: "oauth:secondary-token" },
        configured: true,
        availableAccountIds: ["default", "secondary"],
      }))
      .mockImplementation((_cfg, accountId) => ({
        accountId: accountId?.trim() || "secondary",
        account: {
          channel: "secondary-channel",
          username: "secondary",
          accessToken: "oauth:secondary-token",
          clientId: "secondary-client",
          enabled: true,
        },
        tokenResolution: { source: "config", token: "oauth:secondary-token" },
        configured: true,
        availableAccountIds: ["default", "secondary"],
      }));
    const sendText = twitchOutbound.sendText;
    if (!sendText) {
      throw new Error("twitchOutbound.sendText is unavailable");
    }
    vi.mocked(sendText).mockResolvedValue({
      channel: "twitch",
      messageId: "msg-1",
      timestamp: 1,
    });

    await twitchMessageActions.handleAction!({
      action: "send",
      params: { message: "Hello!" },
      cfg: {
        channels: {
          twitch: {
            defaultAccount: "secondary",
          },
        },
      },
    } as never);

    expect(twitchOutbound.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "secondary",
        to: "secondary-channel",
      }),
    );
  });
});
