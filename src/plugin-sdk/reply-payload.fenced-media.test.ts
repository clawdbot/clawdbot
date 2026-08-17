// Fenced MEDIA diagnostic coverage for shared direct outbound helpers (#41966).
import { describe, expect, it, vi } from "vitest";

const warnFencedMediaSkipsForAcceptedOutboundDelivery = vi.hoisted(() => vi.fn());
vi.mock("./channel-outbound-fenced-media-runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./channel-outbound-fenced-media-runtime.js")>();
  return {
    ...actual,
    warnFencedMediaSkipsForAcceptedOutboundDelivery: (
      ...args: Parameters<typeof warnFencedMediaSkipsForAcceptedOutboundDelivery>
    ) => warnFencedMediaSkipsForAcceptedOutboundDelivery(...args),
  };
});

import {
  deliverTextOrMediaReply,
  sendPayloadWithChunkedTextAndMedia,
  sendTextMediaPayload,
} from "./reply-payload.js";

describe("deliverTextOrMediaReply fenced MEDIA diagnostic (#41966)", () => {
  it("warns once after accepted fenced MEDIA text on the shared direct owner (#41966)", async () => {
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockReset();
    const fenced = "```\nMEDIA:/tmp/demo.png\n```";
    const sendMedia = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        payload: { text: fenced },
        text: fenced,
        sendText,
        sendMedia,
        surface: "imessage",
        cfg: {},
      }),
    ).resolves.toBe("text");

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).toHaveBeenCalledTimes(1);
    const arg = warnFencedMediaSkipsForAcceptedOutboundDelivery.mock.calls[0]?.[0] as
      | Array<{ fencedSkippedMediaDirectives?: string[] }>
      | undefined;
    expect(arg?.[0]?.fencedSkippedMediaDirectives).toEqual(["MEDIA:/tmp/demo.png"]);
  });

  it("stays silent for unfenced MEDIA control on shared direct owner (#41966)", async () => {
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockReset();
    const plain = "MEDIA:/tmp/demo.png";
    const sendMedia = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        payload: { text: plain },
        text: plain,
        sendText,
        sendMedia,
        surface: "zalo",
        cfg: {},
      }),
    ).resolves.toBe("text");

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).not.toHaveBeenCalled();
  });

  it("does not warn when caption-bearing media fails then later media succeeds (#41966)", async () => {
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockReset();
    const fenced = "```\nMEDIA:/tmp/demo.png\n```";
    let calls = 0;
    const sendMedia = vi.fn(async ({ caption }: { mediaUrl: string; caption?: string }) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("first media failed");
      }
      // recovered send intentionally has no caption
      expect(caption).toBeUndefined();
    });
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        payload: {
          text: fenced,
          mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
        },
        text: fenced,
        sendText,
        sendMedia,
        onMediaError: async () => {
          // handled failure — continue to next media
        },
        surface: "imessage",
        cfg: {},
      }),
    ).resolves.toBe("media");

    expect(sendMedia).toHaveBeenCalledTimes(2);
    expect(sendText).not.toHaveBeenCalled();
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).not.toHaveBeenCalled();
  });
});

describe("direct sendPayload fenced MEDIA diagnostic (#41966)", () => {
  it("sendPayloadWithChunkedTextAndMedia leaves fenced-MEDIA warn to core (#41966)", async () => {
    // Zalo/Zalouser wire this helper as outbound.sendPayload; core warns after
    // identified delivery. Helper must stay silent to avoid double diagnostics.
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockReset();
    const fenced = "```\nMEDIA:/tmp/demo.png\n```";
    await sendPayloadWithChunkedTextAndMedia({
      ctx: { payload: { text: fenced }, cfg: {} },
      sendText: async (ctx) => ({ channel: "zalo", messageId: ctx.text }),
      sendMedia: async () => ({ channel: "zalo", messageId: "media" }),
      emptyResult: { channel: "zalo", messageId: "" },
      surface: "zalo",
    });
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).not.toHaveBeenCalled();
  });

  it("stays silent for preamble-only accepted text when fenced identity is not sent", async () => {
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockReset();
    const fenced = "preamble\n```\nMEDIA:/tmp/demo.png\n```";
    await sendPayloadWithChunkedTextAndMedia({
      ctx: { payload: { text: fenced }, cfg: {} },
      textChunkLimit: 8,
      chunker: () => ["preamble"],
      sendText: async (ctx) => ({ channel: "zalo", messageId: ctx.text }),
      sendMedia: async () => ({ channel: "zalo", messageId: "media" }),
      emptyResult: { channel: "zalo", messageId: "" },
      surface: "zalo",
    });
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).not.toHaveBeenCalled();
  });

  it("sendTextMediaPayload leaves fenced-MEDIA warn to core delivery owner (#41966)", async () => {
    // Slack/Discord/iMessage-style adapter payload sends are core-mediated; the
    // shared helper must not double-log after core's retained-identity latch.
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockReset();
    const fenced = "```\nMEDIA:/tmp/demo.png\n```";
    await sendTextMediaPayload({
      channel: "imessage",
      ctx: {
        cfg: {},
        to: "chat_id",
        payload: { text: fenced },
      } as never,
      adapter: {
        sendText: async ({ text }) => ({ channel: "imessage", messageId: text }),
        sendMedia: async () => ({ channel: "imessage", messageId: "media" }),
      },
    });
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).not.toHaveBeenCalled();
  });
});
