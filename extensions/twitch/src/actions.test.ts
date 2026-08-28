// Twitch tests cover actions plugin behavior.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { twitchMessageActions } from "./actions.js";
import { resolveTwitchAccountContext } from "./config.js";
import { sendTwitchOutboundText } from "./outbound.js";

type ResolvedTwitchAccountContext = ReturnType<typeof resolveTwitchAccountContext>;

vi.mock("./config.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  resolveTwitchAccountContext: vi.fn(),
}));

vi.mock("./outbound.js", () => ({
  sendTwitchOutboundText: vi.fn(),
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
    const accountContext = createSecondaryAccountContext();
    vi.mocked(resolveTwitchAccountContext).mockReturnValue(accountContext);
    vi.mocked(sendTwitchOutboundText).mockResolvedValue({
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

    expect(resolveTwitchAccountContext).toHaveBeenCalledOnce();
    expect(sendTwitchOutboundText).toHaveBeenCalledWith(
      {
        cfg,
        to: "secondary-channel",
        text: "Hello!",
        accountId: "secondary",
      },
      accountContext,
    );
  });
});
