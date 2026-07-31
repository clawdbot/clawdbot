import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";
import { wakeSessionForGeneratedMediaDirectDelivery } from "./generated-media-direct-delivery-wake.js";

const { enqueueSystemEvent, requestHeartbeat } = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(() => true),
  requestHeartbeat: vi.fn(),
}));

vi.mock("../infra/system-events.js", () => ({ enqueueSystemEvent }));
vi.mock("../infra/heartbeat-wake.js", async () =>
  mergeMockedModule(
    await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
      "../infra/heartbeat-wake.js",
    ),
    () => ({ requestHeartbeat }),
  ),
);

afterEach(() => {
  enqueueSystemEvent.mockReset();
  enqueueSystemEvent.mockReturnValue(true);
  requestHeartbeat.mockReset();
});

describe("wakeSessionForGeneratedMediaDirectDelivery", () => {
  it("continues the owning session after emergency direct delivery", () => {
    wakeSessionForGeneratedMediaDirectDelivery({
      sessionKey: "agent:main:discord:channel:123",
      mediaLabel: "image",
      status: "ok",
      deliveryContext: { channel: "discord", to: "channel:123" },
      contextKey: "image:task-1:emergency",
    });

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("durable agent-loop persistence was unavailable"),
      expect.objectContaining({
        sessionKey: "agent:main:discord:channel:123",
        contextKey: "image:task-1:emergency",
      }),
    );
    expect(requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "generated-media:direct-delivery-emergency" }),
    );
  });

  it("never throws when the emergency wake cannot be queued", () => {
    enqueueSystemEvent.mockImplementation(() => {
      throw new Error("queue unavailable");
    });

    expect(() =>
      wakeSessionForGeneratedMediaDirectDelivery({
        sessionKey: "agent:main:main",
        mediaLabel: "media",
        status: "ok",
        contextKey: "media:task-1:emergency",
      }),
    ).not.toThrow();
  });
});
