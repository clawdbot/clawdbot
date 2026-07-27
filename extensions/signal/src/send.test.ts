// Signal tests cover send plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signalRpcRequestMock = vi.hoisted(() => vi.fn());
const resolveOutboundAttachmentFromUrlMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({
    path: "/tmp/image.png",
    contentType: "image/png",
  })),
);

vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    resolveOutboundAttachmentFromUrl: (...args: unknown[]) =>
      resolveOutboundAttachmentFromUrlMock(...args),
  };
});

const {
  clearSignalApprovalReactionTargetsForTest,
  resolveSignalApprovalReactionTargetWithPersistence,
} = await import("./approval-reactions.js");
const { sendMessageSignal, sendReadReceiptSignal, sendTypingSignal } = await import("./send.js");

const SIGNAL_TEST_CFG = {
  channels: {
    signal: {
      accounts: {
        default: {
          transport: { kind: "external-native", url: "http://signal.test" },
          account: "+15550001111",
        },
      },
    },
  },
} satisfies OpenClawConfig;

describe("sendMessageSignal receipts", () => {
  beforeEach(() => {
    clearSignalApprovalReactionTargetsForTest();
    signalRpcRequestMock.mockReset();
    resolveOutboundAttachmentFromUrlMock.mockClear();
  });

  it("routes a named container account across send, typing, and receipt RPCs", async () => {
    signalRpcRequestMock.mockResolvedValue({ timestamp: 1234567890 });
    const cfg = {
      channels: {
        signal: {
          accounts: {
            work: {
              account: "+15550001111",
              transport: { kind: "container" as const, url: "http://container:8080" },
            },
          },
        },
      },
    };

    await sendMessageSignal("+15551234567", "hello", { cfg, accountId: "work" });
    await sendTypingSignal("+15551234567", { cfg, accountId: "work" });
    await sendReadReceiptSignal("+15551234567", 1234567890, { cfg, accountId: "work" });

    expect(signalRpcRequestMock).toHaveBeenCalledTimes(3);
    for (const call of signalRpcRequestMock.mock.calls) {
      expect(call[2]).toMatchObject({
        baseUrl: "http://container:8080",
        transportKind: "container",
      });
    }
  });

  it("attaches a text receipt for timestamp results", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({
      timestamp: 1234567890,
      results: [{ type: "SUCCESS" }],
    });

    const result = await sendMessageSignal("+15551234567", "hello", {
      cfg: SIGNAL_TEST_CFG,
    });

    expect(result.messageId).toBe("1234567890");
    expect(result.timestamp).toBe(1234567890);
    expect(result.receipt.primaryPlatformMessageId).toBe("1234567890");
    expect(result.receipt.platformMessageIds).toEqual(["1234567890"]);
    expect(result.receipt.raw).toEqual([
      {
        channel: "signal",
        messageId: "1234567890",
        toJid: "+15551234567",
        timestamp: 1234567890,
        meta: { targetType: "recipient" },
      },
    ]);
    expect(result.receipt.parts).toEqual([
      {
        index: 0,
        platformMessageId: "1234567890",
        kind: "text",
        raw: {
          channel: "signal",
          messageId: "1234567890",
          toJid: "+15551234567",
          timestamp: 1234567890,
          meta: { targetType: "recipient" },
        },
      },
    ]);
    expect(result.receipt.sentAt).toBeGreaterThan(0);
  });

  it("rejects per-recipient failures even when signal-cli returns a timestamp", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({
      timestamp: 1234567890,
      results: [{ type: "UNREGISTERED_FAILURE" }],
    });

    await expect(
      sendMessageSignal("+15551234567", "hello", {
        cfg: SIGNAL_TEST_CFG,
      }),
    ).rejects.toThrow("Signal send failed for 1 recipient: UNREGISTERED_FAILURE");
  });

  it("rejects legacy per-recipient success false results", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({
      timestamp: 1234567890,
      results: [{ success: false, message: "recipient is not registered" }],
    });

    await expect(
      sendMessageSignal("+15551234567", "hello", {
        cfg: SIGNAL_TEST_CFG,
      }),
    ).rejects.toThrow("Signal send failed for 1 recipient: recipient is not registered");
  });

  it.each(["username:alice.42", "u:alice.42", "signal:u:ALICE.42"])(
    "sends %s through the canonical username parameter",
    async (target) => {
      signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567890 });

      await sendMessageSignal(target, "hello", { cfg: SIGNAL_TEST_CFG });

      expect(signalRpcRequestMock).toHaveBeenCalledWith(
        "send",
        expect.objectContaining({ username: ["alice.42"] }),
        expect.any(Object),
      );
    },
  );

  it("attaches a media receipt for attachment sends", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567891 });
    const maxBytes = 12 * 1024 * 1024;

    const result = await sendMessageSignal("group:group-1", "", {
      cfg: SIGNAL_TEST_CFG,
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp"],
      maxBytes,
    });

    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalledWith(
      "/tmp/image.png",
      maxBytes,
      expect.objectContaining({ localRoots: ["/tmp"] }),
    );
    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ attachments: ["/tmp/image.png"], message: "" }),
      expect.objectContaining({ maxAttachmentBytes: maxBytes }),
    );
    expect(result.messageId).toBe("1234567891");
    expect(result.timestamp).toBe(1234567891);
    expect(result.receipt.primaryPlatformMessageId).toBe("1234567891");
    expect(result.receipt.platformMessageIds).toEqual(["1234567891"]);
    expect(result.receipt.raw).toEqual([
      {
        channel: "signal",
        messageId: "1234567891",
        chatId: "group-1",
        timestamp: 1234567891,
        meta: { targetType: "group" },
      },
    ]);
    expect(result.receipt.parts).toEqual([
      {
        index: 0,
        platformMessageId: "1234567891",
        kind: "media",
        raw: {
          channel: "signal",
          messageId: "1234567891",
          chatId: "group-1",
          timestamp: 1234567891,
          meta: { targetType: "group" },
        },
      },
    ]);
    expect(result.receipt.sentAt).toBeGreaterThan(0);
  });

  it("does not invent platform ids when signal-cli omits a timestamp", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({});

    const result = await sendMessageSignal("+15551234567", "hello", {
      cfg: SIGNAL_TEST_CFG,
    });

    expect(result.messageId).toBe("unknown");
    expect(result.receipt.platformMessageIds).toStrictEqual([]);
  });

  it("does not add approval reactions to ordinary outbound approval-looking text", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567892 });
    const text = [
      "Here is the command you asked about:",
      "/approve exec-live-approval allow-once|deny",
    ].join("\n");

    await sendMessageSignal("+15551234567", text, {
      cfg: {
        ...SIGNAL_TEST_CFG,
        channels: {
          signal: {
            ...SIGNAL_TEST_CFG.channels.signal,
            allowFrom: ["+15551234567"],
          },
        },
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "signal", to: "+15551234567" }],
          },
        },
      },
    });

    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ message: text }),
      expect.any(Object),
    );
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551234567",
        messageId: "1234567892",
        reactionKey: "👍",
        targetAuthor: "+15550001111",
      }),
    ).resolves.toBeNull();
  });

  it("does not add approval reactions to ordinary outbound text quoting a full prompt", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567893 });
    const text = [
      "The docs show this example:",
      "Exec approval required",
      "ID: exec-live-approval",
      "",
      "Reply with: /approve exec-live-approval allow-once|deny",
    ].join("\n");

    await sendMessageSignal("+15551234567", text, {
      cfg: {
        ...SIGNAL_TEST_CFG,
        channels: {
          signal: {
            ...SIGNAL_TEST_CFG.channels.signal,
            allowFrom: ["+15551234567"],
          },
        },
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "signal", to: "+15551234567" }],
          },
        },
      },
    });

    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ message: text }),
      expect.any(Object),
    );
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551234567",
        messageId: "1234567893",
        reactionKey: "👍",
        targetAuthor: "+15550001111",
      }),
    ).resolves.toBeNull();
  });

  it("does not register ordinary outbound text that includes approval reaction snippets", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567894 });
    const text = [
      "The docs show this example:",
      "Exec approval required",
      "ID: exec-live-approval",
      "",
      "React with:",
      "👍 allow once",
      "👎 deny",
      "",
      "Reply with: /approve exec-live-approval allow-once|deny",
    ].join("\n");

    await sendMessageSignal("+15551234567", text, {
      cfg: {
        ...SIGNAL_TEST_CFG,
        channels: {
          signal: {
            ...SIGNAL_TEST_CFG.channels.signal,
            allowFrom: ["+15551234567"],
          },
        },
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "signal", to: "+15551234567" }],
          },
        },
      },
    });

    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ message: text }),
      expect.any(Object),
    );
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551234567",
        messageId: "1234567894",
        reactionKey: "👍",
        targetAuthor: "+15550001111",
      }),
    ).resolves.toBeNull();
  });

  it("passes native quote metadata when replying to a Signal timestamp", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567892 });

    const result = await sendMessageSignal("+15551234567", "hello", {
      cfg: SIGNAL_TEST_CFG,
      replyToId: "1700000000001",
      replyToAuthor: "+15550002222",
      replyToBody: "original",
    });

    expect(signalRpcRequestMock).toHaveBeenCalledTimes(1);
    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        quoteTimestamp: 1700000000001,
        quoteAuthor: "+15550002222",
        quoteMessage: "original",
      }),
      expect.any(Object),
    );
    expect(result.receipt.replyToId).toBe("1700000000001");
    expect(result.receipt.parts[0]?.replyToId).toBe("1700000000001");
    expect(result.receipt.raw?.[0]?.meta).toEqual({
      targetType: "recipient",
      replyToId: "1700000000001",
      nativeReplyStatus: "sent",
    });
  });

  it("does not add approval reaction hints without explicit approvers", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567895 });
    const text =
      "Exec approval required\nID: exec-live-approval\n\nReply with: /approve exec-live-approval allow-once|deny";

    await sendMessageSignal("+15551234567", text, {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                transport: { kind: "external-native" as const, url: "http://signal.test" },
                account: "+15550001111",
              },
            },
          },
        },
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "signal", to: "+15551234567" }],
          },
        },
      },
    });

    expect(signalRpcRequestMock.mock.calls[0]?.[1]).toMatchObject({ message: text });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551234567",
        messageId: "1234567895",
        reactionKey: "👍",
        targetAuthor: "+15550001111",
      }),
    ).resolves.toBeNull();
  });

  it("adds reaction approval hints for non-presentation approval payload text", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567896 });

    const cfg = {
      channels: {
        signal: {
          accounts: {
            default: {
              transport: { kind: "external-native" as const, url: "http://signal.test" },
              account: "+15550001111",
              allowFrom: ["+15551234567"],
            },
          },
        },
      },
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets" as const,
          targets: [{ channel: "signal", to: "+15551234567" }],
        },
      },
    };

    await sendMessageSignal(
      "+15551234567",
      "Plugin approval required\nID: plugin:abc\n\nReply with: /approve plugin:abc allow-once|deny",
      { cfg },
    );

    expect(signalRpcRequestMock.mock.calls[0]?.[1]).toMatchObject({
      message: expect.stringContaining("React with:\n\n👍 Allow Once\n👎 Deny"),
    });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551234567",
        messageId: "1234567896",
        reactionKey: "👍",
        targetAuthor: "+15550001111",
      }),
    ).resolves.toMatchObject({
      approvalId: "plugin:abc",
      approvalKind: "plugin",
      decision: "allow-once",
    });
  });

  it("keeps standalone plugin approval prompts on plugin reaction config without a plugin-prefixed id", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567897 });

    const cfg = {
      channels: {
        signal: {
          accounts: {
            default: {
              transport: { kind: "external-native" as const, url: "http://signal.test" },
              account: "+15550001111",
              allowFrom: ["+15551234567"],
            },
          },
        },
      },
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets" as const,
          targets: [{ channel: "signal", to: "+15551234567" }],
        },
      },
    };

    await sendMessageSignal(
      "+15551234567",
      "Plugin approval required\nID: abc\n\nReply with: /approve abc allow-once|deny",
      { cfg },
    );

    expect(signalRpcRequestMock.mock.calls[0]?.[1]).toMatchObject({
      message: expect.stringContaining("React with:\n\n👍 Allow Once\n👎 Deny"),
    });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551234567",
        messageId: "1234567897",
        reactionKey: "👍",
        targetAuthor: "+15550001111",
      }),
    ).resolves.toMatchObject({
      approvalId: "abc",
      approvalKind: "plugin",
      decision: "allow-once",
    });
  });

  it.each([
    {
      name: "exec",
      approvalKind: "exec",
      text: "🔒 Exec approval required\nID: exec:abc\n\nReply with: /approve exec:abc allow-once|deny",
      approvalId: "exec:abc",
    },
    {
      name: "plugin",
      approvalKind: "plugin",
      text: "🛡️ Plugin approval required\nID: plugin:abc\n\nReply with: /approve plugin:abc allow-once|deny",
      approvalId: "plugin:abc",
    },
  ])("adds reaction approval hints for icon-prefixed $name approval text", async (testCase) => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567898 });

    const cfg = {
      channels: {
        signal: {
          accounts: {
            default: {
              transport: { kind: "external-native" as const, url: "http://signal.test" },
              account: "+15550001111",
              allowFrom: ["+15551234567"],
            },
          },
        },
      },
      approvals: {
        [testCase.approvalKind]: {
          enabled: true,
          mode: "targets" as const,
          targets: [{ channel: "signal", to: "+15551234567" }],
        },
      },
    };

    await sendMessageSignal("+15551234567", testCase.text, { cfg });

    expect(signalRpcRequestMock.mock.calls[0]?.[1]).toMatchObject({
      message: expect.stringContaining("React with:\n\n👍 Allow Once\n👎 Deny"),
    });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551234567",
        messageId: "1234567898",
        reactionKey: "👍",
        targetAuthor: "+15550001111",
      }),
    ).resolves.toMatchObject({
      approvalId: testCase.approvalId,
      approvalKind: testCase.approvalKind,
      decision: "allow-once",
    });
  });

  it("binds approval reactions to the canonical prompt id", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567898 });

    const cfg = {
      channels: {
        signal: {
          accounts: {
            default: {
              transport: { kind: "external-native" as const, url: "http://signal.test" },
              account: "+15550001111",
              allowFrom: ["+15551234567"],
            },
          },
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets" as const,
          targets: [{ channel: "signal", to: "+15551234567" }],
        },
      },
    };
    const text = [
      "Exec approval required",
      "ID: exec-real",
      "Command: printf '/approve fake allow-once'",
      "",
      "Reply with: /approve exec-real allow-once|deny",
    ].join("\n");

    await sendMessageSignal("+15551234567", text, { cfg });

    expect(signalRpcRequestMock.mock.calls[0]?.[1]).toMatchObject({
      message: expect.stringContaining("React with:\n\n👍 Allow Once\n👎 Deny"),
    });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551234567",
        messageId: "1234567898",
        reactionKey: "👍",
        targetAuthor: "+15550001111",
      }),
    ).resolves.toMatchObject({
      approvalId: "exec-real",
      approvalKind: "exec",
      decision: "allow-once",
    });
  });

  it("adds reaction approval hints for non-presentation approval text with UUID-only accounts", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567899 });

    const cfg = {
      channels: {
        signal: {
          accounts: {
            default: {
              transport: { kind: "external-native" as const, url: "http://signal.test" },
              accountUuid: "123e4567-e89b-12d3-a456-426614174000",
              allowFrom: ["+15551234567"],
            },
          },
        },
      },
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets" as const,
          targets: [{ channel: "signal", to: "+15551234567" }],
        },
      },
    };

    await sendMessageSignal(
      "+15551234567",
      "Plugin approval required\nID: plugin:abc\n\nReply with: /approve plugin:abc allow-once|deny",
      { cfg },
    );

    expect(signalRpcRequestMock.mock.calls[0]?.[1]).toMatchObject({
      message: expect.stringContaining("React with:\n\n👍 Allow Once\n👎 Deny"),
    });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551234567",
        messageId: "1234567899",
        reactionKey: "👍",
        targetAuthorUuid: "123e4567-e89b-12d3-a456-426614174000",
      }),
    ).resolves.toMatchObject({
      approvalId: "plugin:abc",
      approvalKind: "plugin",
      decision: "allow-once",
    });
  });

  it.each([
    "Signal RPC -32602: quote rejected",
    'Signal RPC -32602: Unrecognized field "quoteTimestamp"',
  ])("falls back to an ordinary send when native quote metadata fails: %s", async (message) => {
    signalRpcRequestMock
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValueOnce({ timestamp: 1234567893 });

    const result = await sendMessageSignal("+15551234567", "hello", {
      cfg: SIGNAL_TEST_CFG,
      replyToId: "1700000000001",
      replyToAuthor: "+15550002222",
      replyToBody: "original",
    });

    expect(signalRpcRequestMock).toHaveBeenCalledTimes(2);
    expect(signalRpcRequestMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        quoteTimestamp: 1700000000001,
        quoteAuthor: "+15550002222",
      }),
    );
    expect(signalRpcRequestMock.mock.calls[1]?.[1]).not.toHaveProperty("quoteTimestamp");
    expect(signalRpcRequestMock.mock.calls[1]?.[1]).not.toHaveProperty("quoteAuthor");
    expect(signalRpcRequestMock.mock.calls[1]?.[1]).not.toHaveProperty("quoteMessage");
    expect(result.messageId).toBe("1234567893");
    expect(result.receipt.replyToId).toBe("1700000000001");
    expect(result.receipt.parts[0]?.replyToId).toBe("1700000000001");
    expect(result.receipt.raw?.[0]?.meta).toEqual({
      targetType: "recipient",
      replyToId: "1700000000001",
      nativeReplyStatus: "fallback",
    });
  });

  it("keeps media sends when native quote metadata is rejected", async () => {
    signalRpcRequestMock
      .mockRejectedValueOnce(new Error("Signal RPC -32602: quote invalid"))
      .mockResolvedValueOnce({ timestamp: 1234567894 });

    const result = await sendMessageSignal("+15551234567", "caption", {
      cfg: SIGNAL_TEST_CFG,
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp"],
      replyToId: "1700000000001",
      replyToAuthor: "+15550002222",
      replyToBody: "original",
    });

    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalled();
    expect(signalRpcRequestMock).toHaveBeenCalledTimes(2);
    expect(signalRpcRequestMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        attachments: ["/tmp/image.png"],
        quoteTimestamp: 1700000000001,
        quoteAuthor: "+15550002222",
      }),
    );
    expect(signalRpcRequestMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        attachments: ["/tmp/image.png"],
        message: "caption",
      }),
    );
    expect(signalRpcRequestMock.mock.calls[1]?.[1]).not.toHaveProperty("quoteTimestamp");
    expect(result.messageId).toBe("1234567894");
    expect(result.receipt.parts[0]?.kind).toBe("media");
    expect(result.receipt.raw?.[0]?.meta).toEqual({
      targetType: "recipient",
      replyToId: "1700000000001",
      nativeReplyStatus: "fallback",
    });
  });

  it("does not retry ordinary send failures as quote fallback", async () => {
    signalRpcRequestMock.mockRejectedValueOnce(new Error("Signal HTTP timed out after 10000ms"));

    await expect(
      sendMessageSignal("+15551234567", "hello", {
        cfg: SIGNAL_TEST_CFG,
        replyToId: "1700000000001",
        replyToAuthor: "+15550002222",
        replyToBody: "original",
      }),
    ).rejects.toThrow("Signal HTTP timed out");

    expect(signalRpcRequestMock).toHaveBeenCalledTimes(1);
  });
});
