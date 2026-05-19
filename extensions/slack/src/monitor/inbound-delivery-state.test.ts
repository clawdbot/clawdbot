import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSlackRuntime, setSlackRuntime } from "../runtime.js";
import type { SlackMessageEvent } from "../types.js";
import {
  clearSlackInboundDeliveryStateForTest,
  hasSlackInboundMessageDelivery,
  recordSlackInboundMessageDeliveries,
} from "./inbound-delivery-state.js";

describe("slack inbound delivery state", () => {
  afterEach(() => {
    clearSlackInboundDeliveryStateForTest();
    clearSlackRuntime();
    vi.restoreAllMocks();
  });

  function message(channel: string, ts: string): SlackMessageEvent {
    return { type: "message", channel, ts, text: "hello" };
  }

  it("records every delivered debounced source message", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    setSlackRuntime({
      state: {
        openKeyedStore: vi.fn(() => ({
          register,
          lookup: vi.fn(),
          consume: vi.fn(),
          delete: vi.fn(),
          entries: vi.fn(),
          clear: vi.fn(),
        })),
      },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    await recordSlackInboundMessageDeliveries({
      accountId: "A1",
      messages: [message("C1", "100.001"), message("C1", "100.002")],
    });

    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledWith("A1:C1:100.001", {
      deliveredAt: expect.any(Number),
    });
    expect(register).toHaveBeenCalledWith("A1:C1:100.002", {
      deliveredAt: expect.any(Number),
    });
  });

  it("scopes duplicate checks by account", async () => {
    await recordSlackInboundMessageDeliveries({
      accountId: "A1",
      messages: [message("C1", "100.001")],
    });

    await expect(
      hasSlackInboundMessageDelivery({
        accountId: "A1",
        channelId: "C1",
        ts: "100.001",
      }),
    ).resolves.toBe(true);
    await expect(
      hasSlackInboundMessageDelivery({
        accountId: "A2",
        channelId: "C1",
        ts: "100.001",
      }),
    ).resolves.toBe(false);
  });
});
