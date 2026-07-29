// Slack tests cover threading tool context plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buildSlackThreadingToolContext } from "./threading-tool-context.js";

const emptyCfg = {} as OpenClawConfig;

function resolveReplyToModeWithConfig(params: {
  slackConfig: Record<string, unknown>;
  context: Record<string, unknown>;
}) {
  const cfg = {
    channels: {
      slack: params.slackConfig,
    },
  } as OpenClawConfig;
  const result = buildSlackThreadingToolContext({
    cfg,
    accountId: null,
    context: params.context as never,
  });
  return result.replyToMode;
}

describe("buildSlackThreadingToolContext", () => {
  it("uses top-level replyToMode by default", () => {
    const cfg = {
      channels: {
        slack: { replyToMode: "first" },
      },
    } as OpenClawConfig;
    const result = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      context: { ChatType: "channel" },
    });
    expect(result.replyToMode).toBe("first");
  });

  it("uses chat-type replyToMode overrides for direct messages when configured", () => {
    expect(
      resolveReplyToModeWithConfig({
        slackConfig: {
          replyToMode: "off",
          replyToModeByChatType: { direct: "all" },
        },
        context: { ChatType: "direct" },
      }),
    ).toBe("all");
  });

  it("uses top-level replyToMode for channels when no channel override is set", () => {
    expect(
      resolveReplyToModeWithConfig({
        slackConfig: {
          replyToMode: "off",
          replyToModeByChatType: { direct: "all" },
        },
        context: { ChatType: "channel" },
      }),
    ).toBe("off");
  });

  it("falls back to top-level when no chat-type override is set", () => {
    const cfg = {
      channels: {
        slack: {
          replyToMode: "first",
        },
      },
    } as OpenClawConfig;
    const result = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      context: { ChatType: "direct" },
    });
    expect(result.replyToMode).toBe("first");
  });

  it("uses all mode when MessageThreadId is present", () => {
    expect(
      resolveReplyToModeWithConfig({
        slackConfig: {
          replyToMode: "all",
          replyToModeByChatType: { direct: "off" },
        },
        context: {
          ChatType: "direct",
          ThreadLabel: "thread-label",
          MessageThreadId: "1771999998.834199",
        },
      }),
    ).toBe("all");
  });

  it("does not force all mode from ThreadLabel alone", () => {
    expect(
      resolveReplyToModeWithConfig({
        slackConfig: {
          replyToMode: "all",
          replyToModeByChatType: { direct: "off" },
        },
        context: {
          ChatType: "direct",
          ThreadLabel: "label-without-real-thread",
        },
      }),
    ).toBe("off");
  });

  it("uses ReplyToId as the current thread when MessageThreadId is omitted", () => {
    const result = buildSlackThreadingToolContext({
      cfg: {
        channels: {
          slack: {
            replyToMode: "all",
            replyToModeByChatType: { direct: "off" },
          },
        },
      } as OpenClawConfig,
      accountId: null,
      context: {
        ChatType: "direct",
        To: "user:U8SUVSVGS",
        NativeChannelId: "D8SRXRDNF",
        CurrentMessageId: "1772000000.111111",
        ReplyToId: "1771999998.834199",
      },
    });

    expect(result.currentThreadTs).toBe("1771999998.834199");
    expect(result.replyToMode).toBe("all");
    expect(result.sameChannelThreadRequired).toBe(true);
  });

  it("uses TransportThreadId when ReplyToId matches the current message", () => {
    const result = buildSlackThreadingToolContext({
      cfg: {
        channels: {
          slack: {
            replyToMode: "all",
            replyToModeByChatType: { direct: "off" },
          },
        },
      } as OpenClawConfig,
      accountId: null,
      context: {
        ChatType: "direct",
        CurrentMessageId: "1771999998.834199",
        ReplyToId: "1771999998.834199",
        TransportThreadId: "1771999998.834199",
      },
    });

    expect(result.currentThreadTs).toBe("1771999998.834199");
    expect(result.replyToMode).toBe("all");
    expect(result.sameChannelThreadRequired).toBe(true);
  });

  it("keeps top-level ReplyToId as an anchor without forcing configured off mode", () => {
    const result = buildSlackThreadingToolContext({
      cfg: {
        channels: {
          slack: {
            replyToMode: "all",
            replyToModeByChatType: { direct: "off" },
          },
        },
      } as OpenClawConfig,
      accountId: null,
      context: {
        ChatType: "direct",
        CurrentMessageId: "1771999998.834199",
        ReplyToId: "1771999998.834199",
      },
    });

    expect(result.currentThreadTs).toBe("1771999998.834199");
    expect(result.replyToMode).toBe("off");
    expect(result.sameChannelThreadRequired).toBe(false);
  });

  it("keeps top-level ReplyToId as the first-reply anchor for single-use modes", () => {
    const result = buildSlackThreadingToolContext({
      cfg: {
        channels: {
          slack: {
            replyToMode: "first",
          },
        },
      } as OpenClawConfig,
      accountId: null,
      context: {
        ChatType: "direct",
        CurrentMessageId: "1771999998.834199",
        ReplyToId: "1771999998.834199",
      },
    });

    expect(result.currentThreadTs).toBe("1771999998.834199");
    expect(result.replyToMode).toBe("first");
  });

  it("uses CurrentMessageId as a non-explicit anchor when ReplyToId is omitted", () => {
    const result = buildSlackThreadingToolContext({
      cfg: {
        channels: {
          slack: {
            replyToMode: "first",
          },
        },
      } as OpenClawConfig,
      accountId: null,
      context: {
        ChatType: "channel",
        To: "channel:C123",
        CurrentMessageId: "1771999998.834199",
      },
    });

    expect(result.currentThreadTs).toBe("1771999998.834199");
    expect(result.replyToMode).toBe("first");
    expect(result.sameChannelThreadRequired).toBe(false);
  });

  it("keeps configured channel behavior when not in a thread", () => {
    const cfg = {
      channels: {
        slack: {
          replyToMode: "off",
          replyToModeByChatType: { channel: "first" },
        },
      },
    } as OpenClawConfig;
    const result = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      context: { ChatType: "channel", ThreadLabel: "label-only" },
    });
    expect(result.replyToMode).toBe("first");
  });

  it("prefers the prepared per-channel reply mode over account config", () => {
    const result = buildSlackThreadingToolContext({
      cfg: {
        channels: {
          slack: { replyToMode: "all" },
        },
      } as OpenClawConfig,
      accountId: null,
      context: {
        ChatType: "channel",
        To: "channel:C123",
        ReplyToMode: "off",
        CurrentMessageId: "1771999998.834199",
        ReplyToId: "1771999998.834199",
      },
    });

    expect(result.replyToMode).toBe("off");
  });

  it("defaults to off when no replyToMode is configured", () => {
    const result = buildSlackThreadingToolContext({
      cfg: emptyCfg,
      accountId: null,
      context: { ChatType: "direct" },
    });
    expect(result.replyToMode).toBe("off");
  });

  it("extracts currentChannelId from channel: prefixed To", () => {
    const result = buildSlackThreadingToolContext({
      cfg: emptyCfg,
      accountId: null,
      context: { ChatType: "channel", To: "channel:C1234ABC" },
    });
    expect(result.currentChannelId).toBe("C1234ABC");
    expect(result.currentMessagingTarget).toBe("channel:C1234ABC");
  });

  it("does not expose the core Channel provider as a Slack room name", () => {
    const result = buildSlackThreadingToolContext({
      cfg: emptyCfg,
      accountId: null,
      context: { ChatType: "channel", Channel: "slack", To: "channel:C1234ABC" },
    });
    expect(result).not.toHaveProperty("currentChannelName");
    expect(result.currentChannelId).toBe("C1234ABC");
  });

  it("preserves native and routable DM targets", () => {
    const result = buildSlackThreadingToolContext({
      cfg: emptyCfg,
      accountId: null,
      context: {
        ChatType: "direct",
        To: "user:U8SUVSVGS",
        NativeChannelId: "D8SRXRDNF",
      },
    });
    expect(result.currentChannelId).toBe("D8SRXRDNF");
    expect(result.currentMessagingTarget).toBe("user:U8SUVSVGS");
  });

  it("uses the user target for implicit DM sends when NativeChannelId is missing", () => {
    const result = buildSlackThreadingToolContext({
      cfg: emptyCfg,
      accountId: null,
      context: { ChatType: "direct", To: "user:U8SUVSVGS" },
    });
    expect(result.currentChannelId).toBe("user:U8SUVSVGS");
    expect(result.currentMessagingTarget).toBe("user:U8SUVSVGS");
  });
});
