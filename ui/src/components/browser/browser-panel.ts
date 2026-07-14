// Dockable gateway browser panel for the Control UI shell.
//
// Renders the gateway-controlled browser (the same one agents drive through
// the browser plugin) as a screenshot-backed remote view with tabs, a URL bar,
// and two capture modes: annotate (freehand markup packaged into a chat
// prompt + attachment) and inspect (element details at the pointer). Works in
// any regular browser — no native webview required — and equally inside the
// macOS app's dashboard.
import { html, nothing, svg } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";
import { OpenClawLitElement } from "../../lit/openclaw-element.ts";
import { createDockPanelLayout, type DockPanelSide } from "../dock-panel-layout.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  type BrowserPanelToggleDetail,
} from "../panel-toggle-contract.ts";
import {
  buildAnnotationPrompt,
  composeAnnotatedImage,
  dispatchBrowserAnnotation,
  paintAnnotations,
  type AnnotationRegion,
  type AnnotationStroke,
} from "./browser-annotation.ts";
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
import { browserPanelStyles } from "./browser-panel.styles.ts";
import { normalizeBrowserUrlDraft } from "./browser-url.ts";

// Inline icon set (self-contained; the Control UI blocks external asset loads).
const CLOSE_GLYPH = svg`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>`;
const PLUS_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10" /></svg>`;
const DOCK_BOTTOM_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 10h12" /></svg>`;
const DOCK_RIGHT_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M10 2.5v11" /></svg>`;
const BACK_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5" /></svg>`;
const FORWARD_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5" /></svg>`;
const RELOAD_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" /></svg>`;
const EXTERNAL_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3.5H3.5v9h9V9.5M9.5 3h3.5v3.5M12.8 3.2L7.5 8.5" /></svg>`;
const PENCIL_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.3 2.7l2 2L5 13H3v-2z" /></svg>`;
const INSPECT_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l5.5 10 1.2-4.3L14 7.5z" /></svg>`;

type BrowserDock = DockPanelSide;
type BrowserPanelMode = "interact" | "annotate" | "inspect";
/** One rendered page snapshot plus the geometry needed to map pointer coords. */
type BrowserPanelView = {
  targetId: string;
  dataUrl: string;
  image: HTMLImageElement;
  url: string;
  metrics: BrowserPageMetrics | null;
};

const panelLayout = createDockPanelLayout({
  storageKey: "openclaw.browser.panel.v1",
  minHeight: 240,
  minWidth: 380,
  defaultDock: "right",
  defaultHeight: 420,
  defaultWidth: 560,
});
const INSPECT_THROTTLE_MS = 120;
const ACTION_REFRESH_DELAY_MS = 350;
const FORWARDED_KEYS = new Set([
  "Enter",
  "Backspace",
  "Delete",
  "Tab",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

function tabLabel(tab: BrowserPanelTab): string {
  if (tab.title.trim()) {
    return tab.title.trim();
  }
  try {
    return new URL(tab.url).host || t("browser.untitledTab");
  } catch {
    return tab.url || t("browser.untitledTab");
  }
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("screenshot decode failed")));
    image.src = dataUrl;
  });
}

/** `<openclaw-browser-panel>` — the dockable gateway browser surface. */
class OpenClawBrowserPanel extends OpenClawLitElement {
  /** Gateway client used for browser.request RPCs; null until connected. */
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  /** Whether the connected gateway advertises browser.request to this operator. */
  @property({ type: Boolean }) available = false;
  /** Control UI base path, used for the authenticated media fetch. */
  @property({ attribute: false }) basePath = "";
  /** Bearer credential for the assistant-media screenshot fetch. */
  @property({ attribute: false }) authToken: string | null = null;

  @state() private open = false;
  @state() private dock: BrowserDock = panelLayout.defaults.dock;
  @state() private height = panelLayout.defaults.height;
  @state() private width = panelLayout.defaults.width;
  @state() private running: boolean | null = null;
  @state() private tabs: BrowserPanelTab[] = [];
  /** Stable tab handle (plugin alias when available), not a raw CDP target id. */
  @state() private activeTargetId: string | null = null;
  @state() private view: BrowserPanelView | null = null;
  @state() private loading = false;
  @state() private errorText: string | null = null;
  @state() private noticeText: string | null = null;
  @state() private mode: BrowserPanelMode = "interact";
  @state() private strokes: AnnotationStroke[] = [];
  @state() private inspected: BrowserInspectedNode | null = null;
  @state() private inspectPointer: { x: number; y: number } | null = null;
  @state() private evaluateUnavailable = false;
  @state() private urlDraft = "";
  @state() private pendingNewTab = false;

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
  private resizeCleanup: (() => void) | null = null;
  private readonly onToggleRequest = (event: Event) => this.handleToggleRequest(event);
  private readonly onViewportResize = () => {
    const height = Math.min(this.height, panelLayout.maxHeight());
    const width = Math.min(this.width, panelLayout.maxWidth());
    if (height !== this.height || width !== this.width) {
      this.height = height;
      this.width = width;
      this.syncLayoutReservation();
    }
  };

  static override styles = browserPanelStyles;

  override connectedCallback(): void {
    super.connectedCallback();
    const layout = panelLayout.load();
    this.dock = layout.dock;
    this.height = layout.height;
    this.width = layout.width;
    this.open = layout.open && this.available;
    window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    window.addEventListener("resize", this.onViewportResize);
    if (this.open) {
      void this.refreshAll();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    window.removeEventListener("resize", this.onViewportResize);
    this.clearTimers();
    this.resizeCleanup?.();
    document.documentElement.style.setProperty("--oc-browser-reserve-bottom", "0px");
    document.documentElement.style.setProperty("--oc-browser-reserve-right", "0px");
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("client") || changed.has("available")) {
      if (this.client !== this.activeClient) {
        this.activeClient = this.client;
        this.resetBrowserState();
        if (this.open && this.available && this.client) {
          void this.refreshAll();
        }
      }
      if (!this.available && this.open) {
        // Surface disappeared (disconnect/scope loss): hide without persisting
        // so the open preference survives a reconnect.
        this.open = false;
        this.resetBrowserState();
      } else if (this.available && !this.open && panelLayout.load().open) {
        // Hello arrived after mount (or a reconnect): restore the persisted
        // open state now that the surface is actually available.
        this.open = true;
        void this.refreshAll();
      }
    }
    this.syncLayoutReservation();
    this.paintOverlay();
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

  private resetBrowserState(): void {
    this.viewEpoch += 1;
    this.clearTimers();
    this.running = null;
    this.tabs = [];
    this.activeTargetId = null;
    this.view = null;
    this.loading = false;
    this.errorText = null;
    this.noticeText = null;
    this.mode = "interact";
    this.strokes = [];
    this.drawingStroke = null;
    this.inspected = null;
    this.inspectPointer = null;
    this.pendingNewTab = false;
    // Re-probe per connection: another gateway may have evaluate enabled.
    this.evaluateUnavailable = false;
  }

  /** Publishes the dock footprint so the shell content reflows around it. */
  private syncLayoutReservation(): void {
    const root = document.documentElement.style;
    const visible = this.available && this.open;
    root.setProperty(
      "--oc-browser-reserve-bottom",
      visible && this.dock === "bottom" ? `${this.height}px` : "0px",
    );
    root.setProperty(
      "--oc-browser-reserve-right",
      visible && this.dock === "right" ? `${this.width}px` : "0px",
    );
  }

  toggle(): void {
    if (!this.available) {
      return;
    }
    if (this.open) {
      this.closePanel();
    } else {
      this.open = true;
      this.syncLayoutReservation();
      this.persistLayout();
      void this.refreshAll();
    }
  }

  handleToggleRequest(event: Event): void {
    const detail =
      event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
        ? (event.detail as BrowserPanelToggleDetail)
        : null;
    if (detail?.dock === "right" || detail?.dock === "bottom") {
      this.dock = detail.dock;
    }
    const url = typeof detail?.url === "string" ? normalizeBrowserUrlDraft(detail.url) : null;
    if (url || detail?.open === true) {
      if (!this.available) {
        return;
      }
      const wasOpen = this.open;
      this.open = true;
      this.syncLayoutReservation();
      this.persistLayout();
      if (url) {
        void this.openUrl(url, { newTab: true });
      } else if (!wasOpen) {
        void this.refreshAll();
      }
      return;
    }
    this.toggle();
  }

  private closePanel(): void {
    this.open = false;
    this.syncLayoutReservation();
    this.persistLayout();
  }

  private persistLayout(): void {
    panelLayout.save({
      open: this.open,
      dock: this.dock,
      height: this.height,
      width: this.width,
    });
  }

  private setDock(dock: BrowserDock): void {
    this.dock = dock;
    this.syncLayoutReservation();
    this.persistLayout();
  }

  private currentEpoch(): number {
    return this.viewEpoch;
  }

  private isCurrent(epoch: number): boolean {
    return this.isConnected && this.open && this.viewEpoch === epoch;
  }

  private captureClient(): GatewayBrowserClient | null {
    return this.available && this.client ? this.client : null;
  }

  private reportError(err: unknown): void {
    this.errorText = err instanceof Error ? err.message : String(err);
  }

  private async refreshAll(): Promise<void> {
    const client = this.captureClient();
    if (!client) {
      return;
    }
    const epoch = this.currentEpoch();
    this.errorText = null;
    this.loading = true;
    try {
      const snapshot = await listBrowserTabs(client);
      if (!this.isCurrent(epoch)) {
        return;
      }
      this.running = snapshot.running;
      this.tabs = snapshot.tabs;
      if (!snapshot.running) {
        this.view = null;
      }
      const active =
        snapshot.tabs.find((tab) => tab.id === this.activeTargetId) ?? snapshot.tabs[0];
      this.activeTargetId = active?.id ?? null;
      if (!this.urlDraftEditing) {
        this.urlDraft = active?.url ?? "";
      }
      if (active) {
        await this.refreshView(active.id, epoch);
      } else {
        this.view = null;
      }
    } catch (err) {
      if (this.isCurrent(epoch)) {
        this.reportError(err);
      }
    } finally {
      if (this.isCurrent(epoch)) {
        this.loading = false;
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
    this.loading = true;
    try {
      const shot = await captureBrowserScreenshot(client, targetId);
      if (!current()) {
        return;
      }
      const dataUrl = await fetchBrowserScreenshotDataUrl({
        basePath: this.basePath,
        authToken: this.authToken,
        path: shot.path,
      });
      const image = await loadImage(dataUrl);
      const metrics = await this.readMetrics(client, targetId);
      if (!current()) {
        return;
      }
      this.view = { targetId, dataUrl, image, url: shot.url, metrics };
      if (!this.urlDraftEditing && shot.url) {
        this.urlDraft = shot.url;
      }
    } catch (err) {
      if (current()) {
        this.reportError(err);
      }
    } finally {
      if (this.isCurrent(epoch)) {
        this.loading = false;
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
    } catch (err) {
      if (isBrowserEvaluateDisabledError(err)) {
        // Coordinate mapping falls back to the capture resolution; inspect and
        // wheel scrolling degrade with a visible hint instead of failing.
        this.evaluateUnavailable = true;
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
      this.errorText = null;
      await action(client);
      this.scheduleViewRefresh();
    } catch (err) {
      if (isBrowserEvaluateDisabledError(err)) {
        this.evaluateUnavailable = true;
      }
      this.reportError(err);
    }
  }

  private async startBrowserNow(): Promise<void> {
    const client = this.captureClient();
    if (!client) {
      return;
    }
    const epoch = this.currentEpoch();
    this.loading = true;
    this.errorText = null;
    try {
      await startBrowser(client);
      if (this.isCurrent(epoch)) {
        await this.refreshAll();
      }
    } catch (err) {
      if (this.isCurrent(epoch)) {
        this.reportError(err);
        this.loading = false;
      }
    }
  }

  private async openUrl(url: string, opts: { newTab: boolean }): Promise<void> {
    const client = this.captureClient();
    if (!client) {
      return;
    }
    const epoch = this.currentEpoch();
    this.loading = true;
    this.errorText = null;
    this.pendingNewTab = false;
    try {
      if (opts.newTab || !this.activeTargetId) {
        const tab = await openBrowserTab(client, url);
        if (!this.isCurrent(epoch)) {
          return;
        }
        this.activeTargetId = tab?.id ?? this.activeTargetId;
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
    } catch (err) {
      if (this.isCurrent(epoch)) {
        this.reportError(err);
      }
    } finally {
      if (this.isCurrent(epoch)) {
        this.loading = false;
      }
    }
  }

  private async refreshTabsOnly(client: GatewayBrowserClient, epoch: number): Promise<void> {
    try {
      const snapshot = await listBrowserTabs(client);
      if (this.isCurrent(epoch)) {
        this.running = snapshot.running;
        this.tabs = snapshot.tabs;
      }
    } catch {
      // Tab strip staleness is tolerable; the next full refresh reconciles it.
    }
  }

  private async selectTab(targetId: string): Promise<void> {
    if (targetId === this.activeTargetId) {
      return;
    }
    this.activeTargetId = targetId;
    this.view = null;
    this.exitCaptureModes();
    await this.runActionImmediate(async (client) => {
      await focusBrowserTab(client, targetId);
      await this.refreshView(targetId);
    });
  }

  private async closeTab(targetId: string): Promise<void> {
    await this.runActionImmediate(async (client) => {
      await closeBrowserTab(client, targetId);
      const epoch = this.currentEpoch();
      await this.refreshTabsOnly(client, epoch);
      if (this.activeTargetId === targetId) {
        const next = this.tabs[0] ?? null;
        this.activeTargetId = next?.id ?? null;
        this.view = null;
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
      this.errorText = null;
      await action(client);
    } catch (err) {
      this.reportError(err);
    }
  }

  /** Real page reload: re-navigate to the current URL, then re-capture. A bare
   * screenshot refresh would leave the remote document untouched. */
  private reloadPage(): void {
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

  private goHistory(delta: -1 | 1): void {
    const targetId = this.activeTargetId;
    if (!targetId) {
      return;
    }
    void this.runAction((client) => goBrowserHistory(client, { targetId, delta }));
  }

  private commitUrlDraft(): void {
    const url = normalizeBrowserUrlDraft(this.urlDraft);
    if (!url) {
      return;
    }
    void this.openUrl(url, { newTab: this.pendingNewTab || this.tabs.length === 0 });
  }

  private exitCaptureModes(): void {
    this.mode = "interact";
    this.strokes = [];
    this.drawingStroke = null;
    this.inspected = null;
    this.inspectPointer = null;
  }

  private setMode(mode: BrowserPanelMode): void {
    if (this.mode === mode) {
      this.exitCaptureModes();
      return;
    }
    this.exitCaptureModes();
    this.mode = mode;
    this.noticeText = null;
    if (mode === "inspect" && this.evaluateUnavailable) {
      this.errorText = t("browser.inspectUnavailable");
      this.mode = "interact";
    }
  }

  // --- coordinate mapping -------------------------------------------------

  private stageElement(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(".bp-stage");
  }

  private overlayCanvas(): HTMLCanvasElement | null {
    return this.renderRoot.querySelector<HTMLCanvasElement>(".bp-overlay");
  }

  /** Normalized [0..1] stage coordinates for a pointer event. */
  private normalizedPoint(event: MouseEvent): { x: number; y: number } | null {
    const stage = this.stageElement();
    if (!stage) {
      return null;
    }
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  /** Remote CSS-pixel coordinates for a pointer event. */
  private remotePoint(event: MouseEvent): { x: number; y: number } | null {
    const point = this.normalizedPoint(event);
    const view = this.view;
    if (!point || !view) {
      return null;
    }
    const cssWidth = view.metrics?.cssWidth ?? view.image.naturalWidth;
    const cssHeight = view.metrics?.cssHeight ?? view.image.naturalHeight;
    return { x: point.x * cssWidth, y: point.y * cssHeight };
  }

  private inspectHighlightRegion(): AnnotationRegion | null {
    const view = this.view;
    const node = this.inspected;
    if (!view || !node) {
      return null;
    }
    const cssWidth = view.metrics?.cssWidth ?? view.image.naturalWidth;
    const cssHeight = view.metrics?.cssHeight ?? view.image.naturalHeight;
    if (cssWidth <= 0 || cssHeight <= 0) {
      return null;
    }
    return {
      x: node.rect.x / cssWidth,
      y: node.rect.y / cssHeight,
      width: node.rect.width / cssWidth,
      height: node.rect.height / cssHeight,
    };
  }

  // --- interact mode ------------------------------------------------------

  private handleStageClick(event: MouseEvent): void {
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
    this.renderRoot.querySelector<HTMLElement>(".bp-viewport")?.focus({ preventScroll: true });
    const point = this.remotePoint(event);
    const targetId = this.activeTargetId;
    if (!point || !targetId) {
      return;
    }
    void this.runAction((client) =>
      clickBrowserCoords(client, { targetId, x: point.x, y: point.y }),
    );
  }

  private handleWheel(event: WheelEvent): void {
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

  private handleViewportKeydown(event: KeyboardEvent): void {
    if (this.mode !== "interact" || !this.view) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const key = event.key;
    const forward = FORWARDED_KEYS.has(key) || key.length === 1;
    const targetId = this.activeTargetId;
    if (!forward || !targetId) {
      return;
    }
    event.preventDefault();
    void this.runAction((client) => pressBrowserKey(client, { targetId, key }));
  }

  // --- annotate mode ------------------------------------------------------

  private handleOverlayPointerDown(event: PointerEvent): void {
    if (this.mode === "inspect") {
      this.suppressStageClick = true;
      void this.sendAnnotation({ element: this.inspected });
      return;
    }
    if (this.mode !== "annotate") {
      return;
    }
    const point = this.normalizedPoint(event);
    if (!point) {
      return;
    }
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    this.drawingStroke = { points: [point] };
    this.strokes = [...this.strokes, this.drawingStroke];
    this.paintOverlay();
  }

  private handleOverlayPointerMove(event: PointerEvent): void {
    if (this.mode === "annotate") {
      if (!this.drawingStroke) {
        return;
      }
      const point = this.normalizedPoint(event);
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

  private handleOverlayPointerUp(): void {
    this.drawingStroke = null;
  }

  private queueInspect(event: PointerEvent): void {
    const client = this.captureClient();
    const point = this.remotePoint(event);
    const stagePoint = this.normalizedPoint(event);
    const targetId = this.activeTargetId;
    if (!client || !point || !stagePoint || !targetId || this.evaluateUnavailable) {
      return;
    }
    this.inspectPointer = stagePoint;
    const now = Date.now();
    const run = () => {
      this.lastInspectAt = Date.now();
      const epoch = this.currentEpoch();
      void inspectBrowserElementAt(client, { targetId, x: point.x, y: point.y })
        .then((node) => {
          if (this.isCurrent(epoch) && this.mode === "inspect") {
            this.inspected = node;
            this.paintOverlay();
          }
        })
        .catch((err: unknown) => {
          if (isBrowserEvaluateDisabledError(err)) {
            this.evaluateUnavailable = true;
            this.errorText = t("browser.inspectUnavailable");
            this.mode = "interact";
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

  private undoStroke(): void {
    this.strokes = this.strokes.slice(0, -1);
    this.drawingStroke = null;
    this.paintOverlay();
  }

  private clearStrokes(): void {
    this.strokes = [];
    this.drawingStroke = null;
    this.paintOverlay();
  }

  private async sendAnnotation(params: { element?: BrowserInspectedNode | null }): Promise<void> {
    const view = this.view;
    const tab = this.tabs.find((entry) => entry.id === this.activeTargetId);
    if (!view) {
      return;
    }
    if (this.strokes.length === 0 && !params.element) {
      return;
    }
    const url = view.metrics?.url || view.url || tab?.url || "";
    const title = view.metrics?.title || tab?.title || "";
    const text = buildAnnotationPrompt({
      url,
      title,
      strokes: this.strokes,
      element: params.element ?? null,
    });
    const highlight = params.element ? this.inspectHighlightRegion() : null;
    let dataUrl: string;
    try {
      dataUrl = composeAnnotatedImage({
        image: view.image,
        width: view.image.naturalWidth,
        height: view.image.naturalHeight,
        strokes: this.strokes,
        highlight,
      });
    } catch (err) {
      this.reportError(err);
      return;
    }
    const handled = dispatchBrowserAnnotation({
      text,
      dataUrl,
      fileName: "annotated-page.png",
    });
    if (!handled) {
      this.errorText = t("browser.noChatTarget");
      return;
    }
    this.noticeText = t("browser.annotationSent");
    this.exitCaptureModes();
  }

  /** Repaints the live stroke/highlight overlay; cheap, runs after render. */
  private paintOverlay(): void {
    const canvas = this.overlayCanvas();
    const stage = this.stageElement();
    if (!canvas || !stage) {
      return;
    }
    const width = Math.max(1, Math.round(stage.clientWidth));
    const height = Math.max(1, Math.round(stage.clientHeight));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, width, height);
    paintAnnotations(ctx, {
      width,
      height,
      strokes: this.strokes,
      highlight: this.mode === "inspect" ? this.inspectHighlightRegion() : null,
    });
  }

  private startResize(event: PointerEvent): void {
    event.preventDefault();
    this.resizeCleanup?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const startHeight = this.height;
    const startWidth = this.width;
    const onMove = (move: PointerEvent) => {
      if (this.dock === "bottom") {
        const next = Math.max(panelLayout.minHeight, startHeight + (startY - move.clientY));
        this.height = Math.min(next, panelLayout.maxHeight());
      } else {
        const next = Math.max(panelLayout.minWidth, startWidth + (startX - move.clientX));
        this.width = Math.min(next, panelLayout.maxWidth());
      }
      this.syncLayoutReservation();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      if (this.resizeCleanup === cleanup) {
        this.resizeCleanup = null;
      }
    };
    const onUp = () => {
      cleanup();
      if (this.isConnected) {
        this.persistLayout();
      }
    };
    this.resizeCleanup = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  }

  // --- render ---------------------------------------------------------------

  private renderTabStrip() {
    return html`
      <div class="bp-tabs" role="tablist">
        ${this.tabs.map(
          (tab) => html`
            <div
              class="bp-tab ${tab.id === this.activeTargetId ? "is-active" : ""}"
              role="tab"
              title=${tab.url}
              aria-selected=${tab.id === this.activeTargetId ? "true" : "false"}
              @click=${() => void this.selectTab(tab.id)}
              @auxclick=${(event: MouseEvent) => {
                if (event.button === 1) {
                  event.preventDefault();
                  void this.closeTab(tab.id);
                }
              }}
            >
              <span class="bp-tab__label">${tabLabel(tab)}</span>
              <button
                class="bp-tab__close"
                type="button"
                title=${t("browser.closeTab")}
                aria-label=${t("browser.closeTab")}
                @click=${(event: Event) => {
                  event.stopPropagation();
                  void this.closeTab(tab.id);
                }}
              >
                ${CLOSE_GLYPH}
              </button>
            </div>
          `,
        )}
        <button
          class="bp-new"
          type="button"
          title=${t("browser.newTab")}
          aria-label=${t("browser.newTab")}
          @click=${() => {
            this.pendingNewTab = true;
            this.urlDraft = "";
            void this.updateComplete.then(() =>
              this.renderRoot.querySelector<HTMLInputElement>(".bp-url")?.focus(),
            );
          }}
        >
          ${PLUS_GLYPH}
        </button>
      </div>
    `;
  }

  private renderHeaderActions() {
    const activeUrl = this.view?.metrics?.url || this.view?.url || this.urlDraft;
    return html`
      <div class="bp-actions">
        <button
          class="bp-icon ${this.dock === "bottom" ? "is-active" : ""}"
          type="button"
          title=${t("browser.dockBottom")}
          aria-label=${t("browser.dockBottom")}
          @click=${() => this.setDock("bottom")}
        >
          ${DOCK_BOTTOM_GLYPH}
        </button>
        <button
          class="bp-icon ${this.dock === "right" ? "is-active" : ""}"
          type="button"
          title=${t("browser.dockRight")}
          aria-label=${t("browser.dockRight")}
          @click=${() => this.setDock("right")}
        >
          ${DOCK_RIGHT_GLYPH}
        </button>
        <button
          class="bp-icon"
          type="button"
          title=${t("browser.openExternal")}
          aria-label=${t("browser.openExternal")}
          ?disabled=${!activeUrl}
          @click=${() => {
            if (activeUrl) {
              openExternalUrlSafe(activeUrl);
            }
          }}
        >
          ${EXTERNAL_GLYPH}
        </button>
        <button
          class="bp-icon"
          type="button"
          title=${t("browser.hide")}
          aria-label=${t("browser.hide")}
          @click=${() => this.closePanel()}
        >
          ${CLOSE_GLYPH}
        </button>
      </div>
    `;
  }

  private renderToolbar() {
    const hasView = Boolean(this.view);
    return html`
      <div class="bp-toolbar">
        <button
          class="bp-icon"
          type="button"
          title=${t("browser.back")}
          aria-label=${t("browser.back")}
          ?disabled=${!hasView || this.evaluateUnavailable}
          @click=${() => this.goHistory(-1)}
        >
          ${BACK_GLYPH}
        </button>
        <button
          class="bp-icon"
          type="button"
          title=${t("browser.forward")}
          aria-label=${t("browser.forward")}
          ?disabled=${!hasView || this.evaluateUnavailable}
          @click=${() => this.goHistory(1)}
        >
          ${FORWARD_GLYPH}
        </button>
        <button
          class="bp-icon"
          type="button"
          title=${t("browser.reload")}
          aria-label=${t("browser.reload")}
          ?disabled=${!this.activeTargetId}
          @click=${() => this.reloadPage()}
        >
          ${RELOAD_GLYPH}
        </button>
        <input
          class="bp-url"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder=${t("browser.urlPlaceholder")}
          .value=${this.urlDraft}
          @focus=${(event: FocusEvent) => {
            this.urlDraftEditing = true;
            (event.target as HTMLInputElement).select();
          }}
          @blur=${() => {
            this.urlDraftEditing = false;
          }}
          @input=${(event: InputEvent) => {
            this.urlDraft = (event.target as HTMLInputElement).value;
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Enter") {
              event.preventDefault();
              this.commitUrlDraft();
              (event.target as HTMLInputElement).blur();
            } else if (event.key === "Escape") {
              this.urlDraft = this.view?.metrics?.url || this.view?.url || "";
              (event.target as HTMLInputElement).blur();
            }
          }}
        />
        <button
          class="bp-icon ${this.mode === "annotate" ? "is-active" : ""}"
          type="button"
          title=${t("browser.annotate")}
          aria-label=${t("browser.annotate")}
          ?disabled=${!hasView}
          @click=${() => this.setMode("annotate")}
        >
          ${PENCIL_GLYPH}
        </button>
        <button
          class="bp-icon ${this.mode === "inspect" ? "is-active" : ""}"
          type="button"
          title=${this.evaluateUnavailable ? t("browser.inspectUnavailable") : t("browser.inspect")}
          aria-label=${t("browser.inspect")}
          ?disabled=${!hasView || this.evaluateUnavailable}
          @click=${() => this.setMode("inspect")}
        >
          ${INSPECT_GLYPH}
        </button>
      </div>
    `;
  }

  private renderAnnotateBar() {
    if (this.mode !== "annotate") {
      return nothing;
    }
    return html`
      <div class="bp-annotatebar">
        <span class="bp-annotatebar__hint">${t("browser.annotateHint")}</span>
        <button
          class="bp-btn"
          type="button"
          ?disabled=${this.strokes.length === 0}
          @click=${() => this.undoStroke()}
        >
          ${t("browser.annotateUndo")}
        </button>
        <button
          class="bp-btn"
          type="button"
          ?disabled=${this.strokes.length === 0}
          @click=${() => this.clearStrokes()}
        >
          ${t("browser.annotateClear")}
        </button>
        <button
          class="bp-btn"
          type="button"
          title=${t("browser.annotateDone")}
          @click=${() => this.exitCaptureModes()}
        >
          ${CLOSE_GLYPH}
        </button>
        <button
          class="bp-btn bp-btn--primary"
          type="button"
          ?disabled=${this.strokes.length === 0}
          @click=${() => void this.sendAnnotation({})}
        >
          ${t("browser.annotateSend")}
        </button>
      </div>
    `;
  }

  private renderInspectTooltip() {
    const node = this.inspected;
    const pointer = this.inspectPointer;
    if (this.mode !== "inspect" || !node || !pointer) {
      return nothing;
    }
    const left = `${Math.min(92, Math.max(0, pointer.x * 100))}%`;
    const top = `${Math.min(92, Math.max(0, pointer.y * 100 + 2))}%`;
    const classes = node.classes.map((cls) => `.${cls}`).join("");
    return html`
      <div class="bp-tooltip" style="left:${left};top:${top}">
        <div class="bp-tooltip__title">
          <span class="bp-tooltip__selector"
            >${node.tag}${node.id ? `#${node.id}` : ""}${classes}</span
          >
          <span class="bp-tooltip__size"
            >${Math.round(node.rect.width)} × ${Math.round(node.rect.height)}</span
          >
        </div>
        ${node.name
          ? html`<div class="bp-tooltip__row">
              <span>${t("browser.inspectName")}</span><span>${node.name}</span>
            </div>`
          : nothing}
        ${node.role
          ? html`<div class="bp-tooltip__row">
              <span>${t("browser.inspectRole")}</span><span>${node.role}</span>
            </div>`
          : nothing}
        <div class="bp-tooltip__row">
          <span>${t("browser.inspectFocusable")}</span><span>${node.focusable ? "✓" : "–"}</span>
        </div>
      </div>
    `;
  }

  private renderViewport() {
    if (this.running === false) {
      return html`
        <div class="bp-status">
          <span>${t("browser.notRunning")}</span>
          <button
            class="bp-btn bp-btn--primary"
            type="button"
            @click=${() => void this.startBrowserNow()}
          >
            ${t("browser.start")}
          </button>
        </div>
      `;
    }
    if (!this.view) {
      return html`
        <div class="bp-status">
          <span>${this.loading ? t("browser.loading") : t("browser.empty")}</span>
        </div>
      `;
    }
    const overlayMode =
      this.mode === "annotate"
        ? "bp-overlay--annotate"
        : this.mode === "inspect"
          ? "bp-overlay--inspect"
          : "";
    return html`
      <div class="bp-stage">
        <img class="bp-shot" src=${this.view.dataUrl} alt=${this.view.metrics?.title || ""} />
        <canvas
          class="bp-overlay ${overlayMode}"
          @click=${(event: MouseEvent) => this.handleStageClick(event)}
          @pointerdown=${(event: PointerEvent) => this.handleOverlayPointerDown(event)}
          @pointermove=${(event: PointerEvent) => this.handleOverlayPointerMove(event)}
          @pointerup=${() => this.handleOverlayPointerUp()}
          @pointercancel=${() => this.handleOverlayPointerUp()}
        ></canvas>
        ${this.renderInspectTooltip()}
      </div>
    `;
  }

  override render() {
    if (!this.available || !this.open) {
      return nothing;
    }
    const style = this.dock === "bottom" ? `height:${this.height}px` : `width:${this.width}px`;
    return html`
      <section class="bp bp--${this.dock}" style=${style} aria-label=${t("browser.title")}>
        <div
          class="bp-resizer bp-resizer--${this.dock}"
          @pointerdown=${(event: PointerEvent) => this.startResize(event)}
          role="separator"
          aria-label=${t("browser.resize")}
        ></div>
        <header class="bp-header">${this.renderTabStrip()} ${this.renderHeaderActions()}</header>
        ${this.renderToolbar()} ${this.renderAnnotateBar()}
        ${this.errorText
          ? html`<div class="bp-note bp-note--error" role="alert">${this.errorText}</div>`
          : this.noticeText
            ? html`<div class="bp-note" role="status">${this.noticeText}</div>`
            : nothing}
        <div
          class="bp-viewport"
          tabindex="0"
          @wheel=${(event: WheelEvent) => this.handleWheel(event)}
          @keydown=${(event: KeyboardEvent) => this.handleViewportKeydown(event)}
        >
          ${this.loading && this.view
            ? html`<span class="bp-loading">${t("browser.loading")}</span>`
            : nothing}
          ${this.renderViewport()}
        </div>
      </section>
    `;
  }
}

// Guarded define (not @customElement) so re-imports under a shared registry —
// e.g. vitest with isolate=false — don't throw "already registered".
if (!customElements.get("openclaw-browser-panel")) {
  customElements.define("openclaw-browser-panel", OpenClawBrowserPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-browser-panel": OpenClawBrowserPanel;
  }
}
