import { describe, expect, it } from "vitest";
import {
  normalizeTerminalDeliveryEvidenceResult,
  projectTerminalDeliveryEvidence,
} from "./terminal-delivery-evidence.js";

describe("projectTerminalDeliveryEvidence", () => {
  it("bounds payloads and targets to the shared cap and marks truncation", () => {
    const evidence = projectTerminalDeliveryEvidence({
      payloads: Array.from({ length: 65 }, (_, index) => ({
        text: `payload ${index}`,
        mediaUrls: [`/tmp/payload-${index}.png`],
      })),
      messagingToolSentTargets: Array.from({ length: 65 }, (_, index) => ({
        provider: "discord",
        to: `channel:${index}`,
        text: `sent ${index}`,
        mediaUrls: [`/tmp/target-${index}.png`],
      })),
    });

    expect(evidence.payloads).toHaveLength(64);
    expect(evidence.messagingToolSentTargets).toHaveLength(64);
    expect(evidence.payloadsTruncated).toBe(true);
    expect(evidence.messagingToolSentTargetsTruncated).toBe(true);
  });

  it("allows only bounded delivery statuses and payload outcomes", () => {
    const evidence = projectTerminalDeliveryEvidence({
      deliveryStatus: {
        status: "partial_failed",
        errorMessage: " delivery failed ",
        payloadOutcomes: [
          { index: 0, status: "sent", sentBeforeError: false },
          { index: 1, status: "suppressed" },
          { index: 2, status: "failed", sentBeforeError: true },
          { index: 3, status: "weird", sentBeforeError: true },
          { index: -1, status: "sent" },
          { index: 1.5, status: "sent" },
          { index: "4", status: "sent" },
          null,
        ],
      },
    } as never);

    expect(evidence.deliveryStatus).toEqual({
      status: "partial_failed",
      errorMessage: "delivery failed",
      payloadOutcomes: [
        { index: 0, status: "sent", sentBeforeError: false },
        { index: 1, status: "suppressed" },
        { index: 2, status: "failed", sentBeforeError: true },
      ],
    });
  });

  it("projects visibility and media without leaking message text or channelData", () => {
    const evidence = projectTerminalDeliveryEvidence({
      payloads: [
        {
          text: "secret body",
          mediaUrls: ["/tmp/proof.png"],
          channelData: { token: "nope" },
          metadata: { internal: true },
        },
        { isReasoning: true, text: "private reasoning", mediaUrls: ["/tmp/reasoning.png"] },
      ],
      messagingToolSentTargets: [
        {
          provider: "matrix",
          accountId: "main",
          to: "!room:example",
          threadId: 42,
          threadImplicit: true,
          threadSuppressed: true,
          text: "hello",
          mediaUrls: ["/tmp/outbound.png"],
          visible: false,
          richContent: { html: "<b>secret</b>" },
          channelData: { mxid: "@secret:example" },
        },
      ],
    } as never);

    expect(evidence).toEqual({
      captured: true,
      payloads: [
        { mediaUrls: ["/tmp/proof.png"], visible: true },
        { mediaUrls: ["/tmp/reasoning.png"], visible: false },
      ],
      messagingToolSentTargets: [
        {
          provider: "matrix",
          accountId: "main",
          to: "!room:example",
          threadId: "42",
          threadImplicit: true,
          threadSuppressed: true,
          mediaUrls: ["/tmp/outbound.png"],
          visible: true,
        },
      ],
      unsafeSideEffectsDetected: true,
    });
    expect(JSON.stringify(evidence)).not.toContain("secret body");
    expect(JSON.stringify(evidence)).not.toContain("channelData");
    expect(JSON.stringify(evidence)).not.toContain("richContent");
  });

  it("marks committed outbound evidence and deterministic approval prompts as unsafe side effects", () => {
    expect(
      projectTerminalDeliveryEvidence({
        didSendDeterministicApprovalPrompt: true,
      }),
    ).toEqual({ captured: true, unsafeSideEffectsDetected: true });

    expect(
      projectTerminalDeliveryEvidence({
        successfulCronAdds: 1,
      }),
    ).toEqual({ captured: true, unsafeSideEffectsDetected: true });
  });

  it("marks aggregate-only messaging sends as unaccounted and unsafe", () => {
    expect(
      projectTerminalDeliveryEvidence({
        didSendViaMessagingTool: true,
        messagingToolSentMediaUrls: ["/tmp/proof.png"],
      }),
    ).toEqual({
      captured: true,
      messagingToolAggregateEvidenceUnaccounted: true,
      unsafeSideEffectsDetected: true,
    });
  });

  it("excludes malformed and unrelated fields from normalized evidence", () => {
    const normalized = normalizeTerminalDeliveryEvidenceResult({
      captured: true,
      payloads: [
        {
          mediaUrls: ["/tmp/proof.png", "", 5, "/tmp/proof.png"],
          visible: true,
          text: "leak",
        },
        "bad-payload",
      ],
      payloadsTruncated: true,
      deliveryStatus: {
        status: "failed",
        errorMessage: " bad route ",
        payloadOutcomes: [
          { index: 0, status: "sent" },
          { index: -1, status: "failed" },
          { index: 1, status: "invalid" },
        ],
        body: "secret",
      },
      messagingToolSentTargets: [
        {
          provider: "discord",
          accountId: "main",
          to: "channel:123",
          threadId: 7,
          mediaUrls: ["/tmp/outbound.png", null, "/tmp/outbound.png"],
          visible: false,
          text: "leak me",
          channelData: { nope: true },
        },
        { text: "missing route" },
      ],
      messagingToolSentTargetsTruncated: true,
      messagingToolAggregateEvidenceUnaccounted: true,
      unsafeSideEffectsDetected: true,
      rawRunnerMetadata: { toolCalls: 5 },
    } as never);

    expect(normalized).toEqual({
      captured: true,
      payloads: [{ mediaUrls: ["/tmp/proof.png"], visible: true }, {}],
      payloadsTruncated: true,
      deliveryStatus: {
        status: "failed",
        errorMessage: "bad route",
        payloadOutcomes: [{ index: 0, status: "sent" }],
      },
      messagingToolSentTargets: [
        {
          provider: "discord",
          accountId: "main",
          to: "channel:123",
          threadId: "7",
          mediaUrls: ["/tmp/outbound.png"],
          visible: false,
        },
      ],
      messagingToolSentTargetsTruncated: true,
      messagingToolAggregateEvidenceUnaccounted: true,
      unsafeSideEffectsDetected: true,
    });
    expect(JSON.stringify(normalized)).not.toContain("leak me");
    expect(JSON.stringify(normalized)).not.toContain("rawRunnerMetadata");
  });

  it("does not inherit restart-recovery persistence aliases", () => {
    expect(
      normalizeTerminalDeliveryEvidenceResult({
        restartUnsafeSideEffectsDetected: true,
      } as never),
    ).toBeUndefined();
  });
});
