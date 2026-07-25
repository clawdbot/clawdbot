// Dockable gateway browser panel for the Control UI shell.
//
// Renders the gateway-controlled browser (the same one agents drive through
// the browser plugin) as a screenshot-backed remote view with tabs, a URL bar,
// and two capture modes: annotate (freehand markup packaged into a chat
// prompt + attachment) and inspect (element details at the pointer). Works in
// any regular browser — no native webview required — and equally inside the
// macOS app's dashboard.
import { nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { OpenClawLitElement } from "../../lit/openclaw-element.ts";
import { createDockPanelLayout } from "../dock-panel-layout.ts";
import { panelTabStripStyles } from "../panel-tab-strip.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  type BrowserPanelToggleDetail,
} from "../panel-toggle-contract.ts";
import {
  BrowserPanelController,
  type BrowserPanelControllerHost,
} from "./browser-panel-controller.ts";
import { renderBrowserPanelChrome, type BrowserPanelDock } from "./browser-panel-render.ts";
import { browserPanelStyles } from "./browser-panel.styles.ts";
import { normalizeBrowserUrlDraft } from "./browser-url.ts";

const panelLayout = createDockPanelLayout({
  storageKey: "openclaw.browser.panel.v1",
  minHeight: 240,
  minWidth: 380,
  defaultDock: "right",
  supportedDocks: ["bottom", "right"],
  defaultHeight: 420,
  defaultWidth: 560,
});

/** `<openclaw-browser-panel>` — the dockable gateway browser surface. */
class OpenClawBrowserPanel extends OpenClawLitElement implements BrowserPanelControllerHost {
  /** Gateway client used for browser.request RPCs; null until connected. */
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  /** Whether the connected gateway advertises browser.request to this operator. */
  @property({ type: Boolean }) available = false;
  /** Control UI base path, used for the authenticated media fetch. */
  @property({ attribute: false }) basePath = "";
  /** Bearer credential for the assistant-media screenshot fetch. */
  @property({ attribute: false }) authToken: string | null = null;

  @state() private open = false;
  @state() private dock: BrowserPanelDock = panelLayout.defaults.dock;
  @state() private height = panelLayout.defaults.height;
  @state() private width = panelLayout.defaults.width;
  private readonly browserPanelController = new BrowserPanelController(this);
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

  static override styles = [panelTabStripStyles, browserPanelStyles];

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
      void this.browserPanelController.refreshAll();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    window.removeEventListener("resize", this.onViewportResize);
    this.resizeCleanup?.();
    document.documentElement.style.setProperty("--oc-browser-reserve-bottom", "0px");
    document.documentElement.style.setProperty("--oc-browser-reserve-right", "0px");
  }

  override updated(changed: Map<string, unknown>): void {
    this.browserPanelController.synchronizeHostProperties(changed);
    if (changed.has("client") || changed.has("available")) {
      if (!this.available && this.open) {
        // Surface disappeared (disconnect/scope loss): hide without persisting
        // so the open preference survives a reconnect.
        this.open = false;
        this.browserPanelController.resetBrowserState();
      } else if (this.available && !this.open && panelLayout.load().open) {
        // Hello arrived after mount (or a reconnect): restore the persisted
        // open state now that the surface is actually available.
        this.open = true;
        void this.browserPanelController.refreshAll();
      }
    }
    this.syncLayoutReservation();
    this.browserPanelController.paintOverlay();
  }

  browserPanelIsOpen(): boolean {
    return this.open;
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
      void this.browserPanelController.refreshAll();
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
    if (detail?.open === false) {
      this.closePanel();
      return;
    }
    const normalizedRequestedUrl =
      typeof detail?.url === "string" ? normalizeBrowserUrlDraft(detail.url) : null;
    if (normalizedRequestedUrl || detail?.open === true) {
      if (!this.available) {
        return;
      }
      const wasOpen = this.open;
      this.open = true;
      this.syncLayoutReservation();
      this.persistLayout();
      if (normalizedRequestedUrl) {
        void this.browserPanelController.openUrl(normalizedRequestedUrl, { newTab: true });
      } else if (!wasOpen) {
        void this.browserPanelController.refreshAll();
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

  private setDock(dock: BrowserPanelDock): void {
    this.dock = dock;
    this.syncLayoutReservation();
    this.persistLayout();
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

  override render() {
    if (!this.available || !this.open) {
      return nothing;
    }
    return renderBrowserPanelChrome(
      this.browserPanelController,
      this.dock,
      this.height,
      this.width,
      (dock) => this.setDock(dock),
      () => this.closePanel(),
      (event) => this.startResize(event),
    );
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
