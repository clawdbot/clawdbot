import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebInboundMessage } from "../../inbound/types.js";
import { maybeSendAckReaction } from "./ack-reaction.js";

const hoisted = vi.hoisted(() => ({
  sendReactionWhatsApp: vi.fn(async () => undefined),
}));

vi.mock("../../send.js", () => ({
  sendReactionWhatsApp: hoisted.sendReactionWhatsApp,
}));

function createMessage(overrides: Partial<WebInboundMessage> = {}): WebInboundMessage {
  return {
    id: "msg-1",
    from: "15551234567",
    conversationId: "15551234567",
    to: "15559876543",
    accountId: "default",
    body: "hello",
    chatType: "direct",
    chatId: "15551234567@s.whatsapp.net",
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    ...overrides,
  };
}

function createConfig(
  reactionLevel: "off" | "ack" | "minimal" | "extensive",
  extras?: Partial<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>,
): OpenClawConfig {
  return {
    channels: {
      whatsapp: {
        reactionLevel,
        ackReaction: {
          emoji: "👀",
          direct: true,
          group: "mentions",
        },
        ...extras,
      },
    },
  } as OpenClawConfig;
}

describe("maybeSendAckReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["ack", "minimal", "extensive"] as const)(
    "sends ack reactions when reactionLevel is %s",
    async (reactionLevel) => {
      await maybeSendAckReaction({
        cfg: createConfig(reactionLevel),
        msg: createMessage(),
        agentId: "agent",
        sessionKey: "whatsapp:default:15551234567",
        conversationId: "15551234567",
        verbose: false,
        accountId: "default",
        info: vi.fn(),
        warn: vi.fn(),
      });

      expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
        "15551234567@s.whatsapp.net",
        "msg-1",
        "👀",
        {
          verbose: false,
          fromMe: false,
          participant: undefined,
          accountId: "default",
        },
      );
    },
  );

  it("suppresses ack reactions when reactionLevel is off", async () => {
    await maybeSendAckReaction({
      cfg: createConfig("off"),
      msg: createMessage(),
      agentId: "agent",
      sessionKey: "whatsapp:default:15551234567",
      conversationId: "15551234567",
      verbose: false,
      accountId: "default",
      info: vi.fn(),
      warn: vi.fn(),
    });

    expect(hoisted.sendReactionWhatsApp).not.toHaveBeenCalled();
  });

  it("uses the active account reactionLevel override for ack gating", async () => {
    await maybeSendAckReaction({
      cfg: createConfig("off", {
        accounts: {
          work: {
            reactionLevel: "ack",
          },
        },
      }),
      msg: createMessage({
        accountId: "work",
      }),
      agentId: "agent",
      sessionKey: "whatsapp:work:15551234567",
      conversationId: "15551234567",
      verbose: false,
      accountId: "work",
      info: vi.fn(),
      warn: vi.fn(),
    });

    expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
      "15551234567@s.whatsapp.net",
      "msg-1",
      "👀",
      {
        verbose: false,
        fromMe: false,
        participant: undefined,
        accountId: "work",
      },
    );
  });
});
