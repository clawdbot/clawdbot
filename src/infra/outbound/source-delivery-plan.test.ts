// Covers source-delivery target matching, message-tool ownership plans, and
// fallback satisfaction outcomes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

vi.mock("./target-normalization.js", () => ({
  normalizeTargetForProvider: (_provider: string, raw?: string) => raw?.trim(),
}));
import {
  createSourceDeliveryPlan,
  resolveSourceDeliveryOutcome,
  sourceDeliveryTargetsMatch,
} from "./source-delivery-plan.js";

afterEach(() => {
  setActivePluginRegistry(createTestRegistry());
});

describe("source delivery plan", () => {
  it("projects message-tool-owned delivery to existing source reply and message tool fields", () => {
    const contract = createSourceDeliveryPlan({
      owner: "message_tool_then_direct_fallback",
      reason: "cron_announce",
      target: { channel: "discord", to: "channel:123", accountId: "bot-a" },
    });

    expect(contract.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(contract.normalFinal).toBe("private");
    expect(contract.fallback.skipWhenMessageToolSentToTarget).toBe(true);
    expect(contract.messageTool).toMatchObject({
      requireExplicitTarget: false,
      enabled: true,
      force: true,
    });
  });

  it("keeps direct fallback delivery compatible with automatic final payload handling", () => {
    const contract = createSourceDeliveryPlan({
      owner: "direct_fallback",
      reason: "cron_announce",
      target: { channel: "discord", to: "channel:123" },
      messageToolEnabled: true,
      messageToolForced: true,
      directFallback: true,
      skipFallbackWhenMessageToolSentToTarget: false,
    });

    expect(contract.sourceReplyDeliveryMode).toBeUndefined();
    expect(contract.normalFinal).toBe("visible");
    expect(contract.fallback.directDelivery).toBe(true);
    expect(contract.fallback.skipWhenMessageToolSentToTarget).toBe(false);
    expect(contract.messageTool).toMatchObject({
      requireExplicitTarget: false,
      enabled: true,
      force: true,
    });
  });

  it("normalizes message-tool delivery outcomes against the planned source target", () => {
    const contract = createSourceDeliveryPlan({
      owner: "message_tool_then_direct_fallback",
      reason: "cron_announce",
      target: { channel: "feishu", to: "oc_123", accountId: "bot-a", threadId: 456 },
    });

    const outcome = resolveSourceDeliveryOutcome(contract, {
      didSendViaMessageTool: true,
      messageToolSentTargets: [
        {
          tool: "message",
          provider: "message",
          accountId: "bot-a",
          to: "oc_123:topic:456",
          text: "done",
        },
      ],
    });

    expect(outcome.satisfiesSourceDelivery).toBe(true);
    expect(outcome.verifiedMessageToolDelivery).toBe(true);
    expect(outcome.unverifiedMessageToolDelivery).toBe(false);
    expect(outcome.visibleDeliveries).toEqual([
      {
        via: "message_tool",
        verifiedTarget: true,
        target: {
          tool: "message",
          provider: "message",
          accountId: "bot-a",
          to: "oc_123:topic:456",
          text: "done",
        },
      },
    ]);
  });

  it("keeps unverified message-tool sends visible to fallback/error handling", () => {
    const contract = createSourceDeliveryPlan({
      owner: "message_tool_then_direct_fallback",
      reason: "cron_announce",
      target: { channel: "slack", to: "channel:C1" },
    });

    const outcome = resolveSourceDeliveryOutcome(contract, {
      didSendViaMessageTool: true,
      messageToolSentTargets: [{ tool: "message", provider: "slack", to: "channel:C2" }],
    });

    expect(outcome.satisfiesSourceDelivery).toBe(false);
    expect(outcome.verifiedMessageToolDelivery).toBe(false);
    expect(outcome.unverifiedMessageToolDelivery).toBe(true);
    expect(outcome.visibleDeliveries[0]?.verifiedTarget).toBe(false);
  });

  it("keeps verified message-tool delivery separate from source fallback satisfaction", () => {
    const contract = createSourceDeliveryPlan({
      owner: "none",
      reason: "cron_none",
      target: { channel: "slack", to: "channel:C1" },
      messageToolEnabled: true,
      messageToolForced: true,
      directFallback: false,
    });

    const outcome = resolveSourceDeliveryOutcome(contract, {
      didSendViaMessageTool: true,
      messageToolSentTargets: [{ tool: "message", provider: "slack", to: "channel:C1" }],
    });

    expect(outcome.verifiedMessageToolDelivery).toBe(true);
    expect(outcome.satisfiesSourceDelivery).toBe(false);
    expect(outcome.unverifiedMessageToolDelivery).toBe(false);
  });

  it("does not satisfy delivery from target metadata without a committed message-tool send", () => {
    const contract = createSourceDeliveryPlan({
      owner: "message_tool_then_direct_fallback",
      reason: "cron_announce",
      target: { channel: "slack", to: "channel:C1" },
    });

    const outcome = resolveSourceDeliveryOutcome(contract, {
      didSendViaMessageTool: false,
      messageToolSentTargets: [{ tool: "message", provider: "slack", to: "channel:C1" }],
    });

    expect(outcome.visibleDeliveries[0]?.verifiedTarget).toBe(true);
    expect(outcome.verifiedMessageToolDelivery).toBe(false);
    expect(outcome.satisfiesSourceDelivery).toBe(false);
    expect(outcome.unverifiedMessageToolDelivery).toBe(false);
  });

  it("synthesizes the planned target for legacy message-tool sends by default", () => {
    const contract = createSourceDeliveryPlan({
      owner: "message_tool_then_direct_fallback",
      reason: "cron_announce",
      target: { channel: "slack", to: "channel:C1" },
    });

    const outcome = resolveSourceDeliveryOutcome(contract, {
      didSendViaMessageTool: true,
    });

    expect(outcome.visibleDeliveries).toEqual([
      {
        via: "message_tool",
        verifiedTarget: true,
        target: { tool: "message", provider: "slack", to: "channel:C1" },
      },
    ]);
    expect(outcome.verifiedMessageToolDelivery).toBe(true);
    expect(outcome.satisfiesSourceDelivery).toBe(true);
  });

  it("does not synthesize the planned target when explicit target evidence is required", () => {
    const contract = createSourceDeliveryPlan({
      owner: "message_tool_then_direct_fallback",
      reason: "cron_announce",
      target: { channel: "slack", to: "channel:C1" },
      requireExplicitMessageTargetEvidence: true,
    });

    const outcome = resolveSourceDeliveryOutcome(contract, {
      didSendViaMessageTool: true,
    });

    expect(outcome.visibleDeliveries).toEqual([]);
    expect(outcome.verifiedMessageToolDelivery).toBe(false);
    expect(outcome.satisfiesSourceDelivery).toBe(false);
    expect(outcome.unverifiedMessageToolDelivery).toBe(false);
  });

  it("does not synthesize an implicit target without a concrete recipient", () => {
    const contract = createSourceDeliveryPlan({
      owner: "direct_fallback",
      reason: "cron_announce",
      target: { channel: "slack" },
      messageToolEnabled: true,
      messageToolForced: true,
      directFallback: true,
      skipFallbackWhenMessageToolSentToTarget: false,
    });

    const outcome = resolveSourceDeliveryOutcome(contract, {
      didSendViaMessageTool: true,
    });

    expect(outcome.visibleDeliveries).toEqual([]);
    expect(outcome.verifiedMessageToolDelivery).toBe(false);
    expect(outcome.satisfiesSourceDelivery).toBe(false);
    expect(outcome.unverifiedMessageToolDelivery).toBe(false);
  });

  it("matches source targets through the same provider normalization used by delivery", () => {
    expect(
      sourceDeliveryTargetsMatch(
        { provider: "message", to: "channel:C1" },
        { channel: "slack", to: "channel:C1" },
      ),
    ).toBe(true);
    expect(
      sourceDeliveryTargetsMatch(
        { provider: "discord", to: "channel:C1" },
        { channel: "slack", to: "channel:C1" },
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "case-sensitive metadata",
      channel: "exact-chat",
      comparison: "case-sensitive" as const,
      targetTo: "channel:abc",
      deliveryTo: "channel:ABC",
      expected: false,
    },
    {
      name: "lowercase metadata",
      channel: "folded-chat",
      comparison: "lowercase" as const,
      targetTo: "Channel: c1",
      deliveryTo: "channel:C1",
      expected: true,
    },
    {
      name: "undeclared generic normalization",
      channel: "generic-chat",
      comparison: undefined,
      targetTo: "channel:abc",
      deliveryTo: "channel:ABC",
      expected: false,
    },
  ])(
    "uses $name for prefixed target ids",
    ({ channel, comparison, targetTo, deliveryTo, expected }) => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: channel,
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: channel, label: channel }),
              messaging: comparison ? { targetIdComparison: comparison } : {},
            },
          },
        ]),
      );

      expect(
        sourceDeliveryTargetsMatch(
          { provider: channel, to: targetTo },
          { channel, to: deliveryTo },
        ),
      ).toBe(expected);
    },
  );

  it("matches threaded delivery only with explicit or supported implicit thread evidence", () => {
    expect(
      sourceDeliveryTargetsMatch(
        { provider: "telegram", to: "-100:topic:462" },
        { channel: "telegram", to: "-100", threadId: 462 },
      ),
    ).toBe(true);
    expect(
      sourceDeliveryTargetsMatch(
        { provider: "telegram", to: "-100" },
        { channel: "telegram", to: "-100", threadId: 462 },
      ),
    ).toBe(false);
    expect(
      sourceDeliveryTargetsMatch(
        { provider: "telegram", to: "-100", threadImplicit: true },
        { channel: "telegram", to: "-100", threadId: 462 },
      ),
    ).toBe(true);
    expect(
      sourceDeliveryTargetsMatch(
        { provider: "telegram", to: "-100", threadImplicit: true, threadSuppressed: true },
        { channel: "telegram", to: "-100", threadId: 462 },
      ),
    ).toBe(false);
    expect(
      sourceDeliveryTargetsMatch(
        { provider: "telegram", to: "-100", threadId: "111" },
        { channel: "telegram", to: "-100", threadId: 462 },
      ),
    ).toBe(false);
  });
});
