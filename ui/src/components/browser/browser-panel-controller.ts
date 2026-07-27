import type { ReactiveController, ReactiveControllerHost } from "lit";
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
  readBrowserPageMetrics,
  scrollBrowserBy,
  startBrowser,
  type BrowserInspectedNode,
  type BrowserPageMetrics,
  type BrowserPanelTab,
} from "./browser-client.ts";
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

export interface BrowserPanelControllerHost extends ReactiveControllerHost {
  readonly client: GatewayBrowserClient | null;
  readonly available: boolean;
  readonly basePath: string;
  readonly authToken: string | null;
  readonly isConnected: boolean;
  readonly renderRoot: HTMLElement | DocumentFragment;
  readonly updateComplete: Promise<boolean>;
  browserPanelIsOpen(): boolean;
}

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

  /** Rejects stale async results after the client, tab, or panel state moves on. */
  private viewEpoch = 0;
  private refreshTimer: number | null = null;
  private activeClient: GatewayBrowserClient | null = null;
  private drawingStroke: AnnotationStroke | null = null;
  private suppressStageClick = false;
  private urlDraftEditing = false;
  private wheelDeltaX = 0;
  private wheelDeltaY = 0;
  private wheelTimer: number | null = null;
  private lastInspectAt = 0;
  private inspectTimer: number | null = null;

  constructor(private readonly host: BrowserPanelControllerHost) {
    host.addController(this);
  }

  hostConnected(): void {}

  hostDisconnected(): void {
    this.clearTimers();
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

  private clearTimers(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.wheelTimer !== null) {
      clearTimeout(this.wheelTimer);
      this.wheelTimer = null;
    }
    if (this.inspectTimer !== null) {
      clearTimeout(this.inspectTimer);
      this.inspectTimer = null;
    }
  }

  resetBrowserState(): void {
    this.viewEpoch += 1;
    this.clearTimers();
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

  private currentEpoch(): number {
    return this.viewEpoch;
  }

  private isCurrent(epoch: number): boolean {
    return this.host.isConnected && this.host.browserPanelIsOpen() && this.viewEpoch === epoch;
  }

  private captureClient(): GatewayBrowserClient | null {
    return this.host.available && this.host.client ? this.host.client : null;
  }

  private reportError(error: unknown): void {
    this.setState("errorText", error instanceof Error ? error.message : String(error));
  }

  async refreshAll(): Promise<void> {
    const client = this.captureClient();
    if (!client) {
      return;
    }
    const epoch = this.currentEpoch();
    this.setState("errorText", null);
    this.setState("loading", true);
    try {
      const snapshot = await listBrowserTabs(client);
      if (!this.isCurrent(epoch)) {
        return;
      }
      this.setState("running", snapshot.running);
      this.setState("tabs", snapshot.tabs);
      if (!snapshot.running) {
        this.setState("view", null);
      }
      const active =
        snapshot.tabs.find((tab) => tab.id === this.activeTargetId) ?? snapshot.tabs[0];
      this.setState("activeTargetId", active?.id ?? null);
      if (!this.urlDraftEditing) {
        this.setState("urlDraft", active?.url ?? "");
      }
      if (active) {
        await this.refreshView(active.id, epoch);
      } else {
        this.setState("view", null);
      }
    } catch (error) {
      if (this.isCurrent(epoch)) {
        this.reportError(error);
      }
    } finally {
      if (this.isCurrent(epoch)) {
        this.setState("loading", false);
      }
    }
  }

  private async refreshView(targetId: string, epoch = this.currentEpoch()): Promise<void> {
    const client = this.captureClient();
    if (!client) {
      return;
    }
    // A slow capture for one tab must never overwrite the view after the user
    // switched tabs; the epoch alone does not move on tab selection.
    const current = () => this.isCurrent(epoch) && this.activeTargetId === targetId;
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
      const metrics = await this.readMetrics(client, targetId);
      if (!current()) {
        return;
      }
      this.setState("view", { targetId, dataUrl, image, url: shot.url, metrics });
      if (!this.urlDraftEditing && shot.url) {
        this.setState("urlDraft", shot.url);
      }
    } catch (error) {
      if (current()) {
        this.reportError(error);
      }
    } finally {
      if (this.isCurrent(epoch)) {
        this.setState("loading", false);
      }
    }
  }

  private async readMetrics(
    client: GatewayBrowserClient,
    targetId: string,
  ): Promise<BrowserPageMetrics | null> {
    if (this.evaluateUnavailable) {
      return null;
    }
    try {
      return await readBrowserPageMetrics(client, targetId);
    } catch (error) {
      if (isBrowserEvaluateDisabledError(error)) {
        // Coordinate mapping falls back to the capture resolution; inspect and
        // wheel scrolling degrade with a visible hint instead of failing.
        this.setState("evaluateUnavailable", true);
        return null;
      }
      return null;
    }
  }

  private scheduleViewRefresh(delayMs = ACTION_REFRESH_DELAY_MS): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
    }
    const epoch = this.currentEpoch();
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      if (this.isCurrent(epoch) && this.activeTargetId) {
        void this.refreshView(this.activeTargetId, epoch);
      }
    }, delayMs);
  }

  private async runAction(action: (client: GatewayBrowserClient) => Promise<void>): Promise<void> {
    const client = this.captureClient();
    if (!client) {
      return;
    }
    try {
      this.setState("errorText", null);
      await action(client);
      this.scheduleViewRefresh();
    } catch (error) {
      if (isBrowserEvaluateDisabledError(error)) {
        this.setState("evaluateUnavailable", true);
      }
      this.reportError(error);
    }
  }

  async startBrowserNow(): Promise<void> {
    const client = this.captureClient();
    if (!client) {
      return;
    }
    const epoch = this.currentEpoch();
    this.setState("loading", true);
    this.setState("errorText", null);
    try {
      await startBrowser(client);
      if (this.isCurrent(epoch)) {
        await this.refreshAll();
      }
    } catch (error) {
      if (this.isCurrent(epoch)) {
        this.reportError(error);
        this.setState("loading", false);
      }
    }
  }

  async openUrl(url: string, options: { newTab: boolean }): Promise<void> {
    const client = this.captureClient();
    if (!client) {
      return;
    }
    const epoch = this.currentEpoch();
    this.setState("loading", true);
    this.setState("errorText", null);
    this.setState("pendingNewTab", false);
    try {
      if (options.newTab || !this.activeTargetId) {
        const tab = await openBrowserTab(client, url);
        if (!this.isCurrent(epoch)) {
          return;
        }
        this.setState("activeTargetId", tab?.id ?? this.activeTargetId);
      } else {
        // Keep the stable alias as the active handle; navigate may swap the
        // raw target underneath and the alias migrates server-side.
        await navigateBrowser(client, { url, targetId: this.activeTargetId });
        if (!this.isCurrent(epoch)) {
          return;
        }
      }
      await this.refreshTabsOnly(client, epoch);
      if (this.activeTargetId) {
        await this.refreshView(this.activeTargetId, epoch);
      }
    } catch (error) {
      if (this.isCurrent(epoch)) {
        this.reportError(error);
      }
    } finally {
      if (this.isCurrent(epoch)) {
        this.setState("loading", false);
      }
    }
  }

  private async refreshTabsOnly(client: GatewayBrowserClient, epoch: number): Promise<void> {
    try {
      const snapshot = await listBrowserTabs(client);
      if (this.isCurrent(epoch)) {
        this.setState("running", snapshot.running);
        this.setState("tabs", snapshot.tabs);
      }
    } catch {
      // Tab strip staleness is tolerable; the next full refresh reconciles it.
    }
  }

  async selectTab(targetId: string): Promise<void> {
    if (targetId === this.activeTargetId) {
      return;
    }
    this.setState("activeTargetId", targetId);
    this.setState("view", null);
    this.exitCaptureModes();
    await this.runActionImmediate(async (client) => {
      await focusBrowserTab(client, targetId);
      await this.refreshView(targetId);
    });
  }

  async closeTab(targetId: string): Promise<void> {
    await this.runActionImmediate(async (client) => {
      await closeBrowserTab(client, targetId);
      const epoch = this.currentEpoch();
      await this.refreshTabsOnly(client, epoch);
      if (this.activeTargetId === targetId) {
        const next = this.tabs[0] ?? null;
        this.setState("activeTargetId", next?.id ?? null);
        this.setState("view", null);
        if (next) {
          await this.refreshView(next.id, epoch);
        }
      }
    });
  }

  private async runActionImmediate(
    action: (client: GatewayBrowserClient) => Promise<void>,
  ): Promise<void> {
    const client = this.captureClient();
    if (!client) {
      return;
    }
    try {
      this.setState("errorText", null);
      await action(client);
    } catch (error) {
      this.reportError(error);
    }
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

  private overlayCanvas(): HTMLCanvasElement | null {
    return this.host.renderRoot.querySelector<HTMLCanvasElement>(".bp-overlay");
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
    event.preventDefault();
    this.wheelDeltaX += event.deltaX;
    this.wheelDeltaY += event.deltaY;
    if (this.wheelTimer !== null) {
      return;
    }
    this.wheelTimer = window.setTimeout(() => {
      this.wheelTimer = null;
      const deltaX = this.wheelDeltaX;
      const deltaY = this.wheelDeltaY;
      this.wheelDeltaX = 0;
      this.wheelDeltaY = 0;
      const targetId = this.activeTargetId;
      if (!targetId || (deltaX === 0 && deltaY === 0)) {
        return;
      }
      void this.runAction(async (client) => {
        if (this.evaluateUnavailable) {
          // No page JS allowed: fall back to a coarse keyboard scroll.
          await pressBrowserKey(client, {
            targetId,
            key: deltaY >= 0 ? "PageDown" : "PageUp",
          });
          return;
        }
        await scrollBrowserBy(client, { targetId, deltaX, deltaY });
      });
    }, 150);
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
    const client = this.captureClient();
    const point = this.remotePoint(event);
    const stagePoint = browserPanelNormalizedPoint(this.stageElement(), event);
    const targetId = this.activeTargetId;
    if (!client || !point || !stagePoint || !targetId || this.evaluateUnavailable) {
      return;
    }
    this.setState("inspectPointer", stagePoint);
    const now = Date.now();
    const run = () => {
      this.lastInspectAt = Date.now();
      const epoch = this.currentEpoch();
      void inspectBrowserElementAt(client, { targetId, x: point.x, y: point.y })
        .then((node) => {
          if (this.isCurrent(epoch) && this.mode === "inspect") {
            this.setState("inspected", node);
            this.paintOverlay();
          }
        })
        .catch((error: unknown) => {
          if (isBrowserEvaluateDisabledError(error)) {
            this.setState("evaluateUnavailable", true);
            this.setState("errorText", t("browser.inspectUnavailable"));
            this.setState("mode", "interact");
          }
        });
    };
    if (now - this.lastInspectAt >= INSPECT_THROTTLE_MS) {
      run();
      return;
    }
    if (this.inspectTimer !== null) {
      clearTimeout(this.inspectTimer);
    }
    this.inspectTimer = window.setTimeout(() => {
      this.inspectTimer = null;
      if (this.mode === "inspect" && this.captureClient()) {
        run();
      }
    }, INSPECT_THROTTLE_MS);
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
      this.overlayCanvas(),
      this.stageElement(),
      this.strokes,
      this.mode === "inspect" ? this.inspectHighlightRegion() : null,
    );
  }
}
