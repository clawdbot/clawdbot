import type { NativeBrowserTab } from "../../app/native-browser-bridge.ts";
import {
  captureBrowserScreenshot,
  fetchBrowserScreenshotDataUrl,
  isBrowserNavigationBlockedError,
  type BrowserPanelTab,
} from "./browser-client.ts";
import {
  readBrowserPanelOwnedMetrics,
  type BrowserPanelControllerHost,
  type BrowserPanelOperationOwnership,
} from "./browser-panel-operation-ownership.ts";
import { loadBrowserPanelImage, type BrowserPanelView } from "./browser-panel-surface.ts";
import type { BrowserPanelViewportController } from "./browser-panel-viewport-controller.ts";

type BrowserPanelSnapshotState = {
  tabs: BrowserPanelTab[];
  view: BrowserPanelView | null;
  loading: boolean;
  evaluateUnavailable: boolean;
};

interface BrowserPanelSnapshotHost extends BrowserPanelSnapshotState {
  readonly host: Pick<BrowserPanelControllerHost, "resourceBasePath" | "authToken">;
  readonly native: { readonly activeTab: NativeBrowserTab | undefined };
  readonly activeTargetId: string | null;
  readonly operations: Pick<
    BrowserPanelOperationOwnership,
    | "epoch"
    | "captureClient"
    | "isLive"
    | "beginCapture"
    | "capturedTabs"
    | "route"
    | "completeCapture"
  >;
  setState<Key extends keyof BrowserPanelSnapshotState>(
    key: Key,
    value: BrowserPanelSnapshotState[Key],
  ): void;
  clearUnavailableView(): boolean;
  syncUrlDraft(url: string): void;
  reportError(error: unknown): void;
}

/** A remote snapshot owns both its image and the page metrics used for input. */
export class BrowserPanelSnapshotController {
  constructor(
    private readonly controller: BrowserPanelSnapshotHost,
    private readonly viewport: BrowserPanelViewportController,
  ) {}

  async capture(targetId: string, epoch = this.controller.operations.epoch): Promise<void> {
    const client = this.controller.operations.captureClient();
    if (
      this.controller.native.activeTab ||
      !client ||
      !this.controller.operations.isLive(epoch, client) ||
      this.controller.activeTargetId !== targetId
    ) {
      return;
    }
    if (this.controller.clearUnavailableView()) {
      return;
    }
    const current = this.controller.operations.beginCapture(
      client,
      targetId,
      () => this.controller.activeTargetId,
      epoch,
    );
    if (!current) {
      return;
    }
    this.controller.setState("loading", true);
    try {
      const shot = await captureBrowserScreenshot(client, targetId);
      if (!current()) {
        return;
      }
      const dataUrl = await fetchBrowserScreenshotDataUrl({
        resourceBasePath: this.controller.host.resourceBasePath,
        authToken: this.controller.host.authToken,
        path: shot.path,
      });
      if (!current()) {
        return;
      }
      const image = await loadBrowserPanelImage(dataUrl);
      const observedMetrics = await readBrowserPanelOwnedMetrics(
        client,
        targetId,
        this.controller.evaluateUnavailable,
        current,
        () => this.controller.setState("evaluateUnavailable", true),
      );
      if (!current()) {
        return;
      }
      // A navigation between screenshot and evaluation changes the coordinate document.
      const metrics =
        shot.url && observedMetrics?.url && shot.url !== observedMetrics.url
          ? null
          : observedMetrics;
      // Tab snapshots can lag history and in-page navigation. Keep the stable
      // identity aligned with the document this capture owns.
      this.controller.setState(
        "tabs",
        this.controller.operations.capturedTabs(this.controller.tabs, targetId, metrics, shot.url),
      );
      this.controller.setState("view", {
        targetId,
        dataUrl,
        image,
        url: shot.url,
        metrics,
        ...(this.controller.operations.route
          ? { browserTab: { ...this.controller.operations.route, targetId } }
          : {}),
      });
      this.viewport.captured(metrics);
      if (shot.url) {
        this.controller.syncUrlDraft(shot.url);
      }
    } catch (error) {
      if (current()) {
        // A capture denial describes the selected tab; a denied navigation
        // describes the destination and must keep the valid source screenshot.
        if (isBrowserNavigationBlockedError(error)) {
          this.controller.setState(
            "tabs",
            this.controller.tabs.map((tab) =>
              tab.id === targetId
                ? { ...tab, url: "", urlUnavailableReason: "navigation_blocked" }
                : tab,
            ),
          );
          if (!this.controller.clearUnavailableView()) {
            this.controller.reportError(error);
          }
        } else {
          this.controller.reportError(error);
        }
      }
    } finally {
      if (current()) {
        this.controller.operations.completeCapture();
        this.controller.setState("loading", false);
      }
    }
  }
}
