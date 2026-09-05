import { setTimeout as delay } from "node:timers/promises";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { setTelegramRuntime } from "./runtime.js";
import type { TelegramRuntime } from "./runtime.types.js";

const saveRemoteMedia = vi.fn();

vi.mock("./telegram-media.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telegram-media.runtime.js")>();
  return {
    ...actual,
    saveRemoteMedia: (...args: unknown[]) => saveRemoteMedia(...args),
  };
});

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const { getLoadConfigMock, getOnHandler, replySpy, sendMessageSpy, telegramBotDepsForTest } =
  harness;
const { createTelegramBotCore: createTelegramBotBase } = await import("./bot-core.js");

let createTelegramBot: (
  opts: import("./bot.types.js").TelegramBotOptions,
) => ReturnType<typeof import("./bot-core.js").createTelegramBotCore>;

const loadConfig = getLoadConfigMock();
const MEDIA_GROUP_FLUSH_MS = 20;

function createChannelPostContext(params: {
  messageId: number;
  mediaGroupId: string;
  ignore?: boolean;
}) {
  return {
    channelPost: {
      chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
      message_id: params.messageId,
      date: 1_736_380_800 + params.messageId,
      media_group_id: params.mediaGroupId,
      caption: params.ignore ? "/ignore hidden" : "private album detail",
      ...(params.ignore
        ? { caption_entities: [{ type: "bot_command", offset: 0, length: 7 }] }
        : {}),
      photo: [{ file_id: `photo-${params.messageId}` }],
    },
    me: { id: 7, username: "openclaw_bot" },
    getFile: async () => ({ file_path: `photos/${params.messageId}.jpg` }),
  };
}

describe("createTelegramBot channel_post /ignore albums", () => {
  beforeAll(() => {
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        botInfo: telegramBotInfoForTest,
        telegramTransport: {
          fetch: globalThis.fetch,
          sourceFetch: globalThis.fetch,
          close: async () => {},
        },
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
  });

  beforeEach(() => {
    setTelegramRuntime({
      state: {
        openKeyedStore: ((options) =>
          createPluginStateKeyedStoreForTests(
            "telegram",
            options,
          )) as TelegramRuntime["state"]["openKeyedStore"],
        openSyncKeyedStore: ((options) =>
          createPluginStateSyncKeyedStoreForTests(
            "telegram",
            options,
          )) as TelegramRuntime["state"]["openSyncKeyedStore"],
      },
      channel: {},
    } as TelegramRuntime);
    saveRemoteMedia.mockReset();
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "-100777111222": { enabled: true, requireMention: false } },
        },
      },
    });
  });

  it.each(["first", "later"] as const)(
    "suppresses the album when /ignore arrives as the %s member",
    async (position) => {
      createTelegramBot({
        token: "tok",
        testTimings: { mediaGroupFlushMs: MEDIA_GROUP_FLUSH_MS, textFragmentGapMs: 30 },
      });
      const handler = getOnHandler("channel_post") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      const albumId = `channel-ignore-${position}`;
      const ignore = createChannelPostContext({
        messageId: 211,
        mediaGroupId: albumId,
        ignore: true,
      });
      const ordinary = createChannelPostContext({ messageId: 212, mediaGroupId: albumId });

      for (const update of position === "first" ? [ignore, ordinary] : [ordinary, ignore]) {
        await handler(update);
      }
      await delay(MEDIA_GROUP_FLUSH_MS + 25);

      expect(replySpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(saveRemoteMedia).not.toHaveBeenCalled();
    },
  );
});
