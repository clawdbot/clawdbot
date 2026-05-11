import { describe, expect, it, vi, beforeEach } from "vitest";
import { twitchMessageActions } from "./actions.js";
import type { ResolvedTwitchAccountContext } from "./config.js";
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

function createSecondaryAccountContext(accountId = "secondary"): ResolvedTwitchAccountContext {
  return {
    accountId,
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
  };
}

describe("twitchMessageActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses configured defaultAccount when action accountId is omitted", async () => {
    vi.mocked(resolveTwitchAccountContext)
      .mockImplementationOnce(() => createSecondaryAccountContext())
      .mockImplementation((_cfg, accountId) =>
        createSecondaryAccountContext(accountId?.trim() || "secondary"),
      );
    const sendText = twitchOutbound.sendText;
    if (!sendText) {
      throw new Error("twitchOutbound.sendText is unavailable");
    }
    vi.mocked(sendText).mockResolvedValue({
      channel: "twitch",
      messageId: "msg-1",
      timestamp: 1,
    });
    const cfg = {
      channels: {
        twitch: {
          defaultAccount: "secondary",
        },
      },
    };

    await twitchMessageActions.handleAction!({
      action: "send",
      params: { message: "Hello!" },
      cfg,
    } as never);

    expect(twitchOutbound.sendText).toHaveBeenCalledWith({
      cfg,
      to: "secondary-channel",
      text: "Hello!",
      accountId: "secondary",
    });
  });
});
