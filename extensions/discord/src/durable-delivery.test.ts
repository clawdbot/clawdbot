// Discord tests cover durable delivery plugin behavior.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDiscordOutboundHoisted,
  installDiscordOutboundModuleSpies,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";

const hoisted = createDiscordOutboundHoisted();
await installDiscordOutboundModuleSpies(hoisted);

let discordPlugin: typeof import("./channel.js").discordPlugin;
let deliverDiscordReply: typeof import("./monitor/reply-delivery.js").deliverDiscordReply;

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
  ({ deliverDiscordReply } = await import("./monitor/reply-delivery.js"));
});

describe("durable Discord delivery", () => {
  const cfg = { channels: { discord: { token: "test-token" } } };

  beforeEach(() => {
    resetDiscordOutboundMocks(hoisted);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: discordPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("does not replay earlier chunks when a later platform send fails", async () => {
    hoisted.sendMessageDiscordMock
      .mockResolvedValueOnce({
        messageId: "msg-chunk-1",
        channelId: "ch-1",
      })
      .mockRejectedValueOnce(Object.assign(new Error("discord 500"), { status: 500 }));

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "discord",
      to: "channel:123456",
      payloads: [{ text: "first chunk\nsecond chunk" }],
      formatting: {
        chunkMode: "newline",
        maxLinesPerMessage: 1,
        textLimit: 2000,
      },
      skipQueue: true,
    });

    expect(result.status).toBe("partial_failed");
    if (result.status !== "partial_failed") {
      throw new Error("expected durable Discord send to report a partial failure");
    }
    expect(
      result.results.map((entry) => ({
        channel: entry.channel,
        messageId: entry.messageId,
      })),
    ).toEqual([{ channel: "discord", messageId: "msg-chunk-1" }]);
    expect(result.receipt.platformMessageIds).toEqual(["msg-chunk-1"]);
    expect(result.sentBeforeError).toBe(true);
    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(hoisted.sendMessageDiscordMock.mock.calls.map((call) => call[1])).toEqual([
      "first chunk",
      "second chunk",
    ]);
  });

  it("keeps accepted Discord chunks visible when monitored reply delivery fails", async () => {
    hoisted.sendMessageDiscordMock
      .mockResolvedValueOnce({ messageId: "msg-chunk-1", channelId: "ch-1" })
      .mockRejectedValueOnce(Object.assign(new Error("discord 500"), { status: 500 }));

    let error: unknown;
    try {
      await deliverDiscordReply({
        cfg,
        replies: [{ text: "first chunk\nsecond chunk" }],
        target: "channel:123456",
        token: "test-token",
        runtime: {} as RuntimeEnv,
        textLimit: 2000,
        maxLinesPerMessage: 1,
        chunkMode: "newline",
        kind: "final",
      });
    } catch (caught) {
      error = caught;
    }

    expect(isChannelPartialDeliveryError(error)).toBe(true);
    expect(error).toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
      deliveryResult: {
        messageIds: ["msg-chunk-1"],
        receipt: { platformMessageIds: ["msg-chunk-1"] },
        visibleReplySent: true,
      },
    });
    expect(hoisted.sendMessageDiscordMock.mock.calls.map((call) => call[1])).toEqual([
      "first chunk",
      "second chunk",
    ]);
  });
});
