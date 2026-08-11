import { resolveSidebarSessionsScrollState } from "./app-sidebar-session-types.ts";
import type { SidebarSessionsScrollState } from "./app-sidebar-session-types.ts";

/** Owns sidebar scroll observation and its paint-coalesced reactive state. */
export class SessionDataScrollController {
  state: SidebarSessionsScrollState = "none";

  private element: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private frame: number | null = null;

  /** Creates a scroll owner that notifies its reactive host on state changes. */
  constructor(private readonly notify: () => void) {}

  /** Rebinds observation to the sidebar's current scroll container. */
  synchronize(host: Pick<HTMLElement, "querySelector">): void {
    const element = host.querySelector(".sidebar-shell__body") as HTMLElement | null;
    if (element !== this.element) {
      this.resizeObserver?.disconnect();
      this.element = element;
      this.resizeObserver = null;
      if (element && typeof ResizeObserver === "function") {
        this.resizeObserver = new ResizeObserver(() => this.update(element));
        this.resizeObserver.observe(element);
      }
    }
    if (element && this.frame === null) {
      // One rAF-coalesced read rides paint layout instead of flushing every update.
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        if (this.element?.isConnected) {
          this.update(this.element);
        }
      });
    }
  }

  /** Publishes the scroll affordance state observed from an element. */
  update(element: HTMLElement): void {
    const nextState = resolveSidebarSessionsScrollState(element);
    if (nextState !== this.state) {
      this.state = nextState;
      this.notify();
    }
  }

  /** Releases DOM observers and pending animation-frame work. */
  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.element = null;
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }
}
