import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  loaded: [] as string[],
  coldImports: [] as string[],
  onClientLoad: undefined as (() => void) | undefined,
  onControlLoad: undefined as (() => void) | undefined,
  closeVolatile: vi.fn(async () => {}),
  closeDurable: vi.fn(async () => ({ status: "closed" as const })),
  getControlState: vi.fn(() => null),
}));

vi.mock("openclaw/plugin-sdk/browser-config", async (importOriginal) => {
  runtime.coldImports.push("browser-config");
  return await importOriginal();
});
vi.mock("./src/utils.js", async (importOriginal) => {
  runtime.coldImports.push("utils");
  return await importOriginal();
});
vi.mock("./src/browser/client.js", () => {
  runtime.loaded.push("client");
  runtime.onClientLoad?.();
  return { browserCloseTabByRawTargetId: runtime.closeVolatile };
});
vi.mock("./src/browser/cdp.helpers.js", () => {
  runtime.loaded.push("cdp");
  return { closeTrackedCdpTarget: runtime.closeDurable };
});
vi.mock("./src/browser-control-state.js", () => {
  runtime.loaded.push("control");
  runtime.onControlLoad?.();
  return { getBrowserControlState: runtime.getControlState };
});

it("loads browser close runtimes only for owned tabs", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await state.writeConfig({
      browser: {
        profiles: {
          remote: {
            driver: "existing-session",
            cdpUrl: "http://127.0.0.1:9222",
          },
        },
      },
    });
    const { initializeBrowserSessionTabStore, getBrowserSessionTabStore } =
      await import("./src/browser/session-tab-store.js");
    initializeBrowserSessionTabStore({
      state: {
        openSyncKeyedStore: (options) =>
          createPluginStateSyncKeyedStoreForTests("browser", options),
      },
    });
    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");
    const { trackSessionBrowserTab, untrackSessionBrowserTab } =
      await import("./src/browser/session-tab-registry.js");
    const sessionKey = "agent:main:browser-cleanup";
    try {
      await expect(closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] })).resolves.toBe(
        0,
      );
      expect.soft(runtime.loaded).toEqual([]);
      expect.soft(runtime.coldImports).toEqual([]);

      const volatileTab = {
        sessionKey,
        targetId: "volatile-tab",
        profile: "remote",
        route: { kind: "browser-control" as const, baseUrl: "http://127.0.0.1:9999" },
      };
      trackSessionBrowserTab({ ...volatileTab, now: 1_000 });
      runtime.onClientLoad = () => {
        untrackSessionBrowserTab(volatileTab);
        trackSessionBrowserTab({ ...volatileTab, now: 1_000 });
      };
      await expect(closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] })).resolves.toBe(
        0,
      );
      expect(runtime.closeVolatile).not.toHaveBeenCalled();
      await expect(closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] })).resolves.toBe(
        1,
      );
      expect.soft(runtime.loaded).toEqual(["client"]);
      expect(runtime.closeVolatile).toHaveBeenCalledWith("http://127.0.0.1:9999", "volatile-tab", {
        profile: "remote",
      });

      const durableTab = {
        sessionKey,
        targetId: "durable-tab",
        profile: "remote",
        ownership: {
          status: "durable" as const,
          nativeTargetId: "native-tab",
          profileFingerprint: "profile-fingerprint",
          browserInstanceFingerprint: "browser-fingerprint",
        },
      };
      trackSessionBrowserTab({ ...durableTab, now: 1_000 });
      runtime.onControlLoad = () => trackSessionBrowserTab({ ...durableTab, now: 2_000 });
      await expect(closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] })).resolves.toBe(
        0,
      );
      expect(runtime.closeDurable).not.toHaveBeenCalled();
      expect(getBrowserSessionTabStore().entries()).toHaveLength(1);
      await expect(closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] })).resolves.toBe(
        1,
      );
      expect(runtime.loaded.toSorted()).toEqual(["cdp", "client", "control"]);
      expect(runtime.closeDurable).toHaveBeenCalledWith(
        expect.objectContaining({
          profileName: "remote",
          nativeTargetId: "native-tab",
          expectedProfileFingerprint: "profile-fingerprint",
          expectedBrowserInstanceFingerprint: "browser-fingerprint",
          shouldClose: expect.any(Function),
        }),
      );
      expect(getBrowserSessionTabStore().entries()).toEqual([]);
      await expect(closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] })).resolves.toBe(
        0,
      );
      expect(runtime.closeVolatile).toHaveBeenCalledOnce();
      expect(runtime.closeDurable).toHaveBeenCalledOnce();
    } finally {
      resetPluginStateStoreForTests();
    }
  });
});
