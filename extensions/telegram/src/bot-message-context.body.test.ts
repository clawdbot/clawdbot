import { describe, expect, it, vi } from "vitest";
import { normalizeAllowFrom } from "./bot-access.js";

const transcribeFirstAudioMock = vi.fn();

vi.mock("./media-understanding.runtime.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

const { resolveTelegramInboundBody } = await import("./bot-message-context.body.js");

type TelegramInboundBodyParams = Parameters<typeof resolveTelegramInboundBody>[0];

function resolveTelegramBody(overrides: Partial<TelegramInboundBodyParams>) {
  const chatId = overrides.chatId ?? 42;
  return resolveTelegramInboundBody({
    cfg: {
      channels: { telegram: {} },
    } as never,
    primaryCtx: {
      me: { id: 7, username: "bot" },
    } as never,
    msg: {
      message_id: 0,
      date: 1_700_000_000,
      chat: { id: chatId, type: "private", first_name: "Pat" },
      from: { id: chatId, first_name: "Pat" },
    } as never,
    allMedia: [],
    isGroup: false,
    chatId,
    senderId: String(chatId),
    senderUsername: "",
    routeAgentId: undefined,
    effectiveGroupAllow: normalizeAllowFrom([]),
    effectiveDmAllow: normalizeAllowFrom([]),
    groupConfig: undefined,
    topicConfig: undefined,
    requireMention: false,
    options: undefined,
    groupHistories: new Map(),
    historyLimit: 0,
    logger: { info: vi.fn() },
    ...overrides,
  } as TelegramInboundBodyParams);
}

describe("resolveTelegramInboundBody", () => {
  it("keeps the media marker when a captioned video has no downloaded media", async () => {
    const result = await resolveTelegramBody({
      msg: {
        message_id: 0,
        date: 1_700_000_000,
        chat: { id: 42, type: "private", first_name: "Pat" },
        from: { id: 42, first_name: "Pat" },
        caption: "episode caption",
        video: {
          file_id: "video-1",
          file_unique_id: "video-u1",
          duration: 10,
          width: 320,
          height: 240,
        },
      } as never,
    });

    expect(result).toMatchObject({
      rawBody: "episode caption",
      bodyText: "<media:video> [file_id:video-1]\nepisode caption",
    });
  });

  it("does not transcribe group audio for unauthorized senders", async () => {
    transcribeFirstAudioMock.mockReset();
    const logger = { info: vi.fn() };

    const result = await resolveTelegramBody({
      cfg: {
        channels: { telegram: {} },
        messages: { groupChat: { mentionPatterns: ["\\bbot\\b"] } },
      } as never,
      msg: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
        from: { id: 46, first_name: "Eve" },
        voice: { file_id: "voice-1" },
        entities: [],
      } as never,
      allMedia: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }],
      isGroup: true,
      chatId: -1001234567890,
      senderId: "46",
      senderUsername: "",
      routeAgentId: undefined,
      effectiveGroupAllow: normalizeAllowFrom(["999"]),
      effectiveDmAllow: normalizeAllowFrom([]),
      groupConfig: { requireMention: true } as never,
      requireMention: true,
      logger,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { chatId: -1001234567890, reason: "no-mention" },
      "skipping group message",
    );
    expect(result).toBeNull();
  });

  it("still transcribes when commands.useAccessGroups is false", async () => {
    transcribeFirstAudioMock.mockReset();
    transcribeFirstAudioMock.mockResolvedValueOnce("hey bot please help");

    const result = await resolveTelegramBody({
      cfg: {
        channels: { telegram: {} },
        commands: { useAccessGroups: false },
        messages: { groupChat: { mentionPatterns: ["\\bbot\\b"] } },
        tools: { media: { audio: { enabled: true } } },
      } as never,
      msg: {
        message_id: 2,
        date: 1_700_000_001,
        chat: { id: -1001234567891, type: "supergroup", title: "Test Group" },
        from: { id: 46, first_name: "Eve" },
        voice: { file_id: "voice-2" },
        entities: [],
      } as never,
      allMedia: [{ path: "/tmp/voice-2.ogg", contentType: "audio/ogg" }],
      isGroup: true,
      chatId: -1001234567891,
      senderId: "46",
      senderUsername: "",
      routeAgentId: undefined,
      effectiveGroupAllow: normalizeAllowFrom(["999"]),
      effectiveDmAllow: normalizeAllowFrom([]),
      groupConfig: { requireMention: true } as never,
      requireMention: true,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      bodyText: "hey bot please help",
      effectiveWasMentioned: true,
    });
  });

  it("transcribes DM voice notes via preflight (not only groups)", async () => {
    transcribeFirstAudioMock.mockReset();
    transcribeFirstAudioMock.mockResolvedValueOnce("hello from a voice note");

    const result = await resolveTelegramBody({
      cfg: {
        channels: { telegram: {} },
        tools: { media: { audio: { enabled: true } } },
      } as never,
      msg: {
        message_id: 10,
        date: 1_700_000_010,
        chat: { id: 42, type: "private", first_name: "Pat" },
        from: { id: 42, first_name: "Pat" },
        voice: { file_id: "voice-dm-1" },
        entities: [],
      } as never,
      allMedia: [{ path: "/tmp/voice-dm.ogg", contentType: "audio/ogg" }],
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      bodyText: "hello from a voice note",
    });
    expect(result?.bodyText).not.toContain("<media:audio>");
  });
});
