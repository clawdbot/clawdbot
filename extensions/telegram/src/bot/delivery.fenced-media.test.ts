// Telegram direct Bot API path must warn after accepted fenced MEDIA text (#41966).
import type { Bot } from "grammy";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const warnFencedMediaSkipsForAcceptedOutboundDelivery = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-outbound-fenced-media-runtime", async () => {
  // Keep plan+identity behavior local to the test: production latch imports the warn
  // helper via a relative path, so mocking only the runtime export of `warn*` is not
  // enough. Mirror createDirectAcceptedFencedMediaWarnLatch with the real plan builder.
  const { createOutboundPayloadPlan } = await import("openclaw/plugin-sdk/channel-outbound");
  return {
    warnFencedMediaSkipsForAcceptedOutboundDelivery: (
      ...args: Parameters<typeof warnFencedMediaSkipsForAcceptedOutboundDelivery>
    ) => warnFencedMediaSkipsForAcceptedOutboundDelivery(...args),
    createDirectAcceptedFencedMediaWarnLatch: (params: {
      payload: object;
      cfg?: unknown;
      surface?: string;
    }) => {
      const planEntry = createOutboundPayloadPlan([params.payload as never], {
        cfg: params.cfg as never,
        surface: params.surface,
      })[0];
      if (!planEntry?.mediaTokenSkippedInFence) {
        return { afterAcceptedVisibleText(_chunk: string) {} };
      }
      let warned = false;
      let acceptedVisibleText = "";
      const identities = planEntry.fencedSkippedMediaDirectives ?? [];
      return {
        afterAcceptedVisibleText(visibleChunk: string) {
          if (warned) {
            return;
          }
          if (visibleChunk.trim()) {
            acceptedVisibleText = acceptedVisibleText
              ? `${acceptedVisibleText}\n${visibleChunk}`
              : visibleChunk;
          }
          const retained =
            identities.length > 0
              ? identities.some((directive: string) => {
                  const identity = directive.trim();
                  return (
                    identity.length > 0 &&
                    acceptedVisibleText.split("\n").some((line) => line.trim() === identity)
                  );
                })
              : /media:/i.test(acceptedVisibleText);
          if (!retained) {
            return;
          }
          warned = true;
          warnFencedMediaSkipsForAcceptedOutboundDelivery([
            {
              text: acceptedVisibleText,
              mediaTokenSkippedInFence: true,
              fencedSkippedMediaDirectives: identities,
            },
          ]);
        },
      };
    },
  };
});

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
