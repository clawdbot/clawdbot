import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import "../openclaw-mascot.ts";
import { beginNativeWindowDrag } from "../../app/native-window-drag.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  custodianSessionStore,
  type CustodianSessionStore,
} from "../../pages/custodian/custodian-session-store.ts";
import { DockLayoutController } from "../dock-layout-controller.ts";
import { createDockPanelLayout, type DockPanelSide } from "../dock-panel-layout.ts";
import { icons } from "../icons.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../panel-toggle-contract.ts";
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
    if (this.dockLayout.open) {
      void this.store.refreshTranscriptIfIdle();
    }
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
      if (this.dockLayout.open) {
        void this.store.refreshTranscriptIfIdle();
      }
    }
    if (changed.has("suppressed")) {
      const wasOpen = this.dockLayout.open;
      this.dockLayout.setSuppressed(this.suppressed);
      if (!wasOpen && this.dockLayout.open) {
        void this.store.refreshTranscriptIfIdle();
      }
    }
    if (this.minimizeRequestId > 0 && this.minimizeRequestId !== this.handledMinimizeRequestId) {
      if (this.available) {
        this.handledMinimizeRequestId = this.minimizeRequestId;
      }
      if (this.available && this.store.hasRealUserTurn()) {
        this.setOpen(true);
      }
    }
    if (changed.has("available")) {
      const wasOpen = this.dockLayout.open;
      if (!this.available && this.dockLayout.open) {
        this.dockLayout.hideWithoutPersisting();
      } else if (this.available) {
        this.dockLayout.restoreOpenState();
      }
      if (!wasOpen && this.dockLayout.open) {
        void this.store.refreshTranscriptIfIdle();
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

  private setDock(dock: CustodianDock): void {
    this.dockLayout.setDock(dock);
  }

  private setOpen(open: boolean): void {
    this.dockLayout.setOpen(open);
    if (open) {
      void this.store.refreshTranscriptIfIdle();
    }
  }

  toggle(): void {
    if (!this.available || this.suppressed) {
      return;
    }
    this.setOpen(!this.dockLayout.open);
  }

  handleToggleRequest(event: Event): void {
    const raw: unknown = event instanceof CustomEvent ? event.detail : null;
    const detail = asNullableRecord(raw);
    const dock = detail?.dock;
    if (dock === "right" || dock === "bottom") {
      this.dockLayout.setDock(dock, false);
    }
    if (detail?.open === false) {
      this.setOpen(false);
      return;
    }
    if (detail?.open === true) {
      if (!this.available || this.suppressed) {
        return;
      }
      this.setOpen(true);
      return;
    }
    this.toggle();
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
        <header class="rail-header cp-header" @mousedown=${beginNativeWindowDrag}>
          <div class="cp-title">
            <openclaw-mascot
              .mood=${this.store.sending ? "thinking" : "idle"}
              .size=${16}
            ></openclaw-mascot>
            <strong class="rail-header__title">${t("custodian.panel.title")}</strong>
          </div>
          <div class="rail-header__actions cp-actions">
            <button
              class="rail-header__action cp-icon"
              type="button"
              aria-label=${dock === "bottom"
                ? t("custodian.panel.dockRight")
                : t("custodian.panel.dockBottom")}
              @click=${() => this.setDock(dock === "bottom" ? "right" : "bottom")}
            >
              ${dock === "bottom" ? icons.panelRightOpen : icons.panelBottomOpen}
            </button>
            <button
              class="rail-header__action cp-icon"
              type="button"
              aria-label=${t("custodian.panel.close")}
              @click=${() => this.setOpen(false)}
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
