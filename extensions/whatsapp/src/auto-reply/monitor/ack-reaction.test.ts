// Whatsapp tests cover ack reaction plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { maybeSendAckReaction } from "./ack-reaction.js";

const hoisted = vi.hoisted(() => ({
  sendReactionWhatsApp: vi.fn(async () => undefined),
}));

vi.mock("../../send.js", () => ({
  sendReactionWhatsApp: hoisted.sendReactionWhatsApp,
}));

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: vi.fn(async () => "always"),
}));

type TestMsgOverrides = NonNullable<Parameters<typeof createTestWebInboundMessage>[0]>;

function createMessage(overrides: TestMsgOverrides = {}): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    event: { id: "msg-1" },
    platform: {
      chatJid: "15551234567@s.whatsapp.net",
      recipientJid: "15559876543",
    },
    admission: {
      accountId: "default",
      conversation: {
        kind: "direct",
        id: "15551234567",
      },
      sender: {
        id: "15551234567",
      },
    },
    ...overrides,
  });
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

type AckReactionParams = Parameters<typeof maybeSendAckReaction>[0];

const runAckReaction = (overrides: Partial<AckReactionParams> = {}) =>
  maybeSendAckReaction({
    cfg: createConfig("ack"),
    msg: createMessage(),
    agentId: "agent",
    sessionKey: "whatsapp:default:15551234567",
    verbose: false,
    info: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  });

const expectAckReactionSent = (accountId: string, cfg: OpenClawConfig = createConfig("ack")) => {
  expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
    "15551234567@s.whatsapp.net",
    "msg-1",
    "👀",
    {
      verbose: false,
      fromMe: false,
      accountId,
      cfg,
    },
  );
};

describe("maybeSendAckReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["ack", "minimal", "extensive"] as const)(
    "sends ack reactions when reactionLevel is %s",
    async (reactionLevel) => {
      const cfg = createConfig(reactionLevel);
      const ackReaction = await runAckReaction({
        cfg,
      });

      expect(ackReaction?.ackReactionValue).toBe("👀");
      await expect(ackReaction?.ackReactionPromise).resolves.toBe(true);
      expectAckReactionSent("default", cfg);
    },
  );

  it("suppresses ack reactions when reactionLevel is off", async () => {
    const ackReaction = await runAckReaction({
      cfg: createConfig("off"),
    });

    expect(ackReaction).toBeNull();
    expect(hoisted.sendReactionWhatsApp).not.toHaveBeenCalled();
  });

  it("uses the active account reactionLevel override for ack gating", async () => {
    const cfg = createConfig("off", {
      accounts: {
        work: {
          reactionLevel: "ack",
        },
      },
    });
    const ackReaction = await runAckReaction({
      cfg,
      msg: createMessage({
        admission: {
          accountId: "work",
        },
      }),
      sessionKey: "whatsapp:work:15551234567",
    });

    expect(ackReaction?.ackReactionValue).toBe("👀");
    expectAckReactionSent("work", cfg);
  });

  it("uses the agent identity emoji when WhatsApp ackReaction has no emoji", async () => {
    const cfg = {
      agents: {
        list: [{ id: "agent", identity: { emoji: "🔥" } }],
      },
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          ackReaction: {
            direct: true,
            group: "mentions",
          },
        },
      },
    } as OpenClawConfig;

    const ackReaction = await runAckReaction({ cfg });

    expect(ackReaction?.ackReactionValue).toBe("🔥");
    await expect(ackReaction?.ackReactionPromise).resolves.toBe(true);
    expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
      "15551234567@s.whatsapp.net",
      "msg-1",
      "🔥",
      {
        verbose: false,
        fromMe: false,
        accountId: "default",
        cfg,
      },
    );
  });

  it("returns a handle that removes the ack with an empty reaction", async () => {
    const cfg = createConfig("ack");
    const ackReaction = await runAckReaction({ cfg });

    await ackReaction?.remove();

    expect(hoisted.sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "15551234567@s.whatsapp.net",
      "msg-1",
      "",
      {
        verbose: false,
        fromMe: false,
        accountId: "default",
        cfg,
      },
    );
  });

  it("uses the sender LID as the group reaction participant when no sender JID is available", async () => {
    const cfg = createConfig("ack", {
      ackReaction: {
        emoji: "👀",
        direct: true,
        group: "always",
      },
    });
    const ackReaction = await runAckReaction({
      cfg,
      msg: createMessage({
        platform: {
          chatJid: "120363000000000000@g.us",
          sender: {
            jid: null,
            lid: "277038292303944@lid",
          },
        },
        admission: {
          conversation: {
            kind: "group",
            id: "120363000000000000@g.us",
          },
          sender: {
            id: "277038292303944@lid",
          },
        },
      }),
      sessionKey: "whatsapp:default:120363000000000000@g.us",
    });

    await expect(ackReaction?.ackReactionPromise).resolves.toBe(true);
    expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
      "120363000000000000@g.us",
      "msg-1",
      "👀",
      {
        verbose: false,
        fromMe: false,
        participant: "277038292303944@lid",
        accountId: "default",
        cfg,
      },
    );

    await ackReaction?.remove();

    expect(hoisted.sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "120363000000000000@g.us",
      "msg-1",
      "",
      {
        verbose: false,
        fromMe: false,
        participant: "277038292303944@lid",
        accountId: "default",
        cfg,
      },
    );
  });

  it("records ack send failures on the handle", async () => {
    const cfg = createConfig("ack");
    const warn = vi.fn();
    hoisted.sendReactionWhatsApp.mockRejectedValueOnce(new Error("session down"));

    const ackReaction = await runAckReaction({ cfg, warn });

    await expect(ackReaction?.ackReactionPromise).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      {
        error: "session down",
        chatId: "15551234567@s.whatsapp.net",
        messageId: "msg-1",
      },
      "failed to send ack reaction",
    );
  });
});
