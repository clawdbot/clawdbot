// Telegram tests cover the pre-download mention gate honoring
// disableAudioPreflight for captionless voice notes in mention-gated groups.
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramBotDepsForTest } from "./bot.media.e2e.test-harness.js";
import {
  TELEGRAM_TEST_TIMINGS,
  createBotHandlerWithOptions,
  mockTelegramFileDownload,
  watchTelegramFetch,
} from "./bot.media.test-utils.js";

vi.mock("./media-understanding.runtime.js", () => ({
  transcribeFirstAudio: vi.fn(async () => "mock transcript"),
}));

type GroupConfig = Record<
  string,
  {
    requireMention?: boolean;
    disableAudioPreflight?: boolean;
    topics?: Record<string, { disableAudioPreflight?: boolean }>;
  }
>;

const originalGetRuntimeConfig = telegramBotDepsForTest.getRuntimeConfig;

function setGroupConfig(groups: GroupConfig): void {
  telegramBotDepsForTest.getRuntimeConfig = () =>
    ({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "open",
          groups,
        },
      },
    }) as ReturnType<typeof originalGetRuntimeConfig>;
}

afterEach(() => {
  telegramBotDepsForTest.getRuntimeConfig = originalGetRuntimeConfig;
});

function captionlessVoiceMessage(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      message_id: 1,
      chat: { id: -100123, type: "group" },
      from: { id: 777, is_bot: false, first_name: "Ada" },
      voice: { file_id: "voice-1" },
      date: 1736380800,
      ...overrides,
    },
    me: { username: "openclaw_bot" },
    getFile: vi.fn(async () => ({ file_path: "voice/1.ogg" })),
  };
}

describe("telegram inbound media pre-download mention gate", () => {
  const INBOUND_MEDIA_TEST_TIMEOUT_MS = 90_000;

  it(
    "does not download captionless voice notes when disableAudioPreflight is enabled for the group",
    async () => {
      setGroupConfig({ "-100123": { requireMention: true, disableAudioPreflight: true } });
      const { handler, replySpy } = await createBotHandlerWithOptions({});
      const ctx = captionlessVoiceMessage();
      const fetchSpy = watchTelegramFetch();
      try {
        await handler(ctx);
        expect(ctx.getFile).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(replySpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
    INBOUND_MEDIA_TEST_TIMEOUT_MS,
  );

  it(
    "still downloads captionless voice notes for mention preflight when disableAudioPreflight is not set",
    async () => {
      setGroupConfig({ "-100123": { requireMention: true } });
      const { handler } = await createBotHandlerWithOptions({});
      const ctx = captionlessVoiceMessage();
      const fetchSpy = mockTelegramFileDownload({
        contentType: "audio/ogg",
        bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]), // "OggS"
      });
      try {
        await handler(ctx);
        expect(ctx.getFile).toHaveBeenCalled();
        expect(fetchSpy).toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
    INBOUND_MEDIA_TEST_TIMEOUT_MS,
  );

  it(
    "downloads captionless voice notes when a topic-level disableAudioPreflight false override is set",
    async () => {
      setGroupConfig({
        "-100123": {
          requireMention: true,
          disableAudioPreflight: true,
          topics: { "5": { disableAudioPreflight: false } },
        },
      });
      const { handler } = await createBotHandlerWithOptions({});
      const ctx = captionlessVoiceMessage({
        message_id: 3,
        message_thread_id: 5,
        is_topic_message: true,
        chat: { id: -100123, type: "supergroup", is_forum: true },
      });
      const fetchSpy = mockTelegramFileDownload({
        contentType: "audio/ogg",
        bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]), // "OggS"
      });
      try {
        await handler(ctx);
        expect(ctx.getFile).toHaveBeenCalled();
        expect(fetchSpy).toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
    INBOUND_MEDIA_TEST_TIMEOUT_MS,
  );
});
