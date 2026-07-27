import { describe, expect, it } from "vitest";
import {
  buildCurrentRunRestartRecoveryClaim,
  buildRestartRecoveryTerminalDeliveryEvidence,
  constrainRestartRecoveryDeliveryPayloads,
} from "./agent-command-restart-recovery.js";

describe("buildCurrentRunRestartRecoveryClaim", () => {
  it("persists the complete generated-media policy, including an empty allowlist", () => {
    expect(
      buildCurrentRunRestartRecoveryClaim({
        deliveryMediaUrls: [],
        disableMessageTool: true,
        entry: { sessionId: "session-1", updatedAt: 1 },
        forceRestartSafeTools: true,
        runId: "media-run",
        sourceIngress: "internal",
        sourceRunId: "media-run",
        sourceReplyDeliveryMode: "automatic",
        suppressTextDelivery: true,
      }),
    ).toEqual({
      restartRecoveryDeliveryContext: undefined,
      restartRecoveryDeliveryMediaUrls: [],
      restartRecoveryDisableMessageTool: true,
      restartRecoveryDeliveryRunId: "media-run",
      restartRecoveryDeliverySourceRunId: "media-run",
      restartRecoverySourceIngress: "internal",
      restartRecoverySourceReplyDeliveryMode: "automatic",
      restartRecoveryForceSafeTools: true,
      restartRecoverySuppressTextDelivery: true,
    });
  });

  it("preserves a preclaimed recovery policy", () => {
    expect(
      buildCurrentRunRestartRecoveryClaim({
        entry: {
          sessionId: "session-1",
          updatedAt: 1,
          restartRecoveryDeliveryContext: {
            channel: "discord",
            to: "channel:123",
            accountId: "main",
            threadId: "42",
          },
          restartRecoveryDeliveryRunId: "recovery-run",
          restartRecoveryDeliverySourceRunId: "media-run",
          restartRecoveryDeliveryMediaUrls: ["/tmp/proof.png"],
          restartRecoveryDisableMessageTool: true,
          restartRecoverySourceIngress: "internal",
          restartRecoverySourceReplyDeliveryMode: "automatic",
          restartRecoveryForceSafeTools: true,
          restartRecoverySuppressTextDelivery: true,
        },
        runId: "recovery-run",
      }),
    ).toEqual({
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "channel:123",
        accountId: "main",
        threadId: "42",
      },
      restartRecoveryDeliveryMediaUrls: ["/tmp/proof.png"],
      restartRecoveryDisableMessageTool: true,
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "media-run",
      restartRecoverySourceIngress: "internal",
      restartRecoverySourceReplyDeliveryMode: "automatic",
      restartRecoveryForceSafeTools: true,
      restartRecoverySuppressTextDelivery: true,
    });
  });

  it("rejects a route change after recovery ownership is claimed", () => {
    expect(() =>
      buildCurrentRunRestartRecoveryClaim({
        deliveryContext: { channel: "discord", to: "channel:other" },
        entry: {
          sessionId: "session-1",
          updatedAt: 1,
          restartRecoveryDeliveryRunId: "recovery-run",
          restartRecoveryDeliveryContext: { channel: "discord", to: "channel:123" },
        },
        runId: "recovery-run",
      }),
    ).toThrow("restart recovery delivery route changed after the run was claimed");
  });

  it("requires explicit ownership for a new source claim", () => {
    expect(() =>
      buildCurrentRunRestartRecoveryClaim({
        entry: { sessionId: "session-1", updatedAt: 1 },
        runId: "media-run",
        sourceRunId: "media-run",
      }),
    ).toThrow("restart recovery source ownership is required for a new claim");
  });
});

describe("constrainRestartRecoveryDeliveryPayloads", () => {
  it("replaces model media with the exact host-owned set", () => {
    expect(
      constrainRestartRecoveryDeliveryPayloads(
        [
          {
            text: "ready",
            mediaUrl: "/tmp/old.png",
            mediaUrls: ["/tmp/old-2.png"],
            trustedLocalMedia: true,
            audioAsVoice: true,
            ...({ attachments: [{ url: "/tmp/nested-old.png" }] } as Record<string, unknown>),
          },
        ],
        [" /tmp/missing.png ", "/tmp/missing.png"],
      ),
    ).toEqual([{ text: "ready" }, { mediaUrls: ["/tmp/missing.png"], trustedLocalMedia: true }]);
  });

  it("strips all model media from a text-only notice", () => {
    expect(
      constrainRestartRecoveryDeliveryPayloads(
        [{ text: "failed", mediaUrls: ["/tmp/unrelated.png"], sensitiveMedia: true }],
        [],
      ),
    ).toEqual([{ text: "failed" }]);
  });

  it("suppresses model text on a media-only repair attempt", () => {
    expect(
      constrainRestartRecoveryDeliveryPayloads(
        [{ text: "caption already sent", mediaUrls: ["/tmp/old.png"] }],
        ["/tmp/missing.png"],
        true,
      ),
    ).toEqual([{ mediaUrls: ["/tmp/missing.png"], trustedLocalMedia: true }]);
  });
});

describe("buildRestartRecoveryTerminalDeliveryEvidence", () => {
  it("marks an empty terminal result as captured", () => {
    expect(buildRestartRecoveryTerminalDeliveryEvidence({})).toEqual({ captured: true });
  });

  it("marks bounded messaging-tool target evidence as truncated", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      messagingToolSentTargets: Array.from({ length: 65 }, (_, index) => ({
        provider: "discord",
        to: `channel:${index}`,
        text: "sent",
      })),
    });

    expect(evidence?.messagingToolSentTargets).toHaveLength(64);
    expect(evidence?.messagingToolSentTargetsTruncated).toBe(true);
  });

  it("does not mark reasoning payloads as visible terminal replies", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      payloads: [{ isReasoning: true, mediaUrls: ["/tmp/private.png"] }],
    });

    expect(evidence?.payloads).toEqual([{ mediaUrls: ["/tmp/private.png"], visible: false }]);
  });

  it("preserves explicit hidden-payload visibility", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      payloads: [{ visible: false, mediaUrls: ["/tmp/private.png"] }],
    });

    expect(evidence?.payloads).toEqual([{ mediaUrls: ["/tmp/private.png"], visible: false }]);
  });

  it("retains aggregate-only messaging-tool delivery as ambiguous evidence", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      didSendViaMessagingTool: true,
      messagingToolSentMediaUrls: ["/tmp/proof.png"],
    });

    expect(evidence).toEqual({
      captured: true,
      messagingToolAggregateEvidenceUnaccounted: true,
      restartUnsafeSideEffectsDetected: true,
    });
  });

  it("retains mixed unaccounted aggregate delivery as ambiguous evidence", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      didSendViaMessagingTool: true,
      messagingToolSentMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
      messagingToolSentTargets: [
        { provider: "discord", to: "channel:123", mediaUrls: ["/tmp/one.png"] },
      ],
    });

    expect(evidence?.messagingToolAggregateEvidenceUnaccounted).toBe(true);
    expect(evidence?.messagingToolSentTargets).toEqual([
      {
        provider: "discord",
        to: "channel:123",
        mediaUrls: ["/tmp/one.png"],
        visible: true,
      },
    ]);
  });

  it("retains restart-unsafe committed side effects", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({ successfulCronAdds: 1 });

    expect(evidence).toEqual({ captured: true, restartUnsafeSideEffectsDetected: true });
  });

  it("preserves explicit negative messaging-target visibility", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      messagingToolSentTargets: [{ provider: "discord", to: "channel:123", text: "" }],
    });

    expect(evidence?.messagingToolSentTargets).toEqual([
      { provider: "discord", to: "channel:123", visible: false },
    ]);
  });
});
