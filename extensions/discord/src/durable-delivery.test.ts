// Discord tests cover durable delivery plugin behavior.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
  mockDiscordBoundThreadManager,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";

const hoisted = createDiscordOutboundHoisted();
await installDiscordOutboundModuleSpies(hoisted);

let discordPlugin: typeof import("./channel.js").discordPlugin;
let deliverDiscordReply: typeof import("./monitor/reply-delivery.js").deliverDiscordReply;
const twentyLines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
const twentyLineText = twentyLines.join("\n");

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
  ({ deliverDiscordReply } = await import("./monitor/reply-delivery.js"));
});

describe("durable Discord delivery", () => {
  const cfg = {
    channels: { discord: { token: "test-token", maxLinesPerMessage: 50 } },
  };

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

  it.each<{
    name: string;
    cfg: OpenClawConfig;
    accountId?: string;
    expected: string[];
  }>([
    {
      name: "the root line limit",
      cfg: { channels: { discord: { token: "test-token", maxLinesPerMessage: 50 } } },
      accountId: undefined,
      expected: [twentyLineText],
    },
    {
      name: "the default 17-line limit",
      cfg: { channels: { discord: { token: "test-token" } } },
      accountId: undefined,
      expected: [twentyLines.slice(0, 17).join("\n"), twentyLines.slice(17).join("\n")],
    },
    {
      name: "the configured default account line limit",
      cfg: {
        channels: {
          discord: {
            token: "test-token",
            defaultAccount: "work",
            maxLinesPerMessage: 5,
            accounts: { work: { token: "work-token", maxLinesPerMessage: 50 } },
          },
        },
      },
      accountId: undefined,
      expected: [twentyLineText],
    },
    {
      name: "the explicit account line limit",
      cfg: {
        channels: {
          discord: {
            token: "test-token",
            defaultAccount: "default",
            maxLinesPerMessage: 5,
            accounts: {
              default: { token: "default-token", maxLinesPerMessage: 5 },
              work: { token: "work-token", maxLinesPerMessage: 50 },
            },
          },
        },
      },
      accountId: "work",
      expected: [twentyLineText],
    },
  ])("honors $name before platform sends", async ({ cfg: caseCfg, accountId, expected }) => {
    const result = await sendDurableMessageBatch({
      cfg: caseCfg,
      channel: "discord",
      to: "channel:123456",
      accountId,
      payloads: [{ text: twentyLineText }],
      skipQueue: true,
    });

    expect(result.status).toBe("sent");
    expect(hoisted.sendMessageDiscordMock.mock.calls.map((call) => call[1])).toEqual(expected);
  });

  it("keeps a configured 20-line bound-thread reply in one webhook send", async () => {
    mockDiscordBoundThreadManager(hoisted);

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "discord",
      to: "channel:parent-1",
      accountId: "default",
      threadId: "thread-1",
      payloads: [{ text: twentyLineText }],
      skipQueue: true,
    });

    expect(result.status).toBe("sent");
    expect(hoisted.sendWebhookMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(hoisted.sendWebhookMessageDiscordMock.mock.calls[0]?.[0]).toBe(twentyLineText);
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
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
