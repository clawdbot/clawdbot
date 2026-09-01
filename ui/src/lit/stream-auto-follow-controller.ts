import type { ReactiveController, ReactiveControllerHost } from "lit";

// Activity and logs intentionally share the audit-frozen 120px follow boundary.
const AT_BOTTOM_THRESHOLD_PX = 120;

// Row heights settle asynchronously: the virtualizer re-measures content for
// several frames after we scroll, growing scrollHeight and pushing the viewport
// away from the bottom again. Re-assert the bottom position for a short settle
// window so following the tail actually sticks.
const SETTLE_FRAMES = 12;

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
        if (
          !force &&
          (!this.options.isEnabled() || (!this.atBottom && distance >= AT_BOTTOM_THRESHOLD_PX))
        ) {
          return;
        }
        this.scrollToBottomUntilSettled(container);
      });
    });
  }

  private scrollToBottomUntilSettled(container: HTMLElement, framesLeft = SETTLE_FRAMES): void {
    const heightAtScroll = container.scrollHeight;
    container.scrollTop = container.scrollHeight;
    this.atBottom = true;
    if (framesLeft <= 1) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      // Chase the bottom only while content growth pushed us away from it. Stop
      // when the user scrolled up (atBottom flips false in handleScroll) or when
      // content shrank underneath us.
      if (distance > 2 && this.atBottom && container.scrollHeight >= heightAtScroll) {
        this.scrollToBottomUntilSettled(container, framesLeft - 1);
      }
    });
  }

  handleScroll(event: Event): void {
    const container = event.currentTarget as HTMLElement | null;
    if (container) {
      this.atBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        AT_BOTTOM_THRESHOLD_PX;
    }
  }

  hostDisconnected(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }
}
