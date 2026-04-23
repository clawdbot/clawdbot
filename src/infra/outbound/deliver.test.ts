import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkText } from "../../auto-reply/chunk.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
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
  withActiveDeliveryClaim: vi.fn<
    (
      entryId: string,
      fn: () => Promise<unknown>,
    ) => Promise<{ status: "claimed"; value: unknown } | { status: "claimed-by-other-owner" }>
  >(async (_entryId, fn) => ({ status: "claimed", value: await fn() })),
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
  withActiveDeliveryClaim: queueMocks.withActiveDeliveryClaim,
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

const matrixChunkConfig: OpenClawConfig = {
  channels: { matrix: { textChunkLimit: 4000 } } as OpenClawConfig["channels"],
};

const expectedPreferredTmpRoot = resolvePreferredOpenClawTmpDir();

type DeliverOutboundArgs = Parameters<DeliverModule["deliverOutboundPayloads"]>[0];
type DeliverOutboundPayload = DeliverOutboundArgs["payloads"][number];
type MatrixSendFn = (
  to: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<{ messageId: string } & Record<string, unknown>>;

function resolveMatrixSender(deps: DeliverOutboundArgs["deps"]): MatrixSendFn {
  const sender = deps?.matrix;
  if (typeof sender !== "function") {
    throw new Error("missing matrix sender");
  }
  return sender as MatrixSendFn;
}

function withMatrixChannel(result: Awaited<ReturnType<MatrixSendFn>>) {
  return {
    channel: "matrix" as const,
    ...result,
  };
}

const matrixOutboundForTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  sanitizeText: ({ text }) => (text === "<br>" || text === "<br><br>" ? "" : text),
  sendText: async ({ cfg, to, text, accountId, deps, gifPlayback }) =>
    withMatrixChannel(
      await resolveMatrixSender(deps)(to, text, {
        cfg,
        accountId: accountId ?? undefined,
        gifPlayback,
      }),
    ),
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    mediaReadFile,
    accountId,
    deps,
    gifPlayback,
  }) =>
    withMatrixChannel(
      await resolveMatrixSender(deps)(to, text, {
        cfg,
        mediaUrl,
        mediaLocalRoots,
        mediaReadFile,
        accountId: accountId ?? undefined,
        gifPlayback,
      }),
    ),
};

async function deliverMatrixPayload(params: {
  sendMatrix: MatrixSendFn;
  payload: DeliverOutboundPayload;
  cfg?: OpenClawConfig;
}) {
  return deliverOutboundPayloads({
    cfg: params.cfg ?? matrixChunkConfig,
    channel: "matrix",
    to: "!room:example",
    payloads: [params.payload],
    deps: { matrix: params.sendMatrix },
  });
}

async function runChunkedMatrixDelivery(params?: {
  mirror?: Parameters<typeof deliverOutboundPayloads>[0]["mirror"];
}) {
  const sendMatrix = vi
    .fn()
    .mockResolvedValueOnce({ messageId: "m1", roomId: "!room:example" })
    .mockResolvedValueOnce({ messageId: "m2", roomId: "!room:example" });
  const cfg: OpenClawConfig = {
    channels: { matrix: { textChunkLimit: 2 } } as OpenClawConfig["channels"],
  };
  const results = await deliverOutboundPayloads({
    cfg,
    channel: "matrix",
    to: "!room:example",
    payloads: [{ text: "abcd" }],
    deps: { matrix: sendMatrix },
    ...(params?.mirror ? { mirror: params.mirror } : {}),
  });
  return { sendMatrix, results };
}

async function deliverSingleMatrixForHookTest(params?: { sessionKey?: string }) {
  const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
  await deliverOutboundPayloads({
    cfg: matrixChunkConfig,
    channel: "matrix",
    to: "!room:example",
    payloads: [{ text: "hello" }],
    deps: { matrix: sendMatrix },
    ...(params?.sessionKey ? { session: { key: params.sessionKey } } : {}),
  });
}

async function runBestEffortPartialFailureDelivery() {
  const sendMatrix = vi
    .fn()
    .mockRejectedValueOnce(new Error("fail"))
    .mockResolvedValueOnce({ messageId: "m2", roomId: "!room:example" });
  const onError = vi.fn();
  const cfg: OpenClawConfig = {};
  const results = await deliverOutboundPayloads({
    cfg,
    channel: "matrix",
    to: "!room:example",
    payloads: [{ text: "a" }, { text: "b" }],
    deps: { matrix: sendMatrix },
    bestEffort: true,
    onError,
  });
  return { sendMatrix, onError, results };
}

function expectSuccessfulMatrixInternalHookPayload(
  expected: Partial<{
    content: string;
    messageId: string;
    isGroup: boolean;
    groupId: string;
  }>,
) {
  return expect.objectContaining({
    to: "!room:example",
    success: true,
    channelId: "matrix",
    conversationId: "!room:example",
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
    queueMocks.withActiveDeliveryClaim.mockClear();
    queueMocks.withActiveDeliveryClaim.mockImplementation(async (_entryId, fn) => ({
      status: "claimed",
      value: await fn(),
    }));
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
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/policy.png" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:room:ops",
        requesterSenderId: "attacker",
      },
    });

    expect(resolveMediaAccessSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:matrix:room:ops",
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
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m2", roomId: "!room:example" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/policy.png" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:room:ops",
        requesterSenderId: "id:matrix:123",
        requesterSenderName: "Alice",
        requesterSenderUsername: "alice_u",
        requesterSenderE164: "+15551234567",
      },
    });

    expect(resolveMediaAccessSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSenderId: "id:matrix:123",
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
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m3", roomId: "!room:example" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      accountId: "destination-account",
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/policy.png" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:room:ops",
        requesterAccountId: "source-account",
        requesterSenderId: "attacker",
      },
    });

    expect(resolveMediaAccessSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:matrix:room:ops",
        accountId: "source-account",
        requesterSenderId: "attacker",
      }),
    );
    resolveMediaAccessSpy.mockRestore();
  });

  it("skips media access policy for text-only delivery", async () => {
    const resolveMediaAccessSpy = vi.spyOn(
      mediaCapabilityModule,
      "resolveAgentScopedOutboundMediaAccess",
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m4", roomId: "!room:example" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:room:ops",
        requesterSenderId: "attacker",
      },
    });

    expect(resolveMediaAccessSpy).not.toHaveBeenCalled();
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

  it("includes OpenClaw tmp root in plugin mediaLocalRoots", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-media", roomId: "!room" });

    await deliverOutboundPayloads({
      cfg: { channels: { matrix: {} } } as OpenClawConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hi", mediaUrl: "https://example.com/x.png" }],
      deps: { matrix: sendMatrix },
    });

    expect(sendMatrix).toHaveBeenCalledWith(
      "!room:example",
      "hi",
      expect.objectContaining({
        mediaLocalRoots: expect.arrayContaining([expectedPreferredTmpRoot]),
      }),
    );
  });

  it("sends plugin media to an explicit target once instead of fanning out over allowFrom", async () => {
    const sendMedia = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "m1" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn().mockResolvedValue({ channel: "matrix", messageId: "text-1" }),
              sendMedia,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {
        channels: {
          matrix: {
            allowFrom: ["111", "222", "333"],
          },
        } as OpenClawConfig["channels"],
      },
      channel: "matrix",
      to: "!explicit:example",
      payloads: [{ text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" }],
      skipQueue: true,
    });

    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "!explicit:example",
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

  it("chunks plugin text and returns all results", async () => {
    const { sendMatrix, results } = await runChunkedMatrixDelivery();

    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.messageId)).toEqual(["m1", "m2"]);
  });

  it("respects newline chunk mode for plugin text", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    const cfg: OpenClawConfig = {
      channels: {
        matrix: { textChunkLimit: 4000, chunkMode: "newline" },
      } as OpenClawConfig["channels"],
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "Line one\n\nLine two" }],
      deps: { matrix: sendMatrix },
    });

    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect(sendMatrix).toHaveBeenNthCalledWith(
      1,
      "!room:example",
      "Line one",
      expect.objectContaining({ cfg }),
    );
    expect(sendMatrix).toHaveBeenNthCalledWith(
      2,
      "!room:example",
      "Line two",
      expect.objectContaining({ cfg }),
    );
  });

  it("drops text payloads after adapter sanitization removes all content", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    const results = await deliverMatrixPayload({
      sendMatrix,
      payload: { text: "<br><br>" },
    });

    expect(sendMatrix).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("drops plugin HTML-only text payloads after sanitization", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "<br>" }],
      deps: { matrix: sendMatrix },
    });

    expect(sendMatrix).not.toHaveBeenCalled();
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

  it("passes config through for plugin media sends", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-media", roomId: "!room" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForTest }),
        },
      ]),
    );
    const cfg: OpenClawConfig = {
      agents: { defaults: { mediaMaxMb: 3 } },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello", mediaUrls: ["https://example.com/a.png"] }],
      deps: { matrix: sendMatrix },
    });

    expect(sendMatrix).toHaveBeenCalledWith(
      "!room:example",
      "hello",
      expect.objectContaining({
        cfg,
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
    const { sendMatrix, onError, results } = await runBestEffortPartialFailureDelivery();

    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ channel: "matrix", messageId: "m2", roomId: "!room:example" }]);
  });

  it("emits internal message:sent hook with success=true for chunked payload delivery", async () => {
    const { sendMatrix } = await runChunkedMatrixDelivery({
      mirror: {
        sessionKey: "agent:main:main",
        isGroup: true,
        groupId: "matrix:room:123",
      },
    });
    expect(sendMatrix).toHaveBeenCalledTimes(2);

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "sent",
      "agent:main:main",
      expectSuccessfulMatrixInternalHookPayload({
        content: "abcd",
        messageId: "m2",
        isGroup: true,
        groupId: "matrix:room:123",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("does not emit internal message:sent hook when neither mirror nor sessionKey is provided", async () => {
    await deliverSingleMatrixForHookTest();

    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("emits internal message:sent hook when sessionKey is provided without mirror", async () => {
    await deliverSingleMatrixForHookTest({ sessionKey: "agent:main:main" });

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "sent",
      "agent:main:main",
      expectSuccessfulMatrixInternalHookPayload({ content: "hello", messageId: "m1" }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("warns when session.agentId is set without a session key", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    hookMocks.runner.hasHooks.mockReturnValue(true);

    await deliverOutboundPayloads({
      cfg: matrixChunkConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      deps: { matrix: sendMatrix },
      session: { agentId: "agent-main" },
    });

    expect(logMocks.warn).toHaveBeenCalledWith(
      "deliverOutboundPayloads: session.agentId present without session key; internal message:sent hook will be skipped",
      expect.objectContaining({ channel: "matrix", to: "!room:example", agentId: "agent-main" }),
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
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-raw", roomId: "!room:example" });
    const rawPayloads: DeliverOutboundPayload[] = [
      { text: "NO_REPLY" },
      { text: '{"action":"NO_REPLY"}' },
      { text: "caption\nMEDIA:https://x.test/a.png" },
      { text: "NO_REPLY", mediaUrl: " https://x.test/b.png " },
    ];

    await deliverOutboundPayloads({
      cfg: matrixChunkConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: rawPayloads,
      deps: { matrix: sendMatrix },
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

  it("applies silent-reply policy from the outbound session", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-silent", roomId: "!room" });
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            direct: "disallow",
            group: "allow",
            internal: "allow",
          },
          silentReplyRewrite: {
            direct: true,
          },
        },
      },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "NO_REPLY" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:slash:!room",
        policyKey: "agent:main:matrix:direct:!room",
      },
    });

    expect(sendMatrix).toHaveBeenCalledTimes(1);
    expect(sendMatrix.mock.calls[0]?.[1]).toEqual(expect.any(String));
    expect(sendMatrix.mock.calls[0]?.[1]).not.toBe("NO_REPLY");
  });

  it("keeps allowed group silent replies silent during outbound delivery", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-silent", roomId: "!room" });

    await deliverOutboundPayloads({
      cfg: matrixChunkConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "NO_REPLY" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:group:ops",
      },
    });

    expect(sendMatrix).not.toHaveBeenCalled();
  });

  it("bails out without sending when a concurrent drain already claimed the queue entry", async () => {
    // Regression for openclaw/openclaw#70386: if a reconnect or startup drain
    // observes the newly enqueued entry and claims it before the live send
    // path claims it, the live path must not send. The drain already owns
    // ack/fail for that id; sending here would duplicate the outbound and
    // race queue cleanup.
    queueMocks.withActiveDeliveryClaim.mockResolvedValueOnce({
      status: "claimed-by-other-owner",
    });
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hi" }],
      deps: { matrix: sendMatrix },
    });

    expect(results).toEqual([]);
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("acks the queue entry when delivery is aborted", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    const abortController = new AbortController();
    abortController.abort();
    const cfg: OpenClawConfig = {};

    await expect(
      deliverOutboundPayloads({
        cfg,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "a" }],
        deps: { matrix: sendMatrix },
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow("Operation aborted");

    expect(queueMocks.ackDelivery).toHaveBeenCalledWith("mock-queue-id");
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
    expect(sendMatrix).not.toHaveBeenCalled();
  });

  it("passes normalized payload to onError", async () => {
    const sendMatrix = vi.fn().mockRejectedValue(new Error("boom"));
    const onError = vi.fn();
    const cfg: OpenClawConfig = {};

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hi", mediaUrl: "https://x.test/a.jpg" }],
      deps: { matrix: sendMatrix },
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
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      deps: { matrix: sendMatrix },
    });

    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ to: "!room:example", content: "hello", success: true }),
      expect.objectContaining({ channelId: "matrix" }),
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

    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      deps: { matrix: sendMatrix },
    });

    expect(hookMocks.runner.runMessageSending).toHaveBeenCalledTimes(1);
    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
    expect(sendMatrix).not.toHaveBeenCalled();
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

  it("does not fail successful sends when optional delivery pinning fails", async () => {
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-1" });
    const pinDeliveredMessage = vi.fn().mockRejectedValue(new Error("pin denied"));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText, pinDeliveredMessage },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "hello", delivery: { pin: true } }],
    });

    expect(results).toEqual([{ channel: "matrix", messageId: "mx-1" }]);
    expect(pinDeliveredMessage).toHaveBeenCalledTimes(1);
    expect(logMocks.warn).toHaveBeenCalledWith(
      "Delivery pin requested, but channel failed to pin delivered message.",
      expect.objectContaining({
        channel: "matrix",
        messageId: "mx-1",
        error: "pin denied",
      }),
    );
  });

  it("fails sends when required delivery pinning fails", async () => {
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-1" });
    const pinDeliveredMessage = vi.fn().mockRejectedValue(new Error("pin denied"));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText, pinDeliveredMessage },
          }),
        },
      ]),
    );

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:1",
        payloads: [{ text: "hello", delivery: { pin: { enabled: true, required: true } } }],
      }),
    ).rejects.toThrow("pin denied");
  });

  it("pins the first delivered text chunk for chunked payloads", async () => {
    const sendText = vi
      .fn()
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-1" })
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-2" });
    const pinDeliveredMessage = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              chunker: chunkText,
              chunkerMode: "text",
              textChunkLimit: 2,
              sendText,
              pinDeliveredMessage,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "abcd", delivery: { pin: true } }],
    });

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(pinDeliveredMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "mx-1" }),
    );
  });

  it("pins the first delivered media message for multi-media payloads", async () => {
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-text" });
    const sendMedia = vi
      .fn()
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-1" })
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-2" });
    const pinDeliveredMessage = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText, sendMedia, pinDeliveredMessage },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [
        {
          text: "caption",
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
          delivery: { pin: true },
        },
      ],
    });

    expect(sendMedia).toHaveBeenCalledTimes(2);
    expect(pinDeliveredMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "mx-1" }),
    );
  });

  it("preserves channelData-only payloads with empty text for sendPayload channels", async () => {
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
    const sendMatrix = vi.fn().mockRejectedValue(new Error("downstream failed"));

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hi" }],
        deps: { matrix: sendMatrix },
      }),
    ).rejects.toThrow("downstream failed");

    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "!room:example",
        content: "hi",
        success: false,
        error: "downstream failed",
      }),
      expect.objectContaining({ channelId: "matrix" }),
    );
  });
});

const emptyRegistry = createTestRegistry([]);
const defaultRegistry = createTestRegistry([
  {
    pluginId: "matrix",
    plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForTest }),
    source: "test",
  },
]);
