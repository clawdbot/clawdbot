import "./monitor-inbox.test-harness.js";
import { describe, expect, it, vi } from "vitest";
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
        body: "authorized message",
        from: "+999",
        senderE164: "+999",
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
      expect.objectContaining({ body: "self message", from: "+123" }),
    );

    await listener.close();
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
        body: "self ping",
        from: "+123",
        to: "+123",
      }),
    );

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
        },
      },
      messages: DEFAULT_MESSAGES_CFG,
    });

    const { onMessage, listener, sock } = await openInboxMonitor();

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            id: "owner-group-1",
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
        body: "/status",
        chatType: "group",
        from: "120363@g.us",
        fromMe: true,
        senderE164: "+123",
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
