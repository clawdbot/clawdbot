import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCronJob } from "./delivery.test-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveDeliveryTarget: vi.fn(),
}));

vi.mock("./isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: mocks.resolveDeliveryTarget,
}));

const { resolveCronDeliveryPreview } = await import("./delivery-preview.js");

describe("resolveCronDeliveryPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDeliveryTarget.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "direct-123",
      mode: "implicit",
    });
  });

  it("prefers sessionTarget session context over creator sessionKey", async () => {
    const job = makeCronJob({
      agentId: "avery",
      sessionTarget: "session:agent:avery:telegram:direct:direct-123",
      sessionKey: "agent:avery:telegram:group:ops:sender:direct-123",
      delivery: undefined,
    });

    const preview = await resolveCronDeliveryPreview({
      cfg: {} as never,
      job,
    });

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(
      {},
      "avery",
      {
        channel: "last",
        to: undefined,
        threadId: undefined,
        accountId: undefined,
        sessionKey: "agent:avery:telegram:direct:direct-123",
      },
      { dryRun: true },
    );
    expect(preview.detail).toBe(
      "resolved from last, session agent:avery:telegram:direct:direct-123",
    );
  });
});
