import {
  css,
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
} from "lit";
import type { DockPanelLayoutStore, DockPanelPlacement } from "./dock-panel-layout.ts";

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

  private previousDock: TDock | undefined;
  private suppressed = false;
  private resizeCleanup: (() => void) | null = null;
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
    this.previousDock = layout.previousDock;
    this.height = layout.height;
    this.width = Math.min(layout.width, this.maxWidth());
    window.addEventListener("resize", this.onViewportResize);
  }

  hostDisconnected(): void {
    window.removeEventListener("resize", this.onViewportResize);
    this.clearResizeListeners();
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

  setRestorableDock(dock: TDock): void {
    if (dock !== this.dock) {
      this.previousDock = this.dock;
    }
    this.setDock(dock);
  }

  toggleDock(dock: TDock): void {
    if (this.dock === dock) {
      this.setDock(this.previousDock ?? this.options.layout.defaults.dock);
    } else {
      this.setRestorableDock(dock);
    }
  }

  persist(): void {
    this.options.layout.save({
      open: this.open,
      dock: this.dock,
      ...(this.previousDock ? { previousDock: this.previousDock } : {}),
      height: this.height,
      width: this.width,
    });
  }

  syncReservation(): void {
    if (this.options.reserveViewport === false) {
      return;
    }
    const visible = !this.isFullscreen() && this.options.isAvailable() && this.open;
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

  startResize(event: PointerEvent): void {
    event.preventDefault();
    this.clearResizeListeners();
    const startX = event.clientX;
    const startY = event.clientY;
    const startHeight = this.height;
    const startWidth = this.width;
    const onMove = (move: PointerEvent) => {
      if (this.dock === "bottom") {
        const next = Math.max(this.options.layout.minHeight, startHeight + (startY - move.clientY));
        this.height = Math.min(next, this.options.layout.maxHeight());
      } else {
        const next = Math.max(this.options.layout.minWidth, startWidth + (startX - move.clientX));
        this.width = Math.min(next, this.maxWidth());
      }
      this.syncReservation();
      this.options.onResize?.();
      this.host.requestUpdate();
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
      if (this.host.isConnected) {
        this.persist();
      }
    };
    this.resizeCleanup = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  }

  renderResizer(classPrefix: string, label: string): TemplateResult | typeof nothing {
    if (this.isFullscreen() || this.dock === "main") {
      return nothing;
    }
    return html`<div
      class="${classPrefix}-resizer ${classPrefix}-resizer--${this.dock}"
      @pointerdown=${(event: PointerEvent) => this.startResize(event)}
      role="separator"
      aria-label=${label}
    ></div>`;
  }

  clearResizeListeners(): void {
    this.resizeCleanup?.();
    this.resizeCleanup = null;
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
    background: transparent;
  }
  :is(.bp-resizer, .tp-resizer)::after {
    position: absolute;
    content: "";
    background: var(--rail-divider-color, var(--border, #262b34));
    transition:
      background 150ms ease-out,
      width 150ms ease-out,
      height 150ms ease-out;
  }
  :is(.bp-resizer--bottom, .tp-resizer--bottom) {
    top: 0;
    left: 0;
    right: 0;
    height: var(--rail-resizer-size, 4px);
    cursor: ns-resize;
  }
  :is(.bp-resizer--bottom, .tp-resizer--bottom)::after {
    top: 50%;
    right: 0;
    left: 0;
    height: var(--rail-divider-size, 1px);
    transform: translateY(-50%);
  }
  :is(.bp-resizer--right, .tp-resizer--right) {
    top: 0;
    bottom: 0;
    left: 0;
    width: var(--rail-resizer-size, 4px);
    cursor: ew-resize;
  }
  :is(.bp-resizer--right, .tp-resizer--right)::after {
    top: 0;
    bottom: 0;
    left: 50%;
    width: var(--rail-divider-size, 1px);
    transform: translateX(-50%);
  }
  :is(.bp-resizer--bottom, .tp-resizer--bottom):hover::after {
    height: var(--rail-divider-active-size, 2px);
    background: var(--accent, #ff5c5c);
  }
  :is(.bp-resizer--right, .tp-resizer--right):hover::after {
    width: var(--rail-divider-active-size, 2px);
    background: var(--accent, #ff5c5c);
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
  .rail-header__action svg {
    width: var(--rail-header-action-glyph-size, 16px);
    height: var(--rail-header-action-glyph-size, 16px);
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
`;
