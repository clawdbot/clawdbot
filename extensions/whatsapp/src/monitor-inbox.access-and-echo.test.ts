// WhatsApp monitor inbox access and echo behavior.
import { cleanMessage } from "baileys";
import { describe, expect, it, vi } from "vitest";
import { isRecentOutboundMessage } from "./inbound/dedupe.js";
import {
  buildNotifyMessageUpsert,
  expectPairingPromptSent,
  getRecordChannelActivityMock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  settleInboundWork,
  startInboxMonitor,
  upsertPairingRequestMock,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";

const nowSeconds = (offsetMs = 0) => Math.floor((Date.now() + offsetMs) / 1000);
const DEFAULT_MESSAGES_CFG = {
  messagePrefix: undefined,
  responsePrefix: undefined,
} as const;

function createAllowListConfig(allowFrom: string[]) {
  return {
    channels: {
      whatsapp: {
        allowFrom,
      },
    },
    messages: DEFAULT_MESSAGES_CFG,
  };
}

async function openInboxMonitor(onMessage = vi.fn()) {
  const { listener, sock } = await startInboxMonitor(onMessage);
  return { onMessage, listener, sock };
}

function expectOnlyOutboundChannelActivity(accountId = "default") {
  const recordChannelActivityMock = getRecordChannelActivityMock();
  expect(recordChannelActivityMock).toHaveBeenCalledWith({
    channel: "whatsapp",
    accountId,
    direction: "outbound",
  });
  expect(recordChannelActivityMock).not.toHaveBeenCalledWith({
    channel: "whatsapp",
    accountId,
    direction: "inbound",
  });
}

async function expectOutboundDmSkipsPairing(params: {
  selfChatMode: boolean;
  messageId: string;
  body: string;
}) {
  mockLoadConfig.mockReturnValue({
    channels: {
      whatsapp: {
        dmPolicy: "pairing",
        selfChatMode: params.selfChatMode,
      },
    },
    messages: DEFAULT_MESSAGES_CFG,
  });

  const onMessage = vi.fn();
  const { listener, sock } = await startInboxMonitor(onMessage);

  try {
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            id: params.messageId,
            fromMe: true,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: params.body },
          messageTimestamp: nowSeconds(),
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();
  } finally {
    mockLoadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: DEFAULT_MESSAGES_CFG,
    });
    await listener.close();
  }
}

describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  it("allows messages from senders in allowFrom list", async () => {
    mockLoadConfig.mockReturnValue(createAllowListConfig(["+111", "+999"]));

    const { onMessage, listener, sock } = await openInboxMonitor();

    const upsert = buildNotifyMessageUpsert({
      id: "auth1",
      remoteJid: "999@s.whatsapp.net",
      text: "authorized message",
      timestamp: nowSeconds(60_000),
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    // Should call onMessage for authorized senders
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        admission: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "+999",
          }),
        }),
        payload: expect.objectContaining({
          body: "authorized message",
        }),
        platform: expect.objectContaining({
          senderE164: "+999",
        }),
      }),
    );

    await listener.close();
  });

  it("allows same-phone messages even if not in allowFrom", async () => {
    // Same-phone mode: when from === selfJid, should always be allowed
    // This allows users to message themselves even with restrictive allowFrom
    mockLoadConfig.mockReturnValue(createAllowListConfig(["+111"]));

    const { onMessage, listener, sock } = await openInboxMonitor();

    // Message from self (sock.user.id is "123@s.whatsapp.net" in mock)
    const upsert = buildNotifyMessageUpsert({
      id: "self1",
      remoteJid: "123@s.whatsapp.net",
      text: "self message",
      timestamp: nowSeconds(60_000),
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    // Should allow self-messages even if not in allowFrom
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        admission: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "+123",
          }),
        }),
        payload: expect.objectContaining({
          body: "self message",
        }),
      }),
    );

    await listener.close();
  });

  it("blocks allowlisted same-phone fromMe DMs when self-chat mode is disabled", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: ["+123"],
          selfChatMode: false,
        },
      },
      messages: DEFAULT_MESSAGES_CFG,
    });
    const { onMessage, listener, sock } = await openInboxMonitor();

    try {
      sock.ev.emit("messages.upsert", {
        type: "notify",
        messages: [
          {
            key: {
              id: "self-disabled",
              fromMe: true,
              remoteJid: "123@s.whatsapp.net",
            },
            message: { conversation: "disabled self-chat" },
            messageTimestamp: nowSeconds(),
          },
        ],
      });
      await settleInboundWork();

      expect(onMessage).not.toHaveBeenCalled();
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      expect(sock.sendMessage).not.toHaveBeenCalled();
      expect(sock.readMessages).not.toHaveBeenCalled();
    } finally {
      await listener.close();
    }
  });

  it("locks down when no config is present (pairing for unknown senders)", async () => {
    // No config file => locked-down defaults apply (pairing for unknown senders)
    mockLoadConfig.mockReturnValue({});
    upsertPairingRequestMock
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });

    const { onMessage, listener, sock } = await openInboxMonitor();

    // Message from someone else should be blocked
    const upsertBlocked = buildNotifyMessageUpsert({
      id: "no-config-1",
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: nowSeconds(),
    });

    sock.ev.emit("messages.upsert", upsertBlocked);
    await vi.waitFor(
      () => {
        expect(sock.sendMessage).toHaveBeenCalledTimes(1);
      },
      { timeout: 5_000, interval: 5 },
    );
    expect(onMessage).not.toHaveBeenCalled();
    expectPairingPromptSent(sock, "999@s.whatsapp.net", "+999");

    const upsertBlockedAgain = buildNotifyMessageUpsert({
      id: "no-config-1b",
      remoteJid: "999@s.whatsapp.net",
      text: "ping again",
      timestamp: nowSeconds(),
    });

    sock.ev.emit("messages.upsert", upsertBlockedAgain);
    await settleInboundWork();
    expect(onMessage).not.toHaveBeenCalled();
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);

    // Message from self should be allowed
    const upsertSelf = buildNotifyMessageUpsert({
      id: "no-config-2",
      remoteJid: "123@s.whatsapp.net",
      text: "self ping",
      timestamp: nowSeconds(),
    });

    sock.ev.emit("messages.upsert", upsertSelf);
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        admission: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "+123",
          }),
        }),
        payload: expect.objectContaining({
          body: "self ping",
        }),
        platform: expect.objectContaining({
          recipientJid: "+123",
        }),
      }),
    );

    await listener.close();
  });

  it("still sends pairing replies when live DMs have null timestamps", async () => {
    mockLoadConfig.mockReturnValue({});
    upsertPairingRequestMock.mockResolvedValueOnce({ code: "PAIRCODE", created: true });

    const { onMessage, listener, sock } = await openInboxMonitor();

    const upsertBlocked = buildNotifyMessageUpsert({
      id: "no-config-null-ts",
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: null as never,
    });

    sock.ev.emit("messages.upsert", upsertBlocked);
    await vi.waitFor(
      () => {
        expect(sock.sendMessage).toHaveBeenCalledTimes(1);
      },
      { timeout: 5_000, interval: 5 },
    );

    expect(onMessage).not.toHaveBeenCalled();
    expectPairingPromptSent(sock, "999@s.whatsapp.net", "+999");

    await listener.close();
  });

  it("skips pairing replies for outbound DMs in same-phone mode", async () => {
    await expectOutboundDmSkipsPairing({
      selfChatMode: true,
      messageId: "fromme-1",
      body: "hello",
    });
  });

  it("skips pairing replies for outbound DMs when same-phone mode is disabled", async () => {
    await expectOutboundDmSkipsPairing({
      selfChatMode: false,
      messageId: "fromme-2",
      body: "hello again",
    });
  });

  it("allows owner fromMe group commands when they were not sent by the gateway", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          groupPolicy: "open",
          allowFrom: ["+123"],
          selfChatMode: false,
        },
      },
      messages: DEFAULT_MESSAGES_CFG,
    });

    const { onMessage, listener, sock } = await openInboxMonitor();

    sock.sendMessage.mockResolvedValueOnce({ key: { id: "out-1" } });
    await listener.sendMessage("120363@g.us", "/status");

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            id: "in-2",
            fromMe: true,
            remoteJid: "120363@g.us",
            participant: "123@s.whatsapp.net",
          },
          message: { conversation: "/status" },
          messageTimestamp: nowSeconds(),
          pushName: "Owner",
        },
      ],
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        admission: expect.objectContaining({
          conversation: expect.objectContaining({
            kind: "group",
            id: "120363@g.us",
          }),
        }),
        payload: expect.objectContaining({
          body: "/status",
        }),
        platform: expect.objectContaining({
          fromMe: true,
          senderE164: "+123",
        }),
      }),
    );

    await listener.close();
  });

  it.each([
    { name: "remote inbound", fromMe: false, selfChatMode: false },
    { name: "linked-device self-chat", fromMe: true, selfChatMode: true },
  ])("admits a distinct-ID $name collision after an accepted outbound send", async (testCase) => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          allowFrom: ["+123", "+999"],
          selfChatMode: testCase.selfChatMode,
        },
      },
      messages: DEFAULT_MESSAGES_CFG,
    });
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage);
    const remoteJid = testCase.fromMe ? "123@s.whatsapp.net" : "999@s.whatsapp.net";

    sock.sendMessage.mockResolvedValueOnce({ key: { id: "out-1" } });
    await listener.sendMessage(remoteJid, "Done.");
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "in-2", fromMe: testCase.fromMe, remoteJid },
          message: { conversation: "Done." },
          messageTimestamp: nowSeconds(),
        },
      ],
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ id: "in-2" }),
        payload: expect.objectContaining({ body: "Done." }),
      }),
    );
    await listener.close();
  });

  it("filters group fromMe echoes only when the gateway sent the matching message id", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          groupPolicy: "open",
          allowFrom: ["+123"],
        },
      },
      messages: DEFAULT_MESSAGES_CFG,
    });

    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage);

    sock.sendMessage.mockResolvedValueOnce({ key: { id: "bot-group-echo-1" } });
    await listener.sendMessage("120363@g.us", "gateway echo candidate");

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            id: "bot-group-echo-1",
            fromMe: true,
            remoteJid: "120363@g.us",
            participant: "123@s.whatsapp.net",
          },
          message: { conversation: "gateway echo candidate" },
          messageTimestamp: nowSeconds(),
          pushName: "Owner",
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();
    expectOnlyOutboundChannelActivity();

    await listener.close();
  });

  it("filters self-chat DM fromMe echoes when the gateway sent the matching message id", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          selfChatMode: true,
          allowFrom: ["+123"],
        },
      },
      messages: DEFAULT_MESSAGES_CFG,
    });

    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage);

    sock.sendMessage.mockResolvedValueOnce({ key: { id: "bot-dm-echo-1" } });
    await listener.sendMessage("123@s.whatsapp.net", "self-chat reply");

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            id: "bot-dm-echo-1",
            fromMe: true,
            remoteJid: "123@s.whatsapp.net",
          },
          message: { conversation: "self-chat reply" },
          messageTimestamp: nowSeconds(),
          pushName: "Owner",
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();
    expectOnlyOutboundChannelActivity();

    await listener.close();
  });

  it.each([
    {
      name: "device-qualified phone JIDs",
      outboundJid: "123:7@s.whatsapp.net",
      echoedJid: "123@s.whatsapp.net",
    },
    {
      name: "legacy c.us phone JIDs",
      outboundJid: "123@c.us",
      echoedJid: "123@s.whatsapp.net",
    },
    {
      name: "hosted phone JIDs",
      outboundJid: "123:7@hosted",
      echoedJid: "123:7@hosted",
    },
    {
      name: "hosted LID JIDs",
      outboundJid: "777:2@hosted.lid",
      echoedJid: "777:2@hosted.lid",
    },
    {
      name: "phone aliases carried alongside direct LID echoes",
      outboundJid: "123@s.whatsapp.net",
      echoedJid: "777@lid",
      echoedAlternateJid: "123:8@s.whatsapp.net",
    },
    {
      name: "LID aliases carried alongside direct phone echoes",
      outboundJid: "777@lid",
      echoedJid: "123@s.whatsapp.net",
      echoedAlternateJid: "777:3@lid",
    },
  ])(
    "filters provider-normalized outbound self echoes for $name",
    async ({ outboundJid, echoedJid, echoedAlternateJid }) => {
      mockLoadConfig.mockReturnValue({
        channels: {
          whatsapp: {
            selfChatMode: true,
            allowFrom: ["+123"],
          },
        },
        messages: DEFAULT_MESSAGES_CFG,
      });

      const onMessage = vi.fn();
      const { listener, sock } = await startInboxMonitor(onMessage);
      sock.signalRepository.lidMapping.getPNForLID.mockImplementation(async (jid: string) =>
        jid.startsWith("777@") ? "123@s.whatsapp.net" : null,
      );
      const messageId = `bot-provider-echo-${outboundJid}`;
      sock.sendMessage.mockResolvedValueOnce({ key: { id: messageId } });
      await listener.sendMessage(outboundJid, "gateway self echo");

      const echoedMessage = {
        key: {
          id: messageId,
          fromMe: true,
          remoteJid: echoedJid,
          ...(echoedAlternateJid ? { remoteJidAlt: echoedAlternateJid } : {}),
        },
        message: { conversation: "gateway self echo" },
        messageTimestamp: nowSeconds(),
      };
      cleanMessage(echoedMessage, "123@s.whatsapp.net", "777@lid");

      sock.ev.emit("messages.upsert", {
        type: "notify",
        messages: [echoedMessage],
      });
      await settleInboundWork();

      expect(onMessage).not.toHaveBeenCalled();
      expectOnlyOutboundChannelActivity();
      await listener.close();
    },
  );

  it("keeps provider-normalized echo matches scoped to their account and message", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          selfChatMode: true,
          allowFrom: ["+123"],
        },
      },
      messages: DEFAULT_MESSAGES_CFG,
    });

    const { listener, sock } = await startInboxMonitor(vi.fn());
    sock.sendMessage.mockResolvedValueOnce({ key: { id: "scoped-hosted-echo" } });
    await listener.sendMessage("123:7@hosted", "gateway self echo");

    expect(
      isRecentOutboundMessage({
        accountId: "other-account",
        remoteJid: "123@s.whatsapp.net",
        messageId: "scoped-hosted-echo",
      }),
    ).toBe(false);
    expect(
      isRecentOutboundMessage({
        accountId: "default",
        remoteJid: "123@s.whatsapp.net",
        messageId: "other-message",
      }),
    ).toBe(false);

    await listener.close();
  });

  it("never treats another group as an alternate direct-chat echo", async () => {
    const { listener, sock } = await startInboxMonitor(vi.fn());
    sock.sendMessage.mockResolvedValueOnce({ key: { id: "group-alias-control" } });
    await listener.sendMessage("12345@g.us", "gateway group message");

    expect(
      isRecentOutboundMessage({
        accountId: "default",
        remoteJid: "67890@g.us",
        alternateRemoteJid: "12345@g.us",
        messageId: "group-alias-control",
      }),
    ).toBe(false);

    await listener.close();
  });

  it("handles append messages by marking them read but skipping auto-reply", async () => {
    const { onMessage, listener, sock } = await openInboxMonitor();
    const staleTs = Math.floor(Date.now() / 1000) - 300;

    const upsert = {
      type: "append",
      messages: [
        {
          key: {
            id: "history1",
            fromMe: false,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: "old message" },
          messageTimestamp: staleTs,
          pushName: "History Sender",
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await vi.waitFor(
      () => {
        expect(sock.readMessages).toHaveBeenCalledWith([
          {
            remoteJid: "999@s.whatsapp.net",
            id: "history1",
            participant: undefined,
            fromMe: false,
          },
        ]);
      },
      { timeout: 5_000, interval: 5 },
    );

    // Verify it WAS NOT passed to onMessage
    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("normalizes participant phone numbers to JIDs in sendReaction", async () => {
    const { listener, sock } = await startInboxMonitor(vi.fn());

    await listener.sendReaction("12345@g.us", "msg123", "👍", false, "+6421000000");

    expect(sock.sendMessage).toHaveBeenCalledWith("12345@g.us", {
      react: {
        text: "👍",
        key: {
          remoteJid: "12345@g.us",
          id: "msg123",
          fromMe: false,
          participant: "6421000000@s.whatsapp.net",
        },
      },
    });

    await listener.close();
  });
});
