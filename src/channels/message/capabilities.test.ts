// Message capability tests cover channel message feature detection and compatibility.
import { describe, expect, it } from "vitest";
import {
  deriveDurableFinalDeliveryRequirements,
  deriveDurableFinalDeliveryRequirementsForBatch,
} from "./capabilities.js";

describe("deriveDurableFinalDeliveryRequirements", () => {
  it("derives the default durable final text and hook requirements", () => {
    expect(deriveDurableFinalDeliveryRequirements({ payload: { text: "hello" } })).toEqual({
      text: true,
      messageSendingHooks: true,
    });
  });

  it("derives payload-dependent delivery requirements", () => {
    expect(
      deriveDurableFinalDeliveryRequirements({
        payload: {
          text: "caption",
          mediaUrls: ["https://example.com/a.png"],
          replyToId: "reply-1",
        },
        threadId: 42,
        silent: true,
        payloadTransport: true,
        batch: true,
        reconcileUnknownSend: true,
        afterSendSuccess: true,
        afterCommit: true,
      }),
    ).toEqual({
      text: true,
      media: true,
      replyTo: true,
      thread: true,
      silent: true,
      messageSendingHooks: true,
      payload: true,
      batch: true,
      reconcileUnknownSend: true,
      afterSendSuccess: true,
      afterCommit: true,
    });
  });

  it("applies channel-native extras without recording false requirements", () => {
    expect(
      deriveDurableFinalDeliveryRequirements({
        payload: { text: "hello" },
        extraCapabilities: {
          nativeQuote: false,
          thread: true,
        },
      }),
    ).toEqual({
      text: true,
      thread: true,
      messageSendingHooks: true,
    });
  });
});

describe("deriveDurableFinalDeliveryRequirementsForBatch", () => {
  it("unions capabilities across the final prepared payloads", () => {
    expect(
      deriveDurableFinalDeliveryRequirementsForBatch({
        payloads: [
          { text: "first" },
          {
            text: "caption",
            mediaUrl: "https://example.com/a.png",
            presentation: { blocks: [{ type: "text", text: "card" }] },
          },
        ],
        replyToId: "reply-1",
        reconcileUnknownSend: true,
      }),
    ).toEqual({
      text: true,
      media: true,
      replyTo: true,
      messageSendingHooks: true,
      payload: true,
      batch: true,
      reconcileUnknownSend: true,
    });
  });

  it("returns no transport requirements for an entirely suppressed batch", () => {
    expect(
      deriveDurableFinalDeliveryRequirementsForBatch({
        payloads: [],
        reconcileUnknownSend: true,
      }),
    ).toEqual({});
  });

  it("keeps post-send delivery directives on the concrete text transport", () => {
    expect(
      deriveDurableFinalDeliveryRequirementsForBatch({
        payloads: [{ text: "pin this", delivery: { pin: true } }],
        reconcileUnknownSend: true,
      }),
    ).toEqual({
      text: true,
      messageSendingHooks: true,
      reconcileUnknownSend: true,
    });
  });

  it("requires payload transport for structured send content", () => {
    expect(
      deriveDurableFinalDeliveryRequirementsForBatch({
        payloads: [{ text: "Meet here", location: { latitude: 1, longitude: 2 } }],
      }),
    ).toMatchObject({ text: true, payload: true });
  });
});
