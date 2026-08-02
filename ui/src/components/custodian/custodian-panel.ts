import { html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import "../openclaw-mascot.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  custodianSessionStore,
  type CustodianSessionStore,
} from "../../pages/custodian/custodian-session-store.ts";
import { DockLayoutController } from "../dock-layout-controller.ts";
import { createDockPanelLayout, type DockPanelSide } from "../dock-panel-layout.ts";
import { icons } from "../icons.ts";
import {
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  type CustodianPanelToggleDetail,
} from "../panel-toggle-contract.ts";
import "../../pages/custodian/custodian-surface.ts";
import "../../styles/custodian-panel.css";

type CustodianDock = Exclude<DockPanelSide, "left">;

const panelLayout = createDockPanelLayout({
  storageKey: "openclaw.custodian.panel.v1",
  minHeight: 240,
  minWidth: 320,
  defaultDock: "right",
  supportedDocks: ["bottom", "right"],
  defaultHeight: 420,
  defaultWidth: 440,
});

export class OpenClawCustodianPanel extends OpenClawLightDomElement {
  @property({ type: Boolean }) available = false;
  @property({ type: Boolean }) suppressed = false;
  @property({ type: Number }) minimizeRequestId = 0;
  @property({ attribute: false }) store: CustodianSessionStore = custodianSessionStore;

  private readonly dockLayout = new DockLayoutController(this, {
    layout: panelLayout,
    reservationPrefix: "custodian",
    isAvailable: () => this.available,
  });
  private readonly onToggleRequest = (event: Event) => this.handleToggleRequest(event);
  private handledMinimizeRequestId = 0;
  private subscribedStore: CustodianSessionStore | null = null;
  private storeCleanup: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.subscribeToStore();
    window.addEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    this.dockLayout.setSuppressed(this.suppressed);
  }

  override disconnectedCallback(): void {
    window.removeEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    this.storeCleanup?.();
    this.storeCleanup = null;
    this.subscribedStore = null;
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("store")) {
      this.subscribeToStore();
    }
    if (changed.has("suppressed")) {
      this.dockLayout.setSuppressed(this.suppressed);
    }
    if (this.minimizeRequestId > 0 && this.minimizeRequestId !== this.handledMinimizeRequestId) {
      if (this.available) {
        this.handledMinimizeRequestId = this.minimizeRequestId;
      }
      if (this.available && this.store.hasRealUserTurn()) {
        this.dockLayout.setOpen(true);
      }
    }
    if (changed.has("available")) {
      if (!this.available && this.dockLayout.open) {
        this.dockLayout.hideWithoutPersisting();
      } else if (this.available) {
        this.dockLayout.restoreOpenState();
      }
    }
    this.dockLayout.syncReservation();
  }

  private subscribeToStore(): void {
    if (!this.isConnected || this.subscribedStore === this.store) {
      return;
    }
    this.storeCleanup?.();
    this.subscribedStore = this.store;
    this.storeCleanup = this.store.subscribe(() => this.requestUpdate());
  }

  toggle(): void {
    if (!this.available || this.suppressed) {
      return;
    }
    if (this.dockLayout.open) {
      this.dockLayout.setOpen(false);
    } else {
      this.dockLayout.setOpen(true);
    }
  }

  handleToggleRequest(event: Event): void {
    const detail =
      event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
        ? (event.detail as CustodianPanelToggleDetail)
        : null;
    if (detail?.dock === "right" || detail?.dock === "bottom") {
      this.dockLayout.setDock(detail.dock, false);
    }
    if (detail?.open === false) {
      this.dockLayout.setOpen(false);
      return;
    }
    if (detail?.open === true) {
      if (!this.available || this.suppressed) {
        return;
      }
      this.dockLayout.setOpen(true);
      return;
    }
    this.toggle();
  }

  private setDock(dock: CustodianDock): void {
    this.dockLayout.setDock(dock);
  }

  get custodianPanelOpen(): boolean {
    return this.dockLayout.open;
  }

  override render() {
    if (!this.available || !this.dockLayout.open) {
      return nothing;
    }
    const dock = this.dockLayout.dock;
    const style =
      dock === "bottom" ? `height:${this.dockLayout.height}px` : `width:${this.dockLayout.width}px`;
    return html`
      <section class="cp cp--${dock}" style=${style} aria-label=${t("custodian.panel.title")}>
        ${this.dockLayout.renderResizer("cp", t("custodian.panel.resize"))}
        <header class="cp-header">
          <div class="cp-title">
            <openclaw-mascot
              .mood=${this.store.sending ? "thinking" : "idle"}
              .size=${26}
            ></openclaw-mascot>
            <strong>${t("custodian.panel.title")}</strong>
          </div>
          <div class="cp-actions">
            <button
              class="cp-icon"
              type="button"
              aria-label=${dock === "bottom"
                ? t("custodian.panel.dockRight")
                : t("custodian.panel.dockBottom")}
              @click=${() => this.setDock(dock === "bottom" ? "right" : "bottom")}
            >
              ${dock === "bottom" ? icons.panelRightOpen : icons.panelBottomOpen}
            </button>
            <button
              class="cp-icon"
              type="button"
              aria-label=${t("custodian.panel.close")}
              @click=${() => this.dockLayout.setOpen(false)}
            >
              ${icons.x}
            </button>
          </div>
        </header>
        <openclaw-custodian-surface
          .store=${this.store}
          .onboarding=${this.store.activeVariant === "onboarding"}
          .newAgentIntent=${this.store.activeVariant === "new-agent"}
          compact
        ></openclaw-custodian-surface>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-custodian-panel")) {
  customElements.define("openclaw-custodian-panel", OpenClawCustodianPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-custodian-panel": OpenClawCustodianPanel;
  }
}
