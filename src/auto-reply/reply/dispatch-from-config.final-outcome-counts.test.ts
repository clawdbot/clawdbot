import { describe, expect, it } from "vitest";
import { getDispatcherFinalOutcomeCounts } from "./dispatch-from-config.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";

describe("getDispatcherFinalOutcomeCounts (#89116)", () => {
  it("returns failed: 0 when the dispatcher does not implement getFailedCounts", () => {
    // Some ReplyDispatcher variants omit the optional count methods entirely; the
    // previous code called dispatcher.getFailedCounts() unguarded and threw
    // "TypeError: dispatcher.getFailedCounts is not a function".
    const dispatcher = {
      getCancelledCounts: () => ({ tool: 0, block: 0, final: 2 }),
      // getFailedCounts intentionally absent
    } as unknown as ReplyDispatcher;

    expect(() => getDispatcherFinalOutcomeCounts(dispatcher)).not.toThrow();
    expect(getDispatcherFinalOutcomeCounts(dispatcher)).toEqual({ cancelled: 2, failed: 0 });
  });

  it("returns cancelled: 0 when getCancelledCounts is absent (existing behavior preserved)", () => {
    const dispatcher = {
      getFailedCounts: () => ({ tool: 0, block: 1, final: 3 }),
    } as unknown as ReplyDispatcher;

    expect(getDispatcherFinalOutcomeCounts(dispatcher)).toEqual({ cancelled: 0, failed: 3 });
  });

  it("uses the real final counts when both methods are present", () => {
    const dispatcher = {
      getCancelledCounts: () => ({ tool: 0, block: 0, final: 1 }),
      getFailedCounts: () => ({ tool: 0, block: 0, final: 5 }),
    } as unknown as ReplyDispatcher;

    expect(getDispatcherFinalOutcomeCounts(dispatcher)).toEqual({ cancelled: 1, failed: 5 });
  });
});
