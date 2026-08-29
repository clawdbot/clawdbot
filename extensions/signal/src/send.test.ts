// Signal tests cover send plugin behavior.
import http from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signalRpcRequestMock = vi.hoisted(() => vi.fn());
const resolveOutboundAttachmentFromUrlMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({
    path: "/tmp/image.png",
    contentType: "image/png",
  })),
);
const filesToBase64DataUrisMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ["data:image/png;filename=image.png;base64,aGVsbG8="]),
);

vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

vi.mock("./client-container.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client-container.js")>()),
  filesToBase64DataUris: (...args: unknown[]) => filesToBase64DataUrisMock(...args),
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
    filesToBase64DataUrisMock.mockClear();
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

  it("preserves a group delivery when at least one member receives the message", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({
      timestamp: 1234567891,
      results: [{ type: "SUCCESS" }, { type: "UNREGISTERED_FAILURE" }],
    });

    await expect(
      sendMessageSignal("group:group-1", "hello", { cfg: SIGNAL_TEST_CFG }),
    ).resolves.toMatchObject({
      messageId: "1234567891",
      timestamp: 1234567891,
      receipt: { primaryPlatformMessageId: "1234567891" },
    });
    expect(signalRpcRequestMock).toHaveBeenCalledOnce();
  });

  it("rejects a group delivery when every member fails", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({
      timestamp: 1234567891,
      results: [{ type: "NETWORK_FAILURE" }, { type: "UNREGISTERED_FAILURE" }],
    });

    await expect(
      sendMessageSignal("group:group-1", "hello", { cfg: SIGNAL_TEST_CFG }),
    ).rejects.toThrow("Signal send failed for 2 recipients: NETWORK_FAILURE, UNREGISTERED_FAILURE");
    expect(signalRpcRequestMock).toHaveBeenCalledOnce();
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
    expect(filesToBase64DataUrisMock).toHaveBeenCalledWith(["/tmp/image.png"], maxBytes);
    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        attachments: ["data:image/png;filename=image.png;base64,aGVsbG8="],
        message: "",
      }),
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

  it("keeps prompt-looking bare text inert", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567896 });
    const text =
      "Exec approval required\nID: exec-bare\n\nReply with: /approve exec-bare allow-once|deny";
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

    await sendMessageSignal("+15551234567", text, { cfg });

    expect(signalRpcRequestMock.mock.calls[0]?.[1]).toMatchObject({ message: text });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551234567",
        messageId: "1234567896",
        reactionKey: "👍",
        targetAuthor: "+15550001111",
      }),
    ).resolves.toBeNull();
  });

  it.each([
    "Signal RPC -32602: quote rejected",
    'Signal RPC -32602: Unrecognized field "quoteTimestamp"',
    "Signal REST 400: quote metadata invalid",
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
    expect(filesToBase64DataUrisMock).toHaveBeenCalledWith(["/tmp/image.png"], expect.any(Number));
    expect(signalRpcRequestMock).toHaveBeenCalledTimes(2);
    expect(signalRpcRequestMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        attachments: ["data:image/png;filename=image.png;base64,aGVsbG8="],
        quoteTimestamp: 1700000000001,
        quoteAuthor: "+15550002222",
      }),
    );
    expect(signalRpcRequestMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        attachments: ["data:image/png;filename=image.png;base64,aGVsbG8="],
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

  it.each([
    "Signal HTTP timed out after 10000ms",
    "quote metadata not found after an unknown transport failure",
    "Signal RPC -32000: quote metadata was rejected after an ambiguous send",
  ])("does not retry an unconfirmed quote rejection: %s", async (message) => {
    signalRpcRequestMock.mockRejectedValueOnce(new Error(message));

    await expect(
      sendMessageSignal("+15551234567", "hello", {
        cfg: SIGNAL_TEST_CFG,
        replyToId: "1700000000001",
        replyToAuthor: "+15550002222",
        replyToBody: "original",
      }),
    ).rejects.toThrow(message);

    expect(signalRpcRequestMock).toHaveBeenCalledTimes(1);
  });
});

describe("Signal quoted-message provider replay safety", () => {
  it.each([
    { label: "HTTP 408", transportKind: "container", status: 408, fallback: false },
    { label: "HTTP 429", transportKind: "container", status: 429, fallback: false },
    { label: "HTTP 503", transportKind: "container", status: 503, fallback: false },
    { label: "HTTP 400", transportKind: "container", status: 400, fallback: true },
    { label: "RPC -32603", transportKind: "external-native", rpcCode: -32603, fallback: false },
    { label: "RPC -32602", transportKind: "external-native", rpcCode: -32602, fallback: true },
  ] as const)("replays a real $label request only after definitive rejection", async (testCase) => {
    const requests: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as Record<string, unknown>;
        requests.push(payload);
        if (requests.length === 1) {
          if (testCase.transportKind === "container") {
            response.writeHead(testCase.status, { "content-type": "text/plain" });
            response.end("quote storage not found during upstream outage");
          } else {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: payload.id,
                error: {
                  code: testCase.rpcCode,
                  message: "quote storage not found during upstream outage",
                },
              }),
            );
          }
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            testCase.transportKind === "container"
              ? { timestamp: 1700000000002 }
              : {
                  jsonrpc: "2.0",
                  id: payload.id,
                  result: { timestamp: 1700000000002 },
                },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as { port: number };
    const cfg = {
      channels: {
        signal: {
          accounts: {
            default: {
              account: "+15550001111",
              transport: { kind: testCase.transportKind, url: `http://127.0.0.1:${port}` },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    vi.doUnmock("./client-adapter.js");
    vi.resetModules();
    const { sendMessageSignal: sendWithRealContainer } = await import("./send.js");

    try {
      const delivery = sendWithRealContainer("+15551234567", "deliver only once", {
        cfg,
        textMode: "plain",
        replyToId: "1700000000001",
        replyToAuthor: "+15550002222",
        replyToBody: "original",
      });
      if (testCase.fallback) {
        await expect(delivery).resolves.toMatchObject({ messageId: "1700000000002" });
      } else {
        const expectedError =
          testCase.transportKind === "container"
            ? `Signal REST ${testCase.status}`
            : `Signal RPC ${testCase.rpcCode}`;
        await expect(delivery).rejects.toThrow(expectedError);
      }
      expect(requests).toHaveLength(testCase.fallback ? 2 : 1);
      const quoteTimestampPath =
        testCase.transportKind === "container" ? "quote_timestamp" : "params.quoteTimestamp";
      expect(requests[0]).toHaveProperty(quoteTimestampPath, 1700000000001);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});

describe("Signal native JSON-RPC recipient delivery", () => {
  it("rejects real per-recipient failures and preserves successful send receipts", async () => {
    const failureTypes = [
      "NETWORK_FAILURE",
      "UNREGISTERED_FAILURE",
      "IDENTITY_FAILURE",
      "RATE_LIMIT_FAILURE",
      "INVALID_PRE_KEY_FAILURE",
    ];
    const responses: Array<{
      timestamp: number;
      results?: Array<{ type?: string; success?: boolean; message?: string }>;
    }> = [
      ...failureTypes.map((type) => ({ timestamp: 1234567890, results: [{ type }] })),
      {
        timestamp: 1234567890,
        results: [{ success: false, message: "recipient is not registered" }],
      },
      {
        timestamp: 1234567891,
        results: [{ type: "SUCCESS" }, { type: "UNREGISTERED_FAILURE" }],
      },
      {
        timestamp: 1234567892,
        results: [{ type: "NETWORK_FAILURE" }, { type: "UNREGISTERED_FAILURE" }],
      },
      { timestamp: 1234567893, results: [{ type: "SUCCESS" }] },
      { timestamp: 1234567894 },
    ];
    const requests: Array<{
      method: string | undefined;
      path: string | undefined;
      contentType: string | undefined;
      jsonrpc: unknown;
      rpcMethod: unknown;
      account: unknown;
      recipient: unknown;
      groupId: unknown;
      message: unknown;
    }> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const envelope = JSON.parse(body) as {
          id?: string;
          jsonrpc?: string;
          method?: string;
          params?: {
            account?: string;
            recipient?: string[];
            groupId?: string;
            message?: string;
          };
        };
        requests.push({
          method: request.method,
          path: request.url,
          contentType: request.headers["content-type"],
          jsonrpc: envelope.jsonrpc,
          rpcMethod: envelope.method,
          account: envelope.params?.account,
          recipient: envelope.params?.recipient,
          groupId: envelope.params?.groupId,
          message: envelope.params?.message,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: envelope.id,
            result: responses.shift(),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as { port: number };
    const cfg = {
      channels: {
        signal: {
          accounts: {
            default: {
              transport: {
                kind: "external-native",
                url: `http://127.0.0.1:${port}`,
              },
              account: "+15550001111",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    signalRpcRequestMock.mockClear();
    vi.doUnmock("./client-adapter.js");
    vi.resetModules();
    const { sendMessageSignal: sendMessageSignalWithRealRpc } = await import("./send.js");

    try {
      for (const failureType of failureTypes) {
        await expect(
          sendMessageSignalWithRealRpc("+15551234567", "hello over real rpc", { cfg }),
        ).rejects.toThrow(`Signal send failed for 1 recipient: ${failureType}`);
      }
      await expect(
        sendMessageSignalWithRealRpc("+15551234567", "hello over real rpc", { cfg }),
      ).rejects.toThrow("Signal send failed for 1 recipient: recipient is not registered");

      await expect(
        sendMessageSignalWithRealRpc("group:group-1", "hello over real rpc", { cfg }),
      ).resolves.toMatchObject({
        messageId: "1234567891",
        timestamp: 1234567891,
        receipt: { primaryPlatformMessageId: "1234567891" },
      });
      await expect(
        sendMessageSignalWithRealRpc("group:group-1", "hello over real rpc", { cfg }),
      ).rejects.toThrow(
        "Signal send failed for 2 recipients: NETWORK_FAILURE, UNREGISTERED_FAILURE",
      );

      await expect(
        sendMessageSignalWithRealRpc("+15551234567", "hello over real rpc", { cfg }),
      ).resolves.toMatchObject({
        messageId: "1234567893",
        timestamp: 1234567893,
        receipt: { primaryPlatformMessageId: "1234567893" },
      });
      await expect(
        sendMessageSignalWithRealRpc("+15551234567", "hello over real rpc", { cfg }),
      ).resolves.toMatchObject({
        messageId: "1234567894",
        timestamp: 1234567894,
        receipt: { primaryPlatformMessageId: "1234567894" },
      });

      expect(signalRpcRequestMock).not.toHaveBeenCalled();
      const expectedBaseRequest = {
        method: "POST",
        path: "/api/v1/rpc",
        contentType: "application/json",
        jsonrpc: "2.0",
        rpcMethod: "send",
        account: "+15550001111",
        message: "hello over real rpc",
      };
      const expectedDirectRequest = {
        ...expectedBaseRequest,
        recipient: ["+15551234567"],
        groupId: undefined,
      };
      const expectedGroupRequest = {
        ...expectedBaseRequest,
        recipient: undefined,
        groupId: "group-1",
      };
      expect(requests).toEqual([
        ...Array.from({ length: 6 }, () => expectedDirectRequest),
        expectedGroupRequest,
        expectedGroupRequest,
        expectedDirectRequest,
        expectedDirectRequest,
      ]);
      expect(responses).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
