import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedBrowserProfile } from "./config.js";
import {
  OPEN_TAB_DISCOVERY_POLL_MS,
  OPEN_TAB_DISCOVERY_WINDOW_MS,
} from "./server-context.constants.js";
import { createProfileSelectionOps } from "./server-context.selection.js";
import type { BrowserTab, ProfileRuntimeState } from "./server-context.types.js";

const LOCAL_PROFILE: ResolvedBrowserProfile = {
  name: "openclaw",
  cdpPort: 18800,
  cdpUrl: "http://127.0.0.1:18800",
  cdpHost: "127.0.0.1",
  cdpIsLoopback: true,
  color: "#FF4500",
  driver: "openclaw",
  headless: true,
  headlessSource: "config",
  attachOnly: false,
};

function tab(targetId: string, wsUrl?: string): BrowserTab {
  return {
    targetId,
    title: targetId,
    url: `https://${targetId.toLowerCase()}.example`,
    type: "page",
    ...(wsUrl ? { wsUrl } : {}),
  };
}

function createSelectionHarness(params: {
  snapshots: Array<BrowserTab[] | Error>;
  openedTab?: BrowserTab;
}) {
  const snapshots = [...params.snapshots];
  let lastSnapshot: BrowserTab[] = [];
  const listTabs = vi.fn(async () => {
    const next = snapshots.shift();
    if (next instanceof Error) {
      throw next;
    }
    if (next) {
      lastSnapshot = next;
    }
    return lastSnapshot;
  });
  const profileState: ProfileRuntimeState = {
    profile: LOCAL_PROFILE,
    running: null,
    lastTargetId: null,
    reconcile: null,
  };
  const openTab = vi.fn(async () => {
    const openedTab = params.openedTab ?? tab("OPENED");
    profileState.lastTargetId = openedTab.targetId;
    return openedTab;
  });
  const selection = createProfileSelectionOps({
    profile: LOCAL_PROFILE,
    getProfileState: () => profileState,
    getCdpControlPolicy: () => undefined,
    ensureBrowserAvailable: async () => {},
    listTabs,
    openTab,
  });
  return { selection, listTabs, openTab, profileState };
}

async function advancePastDiscoveryWindow(): Promise<void> {
  await vi.advanceTimersByTimeAsync(OPEN_TAB_DISCOVERY_WINDOW_MS + OPEN_TAB_DISCOVERY_POLL_MS);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("browser profile tab selection", () => {
  it("preserves the opened tab when the immediate relist omits it", async () => {
    const openedTab = tab("OPENED", "ws://127.0.0.1/devtools/page/OPENED");
    const { selection, listTabs, openTab } = createSelectionHarness({
      snapshots: [[], []],
      openedTab,
    });

    await expect(selection.ensureTabAvailable()).resolves.toEqual(openedTab);
    expect(openTab).toHaveBeenCalledOnce();
    expect(listTabs).toHaveBeenCalledTimes(2);
  });

  it("passes the request budget to tab discovery", async () => {
    const ready = tab("READY", "ws://127.0.0.1/devtools/page/READY");
    const { selection, listTabs } = createSelectionHarness({ snapshots: [[ready]] });
    const ctrl = new AbortController();

    await expect(
      selection.ensureTabAvailable(undefined, { signal: ctrl.signal, timeoutMs: 1234 }),
    ).resolves.toEqual(ready);

    expect(listTabs).toHaveBeenCalledWith({ signal: ctrl.signal, timeoutMs: 1234 });
  });

  it("does not start tab discovery for an aborted request", async () => {
    const { selection, listTabs } = createSelectionHarness({ snapshots: [[tab("READY")]] });
    const ctrl = new AbortController();
    ctrl.abort(new Error("request cancelled"));

    await expect(selection.ensureTabAvailable(undefined, { signal: ctrl.signal })).rejects.toThrow(
      /request cancelled/i,
    );

    expect(listTabs).not.toHaveBeenCalled();
  });

  it("preserves a target-id-only opened tab for a Playwright-backed caller", async () => {
    vi.useFakeTimers();
    const openedTab = tab("OPENED");
    const otherWithWs = tab("OTHER", "ws://127.0.0.1/devtools/page/OTHER");
    const { selection } = createSelectionHarness({
      snapshots: [[], [otherWithWs]],
      openedTab,
    });

    const selected = selection.ensureTabAvailable(undefined, {
      allowPlaywrightFallback: true,
    });
    await advancePastDiscoveryWindow();

    await expect(selected).resolves.toEqual(openedTab);
  });

  it("polls until delayed wsUrl discovery makes an existing tab selectable", async () => {
    vi.useFakeTimers();
    const withoutWs = tab("LAGGING");
    const withWs = tab("LAGGING", "ws://127.0.0.1/devtools/page/LAGGING");
    const { selection, listTabs, openTab } = createSelectionHarness({
      snapshots: [[withoutWs], [withoutWs], [withWs]],
    });

    const selected = selection.ensureTabAvailable();
    await vi.advanceTimersByTimeAsync(OPEN_TAB_DISCOVERY_POLL_MS);

    await expect(selected).resolves.toEqual(withWs);
    expect(listTabs).toHaveBeenCalledTimes(3);
    expect(openTab).not.toHaveBeenCalled();
  });

  it("allows an existing target-id-only tab only for Playwright-backed callers", async () => {
    vi.useFakeTimers();
    const withoutWs = tab("PLAYWRIGHT_TARGET");
    const otherWithWs = tab("OTHER", "ws://127.0.0.1/devtools/page/OTHER");
    const { selection } = createSelectionHarness({
      snapshots: [[withoutWs, otherWithWs]],
    });

    const selected = selection.ensureTabAvailable("PLAYWRIGHT_TARGET", {
      allowPlaywrightFallback: true,
    });
    await advancePastDiscoveryWindow();

    await expect(selected).resolves.toEqual(withoutWs);
  });

  it("preserves a sticky target-id-only tab instead of switching to another tab", async () => {
    vi.useFakeTimers();
    const stickyWithoutWs = tab("STICKY");
    const otherWithWs = tab("OTHER", "ws://127.0.0.1/devtools/page/OTHER");
    const { selection, profileState } = createSelectionHarness({
      snapshots: [[stickyWithoutWs, otherWithWs]],
    });
    profileState.lastTargetId = stickyWithoutWs.targetId;

    const selected = selection.ensureTabAvailable(undefined, {
      allowPlaywrightFallback: true,
    });
    await advancePastDiscoveryWindow();

    await expect(selected).resolves.toEqual(stickyWithoutWs);
  });

  it("preserves a sticky raw target when another tab has a colliding friendly reference", async () => {
    const sticky = {
      ...tab("STICKY", "ws://127.0.0.1/devtools/page/STICKY"),
      suggestedTargetId: "t1",
      tabId: "t1",
    };
    const colliding = {
      ...tab("OTHER", "ws://127.0.0.1/devtools/page/OTHER"),
      suggestedTargetId: "STICKY",
      tabId: "t2",
      label: "STICKY",
    };
    const { selection, profileState } = createSelectionHarness({
      snapshots: [[sticky, colliding]],
    });
    profileState.lastTargetId = sticky.targetId;

    await expect(selection.ensureTabAvailable()).resolves.toEqual(sticky);
  });

  it("keeps polling after a transient tab-list rejection", async () => {
    vi.useFakeTimers();
    const withoutWs = tab("RECOVERED");
    const withWs = tab("RECOVERED", "ws://127.0.0.1/devtools/page/RECOVERED");
    const { selection, listTabs } = createSelectionHarness({
      snapshots: [[withoutWs], new Error("transient list failure"), [withWs]],
    });

    const selected = selection.ensureTabAvailable();
    await vi.advanceTimersByTimeAsync(OPEN_TAB_DISCOVERY_POLL_MS);

    await expect(selected).resolves.toEqual(withWs);
    expect(listTabs).toHaveBeenCalledTimes(3);
  });

  it("falls back to the last nonempty unfiltered snapshot after empty relists", async () => {
    vi.useFakeTimers();
    const withoutWs = tab("LAST_NONEMPTY");
    const { selection, openTab } = createSelectionHarness({
      snapshots: [[withoutWs], [], new Error("transient list failure")],
    });

    const selected = selection.ensureTabAvailable(undefined, {
      allowPlaywrightFallback: true,
    });
    await advancePastDiscoveryWindow();

    await expect(selected).resolves.toEqual(withoutWs);
    expect(openTab).not.toHaveBeenCalled();
  });

  it("rejects a target-id-only local tab when the caller cannot use Playwright", async () => {
    vi.useFakeTimers();
    const { selection } = createSelectionHarness({
      snapshots: [[tab("NO_PLAYWRIGHT")]],
    });

    const selected = expect(selection.ensureTabAvailable("NO_PLAYWRIGHT")).rejects.toThrow(
      /tab not found/i,
    );
    await advancePastDiscoveryWindow();

    await selected;
  });
});
