import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createIMessageTestPlugin } from "../../../test/helpers/channels/imessage-test-plugin.js";
import {
  imessageOutboundForTest,
  signalOutbound,
  whatsappOutbound,
} from "../../../test/helpers/infra/deliver-test-outbounds.js";
import type { OpenClawConfig } from "../../config/config.js";
import * as mediaCapabilityModule from "../../media/read-capability.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { addTestHook } from "../../plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { PluginHookRegistration } from "../../plugins/types.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";

const mocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
}));
const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn<(_hookName?: string) => boolean>(() => false),
    runMessageSending: vi.fn<(event: unknown, ctx: unknown) => Promise<unknown>>(
      async () => undefined,
    ),
    runMessageSent: vi.fn<(event: unknown, ctx: unknown) => Promise<void>>(async () => {}),
  },
}));
const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));
const queueMocks = vi.hoisted(() => ({
  enqueueDelivery: vi.fn(async () => "mock-queue-id"),
  ackDelivery: vi.fn(async () => {}),
  failDelivery: vi.fn(async () => {}),
}));
const logMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../../config/sessions/transcript.runtime.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../config/sessions/transcript.runtime.js")
  >("../../config/sessions/transcript.runtime.js");
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
  };
});
vi.mock("../../config/sessions/transcript.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/transcript.js")>(
    "../../config/sessions/transcript.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
  };
});
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: internalHookMocks.createInternalHookEvent,
  triggerInternalHook: internalHookMocks.triggerInternalHook,
}));
vi.mock("./delivery-queue.js", () => ({
  enqueueDelivery: queueMocks.enqueueDelivery,
  ackDelivery: queueMocks.ackDelivery,
  failDelivery: queueMocks.failDelivery,
}));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const makeLogger = () => ({
      warn: logMocks.warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => makeLogger()),
    });
    return makeLogger();
  },
}));

type DeliverModule = typeof import("./deliver.js");

let deliverOutboundPayloads: DeliverModule["deliverOutboundPayloads"];
let normalizeOutboundPayloads: DeliverModule["normalizeOutboundPayloads"];

const whatsappChunkConfig: OpenClawConfig = {
  channels: { whatsapp: { textChunkLimit: 4000 } },
};

const expectedPreferredTmpRoot = resolvePreferredOpenClawTmpDir();

type DeliverOutboundArgs = Parameters<DeliverModule["deliverOutboundPayloads"]>[0];
type DeliverOutboundPayload = DeliverOutboundArgs["payloads"][number];

async function deliverWhatsAppPayload(params: {
  sendWhatsApp: NonNullable<
    NonNullable<Parameters<DeliverModule["deliverOutboundPayloads"]>[0]["deps"]>["whatsapp"]
  >;
  payload: DeliverOutboundPayload;
  cfg?: OpenClawConfig;
}) {
  return deliverOutboundPayloads({
    cfg: params.cfg ?? whatsappChunkConfig,
    channel: "whatsapp",
    to: "+1555",
    payloads: [params.payload],
    deps: { whatsapp: params.sendWhatsApp },
  });
}

async function runChunkedWhatsAppDelivery(params?: {
  mirror?: Parameters<typeof deliverOutboundPayloads>[0]["mirror"];
}) {
  const sendWhatsApp = vi
    .fn()
    .mockResolvedValueOnce({ messageId: "w1", toJid: "jid" })
    .mockResolvedValueOnce({ messageId: "w2", toJid: "jid" });
  const cfg: OpenClawConfig = {
    channels: { whatsapp: { textChunkLimit: 2 } },
  };
  const results = await deliverOutboundPayloads({
    cfg,
    channel: "whatsapp",
    to: "+1555",
    payloads: [{ text: "abcd" }],
    deps: { whatsapp: sendWhatsApp },
    ...(params?.mirror ? { mirror: params.mirror } : {}),
  });
  return { sendWhatsApp, results };
}

async function deliverSingleWhatsAppForHookTest(params?: { sessionKey?: string }) {
  const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
  await deliverOutboundPayloads({
    cfg: whatsappChunkConfig,
    channel: "whatsapp",
    to: "+1555",
    payloads: [{ text: "hello" }],
    deps: { whatsapp: sendWhatsApp },
    ...(params?.sessionKey ? { session: { key: params.sessionKey } } : {}),
  });
}

async function runBestEffortPartialFailureDelivery() {
  const sendWhatsApp = vi
    .fn()
    .mockRejectedValueOnce(new Error("fail"))
    .mockResolvedValueOnce({ messageId: "w2", toJid: "jid" });
  const onError = vi.fn();
  const cfg: OpenClawConfig = {};
  const results = await deliverOutboundPayloads({
    cfg,
    channel: "whatsapp",
    to: "+1555",
    payloads: [{ text: "a" }, { text: "b" }],
    deps: { whatsapp: sendWhatsApp },
    bestEffort: true,
    onError,
  });
  return { sendWhatsApp, onError, results };
}

function expectSuccessfulWhatsAppInternalHookPayload(
  expected: Partial<{
    content: string;
    messageId: string;
    isGroup: boolean;
    groupId: string;
  }>,
) {
  return expect.objectContaining({
    to: "+1555",
    success: true,
    channelId: "whatsapp",
    conversationId: "+1555",
    ...expected,
  });
}

describe("deliverOutboundPayloads", () => {
  beforeAll(async () => {
    ({ deliverOutboundPayloads, normalizeOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    releasePinnedPluginChannelRegistry();
    setActivePluginRegistry(defaultRegistry);
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageSending.mockClear();
    hookMocks.runner.runMessageSending.mockResolvedValue(undefined);
    hookMocks.runner.runMessageSent.mockClear();
    hookMocks.runner.runMessageSent.mockResolvedValue(undefined);
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockClear();
    queueMocks.enqueueDelivery.mockClear();
    queueMocks.enqueueDelivery.mockResolvedValue("mock-queue-id");
    queueMocks.ackDelivery.mockClear();
    queueMocks.ackDelivery.mockResolvedValue(undefined);
    queueMocks.failDelivery.mockClear();
    queueMocks.failDelivery.mockResolvedValue(undefined);
    logMocks.warn.mockClear();
  });

  afterEach(() => {
    releasePinnedPluginChannelRegistry();
    setActivePluginRegistry(emptyRegistry);
  });

  it("keeps requester session channel authoritative for delivery media policy", async () => {
    const resolveMediaAccessSpy = vi.spyOn(
      mediaCapabilityModule,
      "resolveAgentScopedOutboundMediaAccess",
    );
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "hello" }],
      deps: { whatsapp: sendWhatsApp },
      session: {
        key: "agent:main:whatsapp:group:ops",
        requesterSenderId: "attacker",
      },
    });

    expect(resolveMediaAccessSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:whatsapp:group:ops",
        messageProvider: undefined,
        requesterSenderId: "attacker",
      }),
    );
    resolveMediaAccessSpy.mockRestore();
  });

  it("forwards all sender fields to media access for non-id policy matching", async () => {
    const resolveMediaAccessSpy = vi.spyOn(
      mediaCapabilityModule,
      "resolveAgentScopedOutboundMediaAccess",
    );
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w2", toJid: "jid" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "hello" }],
      deps: { whatsapp: sendWhatsApp },
      session: {
        key: "agent:main:whatsapp:group:ops",
        requesterSenderId: "id:whatsapp:123",
        requesterSenderName: "Alice",
        requesterSenderUsername: "alice_u",
        requesterSenderE164: "+15551234567",
      },
    });

    expect(resolveMediaAccessSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSenderId: "id:whatsapp:123",
        requesterSenderName: "Alice",
        requesterSenderUsername: "alice_u",
        requesterSenderE164: "+15551234567",
      }),
    );
    resolveMediaAccessSpy.mockRestore();
  });

  it("uses requester account from session for delivery media policy", async () => {
    const resolveMediaAccessSpy = vi.spyOn(
      mediaCapabilityModule,
      "resolveAgentScopedOutboundMediaAccess",
    );
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w3", toJid: "jid" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "whatsapp",
      to: "+1555",
      accountId: "destination-account",
      payloads: [{ text: "hello" }],
      deps: { whatsapp: sendWhatsApp },
      session: {
        key: "agent:main:whatsapp:group:ops",
        requesterAccountId: "source-account",
        requesterSenderId: "attacker",
      },
    });

    expect(resolveMediaAccessSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:whatsapp:group:ops",
        accountId: "source-account",
        requesterSenderId: "attacker",
      }),
    );
    resolveMediaAccessSpy.mockRestore();
  });

  it("chunks direct adapter text and preserves delivery overrides across sends", async () => {
    const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "!room",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              textChunkLimit: 2,
              chunker: (text, limit) => {
                const chunks: string[] = [];
                for (let i = 0; i < text.length; i += limit) {
                  chunks.push(text.slice(i, i + limit));
                }
                return chunks;
              },
              sendText,
            },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: { channels: { matrix: { textChunkLimit: 2 } } } as OpenClawConfig,
      channel: "matrix",
      to: "!room",
      accountId: "default",
      payloads: [{ text: "abcd", replyToId: "777" }],
    });

    expect(sendText).toHaveBeenCalledTimes(2);
    for (const call of sendText.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          accountId: "default",
          replyToId: "777",
        }),
      );
    }
    expect(results.map((entry) => entry.messageId)).toEqual(["ab", "cd"]);
  });

  it("uses adapter-provided formatted senders and scoped media roots when available", async () => {
    const sendText = vi.fn(async ({ text }: { text: string }) => ({
      channel: "line" as const,
      messageId: `fallback:${text}`,
    }));
    const sendMedia = vi.fn(async ({ text }: { text: string }) => ({
      channel: "line" as const,
      messageId: `media:${text}`,
    }));
    const sendFormattedText = vi.fn(async ({ text }: { text: string }) => [
      { channel: "line" as const, messageId: `fmt:${text}:1` },
      { channel: "line" as const, messageId: `fmt:${text}:2` },
    ]);
    const sendFormattedMedia = vi.fn(
      async ({ text }: { text: string; mediaLocalRoots?: readonly string[] }) => ({
        channel: "line" as const,
        messageId: `fmt-media:${text}`,
      }),
    );
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "line",
            outbound: {
              deliveryMode: "direct",
              sendText,
              sendMedia,
              sendFormattedText,
              sendFormattedMedia,
            },
          }),
        },
      ]),
    );

    const textResults = await deliverOutboundPayloads({
      cfg: { channels: { line: {} } } as OpenClawConfig,
      channel: "line",
      to: "U123",
      accountId: "default",
      payloads: [{ text: "hello **boss**" }],
    });

    expect(sendFormattedText).toHaveBeenCalledTimes(1);
    expect(sendFormattedText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "U123",
        text: "hello **boss**",
        accountId: "default",
      }),
    );
    expect(sendText).not.toHaveBeenCalled();
    expect(textResults.map((entry) => entry.messageId)).toEqual([
      "fmt:hello **boss**:1",
      "fmt:hello **boss**:2",
    ]);

    await deliverOutboundPayloads({
      cfg: { channels: { line: {} } } as OpenClawConfig,
      channel: "line",
      to: "U123",
      payloads: [{ text: "photo", mediaUrl: "file:///tmp/f.png" }],
      session: { agentId: "work" },
    });

    expect(sendFormattedMedia).toHaveBeenCalledTimes(1);
    expect(sendFormattedMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "U123",
        text: "photo",
        mediaUrl: "file:///tmp/f.png",
        mediaLocalRoots: expect.arrayContaining([expectedPreferredTmpRoot]),
      }),
    );
    const sendFormattedMediaCall = sendFormattedMedia.mock.calls[0]?.[0] as
      | { mediaLocalRoots?: string[] }
      | undefined;
    expect(
      sendFormattedMediaCall?.mediaLocalRoots?.some((root) =>
        root.endsWith(path.join(".openclaw", "workspace-work")),
      ),
    ).toBe(true);
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("includes OpenClaw tmp root in signal mediaLocalRoots", async () => {
    const sendSignal = vi.fn().mockResolvedValue({ messageId: "s1", timestamp: 123 });

    await deliverOutboundPayloads({
      cfg: { channels: { signal: {} } },
      channel: "signal",
      to: "+1555",
      payloads: [{ text: "hi", mediaUrl: "https://example.com/x.png" }],
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith(
      "+1555",
      "hi",
      expect.objectContaining({
        mediaLocalRoots: expect.arrayContaining([expectedPreferredTmpRoot]),
      }),
    );
  });

  it("sends telegram media to an explicit target once instead of fanning out over allowFrom", async () => {
    const sendMedia = vi.fn().mockResolvedValue({ channel: "telegram", messageId: "t1" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn().mockResolvedValue({ channel: "telegram", messageId: "text-1" }),
              sendMedia,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {
        channels: {
          telegram: {
            botToken: "tok",
            allowFrom: ["111", "222", "333"],
          },
        },
      },
      channel: "telegram",
      to: "123",
      payloads: [{ text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" }],
      skipQueue: true,
    });

    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "123",
        text: "HEARTBEAT_OK",
        mediaUrl: "https://example.com/img.png",
        accountId: undefined,
      }),
    );
  });

  it("forwards audioAsVoice through generic plugin media delivery", async () => {
    const sendMedia = vi.fn(async () => ({
      channel: "matrix" as const,
      messageId: "mx-1",
      roomId: "!room:example",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText: async ({ to, text }) => ({
                channel: "matrix",
                messageId: `${to}:${text}`,
              }),
              sendMedia,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: { channels: { matrix: {} } } as OpenClawConfig,
      channel: "matrix",
      to: "room:!room:example",
      payloads: [{ text: "voice caption", mediaUrl: "file:///tmp/clip.mp3", audioAsVoice: true }],
    });

    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "room:!room:example",
        text: "voice caption",
        mediaUrl: "file:///tmp/clip.mp3",
        audioAsVoice: true,
      }),
    );
  });

  it("includes OpenClaw tmp root in whatsapp mediaLocalRoots", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });

    await deliverOutboundPayloads({
      cfg: whatsappChunkConfig,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "hi", mediaUrl: "https://example.com/x.png" }],
      deps: { whatsapp: sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledWith(
      "+1555",
      "hi",
      expect.objectContaining({
        mediaLocalRoots: expect.arrayContaining([expectedPreferredTmpRoot]),
      }),
    );
  });

  it("includes OpenClaw tmp root in imessage mediaLocalRoots", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "i1", chatId: "chat-1" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "imessage",
      to: "imessage:+15551234567",
      payloads: [{ text: "hi", mediaUrl: "https://example.com/x.png" }],
      deps: { imessage: sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "imessage:+15551234567",
      "hi",
      expect.objectContaining({
        mediaLocalRoots: expect.arrayContaining([expectedPreferredTmpRoot]),
      }),
    );
  });

  it("chunks WhatsApp text and returns all results", async () => {
    const { sendWhatsApp, results } = await runChunkedWhatsAppDelivery();

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.messageId)).toEqual(["w1", "w2"]);
  });

  it("respects newline chunk mode for WhatsApp", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { textChunkLimit: 4000, chunkMode: "newline" } },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "Line one\n\nLine two" }],
      deps: { whatsapp: sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(sendWhatsApp).toHaveBeenNthCalledWith(
      1,
      "+1555",
      "Line one",
      expect.objectContaining({ verbose: false }),
    );
    expect(sendWhatsApp).toHaveBeenNthCalledWith(
      2,
      "+1555",
      "Line two",
      expect.objectContaining({ verbose: false }),
    );
  });

  it("drops HTML-only WhatsApp text payloads after sanitization", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const results = await deliverWhatsAppPayload({
      sendWhatsApp,
      payload: { text: "<br><br>" },
    });

    expect(sendWhatsApp).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("drops non-WhatsApp HTML-only text payloads after sanitization", async () => {
    const sendSignal = vi.fn().mockResolvedValue({ messageId: "s1", toJid: "jid" });
    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "signal",
      to: "+1555",
      payloads: [{ text: "<br>" }],
      deps: { sendSignal },
    });

    expect(sendSignal).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("preserves fenced blocks for markdown chunkers in newline mode", async () => {
    const chunker = vi.fn((text: string) => (text ? [text] : []));
    const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "r1",
    }));
    const sendMedia = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "r1",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              chunker,
              chunkerMode: "markdown",
              textChunkLimit: 4000,
              sendText,
              sendMedia,
            },
          }),
        },
      ]),
    );

    const cfg: OpenClawConfig = {
      channels: { matrix: { textChunkLimit: 4000, chunkMode: "newline" } },
    };
    const text = "```js\nconst a = 1;\nconst b = 2;\n```\nAfter";

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: "!room",
      payloads: [{ text }],
    });

    expect(chunker).toHaveBeenCalledTimes(1);
    expect(chunker).toHaveBeenNthCalledWith(1, text, 4000);
  });

  it("passes config through for iMessage media sends so the channel runtime can resolve limits", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "i1" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: createIMessageTestPlugin(),
        },
      ]),
    );
    const cfg: OpenClawConfig = {
      agents: { defaults: { mediaMaxMb: 3 } },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "imessage",
      to: "chat_id:42",
      payloads: [{ text: "hello", mediaUrls: ["https://example.com/a.png"] }],
      deps: { imessage: sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:42",
      "hello",
      expect.objectContaining({
        config: cfg,
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("normalizes payloads and drops empty entries", () => {
    const normalized = normalizeOutboundPayloads([
      { text: "hi" },
      { text: "MEDIA:https://x.test/a.jpg" },
      { text: " ", mediaUrls: [] },
    ]);
    expect(normalized).toEqual([
      { text: "hi", mediaUrls: [] },
      { text: "", mediaUrls: ["https://x.test/a.jpg"] },
    ]);
  });

  it("continues on errors when bestEffort is enabled", async () => {
    const { sendWhatsApp, onError, results } = await runBestEffortPartialFailureDelivery();

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ channel: "whatsapp", messageId: "w2", toJid: "jid" }]);
  });

  it("emits internal message:sent hook with success=true for chunked payload delivery", async () => {
    const { sendWhatsApp } = await runChunkedWhatsAppDelivery({
      mirror: {
        sessionKey: "agent:main:main",
        isGroup: true,
        groupId: "whatsapp:group:123",
      },
    });
    expect(sendWhatsApp).toHaveBeenCalledTimes(2);

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "sent",
      "agent:main:main",
      expectSuccessfulWhatsAppInternalHookPayload({
        content: "abcd",
        messageId: "w2",
        isGroup: true,
        groupId: "whatsapp:group:123",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("does not emit internal message:sent hook when neither mirror nor sessionKey is provided", async () => {
    await deliverSingleWhatsAppForHookTest();

    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("emits internal message:sent hook when sessionKey is provided without mirror", async () => {
    await deliverSingleWhatsAppForHookTest({ sessionKey: "agent:main:main" });

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "sent",
      "agent:main:main",
      expectSuccessfulWhatsAppInternalHookPayload({ content: "hello", messageId: "w1" }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("warns when session.agentId is set without a session key", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    hookMocks.runner.hasHooks.mockReturnValue(true);

    await deliverOutboundPayloads({
      cfg: whatsappChunkConfig,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "hello" }],
      deps: { whatsapp: sendWhatsApp },
      session: { agentId: "agent-main" },
    });

    expect(logMocks.warn).toHaveBeenCalledWith(
      "deliverOutboundPayloads: session.agentId present without session key; internal message:sent hook will be skipped",
      expect.objectContaining({ channel: "whatsapp", to: "+1555", agentId: "agent-main" }),
    );
  });

  it("calls failDelivery instead of ackDelivery on bestEffort partial failure", async () => {
    const { onError } = await runBestEffortPartialFailureDelivery();

    // onError was called for the first payload's failure.
    expect(onError).toHaveBeenCalledTimes(1);

    // Queue entry should NOT be acked — failDelivery should be called instead.
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).toHaveBeenCalledWith(
      "mock-queue-id",
      "partial delivery failure (bestEffort)",
    );
  });

  it("writes raw payloads to the queue before normalization", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w-raw", toJid: "jid" });
    const rawPayloads: DeliverOutboundPayload[] = [
      { text: "NO_REPLY" },
      { text: '{"action":"NO_REPLY"}' },
      { text: "caption\nMEDIA:https://x.test/a.png" },
      { text: "NO_REPLY", mediaUrl: " https://x.test/b.png " },
    ];

    await deliverOutboundPayloads({
      cfg: whatsappChunkConfig,
      channel: "whatsapp",
      to: "+1555",
      payloads: rawPayloads,
      deps: { whatsapp: sendWhatsApp },
    });

    expect(queueMocks.enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(queueMocks.enqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [
          { text: "NO_REPLY" },
          { text: '{"action":"NO_REPLY"}' },
          { text: "caption\nMEDIA:https://x.test/a.png" },
          { text: "NO_REPLY", mediaUrl: " https://x.test/b.png " },
        ],
      }),
    );
  });

  it("acks the queue entry when delivery is aborted", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const abortController = new AbortController();
    abortController.abort();
    const cfg: OpenClawConfig = {};

    await expect(
      deliverOutboundPayloads({
        cfg,
        channel: "whatsapp",
        to: "+1555",
        payloads: [{ text: "a" }],
        deps: { whatsapp: sendWhatsApp },
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow("Operation aborted");

    expect(queueMocks.ackDelivery).toHaveBeenCalledWith("mock-queue-id");
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });

  it("passes normalized payload to onError", async () => {
    const sendWhatsApp = vi.fn().mockRejectedValue(new Error("boom"));
    const onError = vi.fn();
    const cfg: OpenClawConfig = {};

    await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "hi", mediaUrl: "https://x.test/a.jpg" }],
      deps: { whatsapp: sendWhatsApp },
      bestEffort: true,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ text: "hi", mediaUrls: ["https://x.test/a.jpg"] }),
    );
  });

  it("mirrors delivered output when mirror options are provided", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "line",
            outbound: {
              deliveryMode: "direct",
              sendText: async ({ text }) => ({ channel: "line", messageId: text }),
              sendMedia: async ({ text }) => ({ channel: "line", messageId: text }),
            },
          }),
        },
      ]),
    );
    mocks.appendAssistantMessageToSessionTranscript.mockClear();

    await deliverOutboundPayloads({
      cfg: { channels: { line: {} } } as OpenClawConfig,
      channel: "line",
      to: "U123",
      payloads: [{ text: "caption", mediaUrl: "https://example.com/files/report.pdf?sig=1" }],
      mirror: {
        sessionKey: "agent:main:main",
        text: "caption",
        mediaUrls: ["https://example.com/files/report.pdf?sig=1"],
        idempotencyKey: "idem-deliver-1",
      },
    });

    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "report.pdf",
        idempotencyKey: "idem-deliver-1",
      }),
    );
  });

  it("emits message_sent success for text-only deliveries", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "hello" }],
      deps: { whatsapp: sendWhatsApp },
    });

    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+1555", content: "hello", success: true }),
      expect.objectContaining({ channelId: "whatsapp" }),
    );
  });

  it("short-circuits lower-priority message_sending hooks after cancel=true", async () => {
    const hookRegistry = createEmptyPluginRegistry();
    const high = vi.fn().mockResolvedValue({ cancel: true, content: "blocked" });
    const low = vi.fn().mockResolvedValue({ cancel: false, content: "override" });
    addTestHook({
      registry: hookRegistry,
      pluginId: "high",
      hookName: "message_sending",
      handler: high as PluginHookRegistration["handler"],
      priority: 100,
    });
    addTestHook({
      registry: hookRegistry,
      pluginId: "low",
      hookName: "message_sending",
      handler: low as PluginHookRegistration["handler"],
      priority: 0,
    });
    const realRunner = createHookRunner(hookRegistry);
    hookMocks.runner.hasHooks.mockImplementation((hookName?: string) =>
      realRunner.hasHooks((hookName ?? "") as never),
    );
    hookMocks.runner.runMessageSending.mockImplementation((event, ctx) =>
      realRunner.runMessageSending(event as never, ctx as never),
    );

    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    await deliverOutboundPayloads({
      cfg: {},
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "hello" }],
      deps: { whatsapp: sendWhatsApp },
    });

    expect(hookMocks.runner.runMessageSending).toHaveBeenCalledTimes(1);
    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
    expect(sendWhatsApp).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageSent).not.toHaveBeenCalled();
  });

  it("emits message_sent success for sendPayload deliveries", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sendPayload = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-1" });
    const sendText = vi.fn();
    const sendMedia = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendPayload, sendText, sendMedia },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "payload text", channelData: { mode: "custom" } }],
    });

    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ to: "!room:1", content: "payload text", success: true }),
      expect.objectContaining({ channelId: "matrix" }),
    );
  });

  it("preserves channelData-only payloads with empty text for non-WhatsApp sendPayload channels", async () => {
    const sendPayload = vi.fn().mockResolvedValue({ channel: "line", messageId: "ln-1" });
    const sendText = vi.fn();
    const sendMedia = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "line",
            outbound: { deliveryMode: "direct", sendPayload, sendText, sendMedia },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "line",
      to: "U123",
      payloads: [{ text: " \n\t ", channelData: { mode: "flex" } }],
    });

    expect(sendPayload).toHaveBeenCalledTimes(1);
    expect(sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ text: "", channelData: { mode: "flex" } }),
      }),
    );
    expect(results).toEqual([{ channel: "line", messageId: "ln-1" }]);
  });

  it("falls back to sendText when plugin outbound omits sendMedia", async () => {
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-1" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "caption", mediaUrl: "https://example.com/file.png" }],
    });

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "caption",
      }),
    );
    expect(logMocks.warn).toHaveBeenCalledWith(
      "Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used",
      expect.objectContaining({
        channel: "matrix",
        mediaCount: 1,
      }),
    );
    expect(results).toEqual([{ channel: "matrix", messageId: "mx-1" }]);
  });

  it("falls back to one sendText call for multi-media payloads when sendMedia is omitted", async () => {
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-2" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [
        {
          text: "caption",
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        },
      ],
    });

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "caption",
      }),
    );
    expect(logMocks.warn).toHaveBeenCalledWith(
      "Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used",
      expect.objectContaining({
        channel: "matrix",
        mediaCount: 2,
      }),
    );
    expect(results).toEqual([{ channel: "matrix", messageId: "mx-2" }]);
  });

  it("fails media-only payloads when plugin outbound omits sendMedia", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-3" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:1",
        payloads: [{ text: "   ", mediaUrl: "https://example.com/file.png" }],
      }),
    ).rejects.toThrow(
      "Plugin outbound adapter does not implement sendMedia and no text fallback is available for media payload",
    );

    expect(sendText).not.toHaveBeenCalled();
    expect(logMocks.warn).toHaveBeenCalledWith(
      "Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used",
      expect.objectContaining({
        channel: "matrix",
        mediaCount: 1,
      }),
    );
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "!room:1",
        content: "",
        success: false,
        error:
          "Plugin outbound adapter does not implement sendMedia and no text fallback is available for media payload",
      }),
      expect.objectContaining({ channelId: "matrix" }),
    );
  });

  it("emits message_sent failure when delivery errors", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sendWhatsApp = vi.fn().mockRejectedValue(new Error("downstream failed"));

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "whatsapp",
        to: "+1555",
        payloads: [{ text: "hi" }],
        deps: { whatsapp: sendWhatsApp },
      }),
    ).rejects.toThrow("downstream failed");

    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+1555",
        content: "hi",
        success: false,
        error: "downstream failed",
      }),
      expect.objectContaining({ channelId: "whatsapp" }),
    );
  });
});

const emptyRegistry = createTestRegistry([]);
const defaultRegistry = createTestRegistry([
  {
    pluginId: "signal",
    plugin: createOutboundTestPlugin({ id: "signal", outbound: signalOutbound }),
    source: "test",
  },
  {
    pluginId: "whatsapp",
    plugin: createOutboundTestPlugin({ id: "whatsapp", outbound: whatsappOutbound }),
    source: "test",
  },
  {
    pluginId: "imessage",
    plugin: createIMessageTestPlugin({ outbound: imessageOutboundForTest }),
    source: "test",
  },
]);
