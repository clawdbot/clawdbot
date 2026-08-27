import type { ReactiveController } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { AnnotationStroke } from "./browser-annotation.ts";
import type { BrowserInspectedNode, BrowserPanelTab } from "./browser-client.ts";
import {
  captureBrowserScreenshot,
  closeBrowserTab,
  fetchBrowserScreenshotDataUrl,
  focusBrowserTab,
  goBrowserHistory,
  isBrowserEvaluateDisabledError,
  listBrowserTabs,
  navigateBrowser,
  openBrowserTab,
  resizeBrowserViewport,
  startBrowser,
} from "./browser-client.ts";
import { BrowserPanelInputController } from "./browser-panel-controller-input.ts";
import {
  BrowserPanelOperationOwnership,
  readBrowserPanelOwnedMetrics,
  type BrowserPanelControllerHost,
  type BrowserPanelSnapshotOutcome,
} from "./browser-panel-operation-ownership.ts";
import { BrowserPanelPendingInput } from "./browser-panel-pending-input.ts";
import { loadBrowserPanelImage, type BrowserPanelView } from "./browser-panel-surface.ts";
import { normalizeBrowserUrlDraft } from "./browser-url.ts";

const ACTION_REFRESH_DELAY_MS = 350;
const VIEWPORT_RESIZE_DELAY_MS = 300;
const MIN_VIEWPORT_DIMENSION = 100;
const MAX_VIEWPORT_DIMENSION = 8192;

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

  readonly operations: BrowserPanelOperationOwnership;
  readonly pendingInput = new BrowserPanelPendingInput();
  private readonly input: BrowserPanelInputController;
  private activeClient: GatewayBrowserClient | null = null;
  private urlDraftEditing = false;
  private observedViewportSize: { width: number; height: number } | null = null;
  private lastRequestedViewport: { targetId: string; width: number; height: number } | null = null;

  constructor(readonly host: BrowserPanelControllerHost) {
    this.operations = new BrowserPanelOperationOwnership(host);
    this.input = new BrowserPanelInputController(this);
    host.addController(this);
  }

  hostDisconnected(): void {
    this.input.cancelOverlayPointerGesture();
    this.invalidateViewOperations();
    this.setState("loading", false);
  }

  setState<Key extends keyof this>(key: Key, value: this[Key]): void {
    if (Object.is(this[key], value)) {
      return;
    }
    Object.assign(this, { [key]: value });
    this.host.requestUpdate();
  }

  synchronizeHostProperties(changed: Map<string, unknown>): boolean {
    if (!changed.has("client") && !changed.has("available")) {
      return false;
    }
    if (this.host.client !== this.activeClient) {
      this.activeClient = this.host.client;
      this.resetBrowserState();
      if (this.host.browserPanelIsOpen() && this.host.available && this.host.client) {
        void this.refreshAll();
        return true;
      }
    }
    return false;
  }

  private invalidateViewOperations(): void {
    this.operations.invalidate();
    this.pendingInput.clear();
    // The resize guard is per-document: after a tab or document change the
    // remote viewport may have been changed by an agent, so a previously
    // requested size must not suppress the next sync for the same target.
    this.lastRequestedViewport = null;
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
    this.input.resetCaptureState();
    this.setState("inspected", null);
    this.setState("inspectPointer", null);
    this.urlDraftEditing = false;
    this.setState("urlDraft", "");
    this.setState("pendingNewTab", false);
    // Re-probe per connection: another gateway may have evaluate enabled.
    this.setState("evaluateUnavailable", false);
  }

  reportError(error: unknown): void {
    const detail = formatUiError(error);
    this.setState("errorText", t("browser.errors.requestFailed", { error: detail }));
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
      this.setState("tabs", this.operations.retainTabSnapshot(client, snapshot.tabs));
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
        resourceBasePath: this.host.resourceBasePath,
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
      // Tab snapshots can lag history and in-page navigation. Keep the stable
      // identity aligned with the document this capture owns.
      this.setState("tabs", this.operations.capturedTabs(this.tabs, targetId, metrics, shot.url));
      this.setState("view", { targetId, dataUrl, image, url: shot.url, metrics });
      if (
        metrics &&
        this.observedViewportSize &&
        (Math.abs(metrics.cssWidth - this.observedViewportSize.width) > 1 ||
          Math.abs(metrics.cssHeight - this.observedViewportSize.height) > 1)
      ) {
        this.scheduleViewportSync();
      }
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

  async runAction(
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

  handleViewportResize(width: number, height: number): void {
    this.observedViewportSize = { width, height };
    this.scheduleViewportSync();
  }

  private scheduleViewportSync(): void {
    this.pendingInput.scheduleViewportResize(VIEWPORT_RESIZE_DELAY_MS, () => this.syncViewport());
  }

  private syncViewport(): void {
    const targetId = this.activeTargetId;
    const observed = this.observedViewportSize;
    // A debounced sync can outlive an ordinary dock close; a hidden panel must
    // never resize the agent-controlled browser.
    if (!this.host.browserPanelIsOpen() || !this.operations.captureClient()) {
      return;
    }
    if (!targetId || !observed) {
      return;
    }
    const width = Math.min(
      MAX_VIEWPORT_DIMENSION,
      Math.max(MIN_VIEWPORT_DIMENSION, Math.round(observed.width)),
    );
    const height = Math.min(
      MAX_VIEWPORT_DIMENSION,
      Math.max(MIN_VIEWPORT_DIMENSION, Math.round(observed.height)),
    );
    const currentView = this.view?.targetId === targetId ? this.view : null;
    // A failed or still-pending capture has not established the surface that
    // owns pointer coordinates. Wait for a successful view before syncing its
    // viewport, otherwise error-state layout changes can create a resize and
    // recapture loop.
    if (!currentView) {
      return;
    }
    const metrics = currentView.metrics;
    if (
      metrics &&
      Math.abs(metrics.cssWidth - width) <= 1 &&
      Math.abs(metrics.cssHeight - height) <= 1
    ) {
      return;
    }
    // A remote that cannot honor the exact size is not re-asked until the panel size or tab changes.
    if (
      this.lastRequestedViewport?.targetId === targetId &&
      this.lastRequestedViewport.width === width &&
      this.lastRequestedViewport.height === height
    ) {
      return;
    }
    this.lastRequestedViewport = { targetId, width, height };
    void this.runAction((client) => resizeBrowserViewport(client, { targetId, width, height }));
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
        if (previousNavigationQueued && this.activeTargetId) {
          const targetId = this.activeTargetId;
          // An earlier queued navigation may already have committed remotely.
          // Recover its actual document without replacing an unchanged view.
          const refreshed = await this.refreshTabsOnly(client, () => invocation.isCurrent());
          const active = this.tabs.find((tab) => tab.id === targetId);
          if (refreshed === "accepted" && invocation.isCurrent() && active) {
            this.setState("view", null);
            await this.refreshView(targetId, invocation.epoch);
            if (invocation.isCurrent() && this.view?.targetId === targetId) {
              this.operations.markNavigationReconciled(client, targetId);
            }
          }
          if (
            invocation.isCurrent() &&
            this.operations.hasUnreconciledNavigation(client, targetId)
          ) {
            this.setState("activeTargetId", null);
            this.setState("view", null);
            if (!this.urlDraftEditing) {
              this.setState("urlDraft", "");
            }
          }
        }
        this.reportError(error);
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
        this.setState("tabs", this.operations.retainTabSnapshot(client, snapshot.tabs));
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
    const client = this.operations.captureClient();
    const previous = { targetId: this.activeTargetId, view: this.view };
    this.invalidateViewOperations();
    const epoch = this.operations.epoch;
    this.setState("activeTargetId", targetId);
    this.setState("view", null);
    this.exitCaptureModes();
    const focused = await this.runAction(async (actionClient) => {
      await focusBrowserTab(actionClient, targetId);
      await this.refreshView(targetId);
      if (this.activeTargetId === targetId && this.view?.targetId === targetId) {
        this.operations.markNavigationReconciled(actionClient, targetId);
      }
    }, false);
    if (!focused && this.operations.isLive(epoch) && this.activeTargetId === targetId) {
      if (this.operations.hasPendingNavigation(client, previous.targetId)) {
        // The prior remote document changed while selection failed. Expose an
        // unavailable state instead of restoring a screenshot that no longer owns it.
        this.setState("activeTargetId", null);
        if (!this.urlDraftEditing) {
          this.setState("urlDraft", "");
        }
        return;
      }
      this.setState("activeTargetId", previous.targetId);
      this.setState("view", previous.view);
    }
  }

  async closeTab(targetId: string): Promise<void> {
    await this.runAction(async (client) => {
      const epoch = this.operations.epoch;
      await closeBrowserTab(client, targetId);
      this.operations.forgetNavigation(client, targetId);
      if (!this.operations.isLive(epoch, client)) {
        if (this.operations.isLive(this.operations.epoch, client)) {
          await this.refreshAll();
        }
        return;
      }
      // DELETE already committed; a failed tab snapshot must not resurrect its
      // target or make the next screenshot address a tab that no longer exists.
      this.setState(
        "tabs",
        this.tabs.filter((tab) => tab.id !== targetId),
      );
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
    await this.host.updateComplete;
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
    this.input.resetCaptureState();
    this.setState("mode", "interact");
    this.setState("strokes", []);
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

  inspectHighlightRegion() {
    return this.input.inspectHighlightRegion();
  }

  handleStageClick(event: MouseEvent): void {
    this.input.handleStageClick(event);
  }

  handleWheel(event: WheelEvent): void {
    this.input.handleWheel(event);
  }

  handleViewportKeydown(event: KeyboardEvent): void {
    this.input.handleViewportKeydown(event);
  }

  handleOverlayPointerDown(event: PointerEvent): void {
    this.input.handleOverlayPointerDown(event);
  }

  handleOverlayPointerMove(event: PointerEvent): void {
    this.input.handleOverlayPointerMove(event);
  }

  handleOverlayPointerUp(event: PointerEvent): void {
    this.input.handleOverlayPointerUp(event);
  }

  cancelOverlayPointerGesture(): void {
    this.input.cancelOverlayPointerGesture();
  }

  undoStroke(): void {
    this.input.undoStroke();
  }

  clearStrokes(): void {
    this.input.clearStrokes();
  }

  async sendAnnotation(params: { element?: BrowserInspectedNode | null }): Promise<void> {
    await this.input.sendAnnotation(params);
  }

  paintOverlay(): void {
    this.input.paintOverlay();
  }
}
