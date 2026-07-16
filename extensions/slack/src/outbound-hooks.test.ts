import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());
const getGlobalHookRunnerMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageSlack: sendMessageSlackMock,
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

let slackOutbound: typeof import("./outbound-adapter.js").slackOutbound;

type SlackSendTextCtx = {
  to: string;
  text: string;
  accountId: string;
  replyToId: string;
  identity?: {
    name?: string;
    avatarUrl?: string;
    emoji?: string;
  };
};

const BASE_SLACK_SEND_CTX = {
  to: "C123",
  accountId: "default",
  replyToId: "1111.2222",
} as const;

const sendSlackText = async (ctx: SlackSendTextCtx) => {
  const sendText = slackOutbound.sendText;
  if (!sendText) {
    throw new Error("slackOutbound.sendText is unavailable");
  }
  return await sendText({
    cfg: {} as OpenClawConfig,
    ...ctx,
  });
};

const sendSlackTextWithDefaults = async (
  overrides: Partial<SlackSendTextCtx> & Pick<SlackSendTextCtx, "text">,
) => {
  return await sendSlackText({
    ...BASE_SLACK_SEND_CTX,
    ...overrides,
  });
};

const expectSlackSendCalledWith = (
  text: string,
  options?: {
    identity?: {
      username?: string;
      iconUrl?: string;
      iconEmoji?: string;
    };
  },
) => {
  const expected = {
    threadTs: "1111.2222",
    accountId: "default",
    cfg: expect.any(Object),
    ...(options?.identity ? { identity: expect.objectContaining(options.identity) } : {}),
  };
  expect(sendMessageSlackMock).toHaveBeenCalledWith(
    "C123",
    text,
    expect.objectContaining(expected),
  );
};

describe("slack outbound hook wiring", () => {
  beforeAll(async () => {
    ({ slackOutbound } = await import("./outbound-adapter.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageSlackMock.mockResolvedValue({ messageId: "1234.5678", channelId: "C123" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls send without hooks when no hooks registered", async () => {
    getGlobalHookRunnerMock.mockReturnValue(null);

    await sendSlackTextWithDefaults({ text: "hello" });
    expectSlackSendCalledWith("hello");
  });

  it("forwards identity opts when present", async () => {
    getGlobalHookRunnerMock.mockReturnValue(null);

    await sendSlackTextWithDefaults({
      text: "hello",
      identity: {
        name: "My Agent",
        avatarUrl: "https://example.com/avatar.png",
        emoji: ":should_not_send:",
      },
    });

    expectSlackSendCalledWith("hello", {
      identity: { username: "My Agent", iconUrl: "https://example.com/avatar.png" },
    });
  });

  it("forwards icon_emoji only when icon_url is absent", async () => {
    getGlobalHookRunnerMock.mockReturnValue(null);

    await sendSlackTextWithDefaults({
      text: "hello",
      identity: { emoji: ":lobster:" },
    });

    expectSlackSendCalledWith("hello", {
      identity: { iconEmoji: ":lobster:" },
    });
  });

  it("calls message_sending hook before sending", async () => {
    const mockRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runMessageSending: vi.fn().mockResolvedValue(undefined),
    };
    getGlobalHookRunnerMock.mockReturnValue(mockRunner);

    await sendSlackTextWithDefaults({ text: "hello" });

    expect(mockRunner.hasHooks).toHaveBeenCalledWith("message_sending");
    expect(mockRunner.runMessageSending).toHaveBeenCalledWith(
      { to: "C123", content: "hello", metadata: { threadTs: "1111.2222", channelId: "C123" } },
      { channelId: "slack", accountId: "default" },
    );
    expectSlackSendCalledWith("hello");
  });

  it("uses configured defaultAccount for hook context when accountId is omitted", async () => {
    const mockRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runMessageSending: vi.fn().mockResolvedValue(undefined),
    };
    getGlobalHookRunnerMock.mockReturnValue(mockRunner);

    const sendText = slackOutbound.sendText;
    if (!sendText) {
      throw new Error("slackOutbound.sendText is unavailable");
    }
    await sendText({
      cfg: {
        channels: {
          slack: {
            defaultAccount: "work",
            accounts: {
              work: {
                botToken: "xoxb-work",
              },
            },
          },
        },
      } as OpenClawConfig,
      to: "C123",
      text: "hello",
      replyToId: "1111.2222",
    });

    expect(mockRunner.runMessageSending).toHaveBeenCalledWith(
      { to: "C123", content: "hello", metadata: { threadTs: "1111.2222", channelId: "C123" } },
      { channelId: "slack", accountId: "work" },
    );
  });

  it("cancels send when hook returns cancel:true", async () => {
    const mockRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runMessageSending: vi.fn().mockResolvedValue({ cancel: true }),
    };
    getGlobalHookRunnerMock.mockReturnValue(mockRunner);

    const result = await sendSlackTextWithDefaults({ text: "hello" });

    expect(sendMessageSlackMock).not.toHaveBeenCalled();
    expect(result.channel).toBe("slack");
  });

  it("modifies text when hook returns content", async () => {
    const mockRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runMessageSending: vi.fn().mockResolvedValue({ content: "modified" }),
    };
    getGlobalHookRunnerMock.mockReturnValue(mockRunner);

    await sendSlackTextWithDefaults({ text: "original" });
    expectSlackSendCalledWith("modified");
  });

  it("skips hooks when runner has no message_sending hooks", async () => {
    const mockRunner = {
      hasHooks: vi.fn().mockReturnValue(false),
      runMessageSending: vi.fn(),
    };
    getGlobalHookRunnerMock.mockReturnValue(mockRunner);

    await sendSlackTextWithDefaults({ text: "hello" });

    expect(mockRunner.runMessageSending).not.toHaveBeenCalled();
    expect(sendMessageSlackMock).toHaveBeenCalled();
  });
});
