// Telegram direct Bot API path must warn after accepted fenced MEDIA text (#41966).
import type { Bot } from "grammy";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const warnFencedMediaSkipsForAcceptedOutboundDelivery = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/plugin-sdk/channel-outbound-fenced-media-warn.ts", () => ({
  warnFencedMediaSkipsForAcceptedOutboundDelivery: (
    ...args: Parameters<typeof warnFencedMediaSkipsForAcceptedOutboundDelivery>
  ) => warnFencedMediaSkipsForAcceptedOutboundDelivery(...args),
}));
vi.mock("../../../../src/plugin-sdk/channel-outbound-fenced-media-warn.js", () => ({
  warnFencedMediaSkipsForAcceptedOutboundDelivery: (
    ...args: Parameters<typeof warnFencedMediaSkipsForAcceptedOutboundDelivery>
  ) => warnFencedMediaSkipsForAcceptedOutboundDelivery(...args),
}));
vi.mock("openclaw/plugin-sdk/channel-outbound-fenced-media-warn", () => ({
  warnFencedMediaSkipsForAcceptedOutboundDelivery: (
    ...args: Parameters<typeof warnFencedMediaSkipsForAcceptedOutboundDelivery>
  ) => warnFencedMediaSkipsForAcceptedOutboundDelivery(...args),
}));

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return {
    ...actual,
    probeVideoDimensions: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/hook-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/hook-runtime")>();
  return {
    ...actual,
    triggerInternalHook: vi.fn(async () => {}),
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...actual,
    getGlobalHookRunner: () => ({
      hasHooks: () => false,
      runMessageSending: vi.fn(),
      runMessageSent: vi.fn(),
    }),
  };
});

vi.mock("../sent-message-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sent-message-cache.js")>();
  return { ...actual, recordSentMessage: vi.fn() };
});

vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("grammy")>();
  return {
    ...actual,
    API_CONSTANTS: {
      DEFAULT_UPDATE_TYPES: ["message"],
      ALL_UPDATE_TYPES: ["message"],
    },
    InputFile: class {
      constructor(
        public buffer: Buffer,
        public filename?: string,
      ) {}
    },
  };
});

const { deliverReplies } = await import("./delivery.js");

function createRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
    log: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

function createBot(
  sendMessage = vi.fn().mockResolvedValue({ message_id: 77, chat: { id: "123" } }),
) {
  return {
    api: {
      sendMessage,
      sendPhoto: vi.fn(),
      sendDocument: vi.fn(),
      sendVoice: vi.fn(),
      sendVideo: vi.fn(),
      sendAudio: vi.fn(),
      sendAnimation: vi.fn(),
      setMessageReaction: vi.fn(),
    },
  } as unknown as Bot;
}

describe("telegram deliverReplies fenced MEDIA diagnostic (#41966)", () => {
  beforeEach(() => {
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockClear();
  });

  it("warns once after accepted Telegram Bot API text retains fenced MEDIA identity", async () => {
    const fenced = "note\n```\nMEDIA:/tmp/demo.png\n```";
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 88, chat: { id: "123" } });
    await deliverReplies({
      replies: [{ text: fenced }],
      chatId: "123",
      token: "tok",
      replyToMode: "off",
      textLimit: 4000,
      runtime: createRuntime(),
      bot: createBot(sendMessage),
    });
    expect(sendMessage).toHaveBeenCalled();
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).toHaveBeenCalledTimes(1);
    const arg = warnFencedMediaSkipsForAcceptedOutboundDelivery.mock.calls[0]?.[0] as
      | Array<{ fencedSkippedMediaDirectives?: string[] }>
      | undefined;
    expect(arg?.[0]?.fencedSkippedMediaDirectives).toEqual(["MEDIA:/tmp/demo.png"]);
  });

  it("stays silent when Telegram send fails before acceptance", async () => {
    const fenced = "```\nMEDIA:/tmp/demo.png\n```";
    const sendMessage = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(
      deliverReplies({
        replies: [{ text: fenced }],
        chatId: "123",
        token: "tok",
        replyToMode: "off",
        textLimit: 4000,
        runtime: createRuntime(),
        bot: createBot(sendMessage),
      }),
    ).rejects.toThrow(/network down/);
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).not.toHaveBeenCalled();
  });
});
