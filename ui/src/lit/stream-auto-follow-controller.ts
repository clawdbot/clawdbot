import type { ReactiveController, ReactiveControllerHost } from "lit";

// Activity and logs intentionally share the audit-frozen 120px follow boundary.
export class StreamAutoFollowController implements ReactiveController {
  atBottom = true;
  private frame: number | null = null;

  constructor(
    private readonly host: ReactiveControllerHost & HTMLElement,
    private readonly options: {
      selector: string;
      isEnabled: () => boolean;
      captureCurrent?: () => () => boolean;
    },
  ) {
    host.addController(this);
  }

  schedule(force = false): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    const isCurrent = this.options.captureCurrent?.() ?? (() => this.host.isConnected);
    if (!isCurrent()) {
      return;
    }
    void this.host.updateComplete.then(() => {
      if (!isCurrent()) {
        return;
      }
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        const container = isCurrent()
          ? this.host.querySelector<HTMLElement>(this.options.selector)
          : null;
        if (!container) {
          return;
        }
        const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
        if (!force && (!this.options.isEnabled() || (!this.atBottom && distance >= 120))) {
          return;
        }
        container.scrollTop = container.scrollHeight;
        this.atBottom = true;
      });
    });
  }

  handleScroll(event: Event): void {
    const container = event.currentTarget as HTMLElement | null;
    if (container) {
      this.atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    }
  }

  hostDisconnected(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }
}
