import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { buildOutboundResultEnvelope } from "./envelope.js";
import type { OutboundDeliveryJson } from "./format.js";

describe("buildOutboundResultEnvelope", () => {
  const delivery: OutboundDeliveryJson = {
    channel: "alpha",
    via: "direct",
    to: "123",
    messageId: "m1",
    mediaUrl: null,
    chatId: "c1",
  };
  const payloads = [{ text: "hi", mediaUrl: null, mediaUrls: undefined }];

  it.each([
    {
      input: { delivery },
      expected: delivery,
    },
    {
      input: {
        payloads,
        meta: { ok: true },
      },
      expected: {
        payloads: [{ text: "hi", mediaUrl: null, mediaUrls: undefined }],
        meta: { ok: true },
      },
    },
  ])("formats outbound envelope for %j", ({ input, expected }) => {
    const envelope = buildOutboundResultEnvelope(input);
    expect(envelope).toEqual(expected);
    if ("payloads" in input) {
      expect((envelope as { payloads: unknown[] }).payloads).not.toBe(input.payloads);
    }
  });

  it("normalizes reply payloads and keeps wrapped delivery when flattening is disabled", () => {
    const payloads: ReplyPayload[] = [{ text: "hello" }];

    expect(
      buildOutboundResultEnvelope({
        payloads,
        delivery,
        flattenDelivery: false,
      }),
    ).toEqual({
      payloads: [
        {
          text: "hello",
          mediaUrl: null,
          channelData: undefined,
        },
      ],
      delivery,
    });
  });
});
