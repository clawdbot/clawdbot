import { describe, expect, it } from "vitest";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  createDeferred,
  flushBrowserResponses,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
} from "./browser-panel-controller-test-support.ts";

setupBrowserPanelTestCleanup();

describe("BrowserPanelController superseded tab snapshots", () => {
  it.each(["reject", "resolve"] as const)(
    "does not let a stale snapshot start a capture that %ss during a new-tab mutation",
    async (completion) => {
      stubScreenshotMedia();
      const activeUrl = "https://example.test/active";
      const nextUrl = "https://example.test/new";
      const activeTab = createBrowserPanelTestTab("active-tab", activeUrl, "Active");
      const tabs = [activeTab];
      const previousSnapshot = createDeferred<{ running: boolean; tabs: typeof tabs }>();
      const openedTab = createDeferred<ReturnType<typeof createBrowserPanelTestTab>>();
      let snapshotCount = 0;
      const { client, request } = createBrowserClient(async (envelope) => {
        if (envelope.path === "/tabs") {
          snapshotCount += 1;
          return snapshotCount === 1
            ? await previousSnapshot.promise
            : { running: true, tabs: [...tabs] };
        }
        if (envelope.path === "/tabs/open") {
          const next = await openedTab.promise;
          tabs.push(next);
          return next;
        }
        if (envelope.path === "/screenshot") {
          if (envelope.body?.targetId === "active-tab") {
            if (completion === "reject") {
              throw new Error("Superseded snapshot capture failed");
            }
            return { path: "/old.png", targetId: "raw-active", url: activeUrl };
          }
          return { path: "/fresh.png", targetId: "raw-new", url: nextUrl };
        }
        if (envelope.path === "/act") {
          return createBrowserPanelTestMetrics(nextUrl, "New");
        }
        throw new Error(`Unexpected browser route: ${envelope.path}`);
      });
      const controller = createBrowserPanelTestController(client, "active-tab", activeUrl);
      const previousView = controller.view;

      const refresh = controller.refreshAll();
      await flushBrowserResponses();
      const opening = controller.openUrl(nextUrl, { newTab: true });
      previousSnapshot.resolve({ running: true, tabs: [activeTab] });
      await refresh;

      expect(controller.loading).toBe(true);
      expect(controller.errorText).toBeNull();
      expect(controller.view).toBe(previousView);
      expect(
        request.mock.calls.some(([, envelope]) => {
          const browserRequest = envelope as {
            path?: string;
            body?: { targetId?: string };
          };
          return (
            browserRequest.path === "/screenshot" && browserRequest.body?.targetId === "active-tab"
          );
        }),
      ).toBe(false);

      openedTab.resolve(createBrowserPanelTestTab("new-tab", nextUrl, "New"));
      await opening;

      expect(controller.activeTargetId).toBe("new-tab");
      expect(controller.view?.url).toBe(nextUrl);
      expect(controller.loading).toBe(false);
      expect(controller.errorText).toBeNull();
    },
  );
});
