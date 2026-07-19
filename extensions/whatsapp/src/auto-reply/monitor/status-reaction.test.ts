// Whatsapp tests cover status reaction plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { createWhatsAppStatusReactionController } from "./status-reaction.js";

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

describe("createWhatsAppStatusReactionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the sender LID as the group reaction participant when no sender JID is available", async () => {
    const cfg = {
      messages: {
        statusReactions: {
          enabled: true,
          timing: {
            debounceMs: 1_000_000,
            stallSoftMs: 1_000_000,
            stallHardMs: 1_000_000,
            doneHoldMs: 0,
            errorHoldMs: 0,
          },
        },
      },
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          ackReaction: {
            emoji: "👀",
            direct: true,
            group: "always",
          },
        },
      },
    } as OpenClawConfig;

    const controller = await createWhatsAppStatusReactionController({
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
      agentId: "agent",
      sessionKey: "whatsapp:default:120363000000000000@g.us",
      verbose: false,
    });

    void controller?.setQueued();
    await vi.waitFor(() => {
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
    });

    await controller?.clear();

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

  it("uses the agent identity emoji when WhatsApp ackReaction has no emoji", async () => {
    const cfg = {
      agents: {
        list: [{ id: "agent", identity: { emoji: "🔥" } }],
      },
      messages: {
        statusReactions: {
          enabled: true,
          timing: {
            debounceMs: 1_000_000,
            stallSoftMs: 1_000_000,
            stallHardMs: 1_000_000,
            doneHoldMs: 0,
            errorHoldMs: 0,
          },
        },
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

    const controller = await createWhatsAppStatusReactionController({
      cfg,
      msg: createMessage(),
      agentId: "agent",
      sessionKey: "whatsapp:default:15551234567",
      verbose: false,
    });

    void controller?.setQueued();
    await vi.waitFor(() => {
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
    await controller?.clear();
  });

  it("uses the active account reactionLevel override from admission", async () => {
    const cfg = {
      messages: {
        statusReactions: {
          enabled: true,
          timing: {
            debounceMs: 1_000_000,
            stallSoftMs: 1_000_000,
            stallHardMs: 1_000_000,
            doneHoldMs: 0,
            errorHoldMs: 0,
          },
        },
      },
      channels: {
        whatsapp: {
          reactionLevel: "off",
          ackReaction: {
            emoji: "👀",
            direct: true,
            group: "mentions",
          },
          accounts: {
            work: {
              reactionLevel: "ack",
            },
          },
        },
      },
    } as OpenClawConfig;

    const controller = await createWhatsAppStatusReactionController({
      cfg,
      msg: createMessage({
        admission: {
          accountId: "work",
        },
      }),
      agentId: "agent",
      sessionKey: "whatsapp:work:15551234567",
      verbose: false,
    });

    void controller?.setQueued();
    await vi.waitFor(() => {
      expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
        "15551234567@s.whatsapp.net",
        "msg-1",
        "👀",
        {
          verbose: false,
          fromMe: false,
          accountId: "work",
          cfg,
        },
      );
    });
    await controller?.clear();
  });
});
