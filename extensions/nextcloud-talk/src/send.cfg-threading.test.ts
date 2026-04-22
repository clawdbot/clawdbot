import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSendCfgThreadingRuntime,
  expectProvidedCfgSkipsRuntimeLoad,
} from "../../../test/helpers/plugins/send-config.js";

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
      roomToken: "abc123",
      timestamp: 1_706_000_000,
    });
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
      roomToken: "abc123",
      timestamp: 1_706_000_001,
    });
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
});
