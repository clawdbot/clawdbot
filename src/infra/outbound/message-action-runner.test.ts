import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { runMessageAction } from "./message-action-runner.js";

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as ClawdbotConfig;

const whatsappConfig = {
  channels: {
    whatsapp: {
      allowFrom: ["*"],
    },
  },
} as ClawdbotConfig;

describe("runMessageAction context isolation", () => {
  it("allows send when target matches current channel", async () => {
    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        to: "#C123",
        message: "hi",
      },
      toolContext: { currentChannelId: "C123" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("blocks send when target differs from current channel", async () => {
    await expect(
      runMessageAction({
        cfg: slackConfig,
        action: "send",
        params: {
          channel: "slack",
          to: "channel:C999",
          message: "hi",
        },
        toolContext: { currentChannelId: "C123" },
        dryRun: true,
      }),
    ).rejects.toThrow(/Cross-context messaging denied/);
  });

  it("blocks thread-reply when channelId differs from current channel", async () => {
    await expect(
      runMessageAction({
        cfg: slackConfig,
        action: "thread-reply",
        params: {
          channel: "slack",
          channelId: "C999",
          message: "hi",
        },
        toolContext: { currentChannelId: "C123" },
        dryRun: true,
      }),
    ).rejects.toThrow(/Cross-context messaging denied/);
  });

  it("allows WhatsApp send when target matches current chat", async () => {
    const result = await runMessageAction({
      cfg: whatsappConfig,
      action: "send",
      params: {
        channel: "whatsapp",
        to: "group:123@g.us",
        message: "hi",
      },
      toolContext: { currentChannelId: "123@g.us" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("blocks WhatsApp send when target differs from current chat", async () => {
    await expect(
      runMessageAction({
        cfg: whatsappConfig,
        action: "send",
        params: {
          channel: "whatsapp",
          to: "456@g.us",
          message: "hi",
        },
        toolContext: { currentChannelId: "123@g.us" },
        dryRun: true,
      }),
    ).rejects.toThrow(/Cross-context messaging denied/);
  });

  it("allows iMessage send when target matches current handle", async () => {
    const result = await runMessageAction({
      cfg: whatsappConfig,
      action: "send",
      params: {
        channel: "imessage",
        to: "imessage:+15551234567",
        message: "hi",
      },
      toolContext: { currentChannelId: "imessage:+15551234567" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("blocks iMessage send when target differs from current handle", async () => {
    await expect(
      runMessageAction({
        cfg: whatsappConfig,
        action: "send",
        params: {
          channel: "imessage",
          to: "imessage:+15551230000",
          message: "hi",
        },
        toolContext: { currentChannelId: "imessage:+15551234567" },
        dryRun: true,
      }),
    ).rejects.toThrow(/Cross-context messaging denied/);
  });
});
