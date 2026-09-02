// Discord tests cover debounce partitioning by reply target.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import {
  createDiscordHandlerParams,
  createDiscordPreflightContext,
} from "./message-handler.test-helpers.js";

function createTextMessageData(messageId: string, channelId = "ch-1") {
  return {
    channel_id: channelId,
    author: { id: "user-1" },
    message: {
      id: messageId,
      author: { id: "user-1", bot: false },
      content: "hello",
      channel_id: channelId,
      attachments: [],
    },
  };
}

function createPreflightContext(channelId = "ch-1") {
  const discordConfig = {
    enabled: true,
    token: "test-token",
    groupPolicy: "allowlist" as const,
  };
  const cfg: OpenClawConfig = {
    channels: { discord: discordConfig },
    messages: { inbound: { debounceMs: 0 } },
  };
  return {
    ...createDiscordPreflightContext(channelId),
    cfg,
    accountId: "default",
    token: "test-token",
    runtime: {
      log: () => {},
      error: () => {},
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    },
    textLimit: 2_000,
    replyToMode: "off" as const,
    discordConfig,
    messageText: "hello",
    isDirectMessage: false,
    isGuildMessage: true,
  };
}

describe("Discord reply-target debounce partitioning", () => {
  beforeEach(() => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
  });

  it("keeps replies to a different message out of an ordinary debounced batch", async () => {
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 20 } };
    preflightDiscordMessageMock.mockImplementation(
      async (preflightParams: { data: ReturnType<typeof createTextMessageData> }) => ({
        ...createPreflightContext(preflightParams.data.channel_id),
        message: preflightParams.data.message,
        messageText: preflightParams.data.message.content,
      }),
    );
    const handler = createDiscordMessageHandler(params);
    const ordinary = createTextMessageData("m-ordinary");
    const reply = createTextMessageData("m-other-bot-reply");
    Object.assign(reply.message, {
      messageReference: {
        type: 0,
        message_id: "m-other-bot",
        channel_id: reply.channel_id,
      },
      referencedMessage: {
        id: "m-other-bot",
        author: { id: "other-bot", bot: true },
      },
    });

    await handler(ordinary as never, {} as never);
    await handler(reply as never, {} as never);

    await expect.poll(() => preflightDiscordMessageMock.mock.calls.length).toBe(2);
    expect(
      preflightDiscordMessageMock.mock.calls.map(
        ([call]) =>
          (call as { data: ReturnType<typeof createTextMessageData> }).data.message.content,
      ),
    ).toEqual(["hello", "hello"]);
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
  });
});
