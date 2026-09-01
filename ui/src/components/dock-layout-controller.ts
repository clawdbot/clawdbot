import {
  css,
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
} from "lit";
import type { DockPanelLayoutStore, DockPanelPlacement } from "./dock-panel-layout.ts";
import "./resizable-divider.ts";

type DockLayoutHost = ReactiveControllerHost & { readonly isConnected: boolean };

type DockLayoutControllerOptions<TDock extends DockPanelPlacement> = {
  layout: DockPanelLayoutStore<TDock>;
  reservationPrefix: string;
  isAvailable: () => boolean;
  isFullscreen?: () => boolean;
  maxWidth?: () => number;
  reserveViewport?: boolean;
  onResize?: () => void;
};

export class DockLayoutController<TDock extends DockPanelPlacement> implements ReactiveController {
  open = false;
  dock: TDock;
  height: number;
  width: number;

  private suppressed = false;
  private readonly onViewportResize = () => {
    const height = Math.min(this.height, this.options.layout.maxHeight());
    const width = Math.min(this.width, this.maxWidth());
    if (height === this.height && width === this.width) {
      return;
    }
    this.height = height;
    this.width = width;
    this.syncReservation();
    this.options.onResize?.();
    this.host.requestUpdate();
  };

  constructor(
    private readonly host: DockLayoutHost,
    private readonly options: DockLayoutControllerOptions<TDock>,
  ) {
    this.dock = options.layout.defaults.dock;
    this.height = options.layout.defaults.height;
    this.width = options.layout.defaults.width;
    host.addController(this);
  }

  hostConnected(): void {
    if (this.isFullscreen()) {
      this.open = this.options.isAvailable();
      return;
    }
    const layout = this.options.layout.load();
    this.open = layout.open && this.options.isAvailable();
    this.dock = layout.dock;
    this.height = layout.height;
    this.width = Math.min(layout.width, this.maxWidth());
    window.addEventListener("resize", this.onViewportResize);
  }

  hostDisconnected(): void {
    window.removeEventListener("resize", this.onViewportResize);
    this.clearReservation();
  }

  setOpen(open: boolean, persist = true): void {
    this.open = open;
    this.syncReservation();
    if (persist) {
      this.persist();
    }
    this.host.requestUpdate();
  }

  hideWithoutPersisting(): void {
    this.setOpen(false, false);
  }

  /**
   * Full-page route takeovers (settings) own the viewport, so docks hide while
   * one renders. Hiding never persists — the user's open preference must survive
   * the visit — and suppression also blocks `restoreOpenState()` so a reconnect
   * mid-takeover cannot pop the panel back over settings. Returns true when the
   * caller must resume its surface after the takeover ends.
   *
   * Only automatic restores are blocked. An explicit open (Ctrl+`, toolbar,
   * `ui.command`) still wins and shows the dock over the takeover: swallowing a
   * requested terminal would be a worse papercut than the one this fixes.
   */
  setSuppressed(suppressed: boolean): boolean {
    if (this.suppressed === suppressed) {
      return false;
    }
    this.suppressed = suppressed;
    if (suppressed) {
      this.hideWithoutPersisting();
      return false;
    }
    return this.restoreOpenState();
  }

  restoreOpenState(): boolean {
    if (
      this.suppressed ||
      !this.options.isAvailable() ||
      this.open ||
      (!this.isFullscreen() && !this.options.layout.load().open)
    ) {
      return false;
    }
    this.open = true;
    this.syncReservation();
    this.host.requestUpdate();
    return true;
  }

  setDock(dock: TDock, persist = true): void {
    this.dock = dock;
    this.syncReservation();
    if (persist) {
      this.persist();
    }
    this.host.requestUpdate();
  }

  persist(): void {
    this.options.layout.save({
      open: this.open,
      dock: this.dock,
      height: this.height,
      width: this.width,
    });
  }

  syncReservation(): void {
    if (this.options.reserveViewport === false) {
      return;
    }
    // Embedded docks live inside a parent layout that already owns their geometry.
    // Reserving the viewport here would apply the standalone dock a second time.
    const embedded = this.host instanceof HTMLElement && this.host.hasAttribute("embedded");
    const visible = !embedded && !this.isFullscreen() && this.options.isAvailable() && this.open;
    const root = document.documentElement.style;
    root.setProperty(
      `--oc-${this.options.reservationPrefix}-reserve-bottom`,
      visible && this.dock === "bottom" ? `${this.height}px` : "0px",
    );
    root.setProperty(
      `--oc-${this.options.reservationPrefix}-reserve-right`,
      visible && this.dock === "right" ? `${this.width}px` : "0px",
    );
  }

  private resize(event: CustomEvent<{ splitRatio: number }>): void {
    const horizontal = this.dock === "bottom";
    const minimum = horizontal ? this.options.layout.minHeight : this.options.layout.minWidth;
    const maximum = horizontal ? this.options.layout.maxHeight() : this.maxWidth();
    const size = Math.min(maximum, Math.max(minimum, (1 - event.detail.splitRatio) * this.size()));
    if (horizontal) {
      this.height = size;
    } else {
      this.width = size;
    }
    this.syncReservation();
    this.options.onResize?.();
    this.host.requestUpdate();
  }

  private size(): number {
    return this.dock === "bottom" ? window.innerHeight : window.innerWidth;
  }

  renderResizer(classPrefix: string, label: string): TemplateResult | typeof nothing {
    if (this.isFullscreen() || this.dock === "main") {
      return nothing;
    }
    const horizontal = this.dock === "bottom";
    const size = this.size();
    const minimum = horizontal ? this.options.layout.minHeight : this.options.layout.minWidth;
    const maximum = horizontal ? this.options.layout.maxHeight() : this.maxWidth();
    const current = horizontal ? this.height : this.width;
    return html`<resizable-divider
      class="${classPrefix}-resizer ${classPrefix}-resizer--${this.dock}"
      .orientation=${horizontal ? "horizontal" : "vertical"}
      .label=${label}
      .splitRatio=${1 - current / size}
      .minRatio=${1 - maximum / size}
      .maxRatio=${1 - minimum / size}
      .measureRatio=${() => 1 - (horizontal ? this.height : this.width) / this.size()}
      .measureSize=${() => this.size()}
      @resize=${(event: CustomEvent<{ splitRatio: number }>) => this.resize(event)}
      @resize-end=${() => this.persist()}
    ></resizable-divider>`;
  }

  private clearReservation(): void {
    if (this.options.reserveViewport === false) {
      return;
    }
    const root = document.documentElement.style;
    root.setProperty(`--oc-${this.options.reservationPrefix}-reserve-bottom`, "0px");
    root.setProperty(`--oc-${this.options.reservationPrefix}-reserve-right`, "0px");
  }

  private isFullscreen(): boolean {
    return this.options.isFullscreen?.() === true;
  }

  private maxWidth(): number {
    return Math.max(
      this.options.layout.minWidth,
      Math.min(
        this.options.layout.maxWidth(),
        this.options.maxWidth?.() ?? Number.POSITIVE_INFINITY,
      ),
    );
  }
}

export const dockPanelStyles = css`
  :host {
    position: fixed;
    z-index: 60;
    color: var(--text, #d7dae0);
    font-family: var(--font-body);
  }
  :host([embedded]) {
    position: static;
    z-index: auto;
    display: flex;
    width: 100%;
    min-width: 0;
    min-height: 0;
    flex: 1 1 0;
  }
  :is(.bp, .tp) {
    position: fixed;
    display: flex;
    flex-direction: column;
    background: var(--bg, #0e1015);
    overflow: hidden;
  }
  :is(.bp-resizer, .tp-resizer) {
    position: absolute;
    z-index: 2;
  }
  :is(.bp-resizer--bottom, .tp-resizer--bottom) {
    --resize-handle-line-block: 0;
    top: 0;
    left: 0;
    right: 0;
  }
  :is(.bp-resizer--right, .tp-resizer--right) {
    --resize-handle-line-inline: 0;
    top: 0;
    bottom: 0;
    left: 0;
  }
  .rail-header {
    box-sizing: border-box;
    display: flex;
    height: var(--rail-header-height, 48px);
    min-height: var(--rail-header-height, 48px);
    flex: 0 0 auto;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 var(--rail-header-padding-end, 8px) 0 var(--rail-header-padding-start, 12px);
    border-bottom: var(--rail-divider-size, 1px) solid
      var(--rail-divider-color, var(--border, #262b34));
    background: var(--rail-header-background, var(--bg, #0e1015));
  }
  .rail-header__actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--rail-header-action-gap, 2px);
  }
  .rail-header__copy {
    display: flex;
    min-width: 0;
    flex: 1 1 auto;
    flex-direction: column;
    justify-content: center;
    gap: var(--rail-header-copy-gap, 2px);
  }
  .rail-header__eyebrow {
    overflow: hidden;
    color: var(--muted, #8a919e);
    font-size: var(--rail-header-eyebrow-size, 10px);
    letter-spacing: var(--rail-header-eyebrow-letter-spacing, 0.04em);
    line-height: 1;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .rail-header__title {
    overflow: hidden;
    color: var(--text, #d7dae0);
    font-size: var(--rail-header-title-size, 12px);
    font-weight: var(--rail-header-title-weight, 600);
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rail-header__action {
    display: inline-flex;
    width: var(--rail-header-action-size, 28px);
    min-width: var(--rail-header-action-size, 28px);
    height: var(--rail-header-action-size, 28px);
    min-height: var(--rail-header-action-size, 28px);
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    box-shadow: none;
    color: var(--rail-header-action-color, var(--muted, #8a919e));
    font: inherit;
    opacity: 1;
  }
  .rail-header__action:hover,
  .rail-header__action:focus-visible {
    border: 0;
    background: transparent;
    box-shadow: none;
    color: var(--rail-header-action-hover-color, var(--text, #d7dae0));
  }
  .rail-header__action:focus-visible {
    outline: 2px solid var(--ring, var(--accent, #ff5c5c));
    outline-offset: -3px;
  }
  .rail-header__action.is-active,
  .rail-header__action[aria-pressed="true"] {
    background: transparent;
    color: var(--rail-header-action-active-color, var(--accent, #ff5c5c));
  }
  .rail-header__action:disabled,
  .rail-header__action[aria-disabled="true"] {
    opacity: var(--rail-header-action-disabled-opacity, 0.4);
  }
  [data-new-tab-action]:not(:disabled):not([disabled]):not([aria-disabled="true"]) {
    cursor: pointer;
  }
  .rail-header__action svg {
    width: var(--rail-header-action-glyph-size, 16px);
    height: var(--rail-header-action-glyph-size, 16px);
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
`;
