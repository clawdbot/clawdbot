import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";

const mocks = vi.hoisted(() => ({
  executeSendAction: vi.fn(),
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./outbound-send-service.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-send-service.js")>(
    "./outbound-send-service.js",
  );
  return {
    ...actual,
    executeSendAction: mocks.executeSendAction,
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
  };
});

import { runMessageAction } from "./message-action-runner.js";

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as MoltbotConfig;

describe("runMessageAction Slack threading", () => {
  beforeEach(async () => {
    const { createPluginRuntime } = await import("../../plugins/runtime/index.js");
    const { setSlackRuntime } = await import("../../../extensions/slack/src/runtime.js");
    const runtime = createPluginRuntime();
    setSlackRuntime(runtime);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: slackPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    mocks.executeSendAction.mockReset();
    mocks.recordSessionMetaFromInbound.mockReset();
  });

  it("uses toolContext thread when auto-threading is active", async () => {
    mocks.executeSendAction.mockResolvedValue({
      handledBy: "plugin",
      payload: {},
    });

    await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:C123",
        message: "hi",
      },
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: "111.222",
        replyToMode: "all",
      },
      agentId: "main",
    });

    const call = mocks.executeSendAction.mock.calls[0]?.[0];
    expect(call?.ctx?.mirror?.sessionKey).toBe("agent:main:slack:channel:c123:thread:111.222");
  });

  it("matches auto-threading when channel ids differ in case", async () => {
    mocks.executeSendAction.mockResolvedValue({
      handledBy: "plugin",
      payload: {},
    });

    await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:c123",
        message: "hi",
      },
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: "333.444",
        replyToMode: "all",
      },
      agentId: "main",
    });

    const call = mocks.executeSendAction.mock.calls[0]?.[0];
    expect(call?.ctx?.mirror?.sessionKey).toBe("agent:main:slack:channel:c123:thread:333.444");
  });
});

const telegramConfig = {
  channels: {
    telegram: {
      enabled: true,
      botToken: "test:token",
    },
  },
} as MoltbotConfig;

describe("runMessageAction thread id injection from toolContext", () => {
  beforeEach(async () => {
    const { createPluginRuntime } = await import("../../plugins/runtime/index.js");
    const { setTelegramRuntime } = await import("../../../extensions/telegram/src/runtime.js");
    const runtime = createPluginRuntime();
    setTelegramRuntime(runtime);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    mocks.executeSendAction.mockReset();
    mocks.recordSessionMetaFromInbound.mockReset();
  });

  it("injects toolContext.currentThreadTs into params.threadId when not explicitly set", async () => {
    mocks.executeSendAction.mockResolvedValue({
      handledBy: "plugin",
      payload: { ok: true, messageId: "123", chatId: "63448508" },
    });

    await runMessageAction({
      cfg: telegramConfig,
      action: "send",
      params: {
        channel: "telegram",
        target: "63448508",
        message: "hello from topic",
      },
      toolContext: {
        currentChannelId: "63448508",
        currentChannelProvider: "telegram",
        currentThreadTs: "994409",
      },
    });

    const call = mocks.executeSendAction.mock.calls[0]?.[0];
    expect(call?.ctx?.params?.threadId).toBe("994409");
  });

  it("does not override explicit threadId with toolContext", async () => {
    mocks.executeSendAction.mockResolvedValue({
      handledBy: "plugin",
      payload: { ok: true, messageId: "124", chatId: "63448508" },
    });

    await runMessageAction({
      cfg: telegramConfig,
      action: "send",
      params: {
        channel: "telegram",
        target: "63448508",
        message: "explicit thread",
        threadId: "12345",
      },
      toolContext: {
        currentChannelId: "63448508",
        currentChannelProvider: "telegram",
        currentThreadTs: "994409",
      },
    });

    const call = mocks.executeSendAction.mock.calls[0]?.[0];
    expect(call?.ctx?.params?.threadId).toBe("12345");
  });

  it("does not inject threadId when toolContext has no currentThreadTs", async () => {
    mocks.executeSendAction.mockResolvedValue({
      handledBy: "plugin",
      payload: { ok: true, messageId: "125", chatId: "63448508" },
    });

    await runMessageAction({
      cfg: telegramConfig,
      action: "send",
      params: {
        channel: "telegram",
        target: "63448508",
        message: "no thread context",
      },
      toolContext: {
        currentChannelId: "63448508",
        currentChannelProvider: "telegram",
      },
    });

    const call = mocks.executeSendAction.mock.calls[0]?.[0];
    expect(call?.ctx?.params?.threadId).toBeUndefined();
  });
});
