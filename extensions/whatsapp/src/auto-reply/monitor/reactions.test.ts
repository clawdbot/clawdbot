// Whatsapp tests cover ack reaction plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { resolveWhatsAppAckEmoji } from "./ack-emoji.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import { createWhatsAppStatusReactionController } from "./status-reaction.js";

const hoisted = vi.hoisted(() => ({
  sendReactionWhatsApp: vi.fn(async () => undefined),
  resolveGroupActivationFor: vi.fn(async (): Promise<"always" | "mention"> => "always"),
}));

vi.mock("../../send.js", () => ({
  sendReactionWhatsApp: hoisted.sendReactionWhatsApp,
}));

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: hoisted.resolveGroupActivationFor,
}));

type TestMsgOverrides = NonNullable<Parameters<typeof createTestWebInboundMessage>[0]>;

type AckReactionConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>["ackReaction"]
>;

function createMessage(overrides: TestMsgOverrides = {}): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    event: { id: "msg-1" },
    platform: {
      chatJid: "15551234567@s.whatsapp.net",
      recipientJid: "15559876543",
      fromMe: false,
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
    messages: { ackReaction: "👀", ackReactionScope: "all" },
    channels: {
      whatsapp: {
        reactionLevel,
        ...extras,
      },
    },
  } as OpenClawConfig;
}

function createAckEmojiConfig(ackReaction?: AckReactionConfig): OpenClawConfig {
  const cfg = {
    agents: {
      list: [{ id: "agent", identity: { emoji: "🔥" } }],
    },
    channels: {
      whatsapp: {},
    },
  } as OpenClawConfig;
  if (ackReaction !== undefined) {
    cfg.channels!.whatsapp!.ackReaction = ackReaction;
  }
  return cfg;
}

function resolveAckEmoji(cfg: OpenClawConfig, agentId = "agent") {
  return resolveWhatsAppAckEmoji({
    cfg,
    agentId,
    ackConfig: cfg.channels?.whatsapp?.ackReaction,
  });
}

function createStatusConfig(
  overrides: {
    ackEmoji?: string;
    agentEmoji?: string;
    reactionLevel?: "off" | "ack";
    workReactionLevel?: "off" | "ack";
  } = {},
): OpenClawConfig {
  return {
    ...(overrides.agentEmoji
      ? { agents: { entries: { agent: { identity: { emoji: overrides.agentEmoji } } } } }
      : {}),
    messages: {
      ackReaction: overrides.ackEmoji ?? "👀",
      ackReactionScope: "all",
      statusReactions: { enabled: true },
    },
    channels: {
      whatsapp: {
        reactionLevel: overrides.reactionLevel ?? "ack",
        ...(overrides.workReactionLevel
          ? { accounts: { work: { reactionLevel: overrides.workReactionLevel } } }
          : {}),
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

describe("resolveWhatsAppAckEmoji", () => {
  it.each([
    {
      name: "keeps missing ackReaction config disabled",
      cfg: createAckEmojiConfig(),
      expected: "",
    },
    {
      name: "uses the configured WhatsApp emoji when present",
      cfg: createAckEmojiConfig({ emoji: " 👀 ", direct: true, group: "mentions" }),
      expected: "👀",
    },
    {
      name: "falls back to the routed agent identity for an empty emoji",
      cfg: createAckEmojiConfig({ emoji: " ", direct: true, group: "mentions" }),
      expected: "🔥",
    },
    {
      name: "falls back to the routed agent identity emoji when the ack object has no emoji",
      cfg: createAckEmojiConfig({ direct: true, group: "mentions" }),
      expected: "🔥",
    },
    {
      name: "uses normalized agent ids for the identity fallback",
      cfg: {
        agents: { list: [{ id: "Agent", identity: { emoji: "🔥" } }] },
        channels: { whatsapp: { ackReaction: { direct: true, group: "mentions" } } },
      } as OpenClawConfig,
      expected: "🔥",
    },
    {
      name: "uses the default ack emoji when configured without an emoji or agent identity",
      cfg: {
        channels: { whatsapp: { ackReaction: { direct: true, group: "mentions" } } },
      } as OpenClawConfig,
      expected: "👀",
    },
  ])("$name", ({ cfg, expected }) => {
    expect(resolveAckEmoji(cfg)).toBe(expected);
  });
});

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

  it.each([
    {
      name: "acks a mentioned group message",
      scope: "group-mentions",
      activation: "mention",
      wasMentioned: true,
      expected: true,
    },
    {
      name: "skips an unmentioned inactive group message",
      scope: "group-mentions",
      activation: "mention",
      wasMentioned: false,
      expected: false,
    },
    {
      name: "acks an activated group without a literal mention",
      scope: "group-mentions",
      activation: "always",
      wasMentioned: false,
      expected: true,
    },
    {
      name: "acks every group message under group-all",
      scope: "group-all",
      activation: "mention",
      wasMentioned: false,
      expected: true,
    },
    {
      name: "keeps direct-only scope out of groups",
      scope: "direct",
      activation: "always",
      wasMentioned: true,
      expected: false,
    },
  ] as const)("$name", async ({ scope, activation, wasMentioned, expected }) => {
    const cfg = createConfig("ack");
    cfg.messages!.ackReactionScope = scope;
    hoisted.resolveGroupActivationFor.mockResolvedValue(activation);

    const ackReaction = await runAckReaction({
      cfg,
      msg: createMessage({
        platform: { chatJid: "120363000000000000@g.us" },
        admission: {
          conversation: { kind: "group", id: "120363000000000000@g.us" },
        },
        groupMention: { wasMentioned, requireMention: true },
      }),
      sessionKey: "whatsapp:default:120363000000000000@g.us",
    });

    expect(Boolean(ackReaction)).toBe(expected);
    if (ackReaction) {
      await expect(ackReaction.ackReactionPromise).resolves.toBe(true);
    }
  });

  it("uses the canonical emoji preserved from agent identity", async () => {
    const cfg = {
      agents: {
        entries: { agent: { identity: { emoji: "🔥" } } },
      },
      messages: { ackReaction: "🔥", ackReactionScope: "all" },
      channels: {
        whatsapp: {
          reactionLevel: "ack",
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

  it("preserves self-authored direction for ack send and removal", async () => {
    const cfg = createConfig("ack");
    const ackReaction = await runAckReaction({
      cfg,
      msg: createMessage({
        platform: {
          chatJid: "15551234567@s.whatsapp.net",
          recipientJid: "15559876543",
          fromMe: true,
        },
      }),
    });

    await expect(ackReaction?.ackReactionPromise).resolves.toBe(true);
    expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
      "15551234567@s.whatsapp.net",
      "msg-1",
      "👀",
      {
        verbose: false,
        fromMe: true,
        accountId: "default",
        cfg,
      },
    );

    await ackReaction?.remove();

    expect(hoisted.sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "15551234567@s.whatsapp.net",
      "msg-1",
      "",
      {
        verbose: false,
        fromMe: true,
        accountId: "default",
        cfg,
      },
    );
  });

  it("uses the sender LID as the group reaction participant when no sender JID is available", async () => {
    const cfg = createConfig("ack");
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

describe("createWhatsAppStatusReactionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the sender LID as the group reaction participant when no sender JID is available", async () => {
    const cfg = createStatusConfig();
    const controller = await createWhatsAppStatusReactionController({
      cfg,
      msg: createMessage({
        platform: {
          chatJid: "120363000000000000@g.us",
          sender: { jid: null, lid: "277038292303944@lid" },
        },
        admission: {
          conversation: { kind: "group", id: "120363000000000000@g.us" },
          sender: { id: "277038292303944@lid" },
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

  it("preserves self-authored direction for status set and clear", async () => {
    const cfg = createStatusConfig();
    const controller = await createWhatsAppStatusReactionController({
      cfg,
      msg: createMessage({
        platform: {
          chatJid: "15551234567@s.whatsapp.net",
          recipientJid: "15559876543",
          fromMe: true,
        },
      }),
      agentId: "agent",
      sessionKey: "whatsapp:default:15551234567",
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
          fromMe: true,
          accountId: "default",
          cfg,
        },
      );
    });

    await controller?.clear();

    expect(hoisted.sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "15551234567@s.whatsapp.net",
      "msg-1",
      "",
      {
        verbose: false,
        fromMe: true,
        accountId: "default",
        cfg,
      },
    );
  });

  it.each([
    {
      name: "uses the canonical emoji preserved from agent identity",
      cfg: createStatusConfig({ ackEmoji: "🔥", agentEmoji: "🔥" }),
      msg: createMessage(),
      sessionKey: "whatsapp:default:15551234567",
      expectedEmoji: "🔥",
      expectedAccountId: "default",
    },
    {
      name: "uses the active account reactionLevel override from admission",
      cfg: createStatusConfig({ reactionLevel: "off", workReactionLevel: "ack" }),
      msg: createMessage({ admission: { accountId: "work" } }),
      sessionKey: "whatsapp:work:15551234567",
      expectedEmoji: "👀",
      expectedAccountId: "work",
    },
  ])("$name", async ({ cfg, msg, sessionKey, expectedEmoji, expectedAccountId }) => {
    const controller = await createWhatsAppStatusReactionController({
      cfg,
      msg,
      agentId: "agent",
      sessionKey,
      verbose: false,
    });

    void controller?.setQueued();
    await vi.waitFor(() => {
      expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
        "15551234567@s.whatsapp.net",
        "msg-1",
        expectedEmoji,
        {
          verbose: false,
          fromMe: false,
          accountId: expectedAccountId,
          cfg,
        },
      );
    });
    await controller?.clear();
  });
});
