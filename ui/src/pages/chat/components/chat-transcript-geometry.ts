import type { Virtualizer } from "@tanstack/virtual-core";
import type { ReactiveController, ReactiveControllerHost } from "lit";

function transcriptScrollMargin(element: Element | null): number {
  if (!(element instanceof HTMLElement) || typeof getComputedStyle !== "function") {
    return 0;
  }
  const margin = Number.parseFloat(getComputedStyle(element).paddingTop);
  return Number.isFinite(margin) ? margin : 0;
}

/** Row offsets start below the scroll padding plus the in-flow history header. */
export function resolveTranscriptScrollMargin(
  scrollElement: Element | null,
  headerHeight: number,
): number {
  return transcriptScrollMargin(scrollElement) + headerHeight;
}

export function syncScrollMargin(
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  headerHeight: number,
): void {
  const scrollMargin = resolveTranscriptScrollMargin(scrollElement, headerHeight);
  if (scrollMargin === virtualizer.options.scrollMargin) {
    return;
  }
  virtualizer.setOptions({
    ...virtualizer.options,
    scrollMargin,
  });
}

export function initialTranscriptRect(host: ReactiveControllerHost) {
  const width = host instanceof HTMLElement ? host.clientWidth : 0;
  const height = host instanceof HTMLElement ? host.clientHeight : 0;
  return {
    width: width || (typeof window === "undefined" ? 0 : window.innerWidth),
    height: height || (typeof window === "undefined" ? 0 : window.innerHeight),
  };
}

export function measureConnectedTranscriptRows(
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): void {
  const rect = scrollElement?.getBoundingClientRect();
  if (
    !scrollElement ||
    virtualizer.scrollElement !== scrollElement ||
    !rect?.width ||
    !rect.height
  ) {
    return;
  }
  // Width changes and retired smooth commands can have undelivered sizes.
  // Ordinary row refs stay on TanStack's observer path; never clear its cache.
  for (const row of scrollElement.querySelectorAll<HTMLElement>(".chat-virtual-row")) {
    virtualizer.resizeItem(virtualizer.indexFromElement(row), row.offsetHeight);
  }
}

export function maxTranscriptScrollOffset(element: HTMLElement | null): number | null {
  return element ? Math.max(0, element.scrollHeight - element.clientHeight) : null;
}

export class PositionRailGutterController implements ReactiveController {
  private frame: number | null = null;

  constructor(
    private readonly host: ReactiveControllerHost & {
      readonly scrollElement: HTMLDivElement | null;
    },
    private readonly inner: () => HTMLDivElement | null,
  ) {
    host.addController(this);
  }

  hostUpdated(): void {
    if (this.frame !== null) {
      return;
    }
    // Nested Lit children can still be replacing footer content. A synchronous
    // layout read here clamps scrolling against that intermediate viewport.
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.sync();
    });
  }

  hostDisconnected(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  sync(): void {
    const viewport = this.host.scrollElement;
    const inner = this.inner();
    if (!viewport?.isConnected || inner?.parentElement !== viewport) {
      return;
    }
    const right =
      viewport.getBoundingClientRect().left + viewport.clientLeft + viewport.clientWidth;
    const gutter = right - inner.getBoundingClientRect().right;
    // The rail's marker/tick footprint reaches 69px from the client edge;
    // reserve 80px including breathing room (see message-layout.css).
    viewport.toggleAttribute("data-position-rail-gutter", gutter >= 80);
  }
}
