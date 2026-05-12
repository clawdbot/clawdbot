// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDisconnected } from "./app-lifecycle.ts";

function createHost() {
  return {
    basePath: "",
    client: { stop: vi.fn() },
    connectGeneration: 0,
    connected: true,
    tab: "chat",
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    localMediaPreviewRoots: [],
    chatHasAutoScrolled: false,
    chatManualRefreshInFlight: false,
    chatLoading: false,
    chatMessages: [],
    chatToolMessages: [],
    chatStream: null,
    logsAutoFollow: false,
    logsAtBottom: true,
    logsEntries: [],
    sessionsChangedReloadTimer: null as number | ReturnType<typeof globalThis.setTimeout> | null,
    popStateHandler: vi.fn(),
    topbarObserver: { disconnect: vi.fn() } as unknown as ResizeObserver,
  };
}

describe("handleDisconnected", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops and clears gateway client on teardown", () => {
    vi.stubGlobal("window", {
      removeEventListener: vi.fn(),
    });
    const removeSpy = vi.spyOn(window, "removeEventListener").mockImplementation(() => undefined);
    const host = createHost();
    const disconnectSpy = (
      host.topbarObserver as unknown as { disconnect: ReturnType<typeof vi.fn> }
    ).disconnect;

    handleDisconnected(host as unknown as Parameters<typeof handleDisconnected>[0]);

    expect(removeSpy).toHaveBeenCalledWith("popstate", host.popStateHandler);
    expect(host.connectGeneration).toBe(1);
    expect(host.client).toBeNull();
    expect(host.connected).toBe(false);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(host.topbarObserver).toBeNull();
    removeSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("clears pending session reload timers on teardown", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      removeEventListener: vi.fn(),
    });
    const host = createHost();
    const pendingReload = vi.fn();
    host.sessionsChangedReloadTimer = globalThis.setTimeout(pendingReload, 1_000);

    handleDisconnected(host as unknown as Parameters<typeof handleDisconnected>[0]);

    expect(host.sessionsChangedReloadTimer).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(pendingReload).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
