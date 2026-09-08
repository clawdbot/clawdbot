import type { NativeBrowserTab } from "../../app/native-browser-bridge.ts";
import { isBrowserNavigationBlockedError, type BrowserPanelTab } from "./browser-client.ts";
import {
  captureBrowserPanelOwnedView,
  type BrowserPanelControllerHost,
  type BrowserPanelOperationOwnership,
} from "./browser-panel-operation-ownership.ts";
import type { BrowserPanelStream } from "./browser-panel-stream.ts";
import type { BrowserPanelView } from "./browser-panel-surface.ts";
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
  readonly stream: Pick<
    BrowserPanelStream,
    "ownsView" | "ensure" | "frameRevision" | "releaseReplacedView"
  >;
  readonly activeTargetId: string | null;
  readonly mode: "interact" | "annotate" | "inspect";
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
      this.controller.activeTargetId !== targetId ||
      this.controller.mode !== "interact"
    ) {
      return;
    }
    if (this.controller.clearUnavailableView() || this.controller.stream.ownsView(targetId)) {
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
    const stream = this.controller.stream;
    let captureRevision = stream.frameRevision;
    const captureCurrent = () =>
      current() &&
      this.controller.mode === "interact" &&
      captureRevision === stream.frameRevision &&
      !stream.ownsView(targetId);
    try {
      if (
        (await stream.ensure(targetId, client, epoch)) ||
        !current() ||
        stream.ownsView(targetId)
      ) {
        return;
      }
      captureRevision = stream.frameRevision;
      const view = await captureBrowserPanelOwnedView({
        client,
        targetId,
        route: this.controller.operations.route,
        host: this.controller.host,
        isEvaluateUnavailable: () => this.controller.evaluateUnavailable,
        current: captureCurrent,
        markEvaluateUnavailable: () => this.controller.setState("evaluateUnavailable", true),
      });
      if (!view || !captureCurrent()) {
        return;
      }
      const { metrics } = view;
      // Tab snapshots can lag history and in-page navigation. Keep the stable
      // identity aligned with the document this capture owns.
      this.controller.setState(
        "tabs",
        this.controller.operations.capturedTabs(this.controller.tabs, targetId, metrics, view.url),
      );
      this.controller.setState("view", view);
      stream.releaseReplacedView();
      this.viewport.captured(metrics);
      if (view.url) {
        this.controller.syncUrlDraft(view.url);
      }
    } catch (error) {
      if (captureCurrent()) {
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
