// Irc tests cover send plugin behavior.
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { createSendCfgThreadingRuntime } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IrcClient } from "./client.js";
import { setIrcRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const hoisted = vi.hoisted(() => {
  const loadConfig = vi.fn();
  const resolveMarkdownTableMode = vi.fn(() => "preserve");
  const convertMarkdownTables = vi.fn((text: string) => text);
  const stripMarkdown = vi.fn((text: string) => text);
  const record = vi.fn();
  const buildIrcConnectOptions = vi.fn(
    (_account: unknown, overrides: Record<string, unknown> = {}) => overrides,
  );
  return {
    loadConfig,
    resolveMarkdownTableMode,
    convertMarkdownTables,
    stripMarkdown,
    record,
    normalizeIrcMessagingTarget: vi.fn((value: string) => value.trim()),
    connectIrcClient: vi.fn(),
    buildIrcConnectOptions,
  };
});

vi.mock("./normalize.js", () => ({
  normalizeIrcMessagingTarget: hoisted.normalizeIrcMessagingTarget,
}));

vi.mock("./client.js", () => ({
  connectIrcClient: hoisted.connectIrcClient,
}));

vi.mock("./connect-options.js", () => ({
  buildIrcConnectOptions: hoisted.buildIrcConnectOptions,
}));

vi.mock("./protocol.js", async () => {
  const actual = await vi.importActual<typeof import("./protocol.js")>("./protocol.js");
  return {
    ...actual,
    makeIrcMessageId: () => "irc-msg-1",
  };
});

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const original = (await vi.importActual("openclaw/plugin-sdk/plugin-config-runtime")) as Record<
    string,
    unknown
  >;
  return original;
});

vi.mock("openclaw/plugin-sdk/markdown-table-runtime", async () => {
  const original = (await vi.importActual("openclaw/plugin-sdk/markdown-table-runtime")) as Record<
    string,
    unknown
  >;
  return {
    ...original,
    resolveMarkdownTableMode: hoisted.resolveMarkdownTableMode,
  };
});

vi.mock("openclaw/plugin-sdk/text-chunking", async () => {
  const original = (await vi.importActual("openclaw/plugin-sdk/text-chunking")) as Record<
    string,
    unknown
  >;
  return {
    ...original,
    convertMarkdownTables: hoisted.convertMarkdownTables,
    stripMarkdown: hoisted.stripMarkdown,
  };
});

import { ircMessageAdapter, sendFormattedIrcText } from "./message-adapter.js";
import { ircOutboundBaseAdapter } from "./outbound-base.js";
import { sendMessageIrc } from "./send.js";

function resetHoistedMocks() {
  hoisted.loadConfig.mockReset();
  hoisted.resolveMarkdownTableMode.mockReset().mockReturnValue("preserve");
  hoisted.convertMarkdownTables.mockReset().mockImplementation((text: string) => text);
  hoisted.stripMarkdown.mockReset().mockImplementation((text: string) => text);
  hoisted.record.mockReset();
  hoisted.normalizeIrcMessagingTarget
    .mockReset()
    .mockImplementation((value: string) => value.trim());
  hoisted.connectIrcClient.mockReset();
  hoisted.buildIrcConnectOptions.mockReset().mockReturnValue({});
}

afterAll(() => {
  vi.doUnmock("./normalize.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./connect-options.js");
  vi.doUnmock("./protocol.js");
  vi.doUnmock("openclaw/plugin-sdk/plugin-config-runtime");
  vi.doUnmock("openclaw/plugin-sdk/markdown-table-runtime");
  vi.doUnmock("openclaw/plugin-sdk/text-chunking");
  vi.resetModules();
});

describe("sendMessageIrc cfg threading", () => {
  beforeEach(() => {
    resetHoistedMocks();
    setIrcRuntime(createSendCfgThreadingRuntime(hoisted) as never);
  });

  it("uses explicitly provided cfg without loading runtime config", async () => {
    const providedCfg = {
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "openclaw",
          accounts: {
            work: {
              host: "irc.example.com",
              nick: "workbot",
            },
          },
        },
      },
    } as unknown as CoreConfig;
    const client = {
      isReady: vi.fn(() => true),
      sendPrivmsg: vi.fn(),
    } as unknown as IrcClient;

    const result = await sendMessageIrc("#room", "hello", {
      cfg: providedCfg,
      client,
      accountId: "work",
    });

    expect(hoisted.loadConfig).not.toHaveBeenCalled();
    expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "hello");
    expect(hoisted.record).toHaveBeenCalledWith({
      channel: "irc",
      accountId: "work",
      direction: "outbound",
    });
    expect(result.target).toBe("#room");
    expect(result.messageId).toBeTypeOf("string");
    expect(result.messageId.length).toBeGreaterThan(0);
    expect(result.receipt.sentAt).toBeTypeOf("number");
    expect(result.receipt.sentAt).toBeGreaterThan(0);
    expect({ ...result.receipt, sentAt: 123 }).toEqual({
      primaryPlatformMessageId: "irc-msg-1",
      platformMessageIds: ["irc-msg-1"],
      parts: [
        {
          platformMessageId: "irc-msg-1",
          kind: "text",
          index: 0,
          raw: {
            channel: "irc",
            conversationId: "#room",
            messageId: "irc-msg-1",
          },
        },
      ],
      sentAt: 123,
      raw: [
        {
          channel: "irc",
          conversationId: "#room",
          messageId: "irc-msg-1",
        },
      ],
    });
  });

  it("strips markdown after table conversion before sending to IRC", async () => {
    const providedCfg = {
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "openclaw",
        },
      },
    } as unknown as CoreConfig;
    const client = {
      isReady: vi.fn(() => true),
      sendPrivmsg: vi.fn(),
    } as unknown as IrcClient;
    hoisted.resolveMarkdownTableMode.mockReturnValue("bullets");
    hoisted.convertMarkdownTables.mockReturnValue("**Status**\n- [docs](https://example.com)");
    hoisted.stripMarkdown.mockReturnValue("Status\n- docs (https://example.com)");

    await sendMessageIrc("#room", "  | a |\n| - |\n| **docs** |  ", {
      cfg: providedCfg,
      client,
    });

    expect(hoisted.convertMarkdownTables).toHaveBeenCalledWith(
      "| a |\n| - |\n| **docs** |",
      "bullets",
    );
    expect(hoisted.stripMarkdown).toHaveBeenCalledWith("**Status**\n- [docs](https://example.com)");
    expect(client.sendPrivmsg).toHaveBeenCalledWith(
      "#room",
      "Status\n- docs (https://example.com)",
    );
  });

  it("fails hard when cfg is omitted", async () => {
    const client = {
      isReady: vi.fn(() => true),
      sendPrivmsg: vi.fn(),
    } as unknown as IrcClient;

    await expect(sendMessageIrc("#ops", "ping", { client } as never)).rejects.toThrow(
      "IRC send requires a resolved runtime config",
    );

    expect(hoisted.loadConfig).not.toHaveBeenCalled();
    expect(client.sendPrivmsg).not.toHaveBeenCalled();
    expect(hoisted.record).not.toHaveBeenCalled();
  });

  it("sends with provided cfg when runtime activity recording is unavailable", async () => {
    const providedCfg = {
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "openclaw",
        },
      },
    } as unknown as CoreConfig;
    const client = {
      isReady: vi.fn(() => true),
      sendPrivmsg: vi.fn(),
    } as unknown as IrcClient;
    hoisted.record.mockImplementation(() => {
      throw new Error("IRC runtime not initialized");
    });

    const result = await sendMessageIrc("#room", "hello", {
      cfg: providedCfg,
      client,
    });

    expect(hoisted.loadConfig).not.toHaveBeenCalled();
    expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "hello");
    expect(result.target).toBe("#room");
    expect(result.messageId).toBeTypeOf("string");
    expect(result.messageId.length).toBeGreaterThan(0);
  });

  it("preserves reply ids in receipts", async () => {
    const providedCfg = {
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "openclaw",
        },
      },
    } as unknown as CoreConfig;
    const client = {
      isReady: vi.fn(() => true),
      sendPrivmsg: vi.fn(),
    } as unknown as IrcClient;

    const result = await sendMessageIrc("#room", "hello", {
      cfg: providedCfg,
      client,
      replyTo: "irc-parent-1",
    });

    expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "hello\n\n[reply:irc-parent-1]");
    expect(result.receipt.sentAt).toBeTypeOf("number");
    expect(result.receipt.sentAt).toBeGreaterThan(0);
    expect({ ...result.receipt, sentAt: 123 }).toEqual({
      primaryPlatformMessageId: "irc-msg-1",
      platformMessageIds: ["irc-msg-1"],
      replyToId: "irc-parent-1",
      parts: [
        {
          platformMessageId: "irc-msg-1",
          kind: "text",
          index: 0,
          replyToId: "irc-parent-1",
          raw: {
            channel: "irc",
            conversationId: "#room",
            messageId: "irc-msg-1",
          },
        },
      ],
      sentAt: 123,
      raw: [
        {
          channel: "irc",
          conversationId: "#room",
          messageId: "irc-msg-1",
        },
      ],
    });
  });

  it("rejects stripped-empty replies before adding reply metadata", async () => {
    const providedCfg = {
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "openclaw",
        },
      },
    } as unknown as CoreConfig;
    const client = {
      isReady: vi.fn(() => true),
      sendPrivmsg: vi.fn(),
    } as unknown as IrcClient;
    hoisted.stripMarkdown.mockReturnValue("");

    await expect(
      sendMessageIrc("#room", "#", {
        cfg: providedCfg,
        client,
        replyTo: "irc-parent-1",
      }),
    ).rejects.toThrow("Message must be non-empty for IRC sends");

    expect(client.sendPrivmsg).not.toHaveBeenCalled();
    expect(hoisted.record).not.toHaveBeenCalled();
  });

  it("uses one transient connection for a chunked outbound message", async () => {
    const providedCfg = {
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "openclaw",
        },
      },
    } as unknown as CoreConfig;
    const client = {
      isReady: vi.fn(() => true),
      join: vi.fn(),
      sendPrivmsg: vi.fn(),
      quit: vi.fn(),
    } as unknown as IrcClient & {
      join: ReturnType<typeof vi.fn>;
      sendPrivmsg: ReturnType<typeof vi.fn>;
      quit: ReturnType<typeof vi.fn>;
    };
    hoisted.connectIrcClient.mockResolvedValue(client);
    const onDeliveryResult = vi.fn();
    const onPlatformSendDispatch = vi.fn();
    const text = Array.from({ length: 80 }, (_, index) => `word-${index}`).join(" ");
    const chunks = ircOutboundBaseAdapter.chunker(text, 350);

    const results = await sendFormattedIrcText({
      cfg: providedCfg,
      to: "#room",
      text,
      replyToId: "parent-1",
      replyToIdSource: "explicit",
      replyToMode: "all",
      onDeliveryResult,
      onPlatformSendDispatch,
    });

    expect(hoisted.connectIrcClient).toHaveBeenCalledOnce();
    expect(client.join).toHaveBeenCalledOnce();
    expect(client.sendPrivmsg.mock.calls).toEqual(
      chunks.map((chunk) => ["#room", `${chunk}\n\n[reply:parent-1]`]),
    );
    expect(client.quit).toHaveBeenCalledOnce();
    expect(onPlatformSendDispatch).toHaveBeenCalledTimes(chunks.length);
    expect(onDeliveryResult).toHaveBeenCalledTimes(chunks.length);
    expect(results).toHaveLength(chunks.length);
  });

  it.each(
    [
      { kind: "formatted", sendMessage: sendFormattedIrcText },
      { kind: "text", sendMessage: ircMessageAdapter.send.text },
      { kind: "media", sendMessage: ircMessageAdapter.send.media },
    ].flatMap(({ kind, sendMessage }) =>
      ["connect", "dispatch"].map((phase) => ({ kind, sendMessage, phase })),
    ),
  )("cancels $kind sends during $phase", async ({ sendMessage, phase }) => {
    const providedCfg = {
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "openclaw",
        },
      },
    } as unknown as CoreConfig;
    const client = {
      isReady: vi.fn(() => true),
      join: vi.fn(),
      sendPrivmsg: vi.fn(),
      quit: vi.fn(),
    } as unknown as IrcClient & {
      join: ReturnType<typeof vi.fn>;
      sendPrivmsg: ReturnType<typeof vi.fn>;
      quit: ReturnType<typeof vi.fn>;
    };
    let resolveConnect!: (client: IrcClient) => void;
    const connect = new Promise<IrcClient>((resolve) => {
      resolveConnect = resolve;
    });
    hoisted.buildIrcConnectOptions.mockImplementation((_account, overrides = {}) => overrides);
    hoisted.connectIrcClient.mockReturnValue(connect);
    const abortController = new AbortController();

    const onPlatformSendDispatch = vi.fn(async () => {
      await Promise.resolve();
      abortController.abort();
    });
    const send = sendMessage({
      cfg: providedCfg,
      to: "#room",
      text: "hello",
      mediaUrl: "https://example.com/image.png",
      signal: abortController.signal,
      abortSignal: abortController.signal,
      onPlatformSendDispatch,
    });
    await vi.waitFor(() => expect(hoisted.connectIrcClient).toHaveBeenCalledOnce());
    if (phase === "connect") {
      abortController.abort();
    }
    resolveConnect(client);

    await expect(send).rejects.toMatchObject({ name: "AbortError" });
    expect(hoisted.buildIrcConnectOptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ abortSignal: abortController.signal }),
    );
    expect(client.join).toHaveBeenCalledTimes(phase === "connect" ? 0 : 1);
    expect(onPlatformSendDispatch).toHaveBeenCalledTimes(phase === "connect" ? 0 : 1);
    expect(client.sendPrivmsg).not.toHaveBeenCalled();
    expect(client.quit).toHaveBeenCalledOnce();
  });

  it("stops before recording another chunk after the connection closes", async () => {
    const providedCfg = {
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "openclaw",
        },
      },
    } as unknown as CoreConfig;
    let ready = true;
    const client = {
      isReady: vi.fn(() => ready),
      join: vi.fn(),
      sendPrivmsg: vi.fn(),
      quit: vi.fn(),
    } as unknown as IrcClient & {
      join: ReturnType<typeof vi.fn>;
      sendPrivmsg: ReturnType<typeof vi.fn>;
      quit: ReturnType<typeof vi.fn>;
    };
    hoisted.connectIrcClient.mockResolvedValue(client);
    const onDeliveryResult = vi.fn(() => {
      ready = false;
    });
    const onPlatformSendDispatch = vi.fn();
    const text = Array.from({ length: 80 }, (_, index) => `word-${index}`).join(" ");

    await expect(
      sendFormattedIrcText({
        cfg: providedCfg,
        to: "#room",
        text,
        onDeliveryResult,
        onPlatformSendDispatch,
      }),
    ).rejects.toThrow("IRC connection closed before send");

    expect(client.sendPrivmsg).toHaveBeenCalledOnce();
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(client.quit).toHaveBeenCalledOnce();
  });

  it("declares message adapter durable text, media, and reply with receipt proofs", async () => {
    const providedCfg = {
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "openclaw",
        },
      },
    } as unknown as CoreConfig;
    const client = {
      isReady: vi.fn(() => true),
      join: vi.fn(),
      sendPrivmsg: vi.fn(),
      quit: vi.fn(),
    } as unknown as IrcClient & {
      join: ReturnType<typeof vi.fn>;
      quit: ReturnType<typeof vi.fn>;
    };
    hoisted.connectIrcClient.mockResolvedValue(client);

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "irc",
      adapter: ircMessageAdapter,
      proofs: {
        text: async () => {
          const result = await ircMessageAdapter.send?.text?.({
            cfg: providedCfg,
            to: "#room",
            text: "hello",
          });
          expect(result?.receipt.platformMessageIds).toEqual(["irc-msg-1"]);
          expect(result?.target).toEqual({ kind: "conversation", id: "#room" });
          expect(client.join).toHaveBeenCalledWith("#room");
          expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "hello");
        },
        media: async () => {
          const result = await ircMessageAdapter.send?.media?.({
            cfg: providedCfg,
            to: "#room",
            text: "image",
            mediaUrl: "https://example.com/image.png",
          });
          expect(result?.receipt.platformMessageIds).toEqual(["irc-msg-1"]);
          expect(client.join).toHaveBeenCalledWith("#room");
          expect(client.sendPrivmsg).toHaveBeenCalledWith(
            "#room",
            "image\n\nAttachment: https://example.com/image.png",
          );
        },
        replyTo: async () => {
          const result = await ircMessageAdapter.send?.text?.({
            cfg: providedCfg,
            to: "#room",
            text: "threaded",
            replyToId: "parent-1",
          });
          expect(result?.receipt.replyToId).toBe("parent-1");
          expect(client.join).toHaveBeenCalledWith("#room");
          expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "threaded\n\n[reply:parent-1]");
        },
      },
    });

    expect(proofResults.find((result) => result.capability === "text")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "media")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "replyTo")?.status).toBe("verified");
  });
});
