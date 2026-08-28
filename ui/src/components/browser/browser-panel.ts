// Dockable gateway browser panel for the Control UI shell.
//
// Renders the gateway-controlled browser (the same one agents drive through
// the browser plugin) as a screenshot-backed remote view with tabs, a URL bar,
// and two capture modes: annotate (freehand markup packaged into a chat
// prompt + attachment) and inspect (element details at the pointer). Works in
// any regular browser — no native webview required — and equally inside the
// macOS app's dashboard.
import { nothing } from "lit";
import { property } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLitElement } from "../../lit/openclaw-element.ts";
import { scrollbarShadowStyles } from "../../lit/scrollbar-styles.ts";
import { DockLayoutController, dockPanelStyles } from "../dock-layout-controller.ts";
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
  /** Full-page route takeovers (settings) own the viewport; the dock hides while one renders. */
  @property({ type: Boolean }) suppressed = false;
  /** Gateway HTTP resource mount used for the authenticated media fetch. */
  @property({ attribute: false }) resourceBasePath = "";
  /** Bearer credential for the assistant-media screenshot fetch. */
  @property({ attribute: false }) authToken: string | null = null;
  /** Hosted by the chat side panel, which owns visibility and geometry. */
  @property({ type: Boolean }) embedded = false;
  /** This embedded instance is the active pane's visible Browser presenter. */
  @property({ type: Boolean }) presented = false;

  private readonly browserPanelController = new BrowserPanelController(this);
  private readonly dockLayout = new DockLayoutController(this, {
    layout: panelLayout,
    reservationPrefix: "browser",
    isAvailable: () => this.available,
  });
  private readonly onToggleRequest = (event: Event) => this.handleToggleRequest(event);
  private viewportResizeObserver: ResizeObserver | null = null;
  private observedViewportElement: Element | null = null;

  static override styles = [
    panelTabStripStyles,
    dockPanelStyles,
    browserPanelStyles,
    scrollbarShadowStyles,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.embedded) {
      window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    }
    // A settings takeover can already own the viewport when the panel mounts.
    // Suppress before the restored open state refreshes a dock nobody can see.
    this.dockLayout.setSuppressed(this.suppressed);
    if (!this.embedded && this.dockLayout.open) {
      void this.browserPanelController.refreshAll();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    this.viewportResizeObserver?.disconnect();
    this.viewportResizeObserver = null;
    this.observedViewportElement = null;
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("embedded")) {
      if (this.embedded) {
        window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.onToggleRequest);
      } else {
        window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.onToggleRequest);
      }
    }
    if (changed.has("suppressed")) {
      const restored = this.dockLayout.setSuppressed(this.suppressed);
      if (this.suppressed) {
        this.browserPanelController.cancelOverlayPointerGesture();
      } else if (restored && this.browserPanelIsOpen()) {
        void this.browserPanelController.refreshAll();
      }
    }
    const gatewayAvailabilityChanged = changed.has("client") || changed.has("available");
    const presentationChanged =
      this.embedded && (changed.has("embedded") || changed.has("presented"));
    const refreshedForClientChange = this.browserPanelController.synchronizeHostProperties(changed);
    if (this.embedded) {
      if (!this.presented || !this.available || !this.client) {
        if (presentationChanged || gatewayAvailabilityChanged) {
          this.browserPanelController.resetBrowserState();
        }
      } else if (!refreshedForClientChange && (presentationChanged || gatewayAvailabilityChanged)) {
        void this.browserPanelController.refreshAll();
      }
    } else if (gatewayAvailabilityChanged) {
      if (!this.available && this.dockLayout.open) {
        // Surface disappeared (disconnect/scope loss): hide without persisting
        // so the open preference survives a reconnect.
        this.dockLayout.hideWithoutPersisting();
        this.browserPanelController.resetBrowserState();
      } else if (this.available && this.dockLayout.restoreOpenState()) {
        // Hello arrived after mount (or a reconnect): restore the persisted
        // open state now that the surface is actually available.
        void this.browserPanelController.refreshAll();
      }
    }
    this.dockLayout.syncReservation();
    this.browserPanelController.paintOverlay();
    const viewportElement = this.renderRoot.querySelector(".bp-viewport");
    if (viewportElement !== this.observedViewportElement) {
      // The viewport is transient while the dock opens, closes, or becomes unavailable.
      this.viewportResizeObserver?.disconnect();
      this.observedViewportElement = viewportElement;
      if (viewportElement && typeof ResizeObserver === "function") {
        this.viewportResizeObserver ??= new ResizeObserver((entries) => {
          const entry = entries[0];
          if (entry) {
            this.browserPanelController.handleViewportResize(
              entry.contentRect.width,
              entry.contentRect.height,
            );
          }
        });
        this.viewportResizeObserver.observe(viewportElement);
      }
    }
  }

  browserPanelIsOpen(): boolean {
    return this.embedded ? this.presented : this.dockLayout.open;
  }

  toggle(): void {
    if (!this.available) {
      return;
    }
    if (this.dockLayout.open) {
      this.closePanel();
    } else {
      this.dockLayout.setOpen(true);
      void this.browserPanelController.refreshAll();
    }
  }

  handleToggleRequest(event: Event): void {
    const detail =
      event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
        ? (event.detail as BrowserPanelToggleDetail)
        : null;
    if (this.embedded) {
      if (!this.presented || detail?.open === false || !this.available) {
        return;
      }
      const normalizedRequestedUrl =
        typeof detail?.url === "string" ? normalizeBrowserUrlDraft(detail.url) : null;
      if (normalizedRequestedUrl) {
        void this.browserPanelController.openUrl(normalizedRequestedUrl, { newTab: true });
      } else if (detail?.newTab === true) {
        this.browserPanelController.beginNewTab();
      } else {
        void this.browserPanelController.refreshAll();
      }
      return;
    }
    if (detail?.dock === "right" || detail?.dock === "bottom") {
      this.dockLayout.setDock(detail.dock, false);
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
      const wasOpen = this.dockLayout.open;
      this.dockLayout.setOpen(true);
      if (normalizedRequestedUrl) {
        void this.browserPanelController.openUrl(normalizedRequestedUrl, { newTab: true });
      } else if (detail?.newTab === true) {
        this.browserPanelController.beginNewTab();
      } else if (!wasOpen) {
        void this.browserPanelController.refreshAll();
      }
      return;
    }
    this.toggle();
  }

  private closePanel(): void {
    this.browserPanelController.cancelOverlayPointerGesture();
    this.dockLayout.setOpen(false);
  }

  private setDock(dock: BrowserPanelDock): void {
    this.dockLayout.setDock(dock);
  }

  override render() {
    if (!this.available || (!this.embedded && !this.dockLayout.open)) {
      return nothing;
    }
    return renderBrowserPanelChrome(
      this.browserPanelController,
      this.dockLayout.dock,
      this.dockLayout.height,
      this.dockLayout.width,
      (dock) => this.setDock(dock),
      () => this.closePanel(),
      this.dockLayout.renderResizer("bp", t("browser.resize")),
      this.embedded,
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
