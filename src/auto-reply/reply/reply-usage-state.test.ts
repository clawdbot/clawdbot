import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeReplyUsageState, recordReplyUsageState } from "./reply-usage-state.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("reply usage state handoff", () => {
  it("requires exact run correlation", () => {
    const snapshot = { provider: "openai", model: "gpt-5.5" };

    recordReplyUsageState("run-correlation", snapshot);

    expect(consumeReplyUsageState()).toBeUndefined();
    expect(consumeReplyUsageState("run-b")).toBeUndefined();
    expect(consumeReplyUsageState("run-correlation")).toBe(snapshot);
  });

  it("ignores snapshots without a run id", () => {
    recordReplyUsageState(undefined, { provider: "openai" });

    expect(consumeReplyUsageState()).toBeUndefined();
  });

  it("expires snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    recordReplyUsageState("run-expiry", { provider: "openai" });

    vi.setSystemTime(5 * 60_000 + 1);

    expect(consumeReplyUsageState("run-expiry")).toBeUndefined();
  });
});
