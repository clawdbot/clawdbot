import { describe, expect, it, vi } from "vitest";

const getBrowserControlState = vi.hoisted(() => vi.fn());
const closeTrackedBrowserTabs = vi.hoisted(() =>
  vi.fn(async (_params: { getResolvedBrowserConfig: () => unknown; sessionKeys: string[] }) => 0),
);

vi.mock("./src/browser-control-state.js", () => ({ getBrowserControlState }));
vi.mock("./src/browser/session-tab-registry.js", () => ({
  closeTrackedBrowserTabsForSessions: closeTrackedBrowserTabs,
}));

import { closeTrackedBrowserTabsForSessions } from "./browser-maintenance.js";

describe("browser maintenance cleanup ownership", () => {
  it("injects the current live Browser runtime config without retaining a stale snapshot", async () => {
    const firstResolved = { marker: "first" };
    const secondResolved = { marker: "second" };
    getBrowserControlState.mockReturnValue({ resolved: firstResolved });

    await closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:main"] });
    const cleanupParams = closeTrackedBrowserTabs.mock.calls[0]?.[0];
    expect(await cleanupParams?.getResolvedBrowserConfig()).toBe(firstResolved);

    getBrowserControlState.mockReturnValue({ resolved: secondResolved });
    expect(await cleanupParams?.getResolvedBrowserConfig()).toBe(secondResolved);
    getBrowserControlState.mockReturnValue(null);
    expect(await cleanupParams?.getResolvedBrowserConfig()).toBeNull();
  });
});
