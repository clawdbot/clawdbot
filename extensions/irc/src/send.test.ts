import { createSendCfgThreadingRuntime } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IrcClient } from "./client.js";
import { setIrcRuntime } from "./runtime.js";
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

vi.mock("openclaw/plugin-sdk/text-runtime", async () => {
  const original = (await vi.importActual("openclaw/plugin-sdk/text-runtime")) as Record<
    string,
    unknown
  >;
  return {
    ...original,
    convertMarkdownTables: hoisted.convertMarkdownTables,
  };
});

import { sendMessageIrc } from "./send.js";

describe("sendMessageIrc cfg threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(result.messageId).toEqual(expect.any(String));
    expect(result.messageId.length).toBeGreaterThan(0);
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
    expect(result.messageId).toEqual(expect.any(String));
    expect(result.messageId.length).toBeGreaterThan(0);
  });
});
