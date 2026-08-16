import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";

const mocks = vi.hoisted(() => ({
  resolveAgentDeliveryPlanWithSessionRoute: vi.fn(),
}));

vi.mock("../../infra/outbound/agent-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/outbound/agent-delivery.js")>()),
  resolveAgentDeliveryPlanWithSessionRoute: mocks.resolveAgentDeliveryPlanWithSessionRoute,
}));

const { resolveAgentDeliveryPhase } = await import("./agent-delivery-phase.js");

describe("resolveAgentDeliveryPhase", () => {
  beforeEach(() => {
    mocks.resolveAgentDeliveryPlanWithSessionRoute.mockReset();
  });

  it("renders a strict target-resolution failure without its Error class", async () => {
    const targetError = Object.assign(new Error('Reserved target "current" for Telegram'), {
      code: "INVALID_TARGET",
    });
    mocks.resolveAgentDeliveryPlanWithSessionRoute.mockResolvedValue({
      baseDelivery: {},
      resolvedChannel: "telegram",
      resolvedTo: "current",
      deliveryTargetMode: "explicit",
      targetResolutionError: targetError,
    });
    const respond = vi.fn();

    await resolveAgentDeliveryPhase({
      request: { message: "strict delivery", deliver: true },
      cfg: {},
      agentId: "main",
      replyTo: "",
      to: "current",
      bestEffortDeliver: false,
      runId: "strict-target-resolution",
      client: null,
      context: { chatAbortControllers: new Map() } as never,
      respond,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Reserved target "current" for Telegram | INVALID_TARGET',
    });
  });
});
