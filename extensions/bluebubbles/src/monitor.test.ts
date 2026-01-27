import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";

import { removeAckReactionAfterReply, shouldAckReaction } from "clawdbot/plugin-sdk";
import type { ClawdbotConfig, PluginRuntime } from "clawdbot/plugin-sdk";
import {
  handleBlueBubblesWebhookRequest,
  registerBlueBubblesWebhookTarget,
  resolveBlueBubblesMessageId,
  _resetBlueBubblesShortIdState,
} from "./monitor.js";
import { setBlueBubblesRuntime } from "./runtime.js";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";

// Mock dependencies
vi.mock("./send.js", () => ({
  resolveChatGuidForTarget: vi.fn().mockResolvedValue("iMessage;-;+15551234567"),
  sendMessageBlueBubbles: vi.fn().mockResolvedValue({ messageId: "msg-123" }),
}));

vi.mock("./chat.js", () => ({
  markBlueBubblesChatRead: vi.fn().mockResolvedValue(undefined),
  sendBlueBubblesTyping: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./attachments.js", () => ({
  downloadBlueBubblesAttachment: vi.fn().mockResolvedValue({
    buffer: Buffer.from("test"),
    contentType: "image/jpeg",
  }),
}));

vi.mock("./reactions.js", async () => {
  const actual = await vi.importActual<typeof import("./reactions.js")>("./reactions.js");
  return {
    ...actual,
    sendBlueBubblesReaction: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock runtime
const mockEnqueueSystemEvent = vi.fn();
const mockBuildPairingReply = vi.fn(() => "Pairing code: TESTCODE");
const mockReadAllowFromStore = vi.fn().mockResolvedValue([]);
const mockUpsertPairingRequest = vi.fn().mockResolvedValue({ code: "TESTCODE", created: true });
const mockResolveAgentRoute = vi.fn(() => ({
  agentId: "main",
  accountId: "default",
  sessionKey: "agent:main:bluebubbles:dm:+15551234567",
}));
const mockBuildMentionRegexes = vi.fn(() => [/\bbert\b/i]);
const mockMatchesMentionPatterns = vi.fn((text: string, regexes: RegExp[]) =>
  regexes.some((r) => r.test(text)),
);
const mockResolveRequireMention = vi.fn(() => false);
const mockResolveGroupPolicy = vi.fn(() => "open");
const mockDispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => undefined);
const mockHasControlCommand = vi.fn(() => false);
const mockResolveCommandAuthorizedFromAuthorizers = vi.fn(() => false);
const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
  path: "/tmp/test-media.jpg",
  contentType: "image/jpeg",
});
const mockResolveStorePath = vi.fn(() => "/tmp/sessions.json");
const mockReadSessionUpdatedAt = vi.fn(() => undefined);
const mockResolveEnvelopeFormatOptions = vi.fn(() => ({
  template: "channel+name+time",
}));
const mockFormatAgentEnvelope = vi.fn((opts: { body: string }) => opts.body);
const mockChunkMarkdownText = vi.fn((text: string) => [text]);

function createMockRuntime(): PluginRuntime {
  return {
    version: "1.0.0",
    config: {
      loadConfig: vi.fn(() => ({})) as unknown as PluginRuntime["config"]["loadConfig"],
      writeConfigFile: vi.fn() as unknown as PluginRuntime["config"]["writeConfigFile"],
    },
    system: {
      enqueueSystemEvent: mockEnqueueSystemEvent as unknown as PluginRuntime["system"]["enqueueSystemEvent"],
      runCommandWithTimeout: vi.fn() as unknown as PluginRuntime["system"]["runCommandWithTimeout"],
    },
    media: {
      loadWebMedia: vi.fn() as unknown as PluginRuntime["media"]["loadWebMedia"],
      detectMime: vi.fn() as unknown as PluginRuntime["media"]["detectMime"],
      mediaKindFromMime: vi.fn() as unknown as PluginRuntime["media"]["mediaKindFromMime"],
      isVoiceCompatibleAudio: vi.fn() as unknown as PluginRuntime["media"]["isVoiceCompatibleAudio"],
      getImageMetadata: vi.fn() as unknown as PluginRuntime["media"]["getImageMetadata"],
      resizeToJpeg: vi.fn() as unknown as PluginRuntime["media"]["resizeToJpeg"],
    },
    tools: {
      createMemoryGetTool: vi.fn() as unknown as PluginRuntime["tools"]["createMemoryGetTool"],
      createMemorySearchTool: vi.fn() as unknown as PluginRuntime["tools"]["createMemorySearchTool"],
      registerMemoryCli: vi.fn() as unknown as PluginRuntime["tools"]["registerMemoryCli"],
    },
    channel: {
      text: {
        chunkMarkdownText: mockChunkMarkdownText as unknown as PluginRuntime["channel"]["text"]["chunkMarkdownText"],
        chunkText: vi.fn() as unknown as PluginRuntime["channel"]["text"]["chunkText"],
        resolveTextChunkLimit: vi.fn(() => 4000) as unknown as PluginRuntime["channel"]["text"]["resolveTextChunkLimit"],
        hasControlCommand: mockHasControlCommand as unknown as PluginRuntime["channel"]["text"]["hasControlCommand"],
        resolveMarkdownTableMode: vi.fn(() => "code") as unknown as PluginRuntime["channel"]["text"]["resolveMarkdownTableMode"],
        convertMarkdownTables: vi.fn((text: string) => text) as unknown as PluginRuntime["channel"]["text"]["convertMarkdownTables"],
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: mockDispatchReplyWithBufferedBlockDispatcher as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
        createReplyDispatcherWithTyping: vi.fn() as unknown as PluginRuntime["channel"]["reply"]["createReplyDispatcherWithTyping"],
        resolveEffectiveMessagesConfig: vi.fn() as unknown as PluginRuntime["channel"]["reply"]["resolveEffectiveMessagesConfig"],
        resolveHumanDelayConfig: vi.fn() as unknown as PluginRuntime["channel"]["reply"]["resolveHumanDelayConfig"],
        dispatchReplyFromConfig: vi.fn() as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"],
        finalizeInboundContext: vi.fn() as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
        formatAgentEnvelope: mockFormatAgentEnvelope as unknown as PluginRuntime["channel"]["reply"]["formatAgentEnvelope"],
        formatInboundEnvelope: vi.fn() as unknown as PluginRuntime["channel"]["reply"]["formatInboundEnvelope"],
        resolveEnvelopeFormatOptions: mockResolveEnvelopeFormatOptions as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
      },
      routing: {
        resolveAgentRoute: mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
      },
      pairing: {
        buildPairingReply: mockBuildPairingReply as unknown as PluginRuntime["channel"]["pairing"]["buildPairingReply"],
        readAllowFromStore: mockReadAllowFromStore as unknown as PluginRuntime["channel"]["pairing"]["readAllowFromStore"],
        upsertPairingRequest: mockUpsertPairingRequest as unknown as PluginRuntime["channel"]["pairing"]["upsertPairingRequest"],
      },
      media: {
        fetchRemoteMedia: vi.fn() as unknown as PluginRuntime["channel"]["media"]["fetchRemoteMedia"],
        saveMediaBuffer: mockSaveMediaBuffer as unknown as PluginRuntime["channel"]["media"]["saveMediaBuffer"],
      },
      session: {
        resolveStorePath: mockResolveStorePath as unknown as PluginRuntime["channel"]["session"]["resolveStorePath"],
        readSessionUpdatedAt: mockReadSessionUpdatedAt as unknown as PluginRuntime["channel"]["session"]["readSessionUpdatedAt"],
        recordInboundSession: vi.fn() as unknown as PluginRuntime["channel"]["session"]["recordInboundSession"],
        recordSessionMetaFromInbound: vi.fn() as unknown as PluginRuntime["channel"]["session"]["recordSessionMetaFromInbound"],
        updateLastRoute: vi.fn() as unknown as PluginRuntime["channel"]["session"]["updateLastRoute"],
      },
      mentions: {
        buildMentionRegexes: mockBuildMentionRegexes as unknown as PluginRuntime["channel"]["mentions"]["buildMentionRegexes"],
        matchesMentionPatterns: mockMatchesMentionPatterns as unknown as PluginRuntime["channel"]["mentions"]["matchesMentionPatterns"],
      },
      reactions: {
        shouldAckReaction,
        removeAckReactionAfterReply,
      },
      groups: {
        resolveGroupPolicy: mockResolveGroupPolicy as unknown as PluginRuntime["channel"]["groups"]["resolveGroupPolicy"],
        resolveRequireMention: mockResolveRequireMention as unknown as PluginRuntime["channel"]["groups"]["resolveRequireMention"],
      },
      debounce: {
        // Create a pass-through debouncer that immediately calls onFlush
        createInboundDebouncer: vi.fn((params: { onFlush: (items: unknown[]) => Promise<void> }) => ({
          enqueue: async (item: unknown) => {
            await params.onFlush([item]);
          },
          flushKey: vi.fn(),
        })) as unknown as PluginRuntime["channel"]["debounce"]["createInboundDebouncer"],
        resolveInboundDebounceMs: vi.fn(() => 0) as unknown as PluginRuntime["channel"]["debounce"]["resolveInboundDebounceMs"],
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers: mockResolveCommandAuthorizedFromAuthorizers as unknown as PluginRuntime["channel"]["commands"]["resolveCommandAuthorizedFromAuthorizers"],
        isControlCommandMessage: vi.fn() as unknown as PluginRuntime["channel"]["commands"]["isControlCommandMessage"],
        shouldComputeCommandAuthorized: vi.fn() as unknown as PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"],
        shouldHandleTextCommands: vi.fn() as unknown as PluginRuntime["channel"]["commands"]["shouldHandleTextCommands"],
      },
      discord: {} as PluginRuntime["channel"]["discord"],
      slack: {} as PluginRuntime["channel"]["slack"],
      telegram: {} as PluginRuntime["channel"]["telegram"],
      signal: {} as PluginRuntime["channel"]["signal"],
      imessage: {} as PluginRuntime["channel"]["imessage"],
      whatsapp: {} as PluginRuntime["channel"]["whatsapp"],
    },
    logging: {
      shouldLogVerbose: vi.fn(() => false) as unknown as PluginRuntime["logging"]["shouldLogVerbose"],
      getChildLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })) as unknown as PluginRuntime["logging"]["getChildLogger"],
    },
    state: {
      resolveStateDir: vi.fn(() => "/tmp/clawdbot") as unknown as PluginRuntime["state"]["resolveStateDir"],
    },
  };
}

function createMockAccount(overrides: Partial<ResolvedBlueBubblesAccount["config"]> = {}): ResolvedBlueBubblesAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    config: {
      serverUrl: "http://localhost:1234",
      password: "test-password",
      dmPolicy: "open",
      groupPolicy: "open",
      allowFrom: [],
      groupAllowFrom: [],
      ...overrides,
    },
  };
}

function createMockRequest(
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = headers;
  (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "127.0.0.1" };

  // Emit body data after a microtask
  Promise.resolve().then(() => {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    req.emit("data", Buffer.from(bodyStr));
    req.emit("end");
  });

  return req;
}

function createMockResponse(): ServerResponse & { body: string; statusCode: number } {
  const res = {
    statusCode: 200,
    body: "",
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => {
      res.body = data ?? "";
    }),
  } as unknown as ServerResponse & { body: string; statusCode: number };
  return res;
}

const flushAsync = async () => {
  for (let i = 0; i < 2; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

describe("BlueBubbles webhook monitor", () => {
  let unregister: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset short ID state between tests for predictable behavior
    _resetBlueBubblesShortIdState();
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "TESTCODE", created: true });
    mockResolveRequireMention.mockReturnValue(false);
    mockHasControlCommand.mockReturnValue(false);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);
    mockBuildMentionRegexes.mockReturnValue([/\bbert\b/i]);

    setBlueBubblesRuntime(createMockRuntime());
  });

  afterEach(() => {
    unregister?.();
  });

  describe("webhook parsing + auth handling", () => {
    it("rejects non-POST requests", async () => {
      const account = createMockAccount();
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const req = createMockRequest("GET", "/bluebubbles-webhook", {});
      const res = createMockResponse();

      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(405);
    });

    it("accepts POST requests with valid JSON payload", async () => {
      const account = createMockAccount();
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("ok");
    });

    it("rejects requests with invalid JSON", async () => {
      const account = createMockAccount();
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const req = createMockRequest("POST", "/bluebubbles-webhook", "invalid json {{");
      const res = createMockResponse();

      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
    });

    it("authenticates via password query parameter", async () => {
      const account = createMockAccount({ password: "secret-token" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      // Mock non-localhost request
      const req = createMockRequest("POST", "/bluebubbles-webhook?password=secret-token", {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
        },
      });
      (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "192.168.1.100" };

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const res = createMockResponse();
      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    });

    it("authenticates via x-password header", async () => {
      const account = createMockAccount({ password: "secret-token" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      const req = createMockRequest(
        "POST",
        "/bluebubbles-webhook",
        {
          type: "new-message",
          data: {
            text: "hello",
            handle: { address: "+15551234567" },
            isGroup: false,
            isFromMe: false,
            guid: "msg-1",
          },
        },
        { "x-password": "secret-token" },
      );
      (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "192.168.1.100" };

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const res = createMockResponse();
      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    });

    it("rejects unauthorized requests with wrong password", async () => {
      const account = createMockAccount({ password: "secret-token" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      const req = createMockRequest("POST", "/bluebubbles-webhook?password=wrong-token", {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
        },
      });
      (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "192.168.1.100" };

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const res = createMockResponse();
      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    });

    it("allows localhost requests without authentication", async () => {
      const account = createMockAccount({ password: "secret-token" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      const req = createMockRequest("POST", "/bluebubbles-webhook", {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
        },
      });
      // Localhost address
      (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "127.0.0.1" };

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const res = createMockResponse();
      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    });

    it("ignores unregistered webhook paths", async () => {
      const req = createMockRequest("POST", "/unregistered-path", {});
      const res = createMockResponse();

      const handled = await handleBlueBubblesWebhookRequest(req, res);

      expect(handled).toBe(false);
    });

    it("parses chatId when provided as a string (webhook variant)", async () => {
      const { resolveChatGuidForTarget } = await import("./send.js");
      vi.mocked(resolveChatGuidForTarget).mockClear();

      const account = createMockAccount({ groupPolicy: "open" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello from group",
          handle: { address: "+15551234567" },
          isGroup: true,
          isFromMe: false,
          guid: "msg-1",
          chatId: "123",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(resolveChatGuidForTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { kind: "chat_id", chatId: 123 },
        }),
      );
    });

    it("extracts chatGuid from nested chat object fields (webhook variant)", async () => {
      const { sendMessageBlueBubbles, resolveChatGuidForTarget } = await import("./send.js");
      vi.mocked(sendMessageBlueBubbles).mockClear();
      vi.mocked(resolveChatGuidForTarget).mockClear();

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver({ text: "replying now" }, { kind: "final" });
      });

      const account = createMockAccount({ groupPolicy: "open" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello from group",
          handle: { address: "+15551234567" },
          isGroup: true,
          isFromMe: false,
          guid: "msg-1",
          chat: { chatGuid: "iMessage;+;chat123456" },
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(resolveChatGuidForTarget).not.toHaveBeenCalled();
      expect(sendMessageBlueBubbles).toHaveBeenCalledWith(
        "chat_guid:iMessage;+;chat123456",
        expect.any(String),
        expect.any(Object),
      );
    });
  });

  describe("DM pairing behavior vs allowFrom", () => {
    it("allows DM from sender in allowFrom list", async () => {
      const account = createMockAccount({
        dmPolicy: "allowlist",
        allowFrom: ["+15551234567"],
      });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello from allowed sender",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);

      // Wait for async processing
      await flushAsync();

      expect(res.statusCode).toBe(200);
      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });

    it("blocks DM from sender not in allowFrom when dmPolicy=allowlist", async () => {
      const account = createMockAccount({
        dmPolicy: "allowlist",
        allowFrom: ["+15559999999"], // Different number
      });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello from blocked sender",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(res.statusCode).toBe(200);
      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("triggers pairing flow for unknown sender when dmPolicy=pairing", async () => {
      // Note: empty allowFrom = allow all. To trigger pairing, we need a non-empty
      // allowlist that doesn't include the sender
      const account = createMockAccount({
        dmPolicy: "pairing",
        allowFrom: ["+15559999999"], // Different number than sender
      });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockUpsertPairingRequest).toHaveBeenCalled();
      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("does not resend pairing reply when request already exists", async () => {
      mockUpsertPairingRequest.mockResolvedValue({ code: "TESTCODE", created: false });

      // Note: empty allowFrom = allow all. To trigger pairing, we need a non-empty
      // allowlist that doesn't include the sender
      const account = createMockAccount({
        dmPolicy: "pairing",
        allowFrom: ["+15559999999"], // Different number than sender
      });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello again",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-2",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockUpsertPairingRequest).toHaveBeenCalled();
      // Should not send pairing reply since created=false
      const { sendMessageBlueBubbles } = await import("./send.js");
      expect(sendMessageBlueBubbles).not.toHaveBeenCalled();
    });

    it("allows all DMs when dmPolicy=open", async () => {
      const account = createMockAccount({
        dmPolicy: "open",
        allowFrom: [],
      });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello from anyone",
          handle: { address: "+15559999999" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });

    it("blocks all DMs when dmPolicy=disabled", async () => {
      const account = createMockAccount({
        dmPolicy: "disabled",
      });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });
  });

  describe("group message gating", () => {
    it("allows group messages when groupPolicy=open and no allowlist", async () => {
      const account = createMockAccount({
        groupPolicy: "open",
      });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello from group",
          handle: { address: "+15551234567" },
          isGroup: true,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;+;chat123456",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });

    it("blocks group messages when groupPolicy=disabled", async () => {
      const account = createMockAccount({
        groupPolicy: "disabled",
      });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello from group",
          handle: { address: "+15551234567" },
          isGroup: true,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;+;chat123456",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("treats chat_guid groups as group even when isGroup=false", async () => {
      const account = createMockAccount({
        groupPolicy: "allowlist",
        dmPolicy: "open",
      });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello from group",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;+;chat123456",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("allows group messages from allowed chat_guid in groupAllowFrom", async () => {
      const account = createMockAccount({
        groupPolicy: "allowlist",
        groupAllowFrom: ["chat_guid:iMessage;+;chat123456"],
      });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello from allowed group",
          handle: { address: "+15551234567" },
          isGroup: true,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;+;chat123456",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });
  });

  describe("mention gating (group messages)", () => {
    it("processes group message when mentioned and requireMention=true", async () => {
      mockResolveRequireMention.mockReturnValue(true);
      mockMatchesMentionPatterns.mockReturnValue(true);

      const account = createMockAccount({ groupPolicy: "open" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "bert, can you help me?",
          handle: { address: "+15551234567" },
          isGroup: true,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;+;chat123456",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
      expect(callArgs.ctx.WasMentioned).toBe(true);
    });

    it("skips group message when not mentioned and requireMention=true", async () => {
      mockResolveRequireMention.mockReturnValue(true);
      mockMatchesMentionPatterns.mockReturnValue(false);

      const account = createMockAccount({ groupPolicy: "open" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello everyone",
          handle: { address: "+15551234567" },
          isGroup: true,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;+;chat123456",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });

    it("processes group message without mention when requireMention=false", async () => {
      mockResolveRequireMention.mockReturnValue(false);

      const account = createMockAccount({ groupPolicy: "open" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello everyone",
          handle: { address: "+15551234567" },
          isGroup: true,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;+;chat123456",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });
  });

  describe("group metadata", () => {
    it("includes group subject + members in ctx", async () => {
      const account = createMockAccount({ groupPolicy: "open" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello group",
          handle: { address: "+15551234567" },
          isGroup: true,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;+;chat123456",
          chatName: "Family",
          participants: [
            { address: "+15551234567", displayName: "Alice" },
            { address: "+15557654321", displayName: "Bob" },
          ],
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
      expect(callArgs.ctx.GroupSubject).toBe("Family");
      expect(callArgs.ctx.GroupMembers).toBe("Alice (+15551234567), Bob (+15557654321)");
    });
  });

  describe("reply metadata", () => {
    it("surfaces reply fields in ctx when provided", async () => {
      const account = createMockAccount({ dmPolicy: "open" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "replying now",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;-;+15551234567",
          replyTo: {
            guid: "msg-0",
            text: "original message",
            handle: { address: "+15550000000", displayName: "Alice" },
          },
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
      // ReplyToId is the full UUID since it wasn't previously cached
      expect(callArgs.ctx.ReplyToId).toBe("msg-0");
      expect(callArgs.ctx.ReplyToBody).toBe("original message");
      expect(callArgs.ctx.ReplyToSender).toBe("+15550000000");
      // Body uses inline [[reply_to:N]] tag format
      expect(callArgs.ctx.Body).toContain("[[reply_to:msg-0]]");
    });

    it("preserves part index prefixes in reply tags when short IDs are unavailable", async () => {
      const account = createMockAccount({ dmPolicy: "open" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "replying now",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;-;+15551234567",
          replyTo: {
            guid: "p:1/msg-0",
            text: "original message",
            handle: { address: "+15550000000", displayName: "Alice" },
          },
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
      expect(callArgs.ctx.ReplyToId).toBe("p:1/msg-0");
      expect(callArgs.ctx.ReplyToIdFull).toBe("p:1/msg-0");
      expect(callArgs.ctx.Body).toContain("[[reply_to:p:1/msg-0]]");
    });

    it("hydrates missing reply sender/body from the recent-message cache", async () => {
      const account = createMockAccount({ dmPolicy: "open", groupPolicy: "open" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const chatGuid = "iMessage;+;chat-reply-cache";

      const originalPayload = {
        type: "new-message",
        data: {
          text: "original message (cached)",
          handle: { address: "+15550000000" },
          isGroup: true,
          isFromMe: false,
          guid: "cache-msg-0",
          chatGuid,
          date: Date.now(),
        },
      };

      const originalReq = createMockRequest("POST", "/bluebubbles-webhook", originalPayload);
      const originalRes = createMockResponse();

      await handleBlueBubblesWebhookRequest(originalReq, originalRes);
      await flushAsync();

      // Only assert the reply message behavior below.
      mockDispatchReplyWithBufferedBlockDispatcher.mockClear();

      const replyPayload = {
        type: "new-message",
        data: {
          text: "replying now",
          handle: { address: "+15551234567" },
          isGroup: true,
          isFromMe: false,
          guid: "cache-msg-1",
          chatGuid,
          // Only the GUID is provided; sender/body must be hydrated.
          replyToMessageGuid: "cache-msg-0",
          date: Date.now(),
        },
      };

      const replyReq = createMockRequest("POST", "/bluebubbles-webhook", replyPayload);
      const replyRes = createMockResponse();

      await handleBlueBubblesWebhookRequest(replyReq, replyRes);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
      // ReplyToId uses short ID "1" (first cached message) for token savings
      expect(callArgs.ctx.ReplyToId).toBe("1");
      expect(callArgs.ctx.ReplyToIdFull).toBe("cache-msg-0");
      expect(callArgs.ctx.ReplyToBody).toBe("original message (cached)");
      expect(callArgs.ctx.ReplyToSender).toBe("+15550000000");
      // Body uses inline [[reply_to:N]] tag format with short ID
      expect(callArgs.ctx.Body).toContain("[[reply_to:1]]");
    });

    it("falls back to threadOriginatorGuid when reply metadata is absent", async () => {
      const account = createMockAccount({ dmPolicy: "open" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "replying now",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          threadOriginatorGuid: "msg-0",
          chatGuid: "iMessage;-;+15551234567",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
      expect(callArgs.ctx.ReplyToId).toBe("msg-0");
    });
  });

  describe("tapback text parsing", () => {
    it("does not rewrite tapback-like text without metadata", async () => {
      const account = createMockAccount({ dmPolicy: "open" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "Loved this idea",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;-;+15551234567",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
      expect(callArgs.ctx.RawBody).toBe("Loved this idea");
      expect(callArgs.ctx.Body).toContain("Loved this idea");
      expect(callArgs.ctx.Body).not.toContain("reacted with");
    });

    it("parses tapback text with custom emoji when metadata is present", async () => {
      const account = createMockAccount({ dmPolicy: "open" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: 'Reacted 😅 to "nice one"',
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-2",
          chatGuid: "iMessage;-;+15551234567",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
      expect(callArgs.ctx.RawBody).toBe("reacted with 😅");
      expect(callArgs.ctx.Body).toContain("reacted with 😅");
      expect(callArgs.ctx.Body).not.toContain("[[reply_to:");
    });
  });

  describe("ack reactions", () => {
    it("sends ack reaction when configured", async () => {
      const { sendBlueBubblesReaction } = await import("./reactions.js");
      vi.mocked(sendBlueBubblesReaction).mockClear();

      const account = createMockAccount({ dmPolicy: "open" });
      const config: ClawdbotConfig = {
        messages: {
          ackReaction: "❤️",
          ackReactionScope: "direct",
        },
      };
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;-;+15551234567",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(sendBlueBubblesReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          chatGuid: "iMessage;-;+15551234567",
          messageGuid: "msg-1",
          emoji: "❤️",
          opts: expect.objectContaining({ accountId: "default" }),
        }),
      );
    });
  });

  describe("command gating", () => {
    it("allows control command to bypass mention gating when authorized", async () => {
      mockResolveRequireMention.mockReturnValue(true);
      mockMatchesMentionPatterns.mockReturnValue(false); // Not mentioned
      mockHasControlCommand.mockReturnValue(true); // Has control command
      mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true); // Authorized

      const account = createMockAccount({
        groupPolicy: "open",
        allowFrom: ["+15551234567"],
      });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "/status",
          handle: { address: "+15551234567" },
          isGroup: true,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;+;chat123456",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      // Should process even without mention because it's an authorized control command
      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });

    it("blocks control command from unauthorized sender in group", async () => {
      mockHasControlCommand.mockReturnValue(true);
      mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);

      const account = createMockAccount({
        groupPolicy: "open",
        allowFrom: [], // No one authorized
      });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "/status",
          handle: { address: "+15559999999" },
          isGroup: true,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;+;chat123456",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });
  });

  describe("typing/read receipt toggles", () => {
    it("marks chat as read when sendReadReceipts=true (default)", async () => {
      const { markBlueBubblesChatRead } = await import("./chat.js");
      vi.mocked(markBlueBubblesChatRead).mockClear();

      const account = createMockAccount({
        sendReadReceipts: true,
      });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;-;+15551234567",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(markBlueBubblesChatRead).toHaveBeenCalled();
    });

    it("does not mark chat as read when sendReadReceipts=false", async () => {
      const { markBlueBubblesChatRead } = await import("./chat.js");
      vi.mocked(markBlueBubblesChatRead).mockClear();

      const account = createMockAccount({
        sendReadReceipts: false,
      });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;-;+15551234567",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(markBlueBubblesChatRead).not.toHaveBeenCalled();
    });

    it("sends typing indicator when processing message", async () => {
      const { sendBlueBubblesTyping } = await import("./chat.js");
      vi.mocked(sendBlueBubblesTyping).mockClear();

      const account = createMockAccount();
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;-;+15551234567",
          date: Date.now(),
        },
      };

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.onReplyStart?.();
      });

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      // Should call typing start when reply flow triggers it.
      expect(sendBlueBubblesTyping).toHaveBeenCalledWith(
        expect.any(String),
        true,
        expect.any(Object),
      );
    });

    it("stops typing on idle", async () => {
      const { sendBlueBubblesTyping } = await import("./chat.js");
      vi.mocked(sendBlueBubblesTyping).mockClear();

      const account = createMockAccount();
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;-;+15551234567",
          date: Date.now(),
        },
      };

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.onReplyStart?.();
        await params.dispatcherOptions.deliver({ text: "replying now" }, { kind: "final" });
        await params.dispatcherOptions.onIdle?.();
      });

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(sendBlueBubblesTyping).toHaveBeenCalledWith(
        expect.any(String),
        false,
        expect.any(Object),
      );
    });

    it("stops typing when no reply is sent", async () => {
      const { sendBlueBubblesTyping } = await import("./chat.js");
      vi.mocked(sendBlueBubblesTyping).mockClear();

      const account = createMockAccount();
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;-;+15551234567",
          date: Date.now(),
        },
      };

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async () => undefined);

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(sendBlueBubblesTyping).toHaveBeenCalledWith(
        expect.any(String),
        false,
        expect.any(Object),
      );
    });
  });

  describe("outbound message ids", () => {
    it("enqueues system event for outbound message id", async () => {
      mockEnqueueSystemEvent.mockClear();

      mockDispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver({ text: "replying now" }, { kind: "final" });
      });

      const account = createMockAccount();
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "msg-1",
          chatGuid: "iMessage;-;+15551234567",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      // Outbound message ID uses short ID "2" (inbound msg-1 is "1", outbound msg-123 is "2")
      expect(mockEnqueueSystemEvent).toHaveBeenCalledWith(
        'Assistant sent "replying now" [message_id:2]',
        expect.objectContaining({
          sessionKey: "agent:main:bluebubbles:dm:+15551234567",
        }),
      );
    });
  });

  describe("reaction events", () => {
    it("enqueues system event for reaction added", async () => {
      mockEnqueueSystemEvent.mockClear();

      const account = createMockAccount();
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "message-reaction",
        data: {
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          associatedMessageGuid: "msg-original-123",
          associatedMessageType: 2000, // Heart reaction added
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockEnqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("reacted with ❤️ [[reply_to:"),
        expect.any(Object),
      );
    });

    it("enqueues system event for reaction removed", async () => {
      mockEnqueueSystemEvent.mockClear();

      const account = createMockAccount();
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "message-reaction",
        data: {
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          associatedMessageGuid: "msg-original-123",
          associatedMessageType: 3000, // Heart reaction removed
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockEnqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("removed ❤️ reaction [[reply_to:"),
        expect.any(Object),
      );
    });

    it("ignores reaction from self (fromMe=true)", async () => {
      mockEnqueueSystemEvent.mockClear();

      const account = createMockAccount();
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "message-reaction",
        data: {
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: true, // From self
          associatedMessageGuid: "msg-original-123",
          associatedMessageType: 2000,
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
    });

    it("maps reaction types to correct emojis", async () => {
      mockEnqueueSystemEvent.mockClear();

      const account = createMockAccount();
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      // Test thumbs up reaction (2001)
      const payload = {
        type: "message-reaction",
        data: {
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          associatedMessageGuid: "msg-123",
          associatedMessageType: 2001, // Thumbs up
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockEnqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("👍"),
        expect.any(Object),
      );
    });
  });

  describe("short message ID mapping", () => {
    it("assigns sequential short IDs to messages", async () => {
      const account = createMockAccount({ dmPolicy: "open" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "p:1/msg-uuid-12345",
          chatGuid: "iMessage;-;+15551234567",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
      const callArgs = mockDispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
      // MessageSid should be short ID "1" instead of full UUID
      expect(callArgs.ctx.MessageSid).toBe("1");
      expect(callArgs.ctx.MessageSidFull).toBe("p:1/msg-uuid-12345");
    });

    it("resolves short ID back to UUID", async () => {
      const account = createMockAccount({ dmPolicy: "open" });
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
          guid: "p:1/msg-uuid-12345",
          chatGuid: "iMessage;-;+15551234567",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      // The short ID "1" should resolve back to the full UUID
      expect(resolveBlueBubblesMessageId("1")).toBe("p:1/msg-uuid-12345");
    });

    it("returns UUID unchanged when not in cache", () => {
      expect(resolveBlueBubblesMessageId("msg-not-cached")).toBe("msg-not-cached");
    });

    it("returns short ID unchanged when numeric but not in cache", () => {
      expect(resolveBlueBubblesMessageId("999")).toBe("999");
    });

    it("throws when numeric short ID is missing and requireKnownShortId is set", () => {
      expect(() =>
        resolveBlueBubblesMessageId("999", { requireKnownShortId: true }),
      ).toThrow(/short message id/i);
    });
  });

  describe("fromMe messages", () => {
    it("ignores messages from self (fromMe=true)", async () => {
      const account = createMockAccount();
      const config: ClawdbotConfig = {};
      const core = createMockRuntime();
      setBlueBubblesRuntime(core);

      unregister = registerBlueBubblesWebhookTarget({
        account,
        config,
        runtime: { log: vi.fn(), error: vi.fn() },
        core,
        path: "/bluebubbles-webhook",
      });

      const payload = {
        type: "new-message",
        data: {
          text: "my own message",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: true,
          guid: "msg-1",
          date: Date.now(),
        },
      };

      const req = createMockRequest("POST", "/bluebubbles-webhook", payload);
      const res = createMockResponse();

      await handleBlueBubblesWebhookRequest(req, res);
      await flushAsync();

      expect(mockDispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });
  });
});
