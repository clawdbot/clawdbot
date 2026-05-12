import {
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
  type OutboundPayloadHarnessParams,
} from "openclaw/plugin-sdk/channel-contract-testing";
import {
  createMessageReceiptFromOutboundResults,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-message";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./accounts.test-mocks.js";
import "./zalo-js.test-mocks.js";
import type { ReplyPayload } from "../runtime-api.js";
import { zalouserPlugin } from "./channel.js";
import { setZalouserRuntime } from "./runtime.js";
import * as sendModule from "./send.js";

vi.mock("./send.js", () => ({
  sendMessageZalouser: vi.fn().mockResolvedValue({ ok: true, messageId: "zlu-1" } as never),
  sendReactionZalouser: vi.fn().mockResolvedValue({ ok: true } as never),
}));

function baseCtx(payload: ReplyPayload) {
  return {
    cfg: {},
    to: "user:987654321",
    text: "",
    payload,
  };
}

type ZalouserOutbound = NonNullable<typeof zalouserPlugin.outbound>;
type ZalouserSendPayload = NonNullable<ZalouserOutbound["sendPayload"]>;
type ZalouserMessageAdapter = NonNullable<typeof zalouserPlugin.message>;
type ZalouserMessageSender = NonNullable<ZalouserMessageAdapter["send"]>;

function requireZalouserSendPayload(): ZalouserSendPayload {
  const sendPayload = zalouserPlugin.outbound?.sendPayload;
  if (!sendPayload) {
    throw new Error("Expected Zalouser outbound sendPayload");
  }
  return sendPayload;
}

function requireZalouserMessageAdapter(): ZalouserMessageAdapter {
  const adapter = zalouserPlugin.message;
  if (!adapter) {
    throw new Error("Expected Zalouser message adapter");
  }
  return adapter;
}

function requireZalouserTextSender(
  adapter: ZalouserMessageAdapter,
): NonNullable<ZalouserMessageSender["text"]> {
  const text = adapter.send?.text;
  if (!text) {
    throw new Error("Expected Zalouser message adapter text sender");
  }
  return text;
}

function requireZalouserMediaSender(
  adapter: ZalouserMessageAdapter,
): NonNullable<ZalouserMessageSender["media"]> {
  const media = adapter.send?.media;
  if (!media) {
    throw new Error("Expected Zalouser message adapter media sender");
  }
  return media;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function requireSendOptions(
  mockedSend: ReturnType<typeof vi.mocked<(typeof import("./send.js"))["sendMessageZalouser"]>>,
): Record<string, unknown> {
  return requireRecord(requireSendCall(mockedSend)[2], "Zalouser send options");
}

function requireSendCall(
  mockedSend: ReturnType<typeof vi.mocked<(typeof import("./send.js"))["sendMessageZalouser"]>>,
): unknown[] {
  const [call] = mockedSend.mock.calls as unknown[][];
  if (!call) {
    throw new Error("expected Zalouser send call");
  }
  return call;
}

describe("zalouserPlugin outbound sendPayload", () => {
  let mockedSend: ReturnType<typeof vi.mocked<(typeof import("./send.js"))["sendMessageZalouser"]>>;

  beforeEach(() => {
    setZalouserRuntime({
      channel: {
        text: {
          resolveChunkMode: vi.fn(() => "length"),
          resolveTextChunkLimit: vi.fn(() => 1200),
        },
      },
    } as never);
    mockedSend = vi.mocked(sendModule.sendMessageZalouser);
    primeChannelOutboundSendMock(mockedSend, { ok: true, messageId: "zlu-1" });
  });

  it("group target delegates with isGroup=true and stripped threadId", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-g1" } as never);
    const sendPayload = requireZalouserSendPayload();

    const result = await sendPayload({
      ...baseCtx({ text: "hello group" }),
      to: "group:1471383327500481391",
    });

    expect(mockedSend).toHaveBeenCalledOnce();
    const sendCall = requireSendCall(mockedSend);
    expect(sendCall[0]).toBe("1471383327500481391");
    expect(sendCall[1]).toBe("hello group");
    const options = requireSendOptions(mockedSend);
    expect(options.isGroup).toBe(true);
    expect(options.textMode).toBe("markdown");
    expect(result.channel).toBe("zalouser");
    expect(result.messageId).toBe("zlu-g1");
  });

  it("treats bare numeric targets as direct chats for backward compatibility", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-d1" } as never);
    const sendPayload = requireZalouserSendPayload();

    const result = await sendPayload({
      ...baseCtx({ text: "hello" }),
      to: "987654321",
    });

    expect(mockedSend).toHaveBeenCalledOnce();
    const sendCall = requireSendCall(mockedSend);
    expect(sendCall[0]).toBe("987654321");
    expect(sendCall[1]).toBe("hello");
    const options = requireSendOptions(mockedSend);
    expect(options.isGroup).toBe(false);
    expect(options.textMode).toBe("markdown");
    expect(result.channel).toBe("zalouser");
    expect(result.messageId).toBe("zlu-d1");
  });

  it("preserves provider-native group ids when sending to raw g- targets", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-g-native" } as never);
    const sendPayload = requireZalouserSendPayload();

    const result = await sendPayload({
      ...baseCtx({ text: "hello native group" }),
      to: "g-1471383327500481391",
    });

    expect(mockedSend).toHaveBeenCalledOnce();
    const sendCall = requireSendCall(mockedSend);
    expect(sendCall[0]).toBe("g-1471383327500481391");
    expect(sendCall[1]).toBe("hello native group");
    const options = requireSendOptions(mockedSend);
    expect(options.isGroup).toBe(true);
    expect(options.textMode).toBe("markdown");
    expect(result.channel).toBe("zalouser");
    expect(result.messageId).toBe("zlu-g-native");
  });

  it("passes long markdown through once so formatting happens before chunking", async () => {
    const text = `**${"a".repeat(2501)}**`;
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-code" } as never);
    const sendPayload = requireZalouserSendPayload();

    const result = await sendPayload({
      ...baseCtx({ text }),
      to: "987654321",
    });

    expect(mockedSend).toHaveBeenCalledTimes(1);
    const sendCall = requireSendCall(mockedSend);
    expect(sendCall[0]).toBe("987654321");
    expect(sendCall[1]).toBe(text);
    const options = requireSendOptions(mockedSend);
    expect(options.isGroup).toBe(false);
    expect(options.textMode).toBe("markdown");
    expect(options.textChunkMode).toBe("length");
    expect(options.textChunkLimit).toBe(1200);
    expect(result.channel).toBe("zalouser");
    expect(result.messageId).toBe("zlu-code");
  });

  it("declares message adapter durable text and media with receipt proofs", async () => {
    mockedSend.mockImplementation(async (_threadId, _text, opts: { mediaUrl?: string } = {}) =>
      opts.mediaUrl
        ? {
            ok: true,
            messageId: "zlu-media-1",
            receipt: createMessageReceiptFromOutboundResults({
              results: [{ channel: "zalouser", messageId: "zlu-media-1" }],
              kind: "media",
            }),
          }
        : {
            ok: true,
            messageId: "zlu-text-1",
            receipt: createMessageReceiptFromOutboundResults({
              results: [{ channel: "zalouser", messageId: "zlu-text-1" }],
              kind: "text",
            }),
          },
    );
    const adapter = requireZalouserMessageAdapter();
    const sendText = requireZalouserTextSender(adapter);
    const sendMedia = requireZalouserMediaSender(adapter);

    const proofs = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "zalouser",
      adapter,
      proofs: {
        text: async () => {
          const result = await sendText({
            cfg: {},
            to: "user:987654321",
            text: "hello",
          });
          expect(result.receipt.platformMessageIds).toEqual(["zlu-text-1"]);
        },
        media: async () => {
          const result = await sendMedia({
            cfg: {},
            to: "user:987654321",
            text: "image",
            mediaUrl: "https://example.com/image.png",
          });
          expect(result.receipt.platformMessageIds).toEqual(["zlu-media-1"]);
        },
        messageSendingHooks: () => {
          expect(adapter.durableFinal?.capabilities?.messageSendingHooks).toBe(true);
        },
      },
    });
    const proofStatusByCapability = new Map(
      proofs.map((proof) => [proof.capability, proof.status] as const),
    );
    expect(proofStatusByCapability.get("text")).toBe("verified");
    expect(proofStatusByCapability.get("media")).toBe("verified");
    expect(proofStatusByCapability.get("messageSendingHooks")).toBe("verified");
  });
});

describe("zalouserPlugin outbound payload contract", () => {
  function createZalouserHarness(params: OutboundPayloadHarnessParams) {
    const mockedSend = vi.mocked(sendModule.sendMessageZalouser);
    setZalouserRuntime({
      channel: {
        text: {
          resolveChunkMode: vi.fn(() => "length"),
          resolveTextChunkLimit: vi.fn(() => 1200),
        },
      },
    } as never);
    primeChannelOutboundSendMock(mockedSend, { ok: true, messageId: "zlu-1" }, params.sendResults);
    const ctx = {
      cfg: {},
      to: "user:987654321",
      text: "",
      payload: params.payload,
    };
    const sendPayload = requireZalouserSendPayload();
    return {
      run: async () => await sendPayload(ctx),
      sendMock: mockedSend,
      to: "987654321",
    };
  }

  installChannelOutboundPayloadContractSuite({
    channel: "zalouser",
    chunking: { mode: "passthrough", longTextLength: 3000 },
    createHarness: createZalouserHarness,
  });
});

describe("zalouserPlugin messaging target normalization", () => {
  it("normalizes user/group aliases to canonical targets", () => {
    const normalize = zalouserPlugin.messaging?.normalizeTarget;
    if (!normalize) {
      throw new Error("normalizeTarget unavailable");
    }
    expect(normalize("zlu:g:30003")).toBe("group:30003");
    expect(normalize("zalouser:u:20002")).toBe("user:20002");
    expect(normalize("zlu:g-30003")).toBe("group:g-30003");
    expect(normalize("zalouser:u-20002")).toBe("user:u-20002");
    expect(normalize("20002")).toBe("20002");
  });

  it("treats canonical and provider-native user/group targets as ids", () => {
    const looksLikeId = zalouserPlugin.messaging?.targetResolver?.looksLikeId;
    if (!looksLikeId) {
      throw new Error("looksLikeId unavailable");
    }
    expect(looksLikeId("user:20002")).toBe(true);
    expect(looksLikeId("group:30003")).toBe(true);
    expect(looksLikeId("g-30003")).toBe(true);
    expect(looksLikeId("u-20002")).toBe(true);
    expect(looksLikeId("Alice Nguyen")).toBe(false);
  });
});
