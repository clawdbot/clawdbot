// Tests privacy and durable ownership for model-spend alerts on routed replies.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  preparePrivateOwnerModelSpendAlertBestEffort: vi.fn(),
  markModelSpendAlertsQueued: vi.fn(),
  releasePreparedModelSpendAlertsBestEffort: vi.fn(),
}));

vi.mock("../../agents/model-spend-alert-delivery.js", () => ({
  preparePrivateOwnerModelSpendAlertBestEffort: mocks.preparePrivateOwnerModelSpendAlertBestEffort,
}));

vi.mock("../../agents/model-spend-alerts.js", () => ({
  markModelSpendAlertsQueued: mocks.markModelSpendAlertsQueued,
  markModelSpendAlertsDelivered: vi.fn(),
  markModelSpendAlertsUnknown: vi.fn(),
  releaseModelSpendAlerts: vi.fn(),
  releasePreparedModelSpendAlertsBestEffort: mocks.releasePreparedModelSpendAlertsBestEffort,
}));

vi.mock("../../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

const { routeReply } = await import("./route-reply.js");

function lastDelivery(): Record<string, unknown> {
  const delivery = mocks.deliverOutboundPayloads.mock.calls.at(-1)?.[0];
  if (!delivery || typeof delivery !== "object") {
    throw new Error("expected outbound delivery");
  }
  return delivery as Record<string, unknown>;
}

function lastDeliveryPayload(): Record<string, unknown> {
  const payloads = lastDelivery().payloads;
  const payload = Array.isArray(payloads) ? payloads[0] : undefined;
  if (!payload || typeof payload !== "object") {
    throw new Error("expected outbound delivery payload");
  }
  return payload as Record<string, unknown>;
}

describe("routeReply model spend alerts", () => {
  beforeEach(() => {
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([]);
    mocks.preparePrivateOwnerModelSpendAlertBestEffort.mockReset();
    mocks.markModelSpendAlertsQueued.mockReset();
    mocks.releasePreparedModelSpendAlertsBestEffort.mockReset();
  });

  it("keeps owner-DM spend alerts out of mirrored model text with durable completion", async () => {
    mocks.preparePrivateOwnerModelSpendAlertBestEffort.mockReturnValueOnce({
      alertIds: ["alert-1"],
      deliveryIntentId: "model-spend-claim-1",
      text: "Warning: deepseek reached $1.40.",
    });
    await routeReply({
      payload: { text: "model reply" },
      replyKind: "final",
      channel: "slack",
      to: "U123",
      sessionKey: "agent:main:main",
      policyConversationType: "direct",
      cfg: {
        commands: { ownerAllowFrom: ["slack:U123"] },
      },
    });

    expect(lastDeliveryPayload().text).toBe("model reply\n\nWarning: deepseek reached $1.40.");
    expect(lastDelivery().mirror).toMatchObject({ text: "model reply" });
    expect(lastDelivery().deliveryCompletion).toEqual({
      kind: "model_spend_alert",
      agentId: "main",
      alertIds: ["alert-1"],
      deliveryIntentId: "model-spend-claim-1",
    });
    const onDeliveryIntent = lastDelivery().onDeliveryIntent as
      | ((intent: { id: string; channel: "slack"; to: string; queuePolicy: "required" }) => void)
      | undefined;
    onDeliveryIntent?.({
      id: "model-spend-claim-1",
      channel: "slack",
      to: "U123",
      queuePolicy: "required",
    });
    expect(mocks.markModelSpendAlertsQueued).toHaveBeenCalledWith(
      expect.objectContaining({ alertIds: ["alert-1"] }),
      "model-spend-claim-1",
    );
    expect(lastDelivery().deliveryIntentId).toBe("model-spend-claim-1");
  });

  it("leaves spend alerts pending for group and non-owner reply routes", async () => {
    const cfg = {
      commands: { ownerAllowFrom: ["slack:U123"] },
    };
    await routeReply({
      payload: { text: "group reply" },
      replyKind: "final",
      channel: "slack",
      to: "U123",
      isGroup: true,
      cfg,
    });
    await routeReply({
      payload: { text: "non-owner reply" },
      replyKind: "final",
      channel: "slack",
      to: "U999",
      policyConversationType: "direct",
      cfg,
    });

    expect(mocks.preparePrivateOwnerModelSpendAlertBestEffort).toHaveBeenCalledTimes(2);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
  });
});
