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

  it("uses legacy dm.replyToMode for direct messages when no chat-type override exists", () => {
    expect(
      resolveReplyToModeWithConfig({
        slackConfig: {
          replyToMode: "off",
          dm: { replyToMode: "all" },
        },
        context: { ChatType: "direct" },
      }),
    ).toBe("all");
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
  });

  it("uses NativeChannelId for DM when To is user-prefixed", () => {
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
  });

  it("returns undefined currentChannelId when neither channel: To nor NativeChannelId is set", () => {
    const result = buildSlackThreadingToolContext({
      cfg: emptyCfg,
      accountId: null,
      context: { ChatType: "direct", To: "user:U8SUVSVGS" },
    });
    expect(result.currentChannelId).toBeUndefined();
  });
});
