import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import register from "./index.js";

describe("thread-ownership plugin", () => {
  const hooks: Record<string, Function> = {};
  const fetchMock = vi.fn() as unknown as typeof globalThis.fetch;
  let configFile: Record<string, unknown> = {};
  const originalSlackForwarderUrl = process.env.SLACK_FORWARDER_URL;
  const originalSlackBotUserId = process.env.SLACK_BOT_USER_ID;
  const api = {
    pluginConfig: {},
    config: {
      agents: {
        list: [{ id: "test-agent", default: true, identity: { name: "TestBot" } }],
      },
    },
    runtime: {
      config: {
        current: () => configFile,
      },
    },
    id: "thread-ownership",
    name: "Thread Ownership",
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    on: vi.fn((hookName: string, handler: Function) => {
      hooks[hookName] = handler;
    }),
  };

  function expectOwnershipFetchCall(index: number, url: string, agentId: string) {
    const call = vi.mocked(globalThis.fetch).mock.calls[index];
    if (!call) {
      throw new Error(`expected ownership fetch call ${index}`);
    }
    expect(call[0]).toBe(url);
    const init = call[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ agent_id: agentId }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(hooks)) {
      delete hooks[key];
    }
    api.pluginConfig = {};
    configFile = {
      agents: api.config.agents,
    };

    process.env.SLACK_FORWARDER_URL = "http://localhost:8750";
    process.env.SLACK_BOT_USER_ID = "U999";

    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalSlackForwarderUrl === undefined) {
      delete process.env.SLACK_FORWARDER_URL;
    } else {
      process.env.SLACK_FORWARDER_URL = originalSlackForwarderUrl;
    }
    if (originalSlackBotUserId === undefined) {
      delete process.env.SLACK_BOT_USER_ID;
    } else {
      process.env.SLACK_BOT_USER_ID = originalSlackBotUserId;
    }
    vi.restoreAllMocks();
  });

  describe("message_sending", () => {
    beforeEach(() => {
      register.register(api as unknown as OpenClawPluginApi);
    });

    async function sendSlackThreadMessage() {
      return await hooks.message_sending(
        { content: "hello", replyToId: "1234.5678", metadata: { channelId: "C123" }, to: "C123" },
        { channelId: "slack", conversationId: "C123" },
      );
    }

    it("allows non-slack channels", async () => {
      const result = await hooks.message_sending(
        { content: "hello", replyToId: "1234.5678", metadata: { channelId: "C123" }, to: "C123" },
        { channelId: "discord", conversationId: "C123" },
      );

      expect(result).toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("allows top-level messages (no threadTs)", async () => {
      const result = await hooks.message_sending(
        { content: "hello", metadata: {}, to: "C123" },
        { channelId: "slack", conversationId: "C123" },
      );

      expect(result).toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("fails open when Slack thread routing has no canonical conversation id", async () => {
      const result = await hooks.message_sending(
        { content: "hello", replyToId: "1234.5678", metadata: {}, to: "" },
        { channelId: "slack", conversationId: "" },
      );

      expect(result).toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("claims ownership successfully", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ owner: "test-agent" }), { status: 200 }),
      );

      const result = await sendSlackThreadMessage();

      expect(result).toBeUndefined();
      expectOwnershipFetchCall(
        0,
        "http://localhost:8750/api/v1/ownership/C123/1234.5678",
        "test-agent",
      );
    });

    it("prefers shared conversationId over non-canonical Slack target shapes", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ owner: "test-agent" }), { status: 200 }),
      );

      const result = await hooks.message_sending(
        {
          content: "hello",
          replyToId: "1234.5678",
          to: "channel:C123",
        },
        { channelId: "slack", conversationId: "C123" },
      );

      expect(result).toBeUndefined();
      expectOwnershipFetchCall(
        0,
        "http://localhost:8750/api/v1/ownership/C123/1234.5678",
        "test-agent",
      );
    });

    it("canonicalizes non-canonical Slack targets when shared conversationId is missing", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ owner: "test-agent" }), { status: 200 }),
      );

      const result = await hooks.message_sending(
        {
          content: "hello",
          replyToId: "1234.5678",
          to: "channel:c123",
        },
        { channelId: "slack", conversationId: "" },
      );

      expect(result).toBeUndefined();
      expectOwnershipFetchCall(
        0,
        "http://localhost:8750/api/v1/ownership/C123/1234.5678",
        "test-agent",
      );
    });

    it("canonicalizes configured ab-test channel allowlists before matching", async () => {
      api.pluginConfig = { abTestChannels: ["channel:c123"] };
      register.register(api as unknown as OpenClawPluginApi);
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ owner: "test-agent" }), { status: 200 }),
      );

      const result = await hooks.message_sending(
        {
          content: "hello",
          replyToId: "1234.5678",
          to: "channel:c123",
        },
        { channelId: "slack", conversationId: "" },
      );

      expect(result).toBeUndefined();
      expectOwnershipFetchCall(
        0,
        "http://localhost:8750/api/v1/ownership/C123/1234.5678",
        "test-agent",
      );
    });

    it("uses live runtime allowlists when deciding whether to claim ownership", async () => {
      api.pluginConfig = { abTestChannels: ["C123"] };
      configFile = {
        ...configFile,
        plugins: {
          entries: {
            "thread-ownership": {
              config: {
                abTestChannels: ["C999"],
              },
            },
          },
        },
      };
      register.register(api as unknown as OpenClawPluginApi);

      const result = await hooks.message_sending(
        {
          content: "hello",
          replyToId: "1234.5678",
          to: "C123",
        },
        { channelId: "slack", conversationId: "C123" },
      );

      expect(result).toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("does not fall back to startup allowlists when live plugin config is removed", async () => {
      api.pluginConfig = { abTestChannels: ["C999"] };
      register.register(api as unknown as OpenClawPluginApi);
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ owner: "test-agent" }), { status: 200 }),
      );

      const result = await hooks.message_sending(
        {
          content: "hello",
          replyToId: "1234.5678",
          to: "C123",
        },
        { channelId: "slack", conversationId: "C123" },
      );

      expect(result).toBeUndefined();
      expectOwnershipFetchCall(
        0,
        "http://localhost:8750/api/v1/ownership/C123/1234.5678",
        "test-agent",
      );
    });

    it("cancels when thread owned by another agent", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ owner: "other-agent" }), { status: 409 }),
      );

      const result = await sendSlackThreadMessage();

      expect(result).toEqual({ cancel: true });
      const infoMessage = vi.mocked(api.logger.info).mock.calls[0]?.[0];
      expect(typeof infoMessage).toBe("string");
      expect(infoMessage).toContain("cancelled send");
    });

    it("fails open on network error", async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await sendSlackThreadMessage();

      expect(result).toBeUndefined();
      const warningMessage = vi.mocked(api.logger.warn).mock.calls[0]?.[0];
      expect(typeof warningMessage).toBe("string");
      expect(warningMessage).toContain("ownership check failed");
    });
  });

  describe("message_received @-mention tracking", () => {
    beforeEach(() => {
      register.register(api as unknown as OpenClawPluginApi);
    });

    it("tracks @-mentions and skips ownership check for mentioned threads", async () => {
      // Simulate receiving a message that @-mentions the agent.
      await hooks.message_received(
        {
          content: "Hey @TestBot help me",
          threadId: "9999.0001",
          metadata: { channelId: "C456" },
        },
        { channelId: "slack", conversationId: "C456" },
      );

      // Now send in the same thread -- should skip the ownership HTTP call.
      const result = await hooks.message_sending(
        { content: "Sure!", replyToId: "9999.0001", metadata: { channelId: "C456" }, to: "C456" },
        { channelId: "slack", conversationId: "C456" },
      );

      expect(result).toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("tracks mentions under the shared conversationId when inbound metadata is non-canonical", async () => {
      await hooks.message_received(
        {
          content: "Hey @TestBot help me",
          threadId: "9999.0002",
          metadata: { channelId: "channel:c456" },
        },
        { channelId: "slack", conversationId: "C456" },
      );

      const result = await hooks.message_sending(
        {
          content: "Sure!",
          replyToId: "9999.0002",
          to: "channel:C456",
        },
        { channelId: "slack", conversationId: "C456" },
      );

      expect(result).toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("canonicalizes inbound non-canonical metadata without shared conversation context", async () => {
      await hooks.message_received(
        {
          content: "Hey @TestBot help me",
          threadId: "9999.0003",
          metadata: { channelId: "channel:c456" },
        },
        { channelId: "slack", conversationId: "" },
      );

      const result = await hooks.message_sending(
        {
          content: "Sure!",
          replyToId: "9999.0003",
          to: "c456",
        },
        { channelId: "slack", conversationId: "C456" },
      );

      expect(result).toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("ignores @-mentions on non-slack channels", async () => {
      // Use a unique thread key so module-level state from other tests doesn't interfere.
      await hooks.message_received(
        { content: "Hey @TestBot", threadId: "7777.0001", metadata: { channelId: "C999" } },
        { channelId: "discord", conversationId: "C999" },
      );

      // The mention should not have been tracked, so sending should still call fetch.
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ owner: "test-agent" }), { status: 200 }),
      );

      await hooks.message_sending(
        { content: "Sure!", replyToId: "7777.0001", metadata: { channelId: "C999" }, to: "C999" },
        { channelId: "slack", conversationId: "C999" },
      );

      expect(globalThis.fetch).toHaveBeenCalled();
    });

    it("tracks bot user ID mentions via <@U999> syntax", async () => {
      await hooks.message_received(
        {
          content: "Hey <@U999> help",
          threadId: "8888.0001",
          metadata: { channelId: "C789" },
        },
        { channelId: "slack", conversationId: "C789" },
      );

      const result = await hooks.message_sending(
        { content: "On it!", replyToId: "8888.0001", metadata: { channelId: "C789" }, to: "C789" },
        { channelId: "slack", conversationId: "C789" },
      );

      expect(result).toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("tracks agent-name mentions case-insensitively", async () => {
      await hooks.message_received(
        {
          content: "hey @testbot help",
          threadId: "8888.0002",
          metadata: { channelId: "C789" },
        },
        { channelId: "slack", conversationId: "C789" },
      );

      const result = await hooks.message_sending(
        { content: "On it!", replyToId: "8888.0002", metadata: { channelId: "C789" }, to: "C789" },
        { channelId: "slack", conversationId: "C789" },
      );

      expect(result).toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("uses the live runtime agent identity for ownership claims", async () => {
      configFile = {
        ...configFile,
        agents: {
          list: [{ id: "live-agent", default: true, identity: { name: "LiveBot" } }],
        },
      };
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ owner: "live-agent" }), { status: 200 }),
      );

      await hooks.message_sending(
        { content: "On it!", replyToId: "8888.0005", metadata: { channelId: "C789" }, to: "C789" },
        { channelId: "slack", conversationId: "C789" },
      );

      expectOwnershipFetchCall(
        0,
        "http://localhost:8750/api/v1/ownership/C789/8888.0005",
        "live-agent",
      );
    });

    it("uses the live runtime agent name for mention tracking", async () => {
      configFile = {
        ...configFile,
        agents: {
          list: [{ id: "live-agent", default: true, identity: { name: "LiveBot" } }],
        },
      };

      await hooks.message_received(
        {
          content: "hey @LiveBot help",
          threadId: "8888.0006",
          metadata: { channelId: "C789" },
        },
        { channelId: "slack", conversationId: "C789" },
      );

      const result = await hooks.message_sending(
        { content: "On it!", replyToId: "8888.0006", metadata: { channelId: "C789" }, to: "C789" },
        { channelId: "slack", conversationId: "C789" },
      );

      expect(result).toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("does not treat superset handles as agent-name mentions", async () => {
      await hooks.message_received(
        {
          content: "hey @testbot2 help",
          threadId: "8888.0003",
          metadata: { channelId: "C789" },
        },
        { channelId: "slack", conversationId: "C789" },
      );

      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ owner: "test-agent" }), { status: 200 }),
      );

      await hooks.message_sending(
        { content: "On it!", replyToId: "8888.0003", metadata: { channelId: "C789" }, to: "C789" },
        { channelId: "slack", conversationId: "C789" },
      );

      expect(globalThis.fetch).toHaveBeenCalled();
    });

    it("does not treat email-like text as an agent-name mention", async () => {
      await hooks.message_received(
        {
          content: "send mail to foo@testbot.com",
          threadId: "8888.0004",
          metadata: { channelId: "C789" },
        },
        { channelId: "slack", conversationId: "C789" },
      );

      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ owner: "test-agent" }), { status: 200 }),
      );

      await hooks.message_sending(
        { content: "On it!", replyToId: "8888.0004", metadata: { channelId: "C789" }, to: "C789" },
        { channelId: "slack", conversationId: "C789" },
      );

      expect(globalThis.fetch).toHaveBeenCalled();
    });
  });
});
