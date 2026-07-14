// Nextcloud Talk tests cover send.cfg threading plugin behavior.
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import {
  createSendCfgThreadingRuntime,
  expectProvidedCfgSkipsRuntimeLoad,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig as CoreConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveMarkdownTableMode: vi.fn(() => "preserve"),
  convertMarkdownTables: vi.fn((text: string) => text),
  record: vi.fn(),
  resolveNextcloudTalkAccount: vi.fn(),
  ssrfPolicyFromPrivateNetworkOptIn: vi.fn(() => undefined),
  generateNextcloudTalkSignature: vi.fn(() => ({
    random: "r",
    signature: "s",
  })),
  mockFetchGuard: vi.fn(),
}));

vi.mock("./send.runtime.js", () => {
  return {
    convertMarkdownTables: hoisted.convertMarkdownTables,
    fetchWithSsrFGuard: hoisted.mockFetchGuard,
    generateNextcloudTalkSignature: hoisted.generateNextcloudTalkSignature,
    getNextcloudTalkRuntime: () => createSendCfgThreadingRuntime(hoisted),
    requireRuntimeConfig: (cfg: unknown, context: string) => {
      if (cfg) {
        return cfg;
      }
      throw new Error(`${context} requires a resolved runtime config`);
    },
    resolveNextcloudTalkAccount: hoisted.resolveNextcloudTalkAccount,
    resolveMarkdownTableMode: hoisted.resolveMarkdownTableMode,
    ssrfPolicyFromPrivateNetworkOptIn: hoisted.ssrfPolicyFromPrivateNetworkOptIn,
  };
});

const { nextcloudTalkMessageAdapter } = await import("./message-adapter.js");
const { sendMessageNextcloudTalk, sendReactionNextcloudTalk } = await import("./send.js");

function expectProvidedMessageCfgThreading(cfg: unknown): void {
  expectProvidedCfgSkipsRuntimeLoad({
    loadConfig: hoisted.loadConfig,
    resolveAccount: hoisted.resolveNextcloudTalkAccount,
    cfg,
    accountId: "work",
  });
  expect(hoisted.resolveMarkdownTableMode).toHaveBeenCalledWith({
    cfg,
    channel: "nextcloud-talk",
    accountId: "default",
  });
  expect(hoisted.convertMarkdownTables).toHaveBeenCalledWith("hello", "preserve");
}

describe("nextcloud-talk send cfg threading", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const fixedSentAt = 1_800_000_000_000;
  const defaultAccount = {
    accountId: "default",
    baseUrl: "https://nextcloud.example.com",
    secret: "secret-value",
  };

  function mockNextcloudMessageResponse(messageId: number, timestamp: number): void {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ocs: { data: { id: messageId, timestamp } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }

  beforeEach(() => {
    vi.setSystemTime(fixedSentAt);
    vi.stubGlobal("fetch", fetchMock);
    // Route the SSRF guard mock through the global fetch mock.
    hoisted.mockFetchGuard.mockImplementation(async (p: { url: string; init?: RequestInit }) => {
      const response = await globalThis.fetch(p.url, p.init);
      return { response, release: async () => {}, finalUrl: p.url };
    });
    hoisted.loadConfig.mockReset();
    hoisted.resolveMarkdownTableMode.mockClear();
    hoisted.convertMarkdownTables.mockClear();
    hoisted.record.mockReset();
    hoisted.ssrfPolicyFromPrivateNetworkOptIn.mockClear();
    hoisted.generateNextcloudTalkSignature.mockClear();
    hoisted.resolveNextcloudTalkAccount.mockReset();
    hoisted.resolveNextcloudTalkAccount.mockReturnValue(defaultAccount);
  });

  afterEach(() => {
    fetchMock.mockReset();
    hoisted.mockFetchGuard.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses provided cfg for sendMessage and skips runtime loadConfig", async () => {
    const cfg = { source: "provided" } as const;
    mockNextcloudMessageResponse(12345, 1_706_000_000);

    const result = await sendMessageNextcloudTalk("room:abc123", "hello", {
      cfg,
      accountId: "work",
    });

    expectProvidedMessageCfgThreading(cfg);
    expect(hoisted.record).toHaveBeenCalledWith({
      channel: "nextcloud-talk",
      accountId: "default",
      direction: "outbound",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      messageId: "12345",
      receipt: {
        platformMessageIds: ["12345"],
        primaryPlatformMessageId: "12345",
        parts: [
          {
            index: 0,
            kind: "text",
            platformMessageId: "12345",
            raw: {
              channel: "nextcloud-talk",
              conversationId: "abc123",
              messageId: "12345",
            },
          },
        ],
        raw: [
          {
            channel: "nextcloud-talk",
            conversationId: "abc123",
            messageId: "12345",
          },
        ],
        sentAt: fixedSentAt,
      },
      roomToken: "abc123",
      timestamp: 1_706_000_000,
    });
  });

  it("strips mixed-case provider and room prefixes before sending", async () => {
    const cfg = { source: "provided" } as const;
    mockNextcloudMessageResponse(12344, 1_706_000_000);

    const result = await sendMessageNextcloudTalk("NC-TALK:ROOM:Ops", "hello", {
      cfg,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://nextcloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/Ops/message",
      expect.any(Object),
    );
    expect(result.roomToken).toBe("Ops");
    expect(result.receipt.raw).toEqual([
      {
        channel: "nextcloud-talk",
        conversationId: "Ops",
        messageId: "12344",
      },
    ]);
  });

  it("preserves caller-authored text on the low-level send path", async () => {
    const cfg = { source: "provided" } as const;
    const text = "Example:\n⚠️ 🛠️ `search repos (agent)` failed";
    mockNextcloudMessageResponse(12346, 1_706_000_001);

    await sendMessageNextcloudTalk("room:abc123", text, {
      cfg,
      accountId: "work",
      replyTo: "parent-1",
    });

    expect(hoisted.generateNextcloudTalkSignature).toHaveBeenCalledWith({
      body: text,
      secret: "secret-value",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ message: text, replyTo: "parent-1" }),
    );
  });

  it("sends with provided cfg even when the runtime store is not initialized", async () => {
    const cfg = { source: "provided" } as const;
    hoisted.record.mockImplementation(() => {
      throw new Error("Nextcloud Talk runtime not initialized");
    });
    mockNextcloudMessageResponse(12346, 1_706_000_001);

    const result = await sendMessageNextcloudTalk("room:abc123", "hello", {
      cfg,
      accountId: "work",
    });

    expectProvidedMessageCfgThreading(cfg);
    expect(result).toEqual({
      messageId: "12346",
      receipt: {
        platformMessageIds: ["12346"],
        primaryPlatformMessageId: "12346",
        parts: [
          {
            index: 0,
            kind: "text",
            platformMessageId: "12346",
            raw: {
              channel: "nextcloud-talk",
              conversationId: "abc123",
              messageId: "12346",
            },
          },
        ],
        raw: [
          {
            channel: "nextcloud-talk",
            conversationId: "abc123",
            messageId: "12346",
          },
        ],
        sentAt: fixedSentAt,
      },
      roomToken: "abc123",
      timestamp: 1_706_000_001,
    });
  });

  it("preserves reply ids in receipts", async () => {
    const cfg = { source: "provided" } as const;
    mockNextcloudMessageResponse(12347, 1_706_000_002);

    const result = await sendMessageNextcloudTalk("room:abc123", "hello", {
      cfg,
      accountId: "work",
      replyTo: "parent-1",
    });

    expect(result.receipt).toEqual({
      platformMessageIds: ["12347"],
      primaryPlatformMessageId: "12347",
      replyToId: "parent-1",
      parts: [
        {
          index: 0,
          kind: "text",
          replyToId: "parent-1",
          platformMessageId: "12347",
          raw: {
            channel: "nextcloud-talk",
            conversationId: "abc123",
            messageId: "12347",
          },
        },
      ],
      raw: [
        {
          channel: "nextcloud-talk",
          conversationId: "abc123",
          messageId: "12347",
        },
      ],
      sentAt: fixedSentAt,
    });
  });

  it("explains that 401 sends can mean the response feature is missing", async () => {
    const cfg = { source: "provided" } as const;
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));

    await expect(
      sendMessageNextcloudTalk("room:abc123", "hello", {
        cfg,
        accountId: "work",
      }),
    ).rejects.toThrow("--feature response");
  });

  it("declares message adapter durable text, media, and reply with receipt proofs", async () => {
    const cfg = { source: "provided" } as const;
    mockNextcloudMessageResponse(22345, 1_706_000_003);
    mockNextcloudMessageResponse(22346, 1_706_000_004);
    mockNextcloudMessageResponse(22347, 1_706_000_005);

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "nextcloud-talk",
      adapter: nextcloudTalkMessageAdapter,
      proofs: {
        text: async () => {
          const result = await nextcloudTalkMessageAdapter.send?.text?.({
            cfg: cfg as CoreConfig,
            to: "room:abc123",
            text: "hello",
            accountId: "work",
          });
          expect(result?.receipt.platformMessageIds).toEqual(["22345"]);
        },
        media: async () => {
          const result = await nextcloudTalkMessageAdapter.send?.media?.({
            cfg: cfg as CoreConfig,
            to: "room:abc123",
            text: "image",
            mediaUrl: "https://example.com/image.png",
            accountId: "work",
          });
          expect(result?.receipt.platformMessageIds).toEqual(["22346"]);
          const mediaSendCall = fetchMock.mock.calls.at(1);
          expect(mediaSendCall?.[0]).toBe(
            "https://nextcloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/abc123/message",
          );
          expect(mediaSendCall?.[1]?.body).toBe(
            JSON.stringify({
              message: "image\n\nAttachment: https://example.com/image.png",
            }),
          );
        },
        replyTo: async () => {
          const result = await nextcloudTalkMessageAdapter.send?.text?.({
            cfg: cfg as CoreConfig,
            to: "room:abc123",
            text: "threaded",
            replyToId: "parent-1",
            accountId: "work",
          });
          expect(result?.receipt.replyToId).toBe("parent-1");
        },
      },
    });

    expect(proofResults.find((result) => result.capability === "text")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "media")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "replyTo")?.status).toBe("verified");
  });

  it("fails hard for sendReaction when cfg is omitted", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await expect(
      sendReactionNextcloudTalk("room:ops", "m-1", "👍", {
        accountId: "default",
      } as never),
    ).rejects.toThrow("Nextcloud Talk send requires a resolved runtime config");

    expect(hoisted.loadConfig).not.toHaveBeenCalled();
    expect(hoisted.resolveNextcloudTalkAccount).not.toHaveBeenCalled();
  });

  it("uses provided cfg for sendReaction and posts the reaction payload", async () => {
    const cfg = { source: "provided" } as const;
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await sendReactionNextcloudTalk("room:ops", "m-1", "👍", {
      cfg,
      accountId: "work",
    });

    expectProvidedCfgSkipsRuntimeLoad({
      loadConfig: hoisted.loadConfig,
      resolveAccount: hoisted.resolveNextcloudTalkAccount,
      cfg,
      accountId: "work",
    });
    expect(hoisted.generateNextcloudTalkSignature).toHaveBeenCalledWith({
      body: "👍",
      secret: "secret-value",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://nextcloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/ops/reaction/m-1",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "OCS-APIRequest": "true",
          "X-Nextcloud-Talk-Bot-Random": "r",
          "X-Nextcloud-Talk-Bot-Signature": "s",
        },
        body: JSON.stringify({ reaction: "👍" }),
      },
    );
    expect(result).toEqual({ ok: true });
  });

  it("surfaces sendReaction HTTP failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    await expect(
      sendReactionNextcloudTalk("room:ops", "m-1", "👍", {
        cfg: { source: "provided" },
        accountId: "work",
      }),
    ).rejects.toThrow("Nextcloud Talk reaction failed: 403 forbidden");
  });
});

describe("nextcloud-talk send bounded response reads", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const account = {
    accountId: "default",
    baseUrl: "https://nextcloud.example.com",
    secret: "secret-value",
  };

  // Builds a streaming body with NO content-length so only the streaming byte
  // cap can stop it. `chunks` chunks of `chunkBytes` each => total may exceed cap.
  function streamingResponse(params: {
    status: number;
    chunkBytes: number;
    chunks: number;
    contentType: string;
    fill?: number;
  }): Response {
    let remaining = params.chunks;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining <= 0) {
          controller.close();
          return;
        }
        remaining -= 1;
        controller.enqueue(new Uint8Array(params.chunkBytes).fill(params.fill ?? 0x7b));
      },
    });
    return new Response(stream, {
      status: params.status,
      headers: { "content-type": params.contentType },
    });
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    hoisted.mockFetchGuard.mockImplementation(async (p: { url: string; init?: RequestInit }) => {
      const response = await globalThis.fetch(p.url, p.init);
      return { response, release: async () => {}, finalUrl: p.url };
    });
    hoisted.resolveNextcloudTalkAccount.mockReset();
    hoisted.resolveNextcloudTalkAccount.mockReturnValue(account);
    hoisted.record.mockReset();
    hoisted.generateNextcloudTalkSignature.mockClear();
  });

  afterEach(() => {
    fetchMock.mockReset();
    hoisted.mockFetchGuard.mockReset();
    vi.unstubAllGlobals();
  });

  it("keeps the unknown receipt when a success body exceeds the JSON byte cap", async () => {
    // 17 MiB streamed as 200-OK JSON with no content-length: over the 16 MiB cap.
    fetchMock.mockResolvedValueOnce(
      streamingResponse({
        status: 200,
        chunkBytes: 1024 * 1024,
        chunks: 17,
        contentType: "application/json",
      }),
    );

    const result = await sendMessageNextcloudTalk("room:abc", "hello", {
      cfg: { source: "provided" },
    });

    // Over-limit success body must not throw and must fall back to the unknown receipt.
    expect(result.messageId).toBe("unknown");
    expect(result.timestamp).toBeUndefined();
  });

  it("bounds an oversized error body into a short send-failure snippet", async () => {
    fetchMock.mockResolvedValueOnce(
      streamingResponse({
        status: 400,
        chunkBytes: 1024 * 1024,
        chunks: 17,
        contentType: "text/plain",
      }),
    );

    await expect(
      sendMessageNextcloudTalk("room:abc", "hello", { cfg: { source: "provided" } }),
    ).rejects.toThrow(/Nextcloud Talk: bad request/);
  });

  it("bounds an oversized reaction error body into a short snippet", async () => {
    fetchMock.mockResolvedValueOnce(
      streamingResponse({
        status: 500,
        chunkBytes: 1024 * 1024,
        chunks: 17,
        contentType: "text/plain",
      }),
    );

    let caught: unknown;
    try {
      await sendReactionNextcloudTalk("room:abc", "m-1", "👍", { cfg: { source: "provided" } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    // The collapsed snippet caps the message far below the streamed 17 MiB body.
    expect((caught as Error).message.length).toBeLessThan(4_000);
  });

  it("still parses a normal small success body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ocs: { data: { id: 99, timestamp: 1_700_000_000 } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await sendMessageNextcloudTalk("room:abc", "hello", {
      cfg: { source: "provided" },
    });

    expect(result.messageId).toBe("99");
    expect(result.timestamp).toBe(1_700_000_000);
  });
});
