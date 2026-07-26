import {
  css,
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
} from "lit";
import type { DockPanelLayoutStore, DockPanelSide } from "./dock-panel-layout.ts";

type DockLayoutHost = ReactiveControllerHost & { readonly isConnected: boolean };

type DockLayoutControllerOptions<TDock extends DockPanelSide> = {
  layout: DockPanelLayoutStore<TDock>;
  reservationPrefix: string;
  isAvailable: () => boolean;
  isFullscreen?: () => boolean;
  onResize?: () => void;
};

export class DockLayoutController<TDock extends DockPanelSide> implements ReactiveController {
  open = false;
  dock: TDock;
  height: number;
  width: number;

  private resizeCleanup: (() => void) | null = null;
  private readonly onViewportResize = () => {
    const height = Math.min(this.height, this.options.layout.maxHeight());
    const width = Math.min(this.width, this.options.layout.maxWidth());
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
    this.width = layout.width;
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

  restoreOpenState(): boolean {
    if (this.open || (!this.isFullscreen() && !this.options.layout.load().open)) {
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
    if (this.isFullscreen()) {
      return;
    }
    const visible = this.options.isAvailable() && this.open;
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
        this.width = Math.min(next, this.options.layout.maxWidth());
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
    if (this.isFullscreen()) {
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
    const root = document.documentElement.style;
    root.setProperty(`--oc-${this.options.reservationPrefix}-reserve-bottom`, "0px");
    root.setProperty(`--oc-${this.options.reservationPrefix}-reserve-right`, "0px");
  }

  private isFullscreen(): boolean {
    return this.options.isFullscreen?.() === true;
  }
}

export const dockPanelStyles = css`
  :host {
    position: fixed;
    z-index: 60;
    color: var(--text, #d7dae0);
    font-family: var(--font-sans, system-ui, sans-serif);
  }
  :is(.bp, .tp) {
    position: fixed;
    display: flex;
    flex-direction: column;
    background: var(--bg, #0e1015);
    overflow: hidden;
  }
  :is(.bp--bottom, .tp--bottom) {
    border-top: 1px solid var(--border, #262b34);
  }
  :is(.bp--right, .tp--right) {
    border-left: 1px solid var(--border, #262b34);
  }
  :is(.bp-resizer, .tp-resizer) {
    position: absolute;
    z-index: 2;
    background: transparent;
  }
  :is(.bp-resizer, .tp-resizer):hover {
    background: var(--accent, #ff5c5c);
    opacity: 0.5;
  }
  :is(.bp-resizer--bottom, .tp-resizer--bottom) {
    top: 0;
    left: 0;
    right: 0;
    height: 5px;
    cursor: ns-resize;
  }
  :is(.bp-resizer--right, .tp-resizer--right) {
    top: 0;
    bottom: 0;
    left: 0;
    width: 5px;
    cursor: ew-resize;
  }
  :is(.bp-header, .tp-header) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 6px 0 4px;
    border-bottom: 1px solid var(--border, #262b34);
    min-height: 36px;
  }
  :is(.bp-icon, .tp-icon) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    background: transparent;
    color: var(--muted, #8a919e);
    border-radius: 6px;
    padding: 0;
  }
  :is(.bp-icon, .tp-icon):hover {
    background: color-mix(in srgb, var(--text, #d7dae0) 12%, transparent);
    color: var(--text, #d7dae0);
  }
  :is(.bp-actions, .tp-actions) {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-left: 6px;
  }
`;
