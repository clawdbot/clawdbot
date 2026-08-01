import { describe, expect, it } from "vitest";
import {
  collectAutomaticDeliveredMediaUrls,
  collectDeliveredMediaUrls,
  hasAmbiguousPayloadSendBeforeError,
  hasCompleteAutomaticMediaDeliveryOutcomeEvidence,
  hasCompletedSourceReplyDeliveryEvidence,
  hasIncompletePartialPayloadOutcomeEvidence,
  hasPayloadOutcomeSendEvidence,
  hasUnaccountedMessagingToolAggregateEvidence,
  hasVisibleOutboundDeliveryEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
} from "./delivery-evidence.js";
import {
  hasIntentionalSilentAgentPayload,
  hasVisibleAgentPayload,
  isMeaningfulTranscriptMessage,
  isTerminalSilentAssistantMessage,
} from "./message-visibility.js";

describe("explicit final source-reply delivery evidence", () => {
  it("distinguishes progress from a delivered final reply", () => {
    expect(
      resolveExplicitFinalSourceReplyDeliveryEvidence({
        messagingToolSentTargets: [{ sourceReplyFinal: false }],
      }),
    ).toBe(false);
    expect(
      resolveExplicitFinalSourceReplyDeliveryEvidence({
        messagingToolSentTargets: [{ sourceReplyFinal: false }, { sourceReplyFinal: true }],
      }),
    ).toBe(true);
    expect(
      resolveExplicitFinalSourceReplyDeliveryEvidence({
        messagingToolSourceReplyPayloads: [{ sourceReplyFinal: true }],
      }),
    ).toBe(true);
  });

  it("returns undefined for legacy telemetry without final markers", () => {
    expect(
      resolveExplicitFinalSourceReplyDeliveryEvidence({
        messagingToolSourceReplyPayloads: [{ text: "legacy reply" }],
      }),
    ).toBeUndefined();
  });

  it("preserves legacy completion evidence when no marker is present", () => {
    expect(
      hasCompletedSourceReplyDeliveryEvidence({
        didDeliverSourceReplyViaMessageTool: true,
      }),
    ).toBe(true);
  });
});

describe("visible messaging-tool delivery evidence", () => {
  it("keeps the coarse flag when detailed delivery metadata is unavailable", () => {
    expect(hasVisibleOutboundDeliveryEvidence({ didSendViaMessagingTool: true })).toBe(true);
  });

  it("lets detailed metadata disprove a coarse send flag", () => {
    expect(
      hasVisibleOutboundDeliveryEvidence({
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["  "],
        messagingToolSentMediaUrls: ["\t"],
        messagingToolSentTargets: [{ text: "\n" }],
      }),
    ).toBe(false);
  });

  it("keeps rich delivery evidence when accompanying text is blank", () => {
    expect(
      hasVisibleOutboundDeliveryEvidence({
        didSendViaMessagingTool: true,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [{ text: "  ", hasRichContent: true }],
      }),
    ).toBe(true);
  });
});

describe("route-checkable messaging-tool aggregate evidence", () => {
  it("accepts aggregate evidence fully represented by target records", () => {
    expect(
      hasUnaccountedMessagingToolAggregateEvidence({
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["ready"],
        messagingToolSentMediaUrls: ["/tmp/one.png"],
        messagingToolSentTargets: [
          {
            provider: "discord",
            to: "channel:123",
            text: "ready",
            mediaUrls: ["/tmp/one.png"],
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects aggregate sends missing from mixed target records", () => {
    expect(
      hasUnaccountedMessagingToolAggregateEvidence({
        didSendViaMessagingTool: true,
        messagingToolSentMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
        messagingToolSentTargets: [
          {
            provider: "discord",
            to: "channel:123",
            mediaUrls: ["/tmp/one.png"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("accounts for duplicate aggregate sends by multiplicity", () => {
    expect(
      hasUnaccountedMessagingToolAggregateEvidence({
        messagingToolSentMediaUrls: ["/tmp/proof.png", "/tmp/proof.png"],
        messagingToolSentTargets: [
          { provider: "discord", to: "channel:123", mediaUrls: ["/tmp/proof.png"] },
        ],
      }),
    ).toBe(true);
  });
});

describe("collectDeliveredMediaUrls attachment recursion", () => {
  it("collects media URLs across nested attachments", () => {
    const urls = collectDeliveredMediaUrls({
      payloads: [
        {
          url: "https://example.com/root.png",
          attachments: [
            { mediaUrl: "https://example.com/child.png" },
            { attachments: [{ filePath: "/tmp/grandchild.jpg" }] },
          ],
        },
      ],
    });
    expect(urls.toSorted()).toEqual([
      "/tmp/grandchild.jpg",
      "https://example.com/child.png",
      "https://example.com/root.png",
    ]);
  });

  it("does not overflow the stack on a self-referential attachments cycle", () => {
    // Payloads arrive as in-process `unknown` objects; a malformed self-referential
    // attachments chain previously recursed until the stack overflowed.
    const cyclic: Record<string, unknown> = { url: "https://example.com/loop.png" };
    cyclic.attachments = [cyclic];

    let urls: string[] = [];
    expect(() => {
      urls = collectDeliveredMediaUrls({ payloads: [cyclic] });
    }).not.toThrow();
    expect(urls).toEqual(["https://example.com/loop.png"]);
  });

  it("does not overflow on a mutual attachments cycle", () => {
    const a: Record<string, unknown> = { mediaUrl: "https://example.com/a.png" };
    const b: Record<string, unknown> = { mediaUrl: "https://example.com/b.png" };
    a.attachments = [b];
    b.attachments = [a];

    const urls = collectDeliveredMediaUrls({ payloads: [a] });
    expect(urls.toSorted()).toEqual(["https://example.com/a.png", "https://example.com/b.png"]);
  });
});

describe("queued delivery evidence", () => {
  it("requires exact per-payload evidence before retrying a partial media send", () => {
    const payloads = [{ text: "sent" }, { mediaUrls: ["/tmp/proof.png"] }];
    expect(
      hasCompleteAutomaticMediaDeliveryOutcomeEvidence(
        { payloads, deliveryStatus: { status: "partial_failed" } },
        ["/tmp/proof.png"],
      ),
    ).toBe(false);
    expect(
      hasCompleteAutomaticMediaDeliveryOutcomeEvidence(
        {
          payloads,
          deliveryStatus: {
            status: "partial_failed",
            payloadOutcomes: [
              { index: 0, status: "sent" },
              { index: 1, status: "failed", sentBeforeError: false },
            ],
          },
        },
        ["/tmp/proof.png"],
      ),
    ).toBe(true);
    expect(
      hasCompleteAutomaticMediaDeliveryOutcomeEvidence(
        {
          payloads,
          payloadsTruncated: true,
          deliveryStatus: {
            status: "partial_failed",
            payloadOutcomes: [{ index: 1, status: "failed", sentBeforeError: false }],
          },
        },
        ["/tmp/proof.png"],
      ),
    ).toBe(false);
  });

  it("does not credit hidden media as automatically delivered", () => {
    expect(
      collectAutomaticDeliveredMediaUrls({
        payloads: [
          { text: "visible reply" },
          { visible: false, mediaUrls: ["/tmp/private.png"] },
          { isReasoning: true, mediaUrls: ["/tmp/reasoning.png"] },
          { mediaUrls: ["/tmp/public.png"] },
        ],
        deliveryStatus: { status: "sent" },
      }),
    ).toEqual(["/tmp/public.png"]);
  });

  it("credits suppressed deliverable media as durably committed", () => {
    const payloads = [{ mediaUrls: ["/tmp/committed.png"] }];
    expect(
      collectAutomaticDeliveredMediaUrls({
        payloads,
        deliveryStatus: { status: "suppressed" },
      }),
    ).toEqual(["/tmp/committed.png"]);
    expect(
      collectAutomaticDeliveredMediaUrls({
        payloads,
        deliveryStatus: {
          status: "suppressed",
          payloadOutcomes: [{ index: 0, status: "suppressed" }],
        },
      }),
    ).toEqual(["/tmp/committed.png"]);
  });

  it("classifies partial payload outcomes in one canonical state machine", () => {
    const complete = {
      payloads: [{ text: "sent" }, { mediaUrls: ["/tmp/proof.png"] }],
      deliveryStatus: {
        status: "partial_failed",
        payloadOutcomes: [
          { index: 0, status: "sent" },
          { index: 1, status: "failed", sentBeforeError: true },
        ],
      },
    };
    expect(hasPayloadOutcomeSendEvidence(complete)).toBe(true);
    expect(hasAmbiguousPayloadSendBeforeError(complete)).toBe(true);
    expect(hasIncompletePartialPayloadOutcomeEvidence(complete)).toBe(false);
    expect(
      hasIncompletePartialPayloadOutcomeEvidence({
        ...complete,
        deliveryStatus: {
          ...complete.deliveryStatus,
          payloadOutcomes: complete.deliveryStatus.payloadOutcomes.slice(1),
        },
      }),
    ).toBe(true);
  });

  it("credits an ambiguous single-payload send only when requested", () => {
    const result = {
      payloads: [{ mediaUrls: ["/tmp/proof.png"] }],
      deliveryStatus: {
        status: "partial_failed",
        payloadOutcomes: [{ index: 0, status: "failed", sentBeforeError: true }],
      },
    };
    expect(
      collectAutomaticDeliveredMediaUrls(result, { includeSuppressedOutcomes: false }),
    ).toEqual([]);
    expect(
      collectAutomaticDeliveredMediaUrls(result, {
        includeAmbiguousSinglePayloadFailure: true,
        includeSuppressedOutcomes: false,
      }),
    ).toEqual(["/tmp/proof.png"]);
  });
});

describe("agent reply visibility", () => {
  it("distinguishes visible replies from intentional silent payloads", () => {
    const result = { payloads: [{ text: "NO_REPLY" }] };
    expect(hasVisibleAgentPayload(result)).toBe(true);
    expect(hasVisibleAgentPayload(result, { includeSilentReplyPayloads: false })).toBe(false);
    expect(hasIntentionalSilentAgentPayload(result)).toBe(true);
    expect(
      hasIntentionalSilentAgentPayload({
        payloads: [{ text: "NO_REPLY", mediaUrls: ["/tmp/proof.png"] }],
      }),
    ).toBe(false);
  });

  it("classifies terminal silent transcript messages and meaningful tails", () => {
    expect(
      isTerminalSilentAssistantMessage({
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "thinking", text: "internal" },
          { type: "text", text: "NO_REPLY" },
        ],
      }),
    ).toBe(true);
    expect(isMeaningfulTranscriptMessage({ role: "system" })).toBe(false);
    expect(isMeaningfulTranscriptMessage({ role: "toolResult" })).toBe(true);
  });
});
