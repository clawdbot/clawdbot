import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-message";
import { createSendCfgThreadingRuntime } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IrcClient } from "./client.js";
import { clearIrcRuntime, setIrcRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const hoisted = vi.hoisted(() => {
  const loadConfig = vi.fn();
  const resolveMarkdownTableMode = vi.fn(() => "preserve");
  const convertMarkdownTables = vi.fn((text: string) => text);
  const record = vi.fn();
  return {
    loadConfig,
    resolveMarkdownTableMode,
    convertMarkdownTables,
    record,
    normalizeIrcMessagingTarget: vi.fn((value: string) => value.trim()),
    connectIrcClient: vi.fn(),
    buildIrcConnectOptions: vi.fn(() => ({})),
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
  };
});

import { ircMessageAdapter } from "./message-adapter.js";
import { sendMessageIrc } from "./send.js";

function resetHoistedMocks() {
  hoisted.loadConfig.mockReset();
  hoisted.resolveMarkdownTableMode.mockReset().mockReturnValue("preserve");
  hoisted.convertMarkdownTables.mockReset().mockImplementation((text: string) => text);
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
  vi.doUnmock("openclaw/plugin-sdk/text-chunking");
  vi.resetModules();
});

describe("sendMessageIrc cfg threading", () => {
  beforeEach(() => {
    resetHoistedMocks();
    setIrcRuntime(createSendCfgThreadingRuntime(hoisted) as never);
  });

  afterEach(() => {
    clearIrcRuntime();
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

  it("sends with provided cfg even when the runtime store is not initialized", async () => {
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
      sendPrivmsg: vi.fn(),
      quit: vi.fn(),
    } as unknown as IrcClient & { quit: ReturnType<typeof vi.fn> };
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
          expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "threaded\n\n[reply:parent-1]");
        },
      },
    });

    expect(proofResults.find((result) => result.capability === "text")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "media")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "replyTo")?.status).toBe("verified");
  });
});
