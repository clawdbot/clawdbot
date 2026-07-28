import type { ReactiveController } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { AnnotationStroke } from "./browser-annotation.ts";
import {
  captureBrowserScreenshot,
  clickBrowserCoords,
  closeBrowserTab,
  fetchBrowserScreenshotDataUrl,
  focusBrowserTab,
  goBrowserHistory,
  inspectBrowserElementAt,
  isBrowserEvaluateDisabledError,
  listBrowserTabs,
  navigateBrowser,
  openBrowserTab,
  pressBrowserKey,
  scrollBrowserBy,
  startBrowser,
  type BrowserInspectedNode,
  type BrowserPanelTab,
} from "./browser-client.ts";
import {
  BrowserPanelOperationOwnership,
  readBrowserPanelOwnedMetrics,
  type BrowserPanelControllerHost,
  type BrowserPanelSnapshotOutcome,
} from "./browser-panel-operation-ownership.ts";
import { BrowserPanelPendingInput } from "./browser-panel-pending-input.ts";
import {
  browserPanelInspectHighlightRegion,
  browserPanelNormalizedPoint,
  browserPanelRemotePoint,
  browserPanelShouldForwardKey,
  dispatchCompositedBrowserAnnotation,
  loadBrowserPanelImage,
  paintBrowserPanelOverlay,
  type BrowserPanelView,
} from "./browser-panel-surface.ts";
import { normalizeBrowserUrlDraft } from "./browser-url.ts";

const INSPECT_THROTTLE_MS = 120;
const ACTION_REFRESH_DELAY_MS = 350;

type BrowserPanelMode = "interact" | "annotate" | "inspect";

export type { BrowserPanelControllerHost } from "./browser-panel-operation-ownership.ts";

/** Browser session, navigation, capture, and input lifecycle for the docked surface. */
export class BrowserPanelController implements ReactiveController {
  running: boolean | null = null;
  tabs: BrowserPanelTab[] = [];
  /** Stable tab handle (plugin alias when available), not a raw CDP target id. */
  activeTargetId: string | null = null;
  view: BrowserPanelView | null = null;
  loading = false;
  errorText: string | null = null;
  noticeText: string | null = null;
  mode: BrowserPanelMode = "interact";
  strokes: AnnotationStroke[] = [];
  inspected: BrowserInspectedNode | null = null;
  inspectPointer: { x: number; y: number } | null = null;
  evaluateUnavailable = false;
  urlDraft = "";
  pendingNewTab = false;

  private readonly operations: BrowserPanelOperationOwnership;
  private readonly pendingInput = new BrowserPanelPendingInput();
  private activeClient: GatewayBrowserClient | null = null;
  private drawingStroke: AnnotationStroke | null = null;
  private suppressStageClick = false;
  private urlDraftEditing = false;

  constructor(private readonly host: BrowserPanelControllerHost) {
    this.operations = new BrowserPanelOperationOwnership(host);
    host.addController(this);
  }

  hostDisconnected(): void {
    this.invalidateViewOperations();
    this.setState("loading", false);
  }

  private setState<Key extends keyof this>(key: Key, value: this[Key]): void {
    if (Object.is(this[key], value)) {
      return;
    }
    Object.assign(this, { [key]: value });
    this.host.requestUpdate();
  }

  synchronizeHostProperties(changed: Map<string, unknown>): void {
    if (!changed.has("client") && !changed.has("available")) {
      return;
    }
    if (this.host.client !== this.activeClient) {
      this.activeClient = this.host.client;
      this.resetBrowserState();
      if (this.host.browserPanelIsOpen() && this.host.available && this.host.client) {
        void this.refreshAll();
      }
    }
  }

  private invalidateViewOperations(): void {
    this.operations.invalidate();
    this.pendingInput.clear();
  }

  resetBrowserState(): void {
    this.invalidateViewOperations();
    this.setState("running", null);
    this.setState("tabs", []);
    this.setState("activeTargetId", null);
    this.setState("view", null);
    this.setState("loading", false);
    this.setState("errorText", null);
    this.setState("noticeText", null);
    this.setState("mode", "interact");
    this.setState("strokes", []);
    this.drawingStroke = null;
    this.setState("inspected", null);
    this.setState("inspectPointer", null);
    this.setState("pendingNewTab", false);
    // Re-probe per connection: another gateway may have evaluate enabled.
    this.setState("evaluateUnavailable", false);
  }

  private reportError(error: unknown): void {
    this.setState("errorText", error instanceof Error ? error.message : String(error));
  }

  async refreshAll(): Promise<void> {
    const client = this.operations.captureClient();
    if (!client) {
      return;
    }
    const invocation = this.operations.beginSnapshot(client);
    this.setState("errorText", null);
    this.setState("loading", true);
    try {
      const snapshot = await listBrowserTabs(client);
      const active =
        snapshot.tabs.find((tab) => tab.id === this.activeTargetId) ?? snapshot.tabs[0];
      if (!this.operations.acceptSnapshot(invocation, this.activeTargetId, active?.id ?? null)) {
        return;
      }
      this.setState("running", snapshot.running);
      this.setState("tabs", snapshot.tabs);
      // A mutation may adopt the same tab while this snapshot is pending.
      // Reconcile its tab strip, but never let it own document or loading state.
      if (!this.operations.canCaptureSnapshot(invocation)) {
        return;
      }
      if (!snapshot.running) {
        this.setState("view", null);
      }
      if (this.activeTargetId !== null && active?.id !== this.activeTargetId) {
        this.invalidateViewOperations();
        invocation.epoch = this.operations.epoch;
        this.setState("view", null);
        this.exitCaptureModes();
      }
      this.setState("activeTargetId", active?.id ?? null);
      if (!this.urlDraftEditing) {
        this.setState("urlDraft", active?.url ?? "");
      }
      if (active) {
        await this.refreshView(active.id, invocation.epoch);
      } else {
        this.setState("view", null);
      }
    } catch (error) {
      if (invocation.isCurrent()) {
        this.reportError(error);
      }
    } finally {
      if (invocation.isCurrent()) {
        this.setState("loading", false);
      }
    }
  }

  private async refreshView(targetId: string, epoch = this.operations.epoch): Promise<void> {
    const client = this.operations.captureClient();
    if (!client) {
      return;
    }
    const current = this.operations.beginCapture(
      client,
      targetId,
      () => this.activeTargetId,
      epoch,
    );
    if (!current) {
      return;
    }
    this.setState("loading", true);
    try {
      const shot = await captureBrowserScreenshot(client, targetId);
      if (!current()) {
        return;
      }
      const dataUrl = await fetchBrowserScreenshotDataUrl({
        basePath: this.host.basePath,
        authToken: this.host.authToken,
        path: shot.path,
      });
      const image = await loadBrowserPanelImage(dataUrl);
      const observedMetrics = await readBrowserPanelOwnedMetrics(
        client,
        targetId,
        this.evaluateUnavailable,
        current,
        () => this.setState("evaluateUnavailable", true),
      );
      if (!current()) {
        return;
      }
      // A navigation between screenshot and evaluation changes the coordinate document.
      const metrics =
        shot.url && observedMetrics?.url && shot.url !== observedMetrics.url
          ? null
          : observedMetrics;
      this.setState("view", { targetId, dataUrl, image, url: shot.url, metrics });
      if (!this.urlDraftEditing && shot.url) {
        this.setState("urlDraft", shot.url);
      }
    } catch (error) {
      if (current()) {
        this.reportError(error);
      }
    } finally {
      if (current()) {
        this.operations.completeCapture();
        this.setState("loading", false);
      }
    }
  }

  private async runAction(
    action: (client: GatewayBrowserClient) => Promise<void>,
    refreshView = true,
  ): Promise<boolean> {
    const client = this.operations.captureClient();
    if (!client) {
      return false;
    }
    const epoch = this.operations.epoch;
    const current = () => this.operations.isLive(epoch, client);
    try {
      this.setState("errorText", null);
      await action(client);
      if (current() && refreshView) {
        this.pendingInput.scheduleRefresh(ACTION_REFRESH_DELAY_MS, () => {
          if (current() && this.activeTargetId) {
            void this.refreshView(this.activeTargetId, epoch);
          }
        });
      }
      return current();
    } catch (error) {
      if (!current()) {
        return false;
      }
      if (isBrowserEvaluateDisabledError(error)) {
        this.setState("evaluateUnavailable", true);
      }
      this.reportError(error);
      if (!this.operations.hasPendingCapture) {
        this.setState("loading", false);
      }
      return false;
    }
  }

  async startBrowserNow(): Promise<void> {
    if (!this.operations.captureClient()) {
      return;
    }
    const epoch = this.operations.epoch;
    this.setState("loading", true);
    await this.runAction(async (actionClient) => {
      await startBrowser(actionClient);
      if (this.operations.isLive(epoch, actionClient)) {
        await this.refreshAll();
      }
    }, false);
  }

  async openUrl(url: string, options: { newTab: boolean }): Promise<void> {
    const client = this.operations.captureClient();
    if (!client) {
      return;
    }
    const invocation = this.operations.beginMutation(client);
    this.setState("loading", true);
    this.setState("errorText", null);
    this.setState("pendingNewTab", false);
    let previousNavigationQueued = false;
    try {
      if (options.newTab || !this.activeTargetId) {
        const tab = await openBrowserTab(client, url);
        if (!invocation.isCurrent()) {
          // An already-created stale tab still belongs in the surviving tab strip.
          await this.refreshTabsOnly(
            client,
            this.operations.survivingInvocation(invocation, client),
          );
          return;
        }
        const nextTargetId = tab?.id ?? this.activeTargetId;
        if (nextTargetId !== this.activeTargetId) {
          this.invalidateViewOperations();
          invocation.epoch = this.operations.epoch;
          this.setState("view", null);
          this.exitCaptureModes();
        }
        this.setState("activeTargetId", nextTargetId);
      } else {
        // Keep the stable alias as the active handle; navigate may swap the
        // raw target underneath and the alias migrates server-side.
        this.invalidateViewOperations();
        invocation.epoch = this.operations.epoch;
        this.exitCaptureModes();
        const targetId = this.activeTargetId;
        previousNavigationQueued =
          this.operations.hasQueuedNavigation(client, targetId) ||
          this.operations.hasUnreconciledNavigation(client, targetId);
        await this.operations.queueNavigation(client, targetId, async () => {
          if (invocation.isCurrent()) {
            await navigateBrowser(client, { url, targetId });
            this.operations.markNavigationCommitted(client, targetId);
          }
        });
        if (!invocation.isCurrent()) {
          return;
        }
        this.setState("view", null);
      }
      const refreshed = await this.refreshTabsOnly(client, () => invocation.isCurrent());
      if (refreshed !== "rejected" && invocation.isCurrent() && this.activeTargetId) {
        const targetId = this.activeTargetId;
        await this.refreshView(targetId, invocation.epoch);
        if (!options.newTab && invocation.isCurrent() && this.view?.targetId === targetId) {
          this.operations.markNavigationReconciled(client, targetId);
        }
      }
    } catch (error) {
      if (invocation.isCurrent()) {
        this.reportError(error);
        if (previousNavigationQueued && this.activeTargetId) {
          const targetId = this.activeTargetId;
          const navigationErrorText = this.errorText;
          // An earlier queued navigation may already have committed remotely.
          // Recover its actual document without replacing an unchanged view.
          try {
            const refreshed = await this.refreshTabsOnly(client, () => invocation.isCurrent());
            const active = this.tabs.find((tab) => tab.id === targetId);
            if (refreshed === "accepted" && invocation.isCurrent() && active) {
              await this.refreshView(targetId, invocation.epoch);
              if (
                invocation.isCurrent() &&
                this.view?.targetId === targetId &&
                this.errorText === navigationErrorText
              ) {
                this.operations.markNavigationReconciled(client, targetId);
              }
            }
          } catch {
            // Recovery is best-effort; retain the original navigation failure.
          }
          if (invocation.isCurrent()) {
            this.reportError(error);
          }
        }
      }
    } finally {
      if (invocation.isCurrent()) {
        this.setState("loading", false);
      }
    }
  }

  private async refreshTabsOnly(
    client: GatewayBrowserClient,
    current: () => boolean,
  ): Promise<BrowserPanelSnapshotOutcome> {
    const invocation = this.operations.beginSnapshot(client);
    try {
      const snapshot = await listBrowserTabs(client);
      if (
        current() &&
        this.operations.acceptSnapshot(invocation, this.activeTargetId, this.activeTargetId)
      ) {
        this.setState("running", snapshot.running);
        this.setState("tabs", snapshot.tabs);
        return "accepted";
      }
      return "rejected";
    } catch {
      // Best-effort tab reconciliation must not let an older failure settle
      // loading or advance a document owned by a newer operation.
      return current() && invocation.isCurrent() ? "failed" : "rejected";
    }
  }

  async selectTab(targetId: string): Promise<void> {
    if (targetId === this.activeTargetId) {
      return;
    }
    const previous = { targetId: this.activeTargetId, view: this.view };
    this.invalidateViewOperations();
    const epoch = this.operations.epoch;
    this.setState("activeTargetId", targetId);
    this.setState("view", null);
    this.exitCaptureModes();
    const focused = await this.runAction(async (client) => {
      await focusBrowserTab(client, targetId);
      await this.refreshView(targetId);
    }, false);
    if (!focused && this.operations.isLive(epoch) && this.activeTargetId === targetId) {
      this.setState("activeTargetId", previous.targetId);
      this.setState("view", previous.view);
    }
  }

  async closeTab(targetId: string): Promise<void> {
    await this.runAction(async (client) => {
      const epoch = this.operations.epoch;
      await closeBrowserTab(client, targetId);
      if (!this.operations.isLive(epoch, client)) {
        if (this.operations.isLive(this.operations.epoch, client)) {
          await this.refreshAll();
        }
        return;
      }
      const snapshot = await this.refreshTabsOnly(client, () =>
        this.operations.isLive(epoch, client),
      );
      if (!this.operations.isLive(epoch, client)) {
        return;
      }
      if (this.activeTargetId !== targetId) {
        if (snapshot !== "rejected" && !this.operations.hasPendingCapture) {
          this.setState("loading", false);
        }
        return;
      }
      const next = this.tabs[0] ?? null;
      this.invalidateViewOperations();
      this.setState("activeTargetId", next?.id ?? null);
      this.setState("view", null);
      this.exitCaptureModes();
      if (next) {
        await this.refreshView(next.id);
      } else {
        this.setState("loading", false);
      }
    }, false);
  }

  /** Real page reload: re-navigate to the current URL, then re-capture. A bare
   * screenshot refresh would leave the remote document untouched. */
  reloadPage(): void {
    const url = this.view?.metrics?.url || this.view?.url || this.urlDraft;
    const normalized = normalizeBrowserUrlDraft(url);
    if (!this.activeTargetId) {
      return;
    }
    if (!normalized) {
      void this.refreshView(this.activeTargetId);
      return;
    }
    void this.openUrl(normalized, { newTab: false });
  }

  goHistory(delta: -1 | 1): void {
    const targetId = this.activeTargetId;
    if (!targetId) {
      return;
    }
    void this.runAction((client) => goBrowserHistory(client, { targetId, delta }));
  }

  commitUrlDraft(): void {
    const url = normalizeBrowserUrlDraft(this.urlDraft);
    if (!url) {
      return;
    }
    void this.openUrl(url, { newTab: this.pendingNewTab || this.tabs.length === 0 });
  }

  beginNewTab(): void {
    this.setState("pendingNewTab", true);
    this.setState("urlDraft", "");
    void this.host.updateComplete.then(() =>
      this.host.renderRoot.querySelector<HTMLInputElement>(".bp-url")?.focus(),
    );
  }

  setUrlDraft(value: string): void {
    this.setState("urlDraft", value);
  }

  setUrlDraftEditing(editing: boolean): void {
    this.urlDraftEditing = editing;
  }

  resetUrlDraftFromView(): void {
    this.setState("urlDraft", this.view?.metrics?.url || this.view?.url || "");
  }

  exitCaptureModes(): void {
    this.operations.invalidateInspection();
    this.pendingInput.clearInput();
    this.setState("mode", "interact");
    this.setState("strokes", []);
    this.drawingStroke = null;
    this.setState("inspected", null);
    this.setState("inspectPointer", null);
  }

  setMode(mode: BrowserPanelMode): void {
    if (this.mode === mode) {
      this.exitCaptureModes();
      return;
    }
    this.exitCaptureModes();
    this.setState("mode", mode);
    this.setState("noticeText", null);
    if (mode === "inspect" && this.evaluateUnavailable) {
      this.setState("errorText", t("browser.inspectUnavailable"));
      this.setState("mode", "interact");
    }
  }

  private stageElement(): HTMLElement | null {
    return this.host.renderRoot.querySelector<HTMLElement>(".bp-stage");
  }

  private remotePoint(event: MouseEvent): { x: number; y: number } | null {
    return browserPanelRemotePoint(this.stageElement(), event, this.view);
  }

  inspectHighlightRegion() {
    return browserPanelInspectHighlightRegion(this.view, this.inspected);
  }

  handleStageClick(event: MouseEvent): void {
    if (this.suppressStageClick) {
      // The click that follows an inspect-capture pointerdown lands after the
      // mode already returned to interact; it must not reach the remote page.
      this.suppressStageClick = false;
      return;
    }
    if (this.mode !== "interact") {
      return;
    }
    // Keep keyboard forwarding live after a click; the canvas itself is not
    // focusable, so focus the surrounding viewport explicitly.
    this.host.renderRoot.querySelector<HTMLElement>(".bp-viewport")?.focus({ preventScroll: true });
    const point = this.remotePoint(event);
    const targetId = this.activeTargetId;
    if (!point || !targetId) {
      return;
    }
    void this.runAction((client) =>
      clickBrowserCoords(client, { targetId, x: point.x, y: point.y }),
    );
  }

  handleWheel(event: WheelEvent): void {
    if (this.mode !== "interact" || !this.view) {
      return;
    }
    const client = this.operations.captureClient();
    const targetId = this.activeTargetId;
    if (!client || !targetId) {
      return;
    }
    event.preventDefault();
    const epoch = this.operations.epoch;
    this.pendingInput.queueWheel(event.deltaX, event.deltaY, 150, (deltaX, deltaY) => {
      if (
        !this.operations.isLive(epoch, client) ||
        this.activeTargetId !== targetId ||
        this.mode !== "interact"
      ) {
        return;
      }
      void this.runAction(async (actionClient) => {
        if (this.evaluateUnavailable) {
          // No page JS allowed: fall back to a coarse keyboard scroll.
          await pressBrowserKey(actionClient, {
            targetId,
            key: deltaY >= 0 ? "PageDown" : "PageUp",
          });
          return;
        }
        await scrollBrowserBy(actionClient, { targetId, deltaX, deltaY });
      });
    });
  }

  handleViewportKeydown(event: KeyboardEvent): void {
    if (this.mode !== "interact" || !this.view) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const key = event.key;
    const targetId = this.activeTargetId;
    if (!browserPanelShouldForwardKey(key) || !targetId) {
      return;
    }
    event.preventDefault();
    void this.runAction((client) => pressBrowserKey(client, { targetId, key }));
  }

  handleOverlayPointerDown(event: PointerEvent): void {
    if (this.mode === "inspect") {
      this.suppressStageClick = true;
      void this.sendAnnotation({ element: this.inspected });
      return;
    }
    if (this.mode !== "annotate") {
      return;
    }
    const point = browserPanelNormalizedPoint(this.stageElement(), event);
    if (!point) {
      return;
    }
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    this.drawingStroke = { points: [point] };
    this.setState("strokes", [...this.strokes, this.drawingStroke]);
    this.paintOverlay();
  }

  handleOverlayPointerMove(event: PointerEvent): void {
    if (this.mode === "annotate") {
      if (!this.drawingStroke) {
        return;
      }
      const point = browserPanelNormalizedPoint(this.stageElement(), event);
      if (point) {
        this.drawingStroke.points.push(point);
        this.paintOverlay();
      }
      return;
    }
    if (this.mode === "inspect") {
      this.queueInspect(event);
    }
  }

  handleOverlayPointerUp(): void {
    this.drawingStroke = null;
  }

  private queueInspect(event: PointerEvent): void {
    const client = this.operations.captureClient();
    const point = this.remotePoint(event);
    const stagePoint = browserPanelNormalizedPoint(this.stageElement(), event);
    const targetId = this.activeTargetId;
    if (!client || !point || !stagePoint || !targetId || this.evaluateUnavailable) {
      return;
    }
    const current = this.operations.beginInspection(
      client,
      () =>
        this.activeTargetId === targetId &&
        this.view?.targetId === targetId &&
        this.mode === "inspect",
    );
    this.setState("inspectPointer", stagePoint);
    this.pendingInput.queueInspection(INSPECT_THROTTLE_MS, current, () => {
      void inspectBrowserElementAt(client, { targetId, x: point.x, y: point.y })
        .then((node) => {
          if (current()) {
            this.setState("inspected", node);
            this.paintOverlay();
          }
        })
        .catch((error: unknown) => {
          if (current() && isBrowserEvaluateDisabledError(error)) {
            this.setState("evaluateUnavailable", true);
            this.setState("errorText", t("browser.inspectUnavailable"));
            this.setState("mode", "interact");
          }
        });
    });
  }

  undoStroke(): void {
    this.setState("strokes", this.strokes.slice(0, -1));
    this.drawingStroke = null;
    this.paintOverlay();
  }

  clearStrokes(): void {
    this.setState("strokes", []);
    this.drawingStroke = null;
    this.paintOverlay();
  }

  async sendAnnotation(params: { element?: BrowserInspectedNode | null }): Promise<void> {
    const view = this.view;
    const tab = this.tabs.find((entry) => entry.id === this.activeTargetId);
    const element = params.element ?? null;
    if (!view || (this.strokes.length === 0 && !element)) {
      return;
    }
    const highlight = element ? this.inspectHighlightRegion() : null;
    let handled: boolean;
    try {
      handled = dispatchCompositedBrowserAnnotation(view, tab, this.strokes, element, highlight);
    } catch (error) {
      this.reportError(error);
      return;
    }
    if (!handled) {
      this.setState("errorText", t("browser.noChatTarget"));
      return;
    }
    this.setState("noticeText", t("browser.annotationSent"));
    this.exitCaptureModes();
  }

  /** Repaints the live stroke/highlight overlay; cheap, runs after render. */
  paintOverlay(): void {
    paintBrowserPanelOverlay(
      this.host.renderRoot.querySelector<HTMLCanvasElement>(".bp-overlay"),
      this.stageElement(),
      this.strokes,
      this.mode === "inspect" ? this.inspectHighlightRegion() : null,
    );
  }
}
