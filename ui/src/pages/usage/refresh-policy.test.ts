// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageRefreshPolicy } from "./refresh-policy.ts";

const USAGE_PAYLOAD_TTL_MS = 5 * 60_000;
const NOW_MS = 1_000_000;

function createPolicy(isLoading = () => false) {
  const reload = vi.fn();
  return { policy: new UsageRefreshPolicy({ isLoading, reload }), reload };
}

describe("UsageRefreshPolicy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("skips automatic refresh while the cached payload is within the TTL", () => {
    const { policy, reload } = createPolicy();
    policy.setLastLoadedAtMs(NOW_MS - USAGE_PAYLOAD_TTL_MS + 1);

    policy.request("reconnect");
    policy.request("poll");

    expect(reload).not.toHaveBeenCalled();
  });

  it("defers stale work until the page is visible", () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { policy, reload } = createPolicy();
    policy.setLastLoadedAtMs(NOW_MS - USAGE_PAYLOAD_TTL_MS);

    policy.request("reconnect");
    expect(reload).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    policy.request("focus");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("always fetches for a manual refresh", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { policy, reload } = createPolicy();
    policy.setLastLoadedAtMs(NOW_MS);

    policy.request("manual");

    expect(reload).toHaveBeenCalledOnce();
  });

  it("refetches a payload the Gateway marked as still refreshing", () => {
    const { policy, reload } = createPolicy();
    policy.markLoaded({ incomplete: true });

    // The incomplete payload must not start the TTL, or every automatic refresh skips.
    policy.request("focus");
    expect(reload).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(5_000);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("stops retrying but keeps the TTL cold while the payload stays incomplete", () => {
    const { policy, reload } = createPolicy();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      policy.markLoaded({ incomplete: true });
      vi.advanceTimersByTime(5_000);
    }

    // Three timers, then no more automatic retries.
    expect(reload).toHaveBeenCalledTimes(3);

    // Exhausting the timers must not mark the payload complete: the data never
    // arrived, so focus/reconnect/manual refreshes still have to fetch it.
    policy.request("poll");
    expect(reload).toHaveBeenCalledTimes(4);
    policy.request("focus");
    expect(reload).toHaveBeenCalledTimes(5);
  });

  it("stops retrying once a complete payload lands and after disposal", () => {
    const { policy, reload } = createPolicy();
    policy.markLoaded({ incomplete: true });
    policy.markLoaded();

    vi.advanceTimersByTime(5_000);
    expect(reload).not.toHaveBeenCalled();

    policy.markLoaded({ incomplete: true });
    policy.dispose();
    vi.advanceTimersByTime(5_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it("retries interrupted work once active despite a fresh payload", () => {
    let loading = true;
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { policy, reload } = createPolicy(() => loading);
    policy.setLastLoadedAtMs(NOW_MS);
    policy.interrupt();
    loading = false;

    policy.request("reconnect");
    expect(reload).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    policy.request("focus");
    expect(reload).toHaveBeenCalledOnce();
  });
});
