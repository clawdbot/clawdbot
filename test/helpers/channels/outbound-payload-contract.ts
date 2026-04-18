import { beforeEach, expect, it, type Mock, vi } from "vitest";
import type { ReplyPayload } from "../../../src/auto-reply/types.js";
import { primeChannelOutboundSendMock } from "../../../src/channels/plugins/contracts/test-helpers.js";
import { createDirectTextMediaOutbound } from "../../../src/channels/plugins/outbound/direct-text-media.js";
import type { ChannelOutboundAdapter } from "../../../src/channels/plugins/types.js";
import { sendPayloadWithChunkedTextAndMedia } from "../../../src/plugin-sdk/reply-payload.js";
import { chunkTextForOutbound } from "../../../src/plugin-sdk/text-chunking.js";
import { resetGlobalHookRunner } from "../../../src/plugins/hook-runner-global.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../../src/test-utils/bundled-plugin-public-surface.js";
type CreateSlackOutboundPayloadHarness = (params: PayloadHarnessParams) => {
  run: () => Promise<Record<string, unknown>>;
  sendMock: Mock;
  to: string;
};

const discordOutboundAdapterModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "discord",
  artifactBasename: "src/outbound-adapter.js",
});
const slackTestApiModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "slack",
  artifactBasename: "outbound-payload-test-api.js",
});
const whatsappTestApiModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "whatsapp",
  artifactBasename: "outbound-payload-test-api.js",
});

let discordOutboundCache: Promise<ChannelOutboundAdapter> | undefined;
let slackTestApiPromise:
  | Promise<{
      createSlackOutboundPayloadHarness: CreateSlackOutboundPayloadHarness;
    }>
  | undefined;
let whatsappTestApiPromise:
  | Promise<{
      whatsappOutbound: ChannelOutboundAdapter;
    }>
  | undefined;

async function getDiscordOutbound(): Promise<ChannelOutboundAdapter> {
  discordOutboundCache ??= (async () => {
    const module = (await import(discordOutboundAdapterModuleId)) as {
      discordOutbound: ChannelOutboundAdapter;
    };
    return module.discordOutbound;
  })();
  return await discordOutboundCache;
}

async function getCreateSlackOutboundPayloadHarness(): Promise<CreateSlackOutboundPayloadHarness> {
  slackTestApiPromise ??= import(slackTestApiModuleId) as Promise<{
    createSlackOutboundPayloadHarness: CreateSlackOutboundPayloadHarness;
  }>;
  const { createSlackOutboundPayloadHarness } = await slackTestApiPromise;
  return createSlackOutboundPayloadHarness;
}

async function getWhatsAppOutboundAsync(): Promise<ChannelOutboundAdapter> {
  whatsappTestApiPromise ??= import(whatsappTestApiModuleId) as Promise<{
    whatsappOutbound: ChannelOutboundAdapter;
  }>;
  const { whatsappOutbound } = await whatsappTestApiPromise;
  return whatsappOutbound;
}

type PayloadHarnessParams = {
  payload: ReplyPayload;
  sendResults?: Array<{ messageId: string }>;
};

type PayloadLike = {
  mediaUrl?: string;
  mediaUrls?: string[];
  text?: string;
};

type SendResultLike = {
  messageId: string;
  [key: string]: unknown;
};

type ChunkingMode =
  | {
      longTextLength: number;
      maxChunkLength: number;
      mode: "split";
    }
  | {
      longTextLength: number;
      mode: "passthrough";
    };

function installChannelOutboundPayloadContractSuite(params: {
  channel: string;
  chunking: ChunkingMode;
  createHarness: (params: { payload: PayloadLike; sendResults?: SendResultLike[] }) =>
    | {
        run: () => Promise<Record<string, unknown>>;
        sendMock: Mock;
        to: string;
      }
    | Promise<{
        run: () => Promise<Record<string, unknown>>;
        sendMock: Mock;
        to: string;
      }>;
}) {
  beforeEach(() => {
    resetGlobalHookRunner();
  });

  it("text-only delegates to sendText", async () => {
    const { run, sendMock, to } = await params.createHarness({
      payload: { text: "hello" },
    });
    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(to, "hello", expect.any(Object));
    expect(result).toMatchObject({ channel: params.channel });
  });

  it("single media delegates to sendMedia", async () => {
    const { run, sendMock, to } = await params.createHarness({
      payload: { text: "cap", mediaUrl: "https://example.com/a.jpg" },
    });
    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      to,
      "cap",
      expect.objectContaining({ mediaUrl: "https://example.com/a.jpg" }),
    );
    expect(result).toMatchObject({ channel: params.channel });
  });

  it("multi-media iterates URLs with caption on first", async () => {
    const { run, sendMock, to } = await params.createHarness({
      payload: {
        text: "caption",
        mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
      },
      sendResults: [{ messageId: "m-1" }, { messageId: "m-2" }],
    });
    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenNthCalledWith(
      1,
      to,
      "caption",
      expect.objectContaining({ mediaUrl: "https://example.com/1.jpg" }),
    );
    expect(sendMock).toHaveBeenNthCalledWith(
      2,
      to,
      "",
      expect.objectContaining({ mediaUrl: "https://example.com/2.jpg" }),
    );
    expect(result).toMatchObject({ channel: params.channel, messageId: "m-2" });
  });

  it("empty payload returns no-op", async () => {
    const { run, sendMock } = await params.createHarness({ payload: {} });
    const result = await run();

    expect(sendMock).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: params.channel, messageId: "" });
  });

  if (params.chunking.mode === "passthrough") {
    it("text exceeding chunk limit is sent as-is when chunker is null", async () => {
      const text = "a".repeat(params.chunking.longTextLength);
      const { run, sendMock, to } = await params.createHarness({ payload: { text } });
      const result = await run();

      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock).toHaveBeenCalledWith(to, text, expect.any(Object));
      expect(result).toMatchObject({ channel: params.channel });
    });
    return;
  }

  const chunking = params.chunking;

  it("chunking splits long text", async () => {
    const text = "a".repeat(chunking.longTextLength);
    const { run, sendMock } = await params.createHarness({
      payload: { text },
      sendResults: [{ messageId: "c-1" }, { messageId: "c-2" }],
    });
    const result = await run();

    expect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of sendMock.mock.calls) {
      expect((call[1] as string).length).toBeLessThanOrEqual(chunking.maxChunkLength);
    }
    expect(result).toMatchObject({ channel: params.channel });
  });
}

function buildChannelSendResult(channel: string, result: Record<string, unknown>) {
  return {
    channel,
    messageId: typeof result.messageId === "string" ? result.messageId : "",
  };
}

function createDiscordHarness(params: PayloadHarnessParams) {
  const sendDiscord = vi.fn();
  primeChannelOutboundSendMock(
    sendDiscord,
    { messageId: "dc-1", channelId: "123456" },
    params.sendResults,
  );
  const ctx = {
    cfg: {},
    to: "channel:123456",
    text: "",
    payload: params.payload,
    deps: {
      sendDiscord,
    },
  };
  return {
    run: async () => await (await getDiscordOutbound()).sendPayload!(ctx),
    sendMock: sendDiscord,
    to: ctx.to,
  };
}

function createWhatsAppHarness(params: PayloadHarnessParams) {
  const sendWhatsApp = vi.fn();
  primeChannelOutboundSendMock(sendWhatsApp, { messageId: "wa-1" }, params.sendResults);
  const ctx = {
    cfg: {},
    to: "5511999999999@c.us",
    text: "",
    payload: params.payload,
    deps: {
      whatsapp: sendWhatsApp,
    },
  };
  return {
    run: async () => await (await getWhatsAppOutboundAsync()).sendPayload!(ctx),
    sendMock: sendWhatsApp,
    to: ctx.to,
  };
}

function createDirectTextMediaHarness(params: PayloadHarnessParams) {
  const sendFn = vi.fn();
  primeChannelOutboundSendMock(sendFn, { messageId: "m1" }, params.sendResults);
  const outbound = createDirectTextMediaOutbound({
    channel: "imessage",
    resolveSender: () => sendFn,
    resolveMaxBytes: () => undefined,
    buildTextOptions: (opts) => opts as never,
    buildMediaOptions: (opts) => opts as never,
  });
  const ctx = {
    cfg: {},
    to: "user1",
    text: "",
    payload: params.payload,
  };
  return {
    run: async () => await outbound.sendPayload!(ctx),
    sendMock: sendFn,
    to: ctx.to,
  };
}

function createZaloHarness(params: PayloadHarnessParams) {
  const sendZalo = vi.fn();
  primeChannelOutboundSendMock(sendZalo, { ok: true, messageId: "zl-1" }, params.sendResults);
  const ctx = {
    cfg: {},
    to: "123456789",
    text: "",
    payload: params.payload,
  };
  return {
    run: async () =>
      await sendPayloadWithChunkedTextAndMedia({
        ctx,
        textChunkLimit: 2000,
        chunker: chunkTextForOutbound,
        sendText: async (nextCtx) =>
          buildChannelSendResult(
            "zalo",
            await sendZalo(nextCtx.to, nextCtx.text, {
              accountId: undefined,
              cfg: nextCtx.cfg,
            }),
          ),
        sendMedia: async (nextCtx) =>
          buildChannelSendResult(
            "zalo",
            await sendZalo(nextCtx.to, nextCtx.text, {
              accountId: undefined,
              cfg: nextCtx.cfg,
              mediaUrl: nextCtx.mediaUrl,
            }),
          ),
        emptyResult: { channel: "zalo", messageId: "" },
      }),
    sendMock: sendZalo,
    to: ctx.to,
  };
}

function createZalouserHarness(params: PayloadHarnessParams) {
  const sendZalouser = vi.fn();
  primeChannelOutboundSendMock(sendZalouser, { ok: true, messageId: "zlu-1" }, params.sendResults);
  const ctx = {
    cfg: {},
    to: "987654321",
    text: "",
    payload: params.payload,
  };
  return {
    run: async () =>
      await sendPayloadWithChunkedTextAndMedia({
        ctx,
        sendText: async (nextCtx) => {
          return buildChannelSendResult(
            "zalouser",
            await sendZalouser(nextCtx.to, nextCtx.text, {
              profile: "default",
              isGroup: false,
              textMode: "markdown",
              textChunkMode: "length",
              textChunkLimit: 1200,
            }),
          );
        },
        sendMedia: async (nextCtx) => {
          return buildChannelSendResult(
            "zalouser",
            await sendZalouser(nextCtx.to, nextCtx.text, {
              profile: "default",
              isGroup: false,
              mediaUrl: nextCtx.mediaUrl,
              textMode: "markdown",
              textChunkMode: "length",
              textChunkLimit: 1200,
            }),
          );
        },
        emptyResult: { channel: "zalouser", messageId: "" },
      }),
    sendMock: sendZalouser,
    to: ctx.to,
  };
}

export function installSlackOutboundPayloadContractSuite() {
  installChannelOutboundPayloadContractSuite({
    channel: "slack",
    chunking: { mode: "passthrough", longTextLength: 5000 },
    createHarness: async (params) => (await getCreateSlackOutboundPayloadHarness())(params),
  });
}

export function installDiscordOutboundPayloadContractSuite() {
  installChannelOutboundPayloadContractSuite({
    channel: "discord",
    chunking: { mode: "passthrough", longTextLength: 3000 },
    createHarness: createDiscordHarness,
  });
}

export function installWhatsAppOutboundPayloadContractSuite() {
  installChannelOutboundPayloadContractSuite({
    channel: "whatsapp",
    chunking: { mode: "split", longTextLength: 5000, maxChunkLength: 4000 },
    createHarness: createWhatsAppHarness,
  });
}

export function installZaloOutboundPayloadContractSuite() {
  installChannelOutboundPayloadContractSuite({
    channel: "zalo",
    chunking: { mode: "split", longTextLength: 3000, maxChunkLength: 2000 },
    createHarness: createZaloHarness,
  });
}

export function installZalouserOutboundPayloadContractSuite() {
  installChannelOutboundPayloadContractSuite({
    channel: "zalouser",
    chunking: { mode: "passthrough", longTextLength: 3000 },
    createHarness: createZalouserHarness,
  });
}

export function installDirectTextMediaOutboundPayloadContractSuite() {
  installChannelOutboundPayloadContractSuite({
    channel: "imessage",
    chunking: { mode: "split", longTextLength: 5000, maxChunkLength: 4000 },
    createHarness: createDirectTextMediaHarness,
  });
}
