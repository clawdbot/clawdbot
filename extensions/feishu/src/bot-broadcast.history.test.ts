import { describe, expect, it, vi } from "vitest";
import {
  createFeishuBroadcastIngressSettlement,
  hasVisibleFeishuBroadcastHistoryDelivery,
} from "./bot-broadcast.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";

function createIngressLifecycle() {
  const calls = {
    adopted: vi.fn(async () => undefined),
    deferred: vi.fn(),
    finalizing: vi.fn(),
    abandoned: vi.fn(async () => undefined),
  };
  const lifecycle: FeishuIngressLifecycle = {
    abortSignal: new AbortController().signal,
    onAdopted: calls.adopted,
    onDeferred: calls.deferred,
    onAdoptionFinalizing: calls.finalizing,
    onAbandoned: calls.abandoned,
  };
  return { calls, lifecycle };
}

describe("Feishu broadcast history settlement", () => {
  it("does not treat durable adoption as visible delivery", async () => {
    const transport = createIngressLifecycle();
    const onVisibleDeliverySettled = vi.fn();
    const settlement = createFeishuBroadcastIngressSettlement({
      lifecycle: transport.lifecycle,
      onVisibleDeliverySettled,
    });
    const lane = settlement.createLane();

    await lane.lifecycle.onAdopted();
    await lane.onDispatchComplete(true);
    await settlement.onDispatchComplete();

    expect(transport.calls.adopted).toHaveBeenCalledOnce();
    expect(onVisibleDeliverySettled).not.toHaveBeenCalled();
  });

  it("settles visible history exactly once after the whole fanout adopts", async () => {
    const transport = createIngressLifecycle();
    const onVisibleDeliverySettled = vi.fn();
    const settlement = createFeishuBroadcastIngressSettlement({
      lifecycle: transport.lifecycle,
      onVisibleDeliverySettled,
    });
    const lane = settlement.createLane();

    settlement.recordVisibleDelivery();
    settlement.recordVisibleDelivery();
    await lane.lifecycle.onAdopted();
    await lane.onDispatchComplete(true);
    expect(onVisibleDeliverySettled).not.toHaveBeenCalled();

    await settlement.onDispatchComplete();
    settlement.recordVisibleDelivery();

    expect(transport.calls.adopted).toHaveBeenCalledOnce();
    expect(onVisibleDeliverySettled).toHaveBeenCalledOnce();
  });

  it("retains visible history while another lane is deferred", async () => {
    const transport = createIngressLifecycle();
    const onVisibleDeliverySettled = vi.fn();
    const settlement = createFeishuBroadcastIngressSettlement({
      lifecycle: transport.lifecycle,
      onVisibleDeliverySettled,
    });
    const activeLane = settlement.createLane();
    const deferredLane = settlement.createLane();

    settlement.recordVisibleDelivery();
    await activeLane.lifecycle.onAdopted();
    await activeLane.onDispatchComplete(true);
    deferredLane.lifecycle.onDeferred();
    await deferredLane.onDispatchComplete(true);
    await settlement.onDispatchComplete();

    expect(transport.calls.adopted).not.toHaveBeenCalled();
    expect(onVisibleDeliverySettled).not.toHaveBeenCalled();

    await deferredLane.lifecycle.onAdopted();

    expect(transport.calls.adopted).toHaveBeenCalledOnce();
    expect(onVisibleDeliverySettled).toHaveBeenCalledOnce();
  });

  it("requires receipt-level or explicit fallback delivery evidence", () => {
    expect(
      hasVisibleFeishuBroadcastHistoryDelivery({ queuedFinal: true, counts: { final: 1 } }, false),
    ).toBe(false);
    expect(
      hasVisibleFeishuBroadcastHistoryDelivery(
        { settledReceipt: { anyVisibleDelivered: false, counts: {} } },
        false,
      ),
    ).toBe(false);
    expect(
      hasVisibleFeishuBroadcastHistoryDelivery(
        { settledReceipt: { anyVisibleDelivered: true, counts: {} } },
        false,
      ),
    ).toBe(true);
    expect(
      hasVisibleFeishuBroadcastHistoryDelivery(
        { settledReceipt: { anyVisibleDelivered: false, counts: {} } },
        true,
      ),
    ).toBe(true);
  });
});
