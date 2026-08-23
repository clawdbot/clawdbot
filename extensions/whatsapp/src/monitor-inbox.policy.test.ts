// WhatsApp monitor inbox policy behavior.
import { describe, expect, it, vi } from "vitest";
import type { WebInboundMessage } from "./inbound/types.js";
import {
  DEFAULT_ACCOUNT_ID,
  expectPairingPromptSent,
  getAuthDir,
  getMonitorWebInbox,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  settleInboundWork,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";

const nowSeconds = (offsetMs = 0) => Math.floor((Date.now() + offsetMs) / 1000);
const DEFAULT_MESSAGES_CFG = {
  messagePrefix: undefined,
  responsePrefix: undefined,
} as const;
const TIMESTAMP_OFF_MESSAGES_CFG = {
  ...DEFAULT_MESSAGES_CFG,
  timestampPrefix: false,
} as const;

const createNotifyUpsert = (message: Record<string, unknown>) => ({
  type: "notify",
  messages: [message],
});

const createDmMessage = (params: { id: string; remoteJid: string; conversation: string }) => ({
  key: {
    id: params.id,
    fromMe: false,
    remoteJid: params.remoteJid,
  },
  message: { conversation: params.conversation },
  messageTimestamp: nowSeconds(),
});

const createGroupMessage = (params: {
  id: string;
  remoteJid?: string;
  participant: string;
  conversation: string;
}) => ({
  key: {
    id: params.id,
    fromMe: false,
    remoteJid: params.remoteJid ?? "11111@g.us",
    participant: params.participant,
  },
  message: { conversation: params.conversation },
  messageTimestamp: nowSeconds(),
});

async function startWebInboxMonitor(params: {
  config?: Record<string, unknown>;
  loadConfig?: () => Record<string, unknown>;
  sendReadReceipts?: boolean;
}) {
  const monitorWebInbox = getMonitorWebInbox();
  if (params.config) {
    mockLoadConfig.mockReturnValue(params.config);
  }
  const onMessage = vi.fn();
  const base = {
    cfg: (params.config ?? mockLoadConfig()) as never,
    ...(params.loadConfig ? { loadConfig: params.loadConfig as never } : {}),
    verbose: false,
    accountId: DEFAULT_ACCOUNT_ID,
    authDir: getAuthDir(),
    onMessage,
  };
  const listener = await monitorWebInbox(
    params.sendReadReceipts === undefined
      ? base
      : {
          ...base,
          sendReadReceipts: params.sendReadReceipts,
        },
  );
  return { onMessage, listener, sock: getSock() };
}

function firstInboundPayload(onMessage: ReturnType<typeof vi.fn>) {
  const payload = onMessage.mock.calls[0]?.[0];
  if (!payload || typeof payload !== "object") {
    throw new Error("expected first inbound payload");
  }
  return payload as WebInboundMessage;
}

describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  it("delivery coordinator blocks unauthorized senders outside allowFrom", async () => {
    // Test for auto-recovery fix: early allowFrom filtering prevents Bad MAC errors
    // from unauthorized senders corrupting sessions
    const config = {
      channels: {
        whatsapp: {
          // Only allow +111
          allowFrom: ["+111"],
        },
      },
      messages: DEFAULT_MESSAGES_CFG,
    };

    const { onMessage, listener, sock } = await startWebInboxMonitor({
      config,
    });

    // Message from unauthorized sender +999 (not in allowFrom)
    sock.ev.emit(
      "messages.upsert",
      createNotifyUpsert(
        createDmMessage({
          id: "unauth1",
          remoteJid: "999@s.whatsapp.net",
          conversation: "unauthorized message",
        }),
      ),
    );
    await vi.waitFor(() => expectPairingPromptSent(sock, "999@s.whatsapp.net", "+999"));

    // Should NOT call onMessage for unauthorized senders
    expect(onMessage).not.toHaveBeenCalled();
    // Should NOT send read receipts for blocked senders (privacy + avoids Baileys Bad MAC churn).
    expect(sock.readMessages).not.toHaveBeenCalled();

    await listener.close();
  });

  it("delivery coordinator applies hot-reloaded dmPolicy to the active listener", async () => {
    const startupConfig = {
      channels: {
        whatsapp: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
      messages: DEFAULT_MESSAGES_CFG,
    };
    const reloadedConfig = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+111"],
        },
      },
      messages: DEFAULT_MESSAGES_CFG,
    };
    mockLoadConfig.mockReturnValue(startupConfig);

    const { onMessage, listener, sock } = await startWebInboxMonitor({
      config: startupConfig,
      loadConfig: () => mockLoadConfig() as Record<string, unknown>,
    });
    mockLoadConfig.mockReturnValue(reloadedConfig);

    sock.ev.emit(
      "messages.upsert",
      createNotifyUpsert(
        createDmMessage({
          id: "hot-reload-block",
          remoteJid: "999@s.whatsapp.net",
          conversation: "should be blocked after reload",
        }),
      ),
    );
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(sock.readMessages).not.toHaveBeenCalled();

    await listener.close();
  });

  it("delivery coordinator skips read receipts in self-chat mode", async () => {
    const config = {
      channels: {
        whatsapp: {
          // Self-chat heuristic: allowFrom includes selfE164 (+123).
          allowFrom: ["+123"],
        },
      },
      messages: DEFAULT_MESSAGES_CFG,
    };

    const { onMessage, listener, sock } = await startWebInboxMonitor({
      config,
    });

    sock.ev.emit(
      "messages.upsert",
      createNotifyUpsert(
        createDmMessage({
          id: "self1",
          remoteJid: "123@s.whatsapp.net",
          conversation: "self ping",
        }),
      ),
    );
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        admission: expect.objectContaining({
          conversation: expect.objectContaining({
            id: "+123",
          }),
          ingress: expect.objectContaining({
            decision: "allow",
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
    expect(sock.readMessages).not.toHaveBeenCalled();

    await listener.close();
  });

  it("delivery coordinator skips read receipts when disabled", async () => {
    const { onMessage, listener, sock } = await startWebInboxMonitor({
      sendReadReceipts: false,
    });
    sock.ev.emit(
      "messages.upsert",
      createNotifyUpsert(
        createDmMessage({
          id: "rr-off-1",
          remoteJid: "222@s.whatsapp.net",
          conversation: "read receipts off",
        }),
      ),
    );
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(sock.readMessages).not.toHaveBeenCalled();

    await listener.close();
  });

  it.each([
    {
      name: "lets group messages through even when sender not in allowFrom",
      id: "grp3",
      groupPolicy: "open",
      messages: DEFAULT_MESSAGES_CFG,
      allowFrom: ["+1234"],
      groupAllowFrom: undefined,
      participant: "999@s.whatsapp.net",
      remoteJid: undefined,
      conversation: "unauthorized group message",
      expectedCalls: 1,
      expectedSender: "+999",
    },
    {
      name: "blocks all group messages when groupPolicy is 'disabled'",
      id: "grp-disabled",
      groupPolicy: "disabled",
      messages: TIMESTAMP_OFF_MESSAGES_CFG,
      allowFrom: ["+1234"],
      groupAllowFrom: undefined,
      participant: "999@s.whatsapp.net",
      remoteJid: undefined,
      conversation: "group message should be blocked",
      expectedCalls: 0,
      expectedSender: undefined,
    },
    {
      name: "blocks group messages from senders not in groupAllowFrom when groupPolicy is 'allowlist'",
      id: "grp-allowlist-blocked",
      groupPolicy: "allowlist",
      messages: TIMESTAMP_OFF_MESSAGES_CFG,
      allowFrom: undefined,
      groupAllowFrom: ["+1234"],
      participant: "999@s.whatsapp.net",
      remoteJid: undefined,
      conversation: "unauthorized group sender",
      expectedCalls: 0,
      expectedSender: undefined,
    },
    {
      name: "allows group messages from senders in groupAllowFrom when groupPolicy is 'allowlist'",
      id: "grp-allowlist-allowed",
      groupPolicy: "allowlist",
      messages: TIMESTAMP_OFF_MESSAGES_CFG,
      allowFrom: undefined,
      groupAllowFrom: ["+15551234567"],
      participant: "15551234567@s.whatsapp.net",
      remoteJid: undefined,
      conversation: "authorized group sender",
      expectedCalls: 1,
      expectedSender: "+15551234567",
    },
    {
      name: "allows all group senders with wildcard in groupPolicy allowlist",
      id: "grp-wildcard-test",
      groupPolicy: "allowlist",
      messages: TIMESTAMP_OFF_MESSAGES_CFG,
      allowFrom: undefined,
      groupAllowFrom: ["*"],
      participant: "9999999999@s.whatsapp.net",
      remoteJid: "22222@g.us",
      conversation: "wildcard group sender",
      expectedCalls: 1,
      expectedSender: undefined,
    },
    {
      name: "blocks group messages when groupPolicy allowlist has no groupAllowFrom",
      id: "grp-allowlist-empty",
      groupPolicy: "allowlist",
      messages: TIMESTAMP_OFF_MESSAGES_CFG,
      allowFrom: undefined,
      groupAllowFrom: undefined,
      participant: "999@s.whatsapp.net",
      remoteJid: undefined,
      conversation: "blocked by empty allowlist",
      expectedCalls: 0,
      expectedSender: undefined,
    },
  ] as const)(
    "$name",
    async ({
      id,
      groupPolicy,
      messages,
      allowFrom,
      groupAllowFrom,
      participant,
      remoteJid,
      conversation,
      expectedCalls,
      expectedSender,
    }) => {
      const { onMessage, listener, sock } = await startWebInboxMonitor({
        config: {
          channels: {
            whatsapp: {
              groupPolicy,
              ...(allowFrom ? { allowFrom: [...allowFrom] } : {}),
              ...(groupAllowFrom ? { groupAllowFrom: [...groupAllowFrom] } : {}),
            },
          },
          messages,
        },
      });
      sock.ev.emit(
        "messages.upsert",
        createNotifyUpsert(
          createGroupMessage({
            id,
            ...(remoteJid ? { remoteJid } : {}),
            participant,
            conversation,
          }),
        ),
      );
      await settleInboundWork();

      expect(onMessage).toHaveBeenCalledTimes(expectedCalls);
      if (expectedCalls === 1) {
        const payload = firstInboundPayload(onMessage);
        expect(payload.admission?.conversation.kind).toBe("group");
        if (expectedSender) {
          expect(payload.platform.senderE164).toBe(expectedSender);
        }
      }
      await listener.close();
    },
  );
});
