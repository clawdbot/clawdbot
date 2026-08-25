import { describe, expect, it, vi } from "vitest";
import { createBlockReplySettlementRegistry } from "./block-reply-settlement-registry.js";

describe("createBlockReplySettlementRegistry", () => {
  it("returns false for an unregistered payload", async () => {
    const registry = createBlockReplySettlementRegistry();

    await expect(registry.settle({ text: "missing" })).resolves.toBe(false);
  });

  it("resolves lazily and shares one settlement", async () => {
    const registry = createBlockReplySettlementRegistry();
    const payload = { text: "queued" };
    const resolve = vi.fn(async () => true);
    const settle = registry.register(payload, resolve);

    expect(resolve).not.toHaveBeenCalled();
    await expect(Promise.all([settle(), registry.settle(payload)])).resolves.toEqual([true, true]);
    expect(resolve).toHaveBeenCalledOnce();
  });
});
