// Exercises the durable batch owner through Discord's real RequestClient boundary.
import { ChannelType, Routes } from "discord-api-types/v10";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDiscordLoopbackRest } from "./send.test-harness.js";

vi.mock("openclaw/plugin-sdk/web-media", async () => {
  const { discordWebMediaMockFactory } = await import("./send.test-harness.js");
  return discordWebMediaMockFactory();
});

let discordPlugin: typeof import("./channel.js").discordPlugin;
let sendMessageDiscord: typeof import("./send.js").sendMessageDiscord;

const DISCORD_TEST_CFG = {
  channels: {
    discord: {
      accounts: {
        default: {},
      },
    },
  },
};

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
  ({ sendMessageDiscord } = await import("./send.js"));
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/web-media");
});

async function runDurableDiscordForumBatch(params: {
  parentType: ChannelType.GuildForum | ChannelType.GuildMedia;
  threadId?: string;
}) {
  const parentId = "700";
  const createdThreadId = "701";
  let messageCount = 0;
  const loopback = await createDiscordLoopbackRest({
    respond: ({ method, path }) => {
      if (method === "GET") {
        const channelId = path?.split("/").at(-1);
        return {
          id: channelId,
          type: channelId === parentId ? params.parentType : ChannelType.PublicThread,
        };
      }
      if (method === "POST" && path?.endsWith(Routes.threads(parentId))) {
        return {
          id: createdThreadId,
          message: { id: "starter-1", channel_id: createdThreadId },
        };
      }
      const channelId = path?.split("/").at(-2);
      messageCount += 1;
      return { id: `message-${messageCount}`, channel_id: channelId };
    },
  });
  const afterDeliverPayload = vi.fn();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          ...discordPlugin,
          outbound: {
            ...discordPlugin.outbound,
            afterDeliverPayload,
          },
        },
      },
    ]),
  );
  try {
    const result = await sendDurableMessageBatch({
      cfg: DISCORD_TEST_CFG,
      channel: "discord",
      to: `channel:${parentId}`,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      payloads: [
        { text: "Forum starter" },
        {
          text: "Generated images",
          mediaUrls: ["https://example.com/first.jpg", "https://example.com/second.jpg"],
        },
      ],
      deps: {
        discord: async (...[target, text, options]: Parameters<typeof sendMessageDiscord>) =>
          await sendMessageDiscord(target, text, {
            ...options,
            rest: loopback.rest,
            token: "t",
          }),
      },
      skipQueue: true,
    });
    return { afterDeliverPayload, requests: [...loopback.requests], result };
  } finally {
    await loopback.close();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  }
}

describe("durable Discord forum batches", () => {
  it.each<ChannelType.GuildForum | ChannelType.GuildMedia>([
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
  ])("keeps a payload batch in one created %s thread", async (parentType) => {
    const { afterDeliverPayload, requests, result } = await runDurableDiscordForumBatch({
      parentType,
    });
    const postPaths = requests
      .filter((request) => request.method === "POST")
      .map((request) => request.path);

    expect(postPaths).toEqual([
      `/v10${Routes.threads("700")}`,
      `/v10${Routes.channelMessages("701")}`,
      `/v10${Routes.channelMessages("701")}`,
    ]);
    expect(
      afterDeliverPayload.mock.calls.map(
        ([ctx]) => (ctx as { target?: { threadId?: unknown } }).target?.threadId,
      ),
    ).toEqual(["701", "701"]);
    expect(result.status).toBe("sent");
    if (result.status !== "sent") {
      throw new Error("expected durable Discord forum batch to send");
    }
    expect(result.receipt).toMatchObject({
      threadId: "701",
      platformMessageIds: ["starter-1", "message-1", "message-2"],
    });
  });

  it("keeps an explicit thread authoritative for the full payload batch", async () => {
    const { afterDeliverPayload, requests, result } = await runDurableDiscordForumBatch({
      parentType: ChannelType.GuildForum,
      threadId: "900",
    });
    const postPaths = requests
      .filter((request) => request.method === "POST")
      .map((request) => request.path);

    expect(postPaths).toEqual([
      `/v10${Routes.channelMessages("900")}`,
      `/v10${Routes.channelMessages("900")}`,
      `/v10${Routes.channelMessages("900")}`,
    ]);
    expect(
      afterDeliverPayload.mock.calls.map(
        ([ctx]) => (ctx as { target?: { threadId?: unknown } }).target?.threadId,
      ),
    ).toEqual(["900", "900"]);
    expect(result.status).toBe("sent");
    if (result.status !== "sent") {
      throw new Error("expected explicit-thread Discord batch to send");
    }
    expect(result.receipt.threadId).toBe("900");
    expect(result.receipt.platformMessageIds).toEqual(["message-1", "message-2", "message-3"]);
  });
});
