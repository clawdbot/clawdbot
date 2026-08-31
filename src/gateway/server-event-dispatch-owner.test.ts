import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createGatewayEventDispatchOwner } from "./server-event-dispatch-owner.js";

describe("createGatewayEventDispatchOwner", () => {
  it("stops admission and drains accepted dispatches", async () => {
    const accepted = createDeferred();
    const rejected = createDeferred();
    const owner = createGatewayEventDispatchOwner();
    const startAfterStop = vi.fn(async () => {});
    const syncFailure = new Error("synchronous dispatch failure");

    expect(owner.tryRun(() => accepted.promise)).toBe(true);
    expect(owner.tryRun(() => rejected.promise)).toBe(true);
    expect(
      owner.tryRun(() => {
        throw syncFailure;
      }),
    ).toBe(true);

    let drained = false;
    const draining = owner.stopAndDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();

    expect(drained).toBe(false);
    expect(owner.tryRun(startAfterStop)).toBe(false);
    expect(startAfterStop).not.toHaveBeenCalled();

    accepted.resolve();
    rejected.reject(new Error("dispatch failed"));
    await draining;

    expect(drained).toBe(true);
  });
});
