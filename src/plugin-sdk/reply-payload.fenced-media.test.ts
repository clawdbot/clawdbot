// Fenced MEDIA diagnostic coverage for shared direct outbound helpers (#41966).
import { describe, expect, it, vi } from "vitest";

const warnFencedMediaSkipsForAcceptedOutboundDelivery = vi.hoisted(() => vi.fn());
vi.mock("./channel-outbound-fenced-media-warn.js", () => ({
  warnFencedMediaSkipsForAcceptedOutboundDelivery: (
    ...args: Parameters<typeof warnFencedMediaSkipsForAcceptedOutboundDelivery>
  ) => warnFencedMediaSkipsForAcceptedOutboundDelivery(...args),
}));

import { createDirectAcceptedFencedMediaWarnLatch } from "./channel-outbound-fenced-media-latch.js";
import {
  deliverFormattedTextWithAttachments,
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
      }),
    ).resolves.toBe("text");

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).toHaveBeenCalledTimes(1);
    const arg = warnFencedMediaSkipsForAcceptedOutboundDelivery.mock.calls[0]?.[0] as
      | Array<{ fencedSkippedMediaDirectives?: string[] }>
      | undefined;
    expect(arg?.[0]?.fencedSkippedMediaDirectives).toEqual(["MEDIA:/tmp/demo.png"]);
  });

  it("stays silent when extractMediaDirectives is disabled on direct latch (#41966)", async () => {
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockReset();
    const fenced = "```\nMEDIA:/tmp/demo.png\n```";
    const sendMedia = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        payload: { text: fenced, extractMediaDirectives: false } as never,
        text: fenced,
        sendText,
        sendMedia,
      }),
    ).resolves.toBe("text");

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).not.toHaveBeenCalled();
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
      }),
    ).resolves.toBe("media");

    expect(sendMedia).toHaveBeenCalledTimes(2);
    expect(sendText).not.toHaveBeenCalled();
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).not.toHaveBeenCalled();
  });
});

describe("deliverFormattedTextWithAttachments fenced MEDIA diagnostic (#41966)", () => {
  it("warns once after accepted formatted direct send (IRC/Nextcloud owner) (#41966)", async () => {
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockReset();
    const fenced = "```\nMEDIA:/tmp/demo.png\n```";
    const send = vi.fn(async () => undefined);

    await expect(
      deliverFormattedTextWithAttachments({
        payload: { text: fenced },
        send,
      }),
    ).resolves.toBe(true);

    expect(send).toHaveBeenCalledTimes(1);
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).toHaveBeenCalledTimes(1);
    const arg = warnFencedMediaSkipsForAcceptedOutboundDelivery.mock.calls[0]?.[0] as
      | Array<{ fencedSkippedMediaDirectives?: string[] }>
      | undefined;
    expect(arg?.[0]?.fencedSkippedMediaDirectives).toEqual(["MEDIA:/tmp/demo.png"]);
  });

  it("does not warn when formatted direct send rejects (#41966)", async () => {
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockReset();
    const fenced = "```\nMEDIA:/tmp/demo.png\n```";
    const send = vi.fn(async () => {
      throw new Error("send failed");
    });

    await expect(
      deliverFormattedTextWithAttachments({
        payload: { text: fenced },
        send,
      }),
    ).rejects.toThrow("send failed");

    expect(send).toHaveBeenCalledTimes(1);
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).not.toHaveBeenCalled();
  });

  it("stays silent for unfenced MEDIA on formatted direct owner (#41966)", async () => {
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockReset();
    const plain = "MEDIA:/tmp/demo.png";
    const send = vi.fn(async () => undefined);

    await expect(
      deliverFormattedTextWithAttachments({
        payload: { text: plain },
        send,
      }),
    ).resolves.toBe(true);

    expect(send).toHaveBeenCalledTimes(1);
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
      ctx: { payload: { text: fenced } },
      sendText: async (ctx) => ({ channel: "zalo", messageId: ctx.text }),
      sendMedia: async () => ({ channel: "zalo", messageId: "media" }),
      emptyResult: { channel: "zalo", messageId: "" },
    });
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).not.toHaveBeenCalled();
  });

  it("stays silent for preamble-only accepted text when fenced identity is not sent", async () => {
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockReset();
    const fenced = "preamble\n```\nMEDIA:/tmp/demo.png\n```";
    await sendPayloadWithChunkedTextAndMedia({
      ctx: { payload: { text: fenced } },
      textChunkLimit: 8,
      chunker: () => ["preamble"],
      sendText: async (ctx) => ({ channel: "zalo", messageId: ctx.text }),
      sendMedia: async () => ({ channel: "zalo", messageId: "media" }),
      emptyResult: { channel: "zalo", messageId: "" },
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

describe("createDirectAcceptedFencedMediaWarnLatch hard-split (#41966)", () => {
  it("warns when hard-split chunks reassemble the directive without synthetic newlines", () => {
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockReset();
    const directive = "MEDIA:/tmp/" + "a".repeat(60) + ".png";
    const payload = { text: ["```", directive, "```"].join("\n") };
    const latch = createDirectAcceptedFencedMediaWarnLatch({
      payload,
    });
    const mid = Math.floor(directive.length / 2);
    latch.afterAcceptedVisibleText(["```", directive.slice(0, mid)].join("\n"));
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).not.toHaveBeenCalled();
    latch.afterAcceptedVisibleText(directive.slice(mid) + "\n```");
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).toHaveBeenCalledTimes(1);
  });
});

describe("createDirectAcceptedFencedMediaWarnLatch extractMediaDirectives mode (#41966)", () => {
  it("does not warn when extractMediaDirectives is false even for fenced MEDIA", () => {
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockReset();
    const fenced = "```\nMEDIA:/tmp/demo.png\n```";
    const latch = createDirectAcceptedFencedMediaWarnLatch({
      payload: { text: fenced, extractMediaDirectives: false } as never,
    });
    latch.afterAcceptedVisibleText(fenced);
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).not.toHaveBeenCalled();
  });

  it("warns when extractMediaDirectives is enabled/default for fenced MEDIA", () => {
    warnFencedMediaSkipsForAcceptedOutboundDelivery.mockReset();
    const fenced = "```\nMEDIA:/tmp/demo.png\n```";
    const latch = createDirectAcceptedFencedMediaWarnLatch({
      payload: { text: fenced },
    });
    latch.afterAcceptedVisibleText(fenced);
    expect(warnFencedMediaSkipsForAcceptedOutboundDelivery).toHaveBeenCalledTimes(1);
  });
});
