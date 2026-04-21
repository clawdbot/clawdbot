import {
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
  type OutboundPayloadHarnessParams,
} from "openclaw/plugin-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./accounts.test-mocks.js";
import "./zalo-js.test-mocks.js";
import type { ReplyPayload } from "../runtime-api.js";
import { zalouserPlugin } from "./channel.js";
import { setZalouserRuntime } from "./runtime.js";
import * as sendModule from "./send.js";

vi.mock("./send.js", () => ({
  sendMessageZalouser: vi.fn().mockResolvedValue({ ok: true, messageId: "zlu-1" }),
  sendReactionZalouser: vi.fn().mockResolvedValue({ ok: true }),
}));

function baseCtx(payload: ReplyPayload) {
  return {
    cfg: {},
    to: "user:987654321",
    text: "",
    payload,
  };
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
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-g1" });

    const result = await zalouserPlugin.outbound!.sendPayload!({
      ...baseCtx({ text: "hello group" }),
      to: "group:1471383327500481391",
    });

    expect(mockedSend).toHaveBeenCalledWith(
      "1471383327500481391",
      "hello group",
      expect.objectContaining({ isGroup: true, textMode: "markdown" }),
    );
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-g1" });
  });

  it("treats bare numeric targets as direct chats for backward compatibility", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-d1" });

    const result = await zalouserPlugin.outbound!.sendPayload!({
      ...baseCtx({ text: "hello" }),
      to: "987654321",
    });

    expect(mockedSend).toHaveBeenCalledWith(
      "987654321",
      "hello",
      expect.objectContaining({ isGroup: false, textMode: "markdown" }),
    );
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-d1" });
  });

  it("preserves provider-native group ids when sending to raw g- targets", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-g-native" });

    const result = await zalouserPlugin.outbound!.sendPayload!({
      ...baseCtx({ text: "hello native group" }),
      to: "g-1471383327500481391",
    });

    expect(mockedSend).toHaveBeenCalledWith(
      "g-1471383327500481391",
      "hello native group",
      expect.objectContaining({ isGroup: true, textMode: "markdown" }),
    );
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-g-native" });
  });

  it("passes long markdown through once so formatting happens before chunking", async () => {
    const text = `**${"a".repeat(2501)}**`;
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-code" });

    const result = await zalouserPlugin.outbound!.sendPayload!({
      ...baseCtx({ text }),
      to: "987654321",
    });

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend).toHaveBeenCalledWith(
      "987654321",
      text,
      expect.objectContaining({
        isGroup: false,
        textMode: "markdown",
        textChunkMode: "length",
        textChunkLimit: 1200,
      }),
    );
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-code" });
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
    return {
      run: async () => await zalouserPlugin.outbound!.sendPayload!(ctx),
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
