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
